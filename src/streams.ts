import {
  Duplex,
  Readable,
  Stream,
  Transform,
  Writable,
} from 'node:stream';

import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

type StreamType = 'Readable' | 'Writable' | 'Transform' | 'Duplex';

type StreamState = {
  id: string;
  type: StreamType;
  creationStack: string;
  destroyed: boolean;
  gcCyclesSurvived: number;
  bufferSnapshots: Array<{
    readableBufferLength?: number;
    writableBufferedRequestCount?: number;
    readableFlowing: boolean | null;
    readablePaused: boolean | null;
    timestamp: number;
  }>;
  lastSnapshotTime: number;
  pipedTo: Set<Stream>; // Use Set instead of WeakSet to track count
  pipedFrom: Stream | null;
  downstreamErrored: boolean;
  upstreamErrored: boolean;
};

const trackedStreams = new WeakMap<Stream, StreamState>();
const allStreams = new Set<Stream>(); // Maintain explicit references for iteration
let streamIdCounter = 0;
const streamIds = new WeakMap<Stream, string>();

let originalReadableConstructor: typeof Readable | null = null;
let originalWritableConstructor: typeof Writable | null = null;
let originalTransformConstructor: typeof Transform | null = null;
let originalDuplexConstructor: typeof Duplex | null = null;
let originalPipe: typeof Readable.prototype.pipe | null = null;
let originalDestroy: typeof Stream.prototype.destroy | null = null;

let gcCycleCount = 0;

/**
 * Gets a unique identifier for a stream instance.
 */
function getStreamId(stream: Stream): string {
  const existing = streamIds.get(stream);
  if (existing !== undefined) {
    return existing;
  }

  const type = getStreamType(stream);
  streamIdCounter++;
  const id = `${type}#${streamIdCounter}`;
  streamIds.set(stream, id);
  return id;
}

/**
 * Determines the type of a stream.
 */
function getStreamType(stream: Stream): StreamType {
  if (stream instanceof Readable && stream instanceof Writable) {
    if (stream instanceof Transform) {
      return 'Transform';
    }
    return 'Duplex';
  }
  if (stream instanceof Readable) {
    return 'Readable';
  }
  if (stream instanceof Writable) {
    return 'Writable';
  }
  return 'Readable'; // Default fallback
}

/**
 * Captures the current internal state of a stream.
 */
function captureStreamState(stream: Stream): StreamState['bufferSnapshots'][0] {
  const snapshot: StreamState['bufferSnapshots'][0] = {
    timestamp: Date.now(),
  };

  // Capture readable state
  if (stream instanceof Readable) {
    const readableState = (stream as any)._readableState;
    if (readableState !== undefined) {
      snapshot.readableBufferLength =
        readableState.buffer?.length ?? readableState.length ?? 0;
      snapshot.readableFlowing = readableState.flowing ?? null;
      snapshot.readablePaused = readableState.paused ?? null;
    }
  }

  // Capture writable state
  if (stream instanceof Writable) {
    const writableState = (stream as any)._writableState;
    if (writableState !== undefined) {
      snapshot.writableBufferedRequestCount =
        writableState.bufferedRequestCount ?? 0;
    }
  }

  return snapshot;
}

/**
 * Checks if a stream has growing buffers.
 */
function hasGrowingBuffers(state: StreamState): boolean {
  if (state.bufferSnapshots.length < 2) {
    return false;
  }

  const snapshots = state.bufferSnapshots;
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];

  const readableGrowth =
    (first.readableBufferLength ?? 0) < (last.readableBufferLength ?? 0);
  const writableGrowth =
    (first.writableBufferedRequestCount ?? 0) <
    (last.writableBufferedRequestCount ?? 0);

  return readableGrowth || writableGrowth;
}

/**
 * Checks if a stream is stuck in a problematic state.
 */
function isStuckInProblematicState(state: StreamState): boolean {
  if (state.bufferSnapshots.length === 0) {
    return false;
  }

  const last = state.bufferSnapshots[state.bufferSnapshots.length - 1];

  // Check if readable stream is stuck in paused or flowing state indefinitely
  if (
    last.readableFlowing !== null &&
    state.bufferSnapshots.length >= 2
  ) {
    // If it's been in the same flowing state for multiple snapshots, it might be stuck
    const allSameFlowingState = state.bufferSnapshots.every(
      (s) => s.readableFlowing === last.readableFlowing,
    );
    if (allSameFlowingState && state.gcCyclesSurvived >= 2) {
      return true;
    }
  }

  return false;
}

/**
 * Starts tracking stream lifecycle and internal buffer growth.
 * Must be called before creating streams to track.
 *
 * @throws {Error} If leak detection is already set up. Call checkStreams() first.
 *
 * @remarks Patches stream constructors and methods to monitor stream creation, destruction, and internal state.
 *
 * @example
 * ```typescript
 * trackStreams();
 * const stream = new Readable(); // This will be tracked
 * ```
 */
