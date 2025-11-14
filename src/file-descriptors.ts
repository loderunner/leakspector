import * as fs from 'node:fs';
import {
  type FileHandle,
  type FSWatcher,
  type ReadStream,
  type WriteStream,
} from 'node:fs';

import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

type FileDescriptorType =
  | 'fs.open'
  | 'fs.createReadStream'
  | 'fs.createWriteStream'
  | 'fs.promises.open'
  | 'fs.watch'
  | 'fs.watchFile';

type FileDescriptorInfo = {
  fd: number | FileHandle | ReadStream | WriteStream | FSWatcher;
  type: FileDescriptorType;
  path: string | Buffer | URL;
  stack: string;
  openedAt: number;
  closed: boolean;
};

type FileHandleInfo = {
  handle: FileHandle;
  path: string | Buffer | URL;
  stack: string;
  openedAt: number;
  closed: boolean;
};

const trackedFileDescriptors = new Map<
  number | FileHandle | ReadStream | WriteStream | FSWatcher,
  FileDescriptorInfo
>();
const trackedFileHandles = new WeakMap<FileHandle, FileHandleInfo>();
const fileHandleRegistry = new FinalizationRegistry<{
  path: string | Buffer | URL;
  stack: string;
  openedAt: number;
}>(handleFinalized);

let initialFdCount = 0;
const fdCountHistory: number[] = [];
const watchFileWatchers = new Map<string | Buffer | URL, symbol>();

let originalOpen: typeof fs.open | null = null;
let originalOpenSync: typeof fs.openSync | null = null;
let originalClose: typeof fs.close | null = null;
let originalCloseSync: typeof fs.closeSync | null = null;
let originalCreateReadStream: typeof fs.createReadStream | null = null;
let originalCreateWriteStream: typeof fs.createWriteStream | null = null;
let originalPromisesOpen: typeof fs.promises.open | null = null;
let originalWatch: typeof fs.watch | null = null;
let originalWatchFile: typeof fs.watchFile | null = null;
let originalUnwatchFile: typeof fs.unwatchFile | null = null;

/**
 * Handles finalization of FileHandle objects that were garbage collected without being closed.
 */
function handleFinalized(info: {
  path: string | Buffer | URL;
  stack: string;
  openedAt: number;
}): void {
  // Mark as leaked - this will be detected during check()
  // We can't access the handle here since it's been GC'd
}

/**
 * Gets a string representation of a file path.
 */
function pathToString(path: string | Buffer | URL): string {
  if (typeof path === 'string') {
    return path;
  }
  if (path instanceof URL) {
    return path.pathname;
  }
  return path.toString();
}

/**
 * Gets the file descriptor number from various handle types.
 */
function getFdNumber(
  fd: number | FileHandle | ReadStream | WriteStream | FSWatcher,
): number | undefined {
  if (typeof fd === 'number') {
    return fd;
  }
  if (fd instanceof FileHandle) {
    return fd.fd;
  }
  if (fd instanceof ReadStream || fd instanceof WriteStream) {
    return fd.fd;
  }
  // FSWatcher doesn't expose fd directly
  return undefined;
}

/**
 * Tracks a file descriptor opening.
 */
function trackFileDescriptor(
  fd: number | FileHandle | ReadStream | WriteStream | FSWatcher,
  type: FileDescriptorType,
  path: string | Buffer | URL,
): void {
  const stack = captureStackTrace();
  const openedAt = Date.now();

  trackedFileDescriptors.set(fd, {
    fd,
    type,
    path,
    stack,
    openedAt,
    closed: false,
  });

  // For FileHandle, also register with FinalizationRegistry
  if (fd instanceof FileHandle) {
    trackedFileHandles.set(fd, {
      handle: fd,
      path,
      stack,
      openedAt,
      closed: false,
    });
    fileHandleRegistry.register(fd, { path, stack, openedAt });
  }

  // Track count over time
  const currentCount = trackedFileDescriptors.size;
  fdCountHistory.push(currentCount);
  // Keep only last 100 entries to avoid unbounded growth
  if (fdCountHistory.length > 100) {
    fdCountHistory.shift();
  }
}

/**
 * Marks a file descriptor as closed.
 */
