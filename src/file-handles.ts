// Use require to get mutable bindings
import type * as fsType from 'node:fs';
import type * as fsPromisesType from 'node:fs/promises';
import { createRequire } from 'node:module';

import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

// Use require to get mutable bindings for monkey-patching
const require = createRequire(import.meta.url);
 
const fs = require('fs') as typeof fsType;
 
const fsPromises = require('fs/promises') as typeof fsPromisesType;

type FileHandleInfo = {
  path: string | Buffer | URL;
  fd?: number;
  stack: string;
  closed: boolean;
  type:
    | 'open'
    | 'readStream'
    | 'writeStream'
    | 'promiseHandle'
    | 'watch'
    | 'watchFile';
  handle?: unknown; // Store reference to streams or watchers
};

// Type aliases for the required fs module
type FsModule = typeof fsType;
type FsPromisesModule = typeof fsPromisesType;

/**
 * Snapshot of currently open file handles.
 */
export type FileHandlesSnapshot = {
  open: number;
  readStream: number;
  writeStream: number;
  promiseHandle: number;
  watch: number;
  watchFile: number;
  total: number;
};

const allHandles = new Set<FileHandleInfo>();

// Store original fs functions
let originalOpen: FsModule['open'] | null = null;
let originalClose: FsModule['close'] | null = null;
let originalCreateReadStream: FsModule['createReadStream'] | null = null;
let originalCreateWriteStream: FsModule['createWriteStream'] | null = null;
let originalPromisesOpen: FsPromisesModule['open'] | null = null;
let originalWatch: FsModule['watch'] | null = null;
let originalWatchFile: FsModule['watchFile'] | null = null;
let originalUnwatchFile: FsModule['unwatchFile'] | null = null;

// FinalizationRegistry to detect FileHandle objects that are GC'd without being closed
const finalizationRegistry = new FinalizationRegistry<{
  info: FileHandleInfo;
}>((heldValue) => {
  if (!heldValue.info.closed) {
    const pathStr =
      typeof heldValue.info.path === 'string'
        ? heldValue.info.path
        : String(heldValue.info.path);
    console.warn(
      `FileHandle for '${pathStr}' was garbage collected without being closed`,
    );
  }
});

/**
 * Starts tracking file handle lifecycles.
 * Must be called before performing file system operations to track.
 *
 * @throws {Error} If file handle tracking is already set up. Call checkFileHandles() first.
 *
 * @remarks Patches fs module functions to monitor file descriptor allocation and closure.
 *
 * @example
 * ```typescript
 * trackFileHandles();
 * const fd = fs.openSync('test.txt', 'r');
 * fs.closeSync(fd); // This will be tracked
 * ```
 */