export function trackStreams(): void {
  if (originalReadableConstructor !== null) {
    throw new Error(
      'Stream leak detection already set up. Call checkStreams() first.',
    );
  }

  gcCycleCount = 0;
  streamIdCounter = 0;

  // Store original constructors and methods
  originalReadableConstructor = Readable;
  originalWritableConstructor = Writable;
  originalTransformConstructor = Transform;
  originalDuplexConstructor = Duplex;
  originalPipe = Readable.prototype.pipe;
  originalDestroy = Stream.prototype.destroy;

  // Wrap constructors with Proxy to intercept `new Readable()` calls
  // This works by creating a Proxy that intercepts the construct trap
  const wrapConstructor = <T extends typeof Stream>(
    Original: T,
    type: StreamType,
  ): T => {
    return new Proxy(Original, {
      construct(target, args) {
        const instance = Reflect.construct(target, args);
        initializeStreamTracking(instance, type);
        return instance;
      },
      get(target, prop) {
        return Reflect.get(target, prop);
      },
    }) as T;
  };

  // Replace constructors in the stream module cache (CommonJS)
  try {
    const streamModule = require.cache
      ? require.cache[require.resolve('node:stream')]
      : null;
    if (streamModule !== null && streamModule.exports !== undefined) {
      streamModule.exports.Readable = wrapConstructor(Readable, 'Readable');
      streamModule.exports.Writable = wrapConstructor(Writable, 'Writable');
      streamModule.exports.Transform = wrapConstructor(Transform, 'Transform');
      streamModule.exports.Duplex = wrapConstructor(Duplex, 'Duplex');
    }
  } catch {
    // require.cache not available (ES modules) - will patch prototypes instead
  }

  // Store original prototype constructors for restoration
  const originalReadableProtoConstructor = Readable.prototype.constructor;
  const originalWritableProtoConstructor = Writable.prototype.constructor;
  const originalTransformProtoConstructor = Transform.prototype.constructor;
  const originalDuplexProtoConstructor = Duplex.prototype.constructor;

  // Patch the constructors by replacing them with Proxies
  // Note: This only works for streams created after tracking starts
  // Users should call trackStreams() before importing/creating streams
  // We'll store the wrapped versions but can't replace the imported bindings directly
  // Instead, we'll patch the prototype.constructor to intercept instance creation
  const patchPrototypeConstructor = (
    Proto: any,
    OriginalConstructor: any,
    type: StreamType,
  ): void => {
    Proto.constructor = new Proxy(OriginalConstructor, {
      construct(target, args) {
        const instance = Reflect.construct(target, args);
        initializeStreamTracking(instance, type);
        return instance;
      },
    });
  };

  patchPrototypeConstructor(
    Readable.prototype,
    originalReadableProtoConstructor,
    'Readable',
  );
  patchPrototypeConstructor(
    Writable.prototype,
    originalWritableProtoConstructor,
    'Writable',
  );
  patchPrototypeConstructor(
    Transform.prototype,
    originalTransformProtoConstructor,
    'Transform',
  );
  patchPrototypeConstructor(
    Duplex.prototype,
    originalDuplexProtoConstructor,
    'Duplex',
  );

  // Patch pipe method to track pipe relationships
  Readable.prototype.pipe = function (
    this: Readable,
    destination: Writable,
    options?: any,
  ): Writable {
    const result = originalPipe!.call(this, destination, options);

    // Track pipe relationship
    const sourceState = trackedStreams.get(this);
    const destState = trackedStreams.get(destination);

    if (sourceState !== undefined) {
      sourceState.pipedTo.add(destination);
    }

    if (destState !== undefined) {
      destState.pipedFrom = this;
    }

    // Monitor for broken pipes (downstream error)
    destination.once('error', () => {
      if (destState !== undefined) {
        destState.downstreamErrored = true;
      }
    });

    this.once('error', () => {
      if (sourceState !== undefined) {
        sourceState.upstreamErrored = true;
      }
    });

    return result;
  };

  // Patch destroy method
  Stream.prototype.destroy = function (this: Stream, error?: Error): Stream {
    const state = trackedStreams.get(this);
    if (state !== undefined) {
      state.destroyed = true;
    }
    return originalDestroy!.call(this, error);
  };
}

/**
 * Initializes tracking for a newly created stream.
 */