function markFileDescriptorClosed(
  fd: number | FileHandle | ReadStream | WriteStream | FSWatcher,
): void {
  const info = trackedFileDescriptors.get(fd);
  if (info !== undefined) {
    info.closed = true;
  }

  if (fd instanceof FileHandle) {
    const handleInfo = trackedFileHandles.get(fd);
    if (handleInfo !== undefined) {
      handleInfo.closed = true;
    }
    // Unregister from FinalizationRegistry since it's being closed properly
    fileHandleRegistry.unregister(fd);
  }
}

/**
 * Starts tracking file descriptor lifecycles by instrumenting fs module operations.
 * Must be called before creating file descriptors to track.
 *
 * @throws {Error} If leak detection is already set up. Call checkFileDescriptors() first.
 *
 * @remarks Patches fs module methods to monitor file descriptor allocation and deallocation.
 *
 * @example
 * ```typescript
 * trackFileDescriptors();
 * const fd = fs.openSync('file.txt', 'r'); // This will be tracked
 * ```
 */
export function trackFileDescriptors(): void {
  if (originalOpen !== null) {
    throw new Error(
      'File descriptor leak detection already set up. Call checkFileDescriptors() first.',
    );
  }

  // Capture initial state
  initialFdCount = trackedFileDescriptors.size;
  trackedFileDescriptors.clear();
  fdCountHistory.length = 0;

  // Store original functions
  originalOpen = fs.open;
  originalOpenSync = fs.openSync;
  originalClose = fs.close;
  originalCloseSync = fs.closeSync;
  originalCreateReadStream = fs.createReadStream;
  originalCreateWriteStream = fs.createWriteStream;
  originalPromisesOpen = fs.promises.open;
  originalWatch = fs.watch;
  originalWatchFile = fs.watchFile;
  originalUnwatchFile = fs.unwatchFile;

  // Helper to patch a property
  function patchFsProperty<K extends keyof typeof fs>(
    key: K,
    patchedFn: typeof fs[K],
  ): void {
    const descriptor = Object.getOwnPropertyDescriptor(fs, key);
    if (descriptor && !descriptor.configurable) {
      // Property is not configurable, try to delete and redefine
      try {
        delete (fs as Record<string, unknown>)[key];
      } catch {
        // If delete fails, try defineProperty anyway - it might work
      }
    }
    const success = Reflect.defineProperty(fs, key, {
      value: patchedFn,
      writable: true,
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
    });
    if (!success) {
      // If defineProperty fails, try direct assignment as fallback
      try {
        (fs as Record<string, unknown>)[key] = patchedFn;
      } catch {
        // If that also fails, the property can't be patched
        // This is expected for some Node.js internal properties
      }
    }
  }

  // Patch fs.open (async)
  patchFsProperty('open', function (
    ...args: Parameters<typeof fs.open>
  ): ReturnType<typeof fs.open> {
    const path = args[0];
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      // Async version
      const wrappedCallback = (
        err: NodeJS.ErrnoException | null,
        fd: number,
      ): void => {
        if (!err && fd !== undefined) {
          trackFileDescriptor(fd, 'fs.open', path);
        }
        callback(err, fd);
      };
      const newArgs = [...args.slice(0, -1), wrappedCallback] as Parameters<
        typeof fs.open
      >;
      return originalOpen!.apply(this, newArgs);
    }
    return originalOpen!.apply(this, args);
  });

  // Patch fs.openSync (sync)
  patchFsProperty('openSync', function (
    ...args: Parameters<typeof fs.openSync>
  ): ReturnType<typeof fs.openSync> {
    const path = args[0];
    const fd = originalOpenSync!.apply(this, args);
    trackFileDescriptor(fd, 'fs.open', path);
    return fd;
  });

  // Patch fs.close (async)
  patchFsProperty('close', function (
    ...args: Parameters<typeof fs.close>
  ): ReturnType<typeof fs.close> {
    const fd = args[0];
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      // Async version
      const wrappedCallback = (err: NodeJS.ErrnoException | null): void => {
        if (!err) {
          markFileDescriptorClosed(fd);
        }
        callback(err);
      };
      const newArgs = [...args.slice(0, -1), wrappedCallback] as Parameters<
        typeof fs.close
      >;
      return originalClose!.apply(this, newArgs);
    }
    return originalClose!.apply(this, args);
  });

  // Patch fs.closeSync (sync)
  patchFsProperty('closeSync', function (
    ...args: Parameters<typeof fs.closeSync>
  ): ReturnType<typeof fs.closeSync> {
    const fd = args[0];
    markFileDescriptorClosed(fd);
    return originalCloseSync!.apply(this, args);
  });

  // Patch fs.createReadStream
  patchFsProperty('createReadStream', function (
    ...args: Parameters<typeof fs.createReadStream>
  ): ReturnType<typeof fs.createReadStream> {
    const path = args[0];
    const stream = originalCreateReadStream!.apply(this, args);
    // ReadStream gets fd when it opens, track it on 'open' event
    stream.once('open', (fd: number) => {
      trackFileDescriptor(stream, 'fs.createReadStream', path);
    });
    // Track close event
    stream.once('close', () => {
      markFileDescriptorClosed(stream);
    });
    return stream;
  });

  // Patch fs.createWriteStream
  patchFsProperty('createWriteStream', function (
    ...args: Parameters<typeof fs.createWriteStream>
  ): ReturnType<typeof fs.createWriteStream> {
    const path = args[0];
    const stream = originalCreateWriteStream!.apply(this, args);
    // WriteStream gets fd when it opens, track it on 'open' event
    stream.once('open', (fd: number) => {
      trackFileDescriptor(stream, 'fs.createWriteStream', path);
    });
    // Track close event
    stream.once('close', () => {
      markFileDescriptorClosed(stream);
    });
    return stream;
  });

  // Patch fs.promises.open
  const promisesDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'open');
  if (promisesDescriptor && !promisesDescriptor.configurable) {
    try {
      delete (fs.promises as Record<string, unknown>).open;
    } catch {
      // If delete fails, we can't patch this property
    }
  }
  Object.defineProperty(fs.promises, 'open', {
    value: function (
      ...args: Parameters<typeof fs.promises.open>
    ): ReturnType<typeof fs.promises.open> {
      const path = args[0];
      const promise = originalPromisesOpen!.apply(this, args);
      promise.then((handle: FileHandle) => {
        trackFileDescriptor(handle, 'fs.promises.open', path);
        // Track close method
        const originalClose = handle.close.bind(handle);
        handle.close = async function (
          ...closeArgs: Parameters<FileHandle['close']>
        ): Promise<void> {
          markFileDescriptorClosed(handle);
          return originalClose(...closeArgs);
        };
      });
      return promise;
    },
    writable: true,
    configurable: true,
    enumerable: promisesDescriptor?.enumerable ?? true,
  });

  // Patch fs.watch
  patchFsProperty('watch', function (
    ...args: Parameters<typeof fs.watch>
  ): ReturnType<typeof fs.watch> {
    const path = args[0];
    const watcher = originalWatch!.apply(this, args);
    trackFileDescriptor(watcher, 'fs.watch', path);
    // Track close method
    const originalClose = watcher.close.bind(watcher);
    watcher.close = function (
      ...closeArgs: Parameters<FSWatcher['close']>
    ): void {
      markFileDescriptorClosed(watcher);
      return originalClose(...closeArgs);
    };
    return watcher;
  });

  // Patch fs.watchFile
  patchFsProperty('watchFile', function (
    ...args: Parameters<typeof fs.watchFile>
  ): ReturnType<typeof fs.watchFile> {
    const path = args[0];
    const result = originalWatchFile!.apply(this, args);
    // watchFile doesn't return a handle, but creates a persistent watcher
    // We'll track it by creating a synthetic identifier
    const watcherId = Symbol(`watchFile:${pathToString(path)}`);
    watchFileWatchers.set(path, watcherId);
    trackFileDescriptor(watcherId as unknown as FSWatcher, 'fs.watchFile', path);
    return result;
  });

  // Patch fs.unwatchFile
  patchFsProperty('unwatchFile', function (
    ...args: Parameters<typeof fs.unwatchFile>
  ): ReturnType<typeof fs.unwatchFile> {
    const path = args[0];
    const result = originalUnwatchFile!.apply(this, args);
    // If unwatching a specific path, mark it as closed
    if (path !== undefined) {
      const watcherId = watchFileWatchers.get(path);
      if (watcherId !== undefined) {
        markFileDescriptorClosed(watcherId as unknown as FSWatcher);
        watchFileWatchers.delete(path);
      }
    } else {
      // Unwatching all - mark all as closed
      for (const [p, watcherId] of watchFileWatchers.entries()) {
        markFileDescriptorClosed(watcherId as unknown as FSWatcher);
      }
      watchFileWatchers.clear();
    }
    return result;
  });
}