export function trackFileHandles(): void {
  if (originalOpen !== null) {
    throw new Error(
      'File handle leak detection already set up. Call checkFileHandles() first.',
    );
  }

  // Store originals
  originalOpen = fs.open;
  originalClose = fs.close;
  originalCreateReadStream = fs.createReadStream;
  originalCreateWriteStream = fs.createWriteStream;
  originalPromisesOpen = fsPromises.open;
  originalWatch = fs.watch;
  originalWatchFile = fs.watchFile;
  originalUnwatchFile = fs.unwatchFile;

  // Hook fs.open
  fs.open = function (
    path: fsType.PathLike,
    flags: fsType.OpenMode,
    ...args: any[]
  ): void {
    const stack = captureStackTrace();
    const callback = args[args.length - 1];

    if (
      callback !== null &&
      callback !== undefined &&
      typeof callback === 'function'
    ) {
      const wrappedCallback = (
        err: NodeJS.ErrnoException | null,
        fd: number,
      ) => {
        if (!err) {
          const info: FileHandleInfo = {
            path,
            fd,
            stack,
            closed: false,
            type: 'open',
          };
          allHandles.add(info);
        }
        callback(err, fd);
      };

      const newArgs: unknown[] = [...args.slice(0, -1), wrappedCallback];
       
      return originalOpen!.call(fs, path, flags, ...(newArgs as any[]));
    }

    return originalOpen!.call(fs, path, flags, ...args);
  };

  // Hook fs.close
  fs.close = function (fd: number, ...args: any[]): void {
    const callback = args[args.length - 1];

    if (
      callback !== null &&
      callback !== undefined &&
      typeof callback === 'function'
    ) {
      const wrappedCallback = (err: NodeJS.ErrnoException | null) => {
        if (!err) {
          // Find and mark the handle as closed
          for (const info of allHandles) {
            if (info.fd === fd && !info.closed) {
              info.closed = true;
              break;
            }
          }
        }
        callback(err);
      };

      const newArgs =
        args.length > 1
          ? [...args.slice(0, -1), wrappedCallback]
          : [wrappedCallback];
      return originalClose!.call(fs, fd, ...newArgs);
    }

    return originalClose!.call(fs, fd, ...args);
  };

  // Hook fs.createReadStream
  fs.createReadStream = function (
    path: fsType.PathLike,
    options?: any,
  ): fsType.ReadStream {
    const stack = captureStackTrace();
    const stream = originalCreateReadStream!.call(fs, path, options);

    const info: FileHandleInfo = {
      path,
      stack,
      closed: false,
      type: 'readStream',
      handle: stream,
    };
    allHandles.add(info);

    // Track when stream closes
    stream.on('close', () => {
      info.closed = true;
    });

    return stream;
  };

  // Hook fs.createWriteStream
  fs.createWriteStream = function (
    path: fsType.PathLike,
    options?: any,
  ): fsType.WriteStream {
    const stack = captureStackTrace();
    const stream = originalCreateWriteStream!.call(fs, path, options);

    const info: FileHandleInfo = {
      path,
      stack,
      closed: false,
      type: 'writeStream',
      handle: stream,
    };
    allHandles.add(info);

    // Track when stream closes
    stream.on('close', () => {
      info.closed = true;
    });

    return stream;
  };

  // Hook fs.promises.open
  fsPromises.open = async function (
    path: fsType.PathLike,
    flags?: string | number,
    mode?: fsType.Mode,
  ): Promise<fsPromisesType.FileHandle> {
    const stack = captureStackTrace();
    const fileHandle = await originalPromisesOpen!.call(
      fsPromises,
      path,
      flags,
      mode,
    );

    const info: FileHandleInfo = {
      path,
      fd: fileHandle.fd,
      stack,
      closed: false,
      type: 'promiseHandle',
      handle: fileHandle,
    };
    allHandles.add(info);

    // Register with FinalizationRegistry
    finalizationRegistry.register(fileHandle, { info }, fileHandle);

    // Hook the close method
    const originalHandleClose = fileHandle.close.bind(fileHandle);
    fileHandle.close = async function (): Promise<void> {
      info.closed = true;
      finalizationRegistry.unregister(fileHandle);
      return originalHandleClose();
    };

    return fileHandle;
  };

  // Hook fs.watch
  fs.watch = function (
    filename: fsType.PathLike,
    ...args: any[]
  ): fsType.FSWatcher {
    const stack = captureStackTrace();
     
    const watcher = originalWatch!.call(fs, filename, ...(args));

    const info: FileHandleInfo = {
      path: filename,
      stack,
      closed: false,
      type: 'watch',
      handle: watcher,
    };
    allHandles.add(info);

    // Track when watcher closes
    watcher.on('close', () => {
      info.closed = true;
    });

    return watcher;
  };

  // Hook fs.watchFile
  fs.watchFile = function (
    filename: fsType.PathLike,
    ...args: any[]
  ): fsType.StatWatcher {
    const stack = captureStackTrace();
     
    const watcher = originalWatchFile!.call(fs, filename, ...(args));

    const info: FileHandleInfo = {
      path: filename,
      stack,
      closed: false,
      type: 'watchFile',
      handle: watcher,
    };
    allHandles.add(info);

    return watcher;
  };

  // Hook fs.unwatchFile
  fs.unwatchFile = function (filename: fsType.PathLike, listener?: any): void {
    // Mark matching handles as closed
    for (const info of allHandles) {
      if (info.type === 'watchFile' && info.path === filename && !info.closed) {
        info.closed = true;
      }
    }

    return originalUnwatchFile!.call(fs, filename, listener);
  };
}

/**
 * Creates a snapshot of all currently tracked file handles.
 * Returns counts by handle type and total count.
 *
 * @returns A snapshot of all tracked file handles, categorized by type.
 *
 * @example
 * ```typescript
 * trackFileHandles();
 * const fd = fs.openSync('test.txt', 'r');
 * const snapshot = snapshotFileHandles();
 * // snapshot = { open: 1, readStream: 0, writeStream: 0, promiseHandle: 0, watch: 0, watchFile: 0, total: 1 }
 * ```
 */