function initializeStreamTracking(stream: Stream, type: StreamType): void {
  const id = getStreamId(stream);
  const creationStack = captureStackTrace();

  const state: StreamState = {
    id,
    type,
    creationStack,
    destroyed: false,
    gcCyclesSurvived: 0,
    bufferSnapshots: [captureStreamState(stream)],
    lastSnapshotTime: Date.now(),
    pipedTo: new Set(),
    pipedFrom: null,
    downstreamErrored: false,
    upstreamErrored: false,
  };

  trackedStreams.set(stream, state);
  allStreams.add(stream);

  // Capture initial state (already done above, but ensure we have at least one)
  if (state.bufferSnapshots.length === 0) {
    state.bufferSnapshots.push(captureStreamState(stream));
  }
}

/**
 * Updates buffer snapshots for all tracked streams.
 */
function updateBufferSnapshots(): void {
  for (const stream of allStreams) {
    const state = trackedStreams.get(stream);
    if (state !== undefined && !state.destroyed) {
      state.bufferSnapshots.push(captureStreamState(stream));
      // Keep only last 10 snapshots to avoid memory growth
      if (state.bufferSnapshots.length > 10) {
        state.bufferSnapshots.shift();
      }
    }
  }
}

/**
 * Snapshot of stream state.
 */
export type StreamsSnapshot = {
  total: number;
  byType: Record<StreamType, number>;
  destroyed: number;
  withGrowingBuffers: number;
  stuckInProblematicState: number;
  brokenPipes: number;
};

/**
 * Creates a snapshot of all currently tracked streams.
 *
 * @returns A snapshot of stream statistics.
 *
 * @example
 * ```typescript
 * trackStreams();
 * const stream = new Readable();
 * const snapshot = snapshotStreams();
 * // snapshot = { total: 1, byType: { Readable: 1, Writable: 0, Transform: 0, Duplex: 0 }, ... }
 * ```
 */
export function snapshotStreams(): StreamsSnapshot {
  const snapshot: StreamsSnapshot = {
    total: 0,
    byType: {
      Readable: 0,
      Writable: 0,
      Transform: 0,
      Duplex: 0,
    },
    destroyed: 0,
    withGrowingBuffers: 0,
    stuckInProblematicState: 0,
    brokenPipes: 0,
  };

  for (const stream of allStreams) {
    const state = trackedStreams.get(stream);
    if (state === undefined) {
      continue;
    }

    snapshot.total++;
    snapshot.byType[state.type]++;

    if (state.destroyed) {
      snapshot.destroyed++;
    }

    if (hasGrowingBuffers(state)) {
      snapshot.withGrowingBuffers++;
    }

    if (isStuckInProblematicState(state)) {
      snapshot.stuckInProblematicState++;
    }

    if (
      (state.downstreamErrored && state.pipedFrom !== null) ||
      (state.upstreamErrored && state.pipedTo.size > 0)
    ) {
      snapshot.brokenPipes++;
    }
  }

  return snapshot;
}

/**
 * Collects all currently tracked streams that are still reachable and have leaks.
 */
function collectLeakedStreams(): StreamState[] {
  const leaked: StreamState[] = [];

  for (const stream of allStreams) {
    const state = trackedStreams.get(stream);
    if (state === undefined) {
      continue;
    }

    // Consider a stream leaked if:
    // 1. Not destroyed AND survived at least one GC cycle
    // 2. Has growing buffers
    // 3. Stuck in problematic state
    // 4. Part of a broken pipe chain
    const isLeaked =
      (!state.destroyed && state.gcCyclesSurvived >= 1) ||
      hasGrowingBuffers(state) ||
      isStuckInProblematicState(state) ||
      (state.downstreamErrored && state.pipedFrom !== null) ||
      (state.upstreamErrored && state.pipedTo.size > 0);

    if (isLeaked) {
      leaked.push(state);
    }
  }

  return leaked;
}

/**
 * Formats leak message in short format.
 */
function formatShortMessage(leakedStreams: Array<StreamState>): string {
  if (leakedStreams.length === 0) {
    return '';
  }

  return `Stream leaks detected: ${leakedStreams.length} leaked stream(s)`;
}

/**
 * Formats leak message in summary format.
 */
