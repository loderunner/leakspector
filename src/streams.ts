/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/strict-boolean-expressions */

import { EventEmitter } from 'node:events';
import { Duplex, Readable, Transform, Writable } from 'node:stream';

import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

type StreamType = 'Readable' | 'Writable' | 'Transform' | 'Duplex';

type BufferState = {
  readableBufferLength: number;
  writableBufferedCount: number;
  isPaused: boolean;
  isFlowing: boolean;
};

type PipeInfo = {
  source: NodeJS.ReadableStream;
  destination: NodeJS.WritableStream;
  stack: string;
};

type StreamInfo = {
  stream: NodeJS.ReadableStream | NodeJS.WritableStream;
  type: StreamType;
  stack: string;
  destroyed: boolean;
  initialBufferState: BufferState;
  gcCycles: number;
  pipes: PipeInfo[];
};

const trackedStreams = new Map<
  NodeJS.ReadableStream | NodeJS.WritableStream,
  StreamInfo
>();
const finalizationRegistry = new FinalizationRegistry<{
  stream: NodeJS.ReadableStream | NodeJS.WritableStream;
}>((heldValue) => {
  const streamInfo = trackedStreams.get(heldValue.stream);
  if (streamInfo !== undefined) {
    trackedStreams.delete(heldValue.stream);
  }
});

let originalReadableConstructor: typeof Readable | null = null;
let originalReadablePipe: typeof Readable.prototype.pipe | null = null;
let originalReadableDestroy: typeof Readable.prototype.destroy | undefined =
  undefined;
let originalReadableConstruct:
  | typeof Readable.prototype._construct
  | undefined = undefined;
let originalWritableConstruct:
  | typeof Writable.prototype._construct
  | undefined = undefined;
let originalDuplexConstruct: typeof Duplex.prototype._construct | undefined =
  undefined;
let originalTransformConstruct:
  | typeof Transform.prototype._construct
  | undefined = undefined;

/**
 * Gets the type of a stream instance.
 *
 * @param stream - The stream to identify.
 * @returns The stream type.
 */
function getStreamType(
  stream: NodeJS.ReadableStream | NodeJS.WritableStream,
): StreamType {
  if (stream instanceof Transform) {
    return 'Transform';
  }
  if (stream instanceof Duplex) {
    return 'Duplex';
  }
  if (stream instanceof Readable) {
    return 'Readable';
  }
  if (stream instanceof Writable) {
    return 'Writable';
  }
  return 'Readable';
}

/**
 * Captures the current buffer state of a stream.
 *
 * @param stream - The stream to inspect.
 * @returns The buffer state.
 */
function captureBufferState(
  stream: NodeJS.ReadableStream | NodeJS.WritableStream,
): BufferState {
  const state: BufferState = {
    readableBufferLength: 0,
    writableBufferedCount: 0,
    isPaused: false,
    isFlowing: false,
  };

  try {
    // Check readable state
    if ('_readableState' in stream) {
      const readableState = (stream as any)._readableState;
      if (readableState !== undefined && readableState !== null) {
        // Check buffer length
        if (
          readableState.buffer !== undefined &&
          readableState.buffer !== null
        ) {
          state.readableBufferLength = readableState.buffer.length ?? 0;
        }
        // Check flowing state
        if (readableState.flowing !== undefined) {
          state.isFlowing = readableState.flowing === true;
          state.isPaused = readableState.flowing === false;
        }
      }
    }

    // Check writable state
    if ('_writableState' in stream) {
      const writableState = (stream as any)._writableState;
      if (writableState !== undefined && writableState !== null) {
        // Check buffered request count
        if (writableState.bufferedRequestCount !== undefined) {
          state.writableBufferedCount = writableState.bufferedRequestCount ?? 0;
        }
      }
    }
  } catch {
    // Property access might fail, return default state
  }

  return state;
}

/**
 * Registers a stream for tracking.
 *
 * @param stream - The stream to track.
 */