export function snapshotFileHandles(): FileHandlesSnapshot {
  const snapshot: FileHandlesSnapshot = {
    open: 0,
    readStream: 0,
    writeStream: 0,
    promiseHandle: 0,
    watch: 0,
    watchFile: 0,
    total: 0,
  };

  for (const info of allHandles) {
    if (!info.closed) {
      snapshot[info.type]++;
      snapshot.total++;
    }
  }

  return snapshot;
}

/**
 * Checks for file handle leaks by identifying handles that remain open.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only (e.g. `"File handle leaks detected: 3 open handle(s)"`)
 * - `"summary"`: List of leaked handles with counts by type
 * - `"details"`: Detailed output with stack traces showing where handles were opened
 *
 * @throws {Error} If file handle tracking is not set up. Call trackFileHandles() first.
 * @throws {Error} If file handle leaks are detected, with details about each leak.
 *
 * @remarks Restores original fs module functions and clears tracking state.
 *
 * @example
 * ```typescript
 * trackFileHandles();
 * const fd = fs.openSync('test.txt', 'r');
 * // ... later ...
 * await checkFileHandles({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkFileHandles(options?: {
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
      'File handle leak detection not set up. Call trackFileHandles() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
  }

  // Restore original functions
  fs.open = originalOpen!;
  fs.close = originalClose!;
  fs.createReadStream = originalCreateReadStream!;
  fs.createWriteStream = originalCreateWriteStream!;
  fsPromises.open = originalPromisesOpen!;
  fs.watch = originalWatch!;
  fs.watchFile = originalWatchFile!;
  fs.unwatchFile = originalUnwatchFile!;

  originalOpen = null;
  originalClose = null;
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

  // Clear tracking state
  allHandles.clear();
  handleCount = 0;

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Formats leak message in short format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(): string {
  let totalLeaked = 0;

  for (const info of allHandles) {
    if (!info.closed) {
      totalLeaked++;
    }
  }

  if (totalLeaked === 0) {
    return '';
  }

  return `File handle leaks detected: ${totalLeaked} open handle(s)`;
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const lines: string[] = [];
  const leaksByType: Record<string, number> = {};

  for (const info of allHandles) {
    if (!info.closed) {
      const currentCount = leaksByType[info.type];
      leaksByType[info.type] =
        (currentCount !== undefined ? currentCount : 0) + 1;
    }
  }

  const totalLeaked = Object.values(leaksByType).reduce((a, b) => a + b, 0);

  if (totalLeaked === 0) {
    return '';
  }

  lines.push('File handle leaks detected:');
  for (const [type, count] of Object.entries(leaksByType)) {
    lines.push(`  ${type}: ${count} leaked`);
  }

  return lines.join('\n');
}

/**
 * Formats leak message in details format with stack traces.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatDetailsMessage(): string {
  const lines: string[] = [];
  const leakedHandles: FileHandleInfo[] = [];

  for (const info of allHandles) {
    if (!info.closed) {
      leakedHandles.push(info);
    }
  }

  if (leakedHandles.length === 0) {
    return '';
  }

  lines.push('File handle leaks detected:');

  // Group by type
  const groupedByType: Record<string, FileHandleInfo[]> = {};
  for (const info of leakedHandles) {
    if (groupedByType[info.type] === undefined) {
      groupedByType[info.type] = [];
    }
    groupedByType[info.type].push(info);
  }

  for (const [type, handles] of Object.entries(groupedByType)) {
    lines.push(`  ${type}: ${handles.length} leaked`);
    for (const info of handles) {
      const pathStr =
        typeof info.path === 'string'
          ? info.path
          : info.path instanceof Buffer
            ? info.path.toString()
            : info.path.toString();

      const formattedStack = formatStackTrace(info.stack);
      if (formattedStack !== '') {
        lines.push(`    * '${pathStr}' opened at ${formattedStack}`);
      } else {
        lines.push(`    * '${pathStr}'`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Convenience object providing access to file handle leak detection functions.
 *
 * @property track - Starts tracking file handles. See {@link trackFileHandles}.
 * @property snapshot - Creates a snapshot of current file handles. See {@link snapshotFileHandles}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkFileHandles}.
 */
export const fileHandles = {
  track: trackFileHandles,
  snapshot: snapshotFileHandles,
  check: checkFileHandles,
};