function formatSummaryMessage(leakedStreams: Array<StreamState>): string {
  if (leakedStreams.length === 0) {
    return '';
  }

  const lines: string[] = ['Stream leaks detected:'];

  for (const state of leakedStreams) {
    const issues: string[] = [];

    if (!state.destroyed) {
      issues.push('not destroyed');
    }

    if (hasGrowingBuffers(state)) {
      issues.push('growing buffers');
    }

    if (isStuckInProblematicState(state)) {
      issues.push('stuck in problematic state');
    }

    if (state.downstreamErrored && state.pipedFrom !== null) {
      issues.push('broken pipe (downstream errored)');
    }

    if (state.upstreamErrored && state.pipedTo.size > 0) {
      issues.push('broken pipe (upstream errored)');
    }

    const issueStr = issues.length > 0 ? ` (${issues.join(', ')})` : '';
    const formattedStack = formatStackTrace(state.creationStack);
    if (formattedStack !== '') {
      lines.push(`  ${state.id}${issueStr} ${formattedStack}`);
    } else {
      lines.push(`  ${state.id}${issueStr}`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats leak message in details format with stack traces.
 */
function formatDetailsMessage(leakedStreams: Array<StreamState>): string {
  if (leakedStreams.length === 0) {
    return '';
  }

  const lines: string[] = ['Stream leaks detected:'];

  for (const state of leakedStreams) {
    lines.push(`  ${state.id}`);

    const issues: string[] = [];

    if (!state.destroyed) {
      issues.push('not destroyed');
    }

    if (hasGrowingBuffers(state)) {
      const first = state.bufferSnapshots[0];
      const last = state.bufferSnapshots[state.bufferSnapshots.length - 1];
      issues.push(
        `growing buffers (readable: ${first.readableBufferLength ?? 0} -> ${last.readableBufferLength ?? 0}, writable: ${first.writableBufferedRequestCount ?? 0} -> ${last.writableBufferedRequestCount ?? 0})`,
      );
    }

    if (isStuckInProblematicState(state)) {
      const last = state.bufferSnapshots[state.bufferSnapshots.length - 1];
      issues.push(
        `stuck in ${last.readableFlowing ? 'flowing' : 'paused'} state`,
      );
    }

    if (state.downstreamErrored && state.pipedFrom !== null) {
      issues.push('broken pipe (downstream errored)');
    }

    if (state.upstreamErrored && state.pipedTo.size > 0) {
      issues.push('broken pipe (upstream errored)');
    }

    if (issues.length > 0) {
      lines.push(`    Issues: ${issues.join(', ')}`);
    }

    const formattedStack = formatStackTrace(state.creationStack);
    if (formattedStack !== '') {
      lines.push(`    Created at: ${formattedStack}`);
    }

    if (state.gcCyclesSurvived > 0) {
      lines.push(
        `    Survived ${state.gcCyclesSurvived} garbage collection cycle(s)`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Checks for stream leaks by identifying streams that persist across GC cycles without being destroyed.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only (e.g. `"Stream leaks detected: 5 leaked stream(s)"`)
 * - `"summary"`: List of leaked streams with issues
 * - `"details"`: Detailed output with stack traces and buffer growth information
 *
 * @throws {Error} If leak detection is not set up. Call trackStreams() first.
 * @throws {Error} If stream leaks are detected, with details about each leak.
 *
 * @remarks Restores original stream constructors and methods and clears tracking state.
 *
 * @example
 * ```typescript
 * trackStreams();
 * const stream = new Readable();
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

  // Update buffer snapshots before GC
  updateBufferSnapshots();

  if (forceGC) {
    await forceGarbageCollection();
    gcCycleCount++;

    // Update GC cycle count for all streams that survived
    for (const stream of allStreams) {
      const state = trackedStreams.get(stream);
      if (state !== undefined && !state.destroyed) {
        state.gcCyclesSurvived = gcCycleCount;
      }
    }

    // Update buffer snapshots after GC to detect growth
    updateBufferSnapshots();
  }

  // Restore original constructors and methods
  try {
    const streamModule = require.cache
      ? require.cache[require.resolve('node:stream')]
      : null;
    if (streamModule !== null && streamModule.exports !== undefined) {
      streamModule.exports.Readable = originalReadableConstructor;
      streamModule.exports.Writable = originalWritableConstructor;
      streamModule.exports.Transform = originalTransformConstructor;
      streamModule.exports.Duplex = originalDuplexConstructor;
    }
  } catch {
    // Ignore if require.cache not available
  }

  // Restore prototype constructors
  // We need to restore them from the original constructors
  Readable.prototype.constructor = originalReadableConstructor.prototype.constructor;
  Writable.prototype.constructor = originalWritableConstructor.prototype.constructor;
  Transform.prototype.constructor = originalTransformConstructor.prototype.constructor;
  Duplex.prototype.constructor = originalDuplexConstructor.prototype.constructor;
  Readable.prototype.pipe = originalPipe!;
  Stream.prototype.destroy = originalDestroy!;

  originalReadableConstructor = null;
  originalWritableConstructor = null;
  originalTransformConstructor = null;
  originalDuplexConstructor = null;
  originalPipe = null;
  originalDestroy = null;

  // Collect leaked streams
  const leakedStreams = collectLeakedStreams();

  let message: string;
  if (format === 'short') {
    message = formatShortMessage(leakedStreams);
  } else if (format === 'details') {
    message = formatDetailsMessage(leakedStreams);
  } else {
    message = formatSummaryMessage(leakedStreams);
  }

  // Clear tracking state
  allStreams.clear();
  streamIdCounter = 0;
  gcCycleCount = 0;

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