function registerStream(
  stream: NodeJS.ReadableStream | NodeJS.WritableStream,
): void {
  if (trackedStreams.has(stream)) {
    return;
  }

  const stack = captureStackTrace();
  const type = getStreamType(stream);
  const initialBufferState = captureBufferState(stream);

  const streamInfo: StreamInfo = {
    stream,
    type,
    stack,
    destroyed: false,
    initialBufferState,
    gcCycles: 0,
    pipes: [],
  };

  trackedStreams.set(stream, streamInfo);

  // Register for finalization to detect when stream is garbage collected
  finalizationRegistry.register(stream, { stream }, stream);

  // Track 'close' and 'end' events as indicators of proper cleanup
  // Note: destroy marking is handled by the global destroy patch in trackStreams()
  if ('on' in stream && typeof stream.on === 'function') {
    stream.on('close', () => {
      const info = trackedStreams.get(stream);
      if (info !== undefined) {
        info.destroyed = true;
      }
    });

    if ('_readableState' in stream) {
      stream.on('end', () => {
        const info = trackedStreams.get(stream);
        if (info !== undefined) {
          info.destroyed = true;
        }
      });
    }
  }
}

/**
 * Starts tracking stream instances and their lifecycle.
 * Patches Readable, Writable, Transform, and Duplex constructors.
 *
 * @throws {Error} If stream tracking is already set up. Call checkStreams() first.
 *
 * @example
 * ```typescript
 * trackStreams();
 * const readable = new Readable();
 * // Stream will be tracked
 * ```
 */
export function trackStreams(): void {
  if (originalReadableConstructor !== null) {
    throw new Error(
      'Stream leak detection already set up. Call checkStreams() first.',
    );
  }

  // Save original constructor marker
  originalReadableConstructor = Readable;
  originalReadablePipe = Readable.prototype.pipe;

  // Patch EventEmitter.init to catch all streams at construction
  const originalEEInit = (EventEmitter.prototype as any).init;
  originalReadableConstruct = originalEEInit;

  if (originalEEInit) {
    (EventEmitter.prototype as any).init = function (
      this: any,
      ...args: any[]
    ) {
      const result = originalEEInit.apply(this, args);
      // Check if this is a stream instance
      if (this instanceof Readable || this instanceof Writable) {
        if (!trackedStreams.has(this)) {
          registerStream(this);
        }
      }
      return result;
    };
  }

  // Also patch key stream methods as fallback
  const originalReadablePush = Readable.prototype.push;
  const originalWritableWrite = Writable.prototype.write;
  const originalReadableRead = Readable.prototype.read;

  originalWritableConstruct = originalWritableWrite;
  originalDuplexConstruct = originalReadableRead;
  originalTransformConstruct = originalReadablePush;

  // Helper to ensure stream is registered
  function ensureRegistered(stream: any) {
    if (!trackedStreams.has(stream)) {
      registerStream(stream);
    }
  }

  // Patch Readable.push
  Readable.prototype.push = function (this: Readable, ...args: any[]) {
    ensureRegistered(this);
    return originalReadablePush.apply(this, args);
  };

  // Patch Writable.write
  Writable.prototype.write = function (this: Writable, ...args: any[]) {
    ensureRegistered(this);
    return originalWritableWrite.apply(this, args);
  };

  // Patch Readable.read
  Readable.prototype.read = function (this: Readable, ...args: any[]) {
    ensureRegistered(this);
    return originalReadableRead.apply(this, args);
  };

  // Patch destroy to ensure all streams are eventually tracked and marked as destroyed
  originalReadableDestroy = Readable.prototype.destroy;
  Readable.prototype.destroy = function (this: Readable, ...args: any[]) {
    ensureRegistered(this);
    const info = trackedStreams.get(this);
    if (info !== undefined) {
      info.destroyed = true;
    }
    return originalReadableDestroy!.apply(this, args);
  };

  // Patch pipe method to track pipe chains
  Readable.prototype.pipe = function <T extends NodeJS.WritableStream>(
    this: Readable,
    destination: T,
    options?: { end?: boolean },
  ): T {
    ensureRegistered(this);
    const stack = captureStackTrace();
    const sourceInfo = trackedStreams.get(this);
    if (sourceInfo !== undefined) {
      sourceInfo.pipes.push({
        source: this,
        destination,
        stack,
      });
    }

    // Register destination if not already tracked
    if (!trackedStreams.has(destination)) {
      registerStream(destination);
    }

    return originalReadablePipe!.call(this, destination, options);
  };
}