export type FileDescriptorsSnapshot = {
  open: number;
  byType: Record<FileDescriptorType, number>;
  files: Array<{
    path: string;
    type: FileDescriptorType;
    openedAt: number;
  }>;
};

/**
 * Creates a snapshot of all currently tracked file descriptors.
 * Returns counts and details of open file descriptors.
 *
 * @returns A snapshot of all tracked file descriptors.
 *
 * @example
 * ```typescript
 * trackFileDescriptors();
 * const fd = fs.openSync('file.txt', 'r');
 * const snapshot = snapshotFileDescriptors();
 * // snapshot = { open: 1, byType: { 'fs.open': 1, ... }, files: [...] }
 * ```
 */
export function snapshotFileDescriptors(): FileDescriptorsSnapshot {
  const openFds: FileDescriptorInfo[] = [];
  for (const info of trackedFileDescriptors.values()) {
    if (!info.closed) {
      openFds.push(info);
    }
  }

  const byType: Record<FileDescriptorType, number> = {
    'fs.open': 0,
    'fs.createReadStream': 0,
    'fs.createWriteStream': 0,
    'fs.promises.open': 0,
    'fs.watch': 0,
    'fs.watchFile': 0,
  };

  for (const info of openFds) {
    byType[info.type]++;
  }

  const files = openFds.map((info) => ({
    path: pathToString(info.path),
    type: info.type,
    openedAt: info.openedAt,
  }));

  return {
    open: openFds.length,
    byType,
    files,
  };
}