export type StreamsSnapshot = {
  total: number;
  byType: Record<StreamType, number>;
  destroyed: number;
  active: number;
};

/**
 * Creates a snapshot of all currently tracked streams.
 * Returns counts by type and destruction state.
 *
 * @returns A snapshot of tracked streams.
 *
 * @example
 * ```typescript
 * trackStreams();
 * const readable = new Readable();
 * const snapshot = snapshotStreams();
 * // snapshot = { total: 1, byType: { Readable: 1, ... }, destroyed: 0, active: 1 }
 * ```
 */
export function snapshotStreams(): StreamsSnapshot {
  const snapshot: StreamsSnapshot = {
    total: trackedStreams.size,
    byType: {
      Readable: 0,
      Writable: 0,
      Transform: 0,
      Duplex: 0,
    },
    destroyed: 0,
    active: 0,
  };

  for (const streamInfo of trackedStreams.values()) {
    snapshot.byType[streamInfo.type]++;
    if (streamInfo.destroyed) {
      snapshot.destroyed++;
    } else {
      snapshot.active++;
    }
  }

  return snapshot;
}

/**
 * Increments the GC cycle counter for all tracked streams.
 * Used internally to track streams persisting across multiple GC cycles.
 */
function incrementGCCycles(): void {
  for (const streamInfo of trackedStreams.values()) {
    if (!streamInfo.destroyed) {
      streamInfo.gcCycles++;
    }
  }
}

/**
 * Detects streams with growing buffers.
 *
 * @returns Array of stream info objects with buffer growth detected.
 */
function detectBufferGrowth(): StreamInfo[] {
  const growingStreams: StreamInfo[] = [];

  for (const streamInfo of trackedStreams.values()) {
    if (streamInfo.destroyed) {
      continue;
    }

    const currentState = captureBufferState(streamInfo.stream);

    // Check for buffer growth
    const readableGrowth =
      currentState.readableBufferLength >
      streamInfo.initialBufferState.readableBufferLength;
    const writableGrowth =
      currentState.writableBufferedCount >
      streamInfo.initialBufferState.writableBufferedCount;

    if (
      (readableGrowth &&
        currentState.readableBufferLength >
          streamInfo.initialBufferState.readableBufferLength + 10) ||
      (writableGrowth &&
        currentState.writableBufferedCount >
          streamInfo.initialBufferState.writableBufferedCount + 10)
    ) {
      growingStreams.push(streamInfo);
    }
  }

  return growingStreams;
}

/**
 * Detects broken pipe chains where upstream continues writing but downstream has errored.
 *
 * @returns Array of pipe info objects for broken pipes.
 */
function detectBrokenPipes(): Array<{
  pipeInfo: PipeInfo;
  sourceInfo: StreamInfo;
}> {
  const brokenPipes: Array<{ pipeInfo: PipeInfo; sourceInfo: StreamInfo }> = [];

  for (const streamInfo of trackedStreams.values()) {
    if (streamInfo.pipes.length === 0) {
      continue;
    }

    for (const pipeInfo of streamInfo.pipes) {
      // Check if destination is destroyed but source is still active
      const destInfo = trackedStreams.get(pipeInfo.destination);
      if (
        destInfo !== undefined &&
        destInfo.destroyed &&
        !streamInfo.destroyed
      ) {
        brokenPipes.push({ pipeInfo, sourceInfo: streamInfo });
      }

      // Check if destination has errored
      try {
        if (
          'destroyed' in pipeInfo.destination &&
          pipeInfo.destination.destroyed === true &&
          !streamInfo.destroyed
        ) {
          brokenPipes.push({ pipeInfo, sourceInfo: streamInfo });
        }
      } catch {
        // Property access might fail
      }
    }
  }

  return brokenPipes;
}

/**
 * Formats leak message in short format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(): string {
  const leakedStreams: StreamInfo[] = [];

  for (const streamInfo of trackedStreams.values()) {
    if (!streamInfo.destroyed) {
      leakedStreams.push(streamInfo);
    }
  }

  if (leakedStreams.length === 0) {
    return '';
  }

  return `Stream leaks detected: ${leakedStreams.length} leaked stream(s)`;
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const lines: string[] = [];
  const leakedStreams: StreamInfo[] = [];
  const growingStreams = detectBufferGrowth();
  const brokenPipes = detectBrokenPipes();

  for (const streamInfo of trackedStreams.values()) {
    if (!streamInfo.destroyed) {
      leakedStreams.push(streamInfo);
    }
  }

  if (
    leakedStreams.length === 0 &&
    growingStreams.length === 0 &&
    brokenPipes.length === 0
  ) {
    return '';
  }

  if (leakedStreams.length > 0) {
    lines.push('Stream leaks detected:');
    for (const streamInfo of leakedStreams) {
      const formattedStack = formatStackTrace(streamInfo.stack, ['streams.ts']);
      const cycleInfo =
        streamInfo.gcCycles > 0
          ? ` (survived ${streamInfo.gcCycles} GC cycles)`
          : '';
      if (formattedStack !== '') {
        lines.push(`  ${streamInfo.type} ${formattedStack}${cycleInfo}`);
      } else {
        lines.push(`  ${streamInfo.type}${cycleInfo}`);
      }
    }
  }

  if (growingStreams.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Streams with growing buffers detected:');
    for (const streamInfo of growingStreams) {
      const currentState = captureBufferState(streamInfo.stream);
      const formattedStack = formatStackTrace(streamInfo.stack, ['streams.ts']);
      const bufferInfo = [];
      if (
        currentState.readableBufferLength >
        streamInfo.initialBufferState.readableBufferLength
      ) {
        bufferInfo.push(
          `readable buffer: ${streamInfo.initialBufferState.readableBufferLength} -> ${currentState.readableBufferLength}`,
        );
      }
      if (
        currentState.writableBufferedCount >
        streamInfo.initialBufferState.writableBufferedCount
      ) {
        bufferInfo.push(
          `writable buffered: ${streamInfo.initialBufferState.writableBufferedCount} -> ${currentState.writableBufferedCount}`,
        );
      }
      if (formattedStack !== '') {
        lines.push(
          `  ${streamInfo.type} ${formattedStack} (${bufferInfo.join(', ')})`,
        );
      } else {
        lines.push(`  ${streamInfo.type} (${bufferInfo.join(', ')})`);
      }
    }
  }

  if (brokenPipes.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Broken pipe chains detected:');
    for (const { pipeInfo, sourceInfo } of brokenPipes) {
      const formattedStack = formatStackTrace(pipeInfo.stack, ['streams.ts']);
      if (formattedStack !== '') {
        lines.push(
          `  ${sourceInfo.type} -> (destroyed destination) ${formattedStack}`,
        );
      } else {
        lines.push(`  ${sourceInfo.type} -> (destroyed destination)`);
      }
    }
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
  const leakedStreams: StreamInfo[] = [];
  const growingStreams = detectBufferGrowth();
  const brokenPipes = detectBrokenPipes();

  for (const streamInfo of trackedStreams.values()) {
    if (!streamInfo.destroyed) {
      leakedStreams.push(streamInfo);
    }
  }

  if (
    leakedStreams.length === 0 &&
    growingStreams.length === 0 &&
    brokenPipes.length === 0
  ) {
    return '';
  }

  if (leakedStreams.length > 0) {
    lines.push('Stream leaks detected:');
    for (const streamInfo of leakedStreams) {
      const currentState = captureBufferState(streamInfo.stream);
      const formattedStack = formatStackTrace(streamInfo.stack, ['streams.ts']);
      const cycleInfo =
        streamInfo.gcCycles > 0
          ? ` (survived ${streamInfo.gcCycles} GC cycles)`
          : '';

      lines.push(`  ${streamInfo.type}${cycleInfo}`);
      if (formattedStack !== '') {
        lines.push(`    Created at: ${formattedStack}`);
      }
      lines.push(
        `    State: ${currentState.isPaused ? 'paused' : currentState.isFlowing ? 'flowing' : 'initial'}`,
      );
      if (currentState.readableBufferLength > 0) {
        lines.push(
          `    Readable buffer: ${currentState.readableBufferLength} items`,
        );
      }
      if (currentState.writableBufferedCount > 0) {
        lines.push(
          `    Writable buffered: ${currentState.writableBufferedCount} requests`,
        );
      }
    }
  }

  if (growingStreams.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Streams with growing buffers detected:');
    for (const streamInfo of growingStreams) {
      const currentState = captureBufferState(streamInfo.stream);
      const formattedStack = formatStackTrace(streamInfo.stack, ['streams.ts']);

      lines.push(`  ${streamInfo.type}`);
      if (formattedStack !== '') {
        lines.push(`    Created at: ${formattedStack}`);
      }
      if (
        currentState.readableBufferLength >
        streamInfo.initialBufferState.readableBufferLength
      ) {
        lines.push(
          `    Readable buffer grew: ${streamInfo.initialBufferState.readableBufferLength} -> ${currentState.readableBufferLength}`,
        );
      }
      if (
        currentState.writableBufferedCount >
        streamInfo.initialBufferState.writableBufferedCount
      ) {
        lines.push(
          `    Writable buffered grew: ${streamInfo.initialBufferState.writableBufferedCount} -> ${currentState.writableBufferedCount}`,
        );
      }
    }
  }

  if (brokenPipes.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Broken pipe chains detected:');
    for (const { pipeInfo, sourceInfo } of brokenPipes) {
      const formattedPipeStack = formatStackTrace(pipeInfo.stack, [
        'streams.ts',
      ]);
      const formattedSourceStack = formatStackTrace(sourceInfo.stack, [
        'streams.ts',
      ]);

      lines.push(`  ${sourceInfo.type} piped to destroyed destination`);
      if (formattedSourceStack !== '') {
        lines.push(`    Source created at: ${formattedSourceStack}`);
      }
      if (formattedPipeStack !== '') {
        lines.push(`    Pipe created at: ${formattedPipeStack}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Checks for stream leaks by examining which streams have not been destroyed.
 * Also detects streams with growing buffers and broken pipe chains.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking. Defaults to true if --expose-gc is available.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to "summary".
 * - `"short"`: Terse count only
 * - `"summary"`: List of leaked streams with counts and buffer growth
 * - `"details"`: Detailed output with stack traces and internal state
 *
 * @throws {Error} If stream tracking is not set up. Call trackStreams() first.
 * @throws {Error} If stream leaks are detected and throwOnLeaks is true.
 *
 * @remarks Restores original stream constructors and clears tracking state.
 *
 * @example
 * ```typescript
 * trackStreams();
 * const readable = new Readable();
 * // ... later ...
 * await checkStreams({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkStreams(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
}): Promise<void> {
  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
  } = options ?? {};

  if (originalReadableConstructor === null) {
    throw new Error(
      'Stream leak detection not set up. Call trackStreams() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
    incrementGCCycles();
  }

  // Restore original prototypes
  if (originalReadablePipe !== null) {
    Readable.prototype.pipe = originalReadablePipe;
  }
  if (originalReadableDestroy !== undefined) {
    Readable.prototype.destroy = originalReadableDestroy;
  }
  if (originalReadableConstruct !== undefined) {
    (EventEmitter.prototype as any).init = originalReadableConstruct;
  }
  if (originalWritableConstruct !== undefined) {
    Writable.prototype.write = originalWritableConstruct as any;
  }
  if (originalDuplexConstruct !== undefined) {
    Readable.prototype.read = originalDuplexConstruct as any;
  }
  if (originalTransformConstruct !== undefined) {
    Readable.prototype.push = originalTransformConstruct as any;
  }

  // Clear references
  originalReadableConstructor = null;
  originalReadablePipe = null;
  originalReadableDestroy = undefined;
  originalReadableConstruct = undefined;
  originalWritableConstruct = undefined;
  originalDuplexConstruct = undefined;
  originalTransformConstruct = undefined;

  let message: string;
  if (format === 'short') {
    message = formatShortMessage();
  } else if (format === 'details') {
    message = formatDetailsMessage();
  } else {
    message = formatSummaryMessage();
  }

  trackedStreams.clear();

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Convenience object providing access to stream leak detection functions.
 *
 * @property track - Starts tracking streams. See {@link trackStreams}.
 * @property snapshot - Creates a snapshot of current streams. See {@link snapshotStreams}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkStreams}.
 */
export const streams = {
  track: trackStreams,
  snapshot: snapshotStreams,
  check: checkStreams,
};