/**
 * Detects growth patterns in file descriptor count over time.
 */
function detectGrowthPattern(): {
  growing: boolean;
  growthRate: number;
  message: string;
} {
  if (fdCountHistory.length < 10) {
    return {
      growing: false,
      growthRate: 0,
      message: '',
    };
  }

  const recent = fdCountHistory.slice(-10);
  const first = recent[0] ?? 0;
  const last = recent[recent.length - 1] ?? 0;
  const growthRate = last - first;

  if (growthRate > 5) {
    return {
      growing: true,
      growthRate,
      message: `File descriptor count is growing: ${first} -> ${last} (+${growthRate})`,
    };
  }

  return {
    growing: false,
    growthRate: 0,
    message: '',
  };
}

/**
 * Formats leak message in short format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(): string {
  const openFds: FileDescriptorInfo[] = [];
  for (const info of trackedFileDescriptors.values()) {
    if (!info.closed) {
      openFds.push(info);
    }
  }

  if (openFds.length === 0) {
    return '';
  }

  return `File descriptor leaks detected: ${openFds.length} leaked file descriptor(s)`;
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const openFds: FileDescriptorInfo[] = [];
  for (const info of trackedFileDescriptors.values()) {
    if (!info.closed) {
      openFds.push(info);
    }
  }

  if (openFds.length === 0) {
    return '';
  }

  const lines: string[] = ['File descriptor leaks detected:'];
  for (const info of openFds) {
    const path = pathToString(info.path);
    const formattedStack = formatStackTrace(info.stack, ['file-descriptors.ts']);
    if (formattedStack !== '') {
      lines.push(`  ${info.type}(${path}) ${formattedStack}`);
    } else {
      lines.push(`  ${info.type}(${path})`);
    }
  }

  const growthPattern = detectGrowthPattern();
  if (growthPattern.growing) {
    lines.push('');
    lines.push(`  Warning: ${growthPattern.message}`);
  }

  return lines.join('\n');
}

/**
 * Formats leak message in details format with stack traces.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatDetailsMessage(): string {
  const openFds: FileDescriptorInfo[] = [];
  for (const info of trackedFileDescriptors.values()) {
    if (!info.closed) {
      openFds.push(info);
    }
  }

  if (openFds.length === 0) {
    return '';
  }

  const lines: string[] = ['File descriptor leaks detected:'];
  for (const info of openFds) {
    const path = pathToString(info.path);
    lines.push(`  ${info.type}(${path})`);
    const formattedStack = formatStackTrace(info.stack, ['file-descriptors.ts']);
    if (formattedStack !== '') {
      lines.push(`    opened at ${formattedStack}`);
    }
    // Include full stack trace in details mode
    const stackLines = info.stack.split('\n').slice(1); // Skip Error: line
    for (const line of stackLines) {
      if (line.trim() !== '') {
        lines.push(`    ${line.trim()}`);
      }
    }
  }

  const growthPattern = detectGrowthPattern();
  if (growthPattern.growing) {
    lines.push('');
    lines.push(`  Warning: ${growthPattern.message}`);
  }

  return lines.join('\n');
}

/**
 * Checks for file descriptor leaks by checking for non-closed file descriptors.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only (e.g. `"File descriptor leaks detected: 5 leaked file descriptor(s)"`)
 * - `"summary"`: List of leaked file descriptors with stack traces
 * - `"details"`: Detailed output with full stack traces
 *
 * @throws {Error} If leak detection is not set up. Call trackFileDescriptors() first.
 * @throws {Error} If file descriptor leaks are detected, with details about each leak.
 *
 * @remarks Restores original fs module methods and clears tracking state.
 *
 * @example
 * ```typescript
 * trackFileDescriptors();
 * const fd = fs.openSync('file.txt', 'r');
 * // ... later ...
 * await checkFileDescriptors({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkFileDescriptors(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
}): Promise<void> {
  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
  } = options ?? {};

  if (originalOpen === null) {
    throw new Error(
      'File descriptor leak detection not set up. Call trackFileDescriptors() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
  }

  // Helper to restore a property
  function restoreFsProperty<K extends keyof typeof fs>(
    key: K,
    originalFn: typeof fs[K],
  ): void {
    const descriptor = Object.getOwnPropertyDescriptor(fs, key);
    if (descriptor && !descriptor.configurable) {
      try {
        delete (fs as Record<string, unknown>)[key];
      } catch {
        return;
      }
    }
    Object.defineProperty(fs, key, {
      value: originalFn,
      writable: true,
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
    });
  }

  // Restore original functions
  restoreFsProperty('open', originalOpen);
  restoreFsProperty('openSync', originalOpenSync!);
  restoreFsProperty('close', originalClose!);
  restoreFsProperty('closeSync', originalCloseSync!);
  restoreFsProperty('createReadStream', originalCreateReadStream!);
  restoreFsProperty('createWriteStream', originalCreateWriteStream!);
  restoreFsProperty('watch', originalWatch!);
  restoreFsProperty('watchFile', originalWatchFile!);
  restoreFsProperty('unwatchFile', originalUnwatchFile!);

  // Restore fs.promises.open
  const promisesDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'open');
  if (promisesDescriptor && !promisesDescriptor.configurable) {
    try {
      delete (fs.promises as Record<string, unknown>).open;
    } catch {
      // If delete fails, we can't restore this property
    }
  }
  Object.defineProperty(fs.promises, 'open', {
    value: originalPromisesOpen!,
    writable: true,
    configurable: true,
    enumerable: promisesDescriptor?.enumerable ?? true,
  });

  originalOpen = null;
  originalOpenSync = null;
  originalClose = null;
  originalCloseSync = null;
  originalCreateReadStream = null;
  originalCreateWriteStream = null;
  originalPromisesOpen = null;
  originalWatch = null;
  originalWatchFile = null;
  originalUnwatchFile = null;

  let message: string;
  if (format === 'short') {
    message = formatShortMessage();
  } else if (format === 'details') {
    message = formatDetailsMessage();
  } else {
    message = formatSummaryMessage();
  }

  trackedFileDescriptors.clear();
  fdCountHistory.length = 0;
  watchFileWatchers.clear();
  initialFdCount = 0;

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Convenience object providing access to file descriptor leak detection functions.
 *
 * @property track - Starts tracking file descriptors. See {@link trackFileDescriptors}.
 * @property snapshot - Creates a snapshot of current file descriptors. See {@link snapshotFileDescriptors}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkFileDescriptors}.
 */
export const fileDescriptors = {
  track: trackFileDescriptors,
  snapshot: snapshotFileDescriptors,
  check: checkFileDescriptors,
};
