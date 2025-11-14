import type { Blob } from 'node:buffer';
import type { X509Certificate } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { MessagePort, Worker } from 'node:worker_threads';

import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

/**
 * Information about a tracked Worker instance.
 */
type WorkerInfo = {
  worker: Worker;
  id: number;
  threadId: number | null;
  createdAt: number;
  stack: string;
  terminated: boolean;
  exitReceived: boolean;
  lastActivityAt: number;
};

/**
 * Information about a tracked MessagePort instance.
 */
type MessagePortInfo = {
  port: MessagePort;
  id: number;
  createdAt: number;
  stack: string;
  closed: boolean;
  relatedWorker: number | null; // WorkerInfo id
};

/**
 * Information about a tracked SharedArrayBuffer.
 */
type SharedArrayBufferInfo = {
  buffer: WeakRef<SharedArrayBuffer>;
  id: number;
  byteLength: number;
  createdAt: number;
  stack: string;
};

/**
 * Snapshot of worker threads state.
 */
export type WorkerThreadsSnapshot = {
  workers: {
    total: number;
    alive: number;
    idle: number;
    terminated: number;
  };
  messagePorts: {
    total: number;
    open: number;
    closed: number;
  };
  sharedArrayBuffers: {
    total: number;
    totalBytes: number;
  };
};

let nextWorkerId = 1;
let nextMessagePortId = 1;
let nextSharedArrayBufferId = 1;

const trackedWorkers = new Map<number, WorkerInfo>();
const trackedMessagePorts = new Map<number, MessagePortInfo>();
const trackedSharedArrayBuffers = new Map<number, SharedArrayBufferInfo>();
const workerToId = new WeakMap<Worker, number>();
const messagePortToId = new WeakMap<MessagePort, number>();

let originalWorkerConstructor: typeof Worker | null = null;
let originalSharedArrayBufferConstructor: typeof SharedArrayBuffer | null =
  null;

/**
 * How long (in milliseconds) a worker can be inactive before being considered idle.
 * Default: 5 seconds.
 */
let idleThresholdMs = 5000;

/**
 * Configures the idle threshold for worker detection.
 *
 * @param thresholdMs - Time in milliseconds. A worker is considered idle if it hasn't had activity for this duration.
 *
 * @example
 * ```typescript
 * // Set idle threshold to 10 seconds
 * setWorkerIdleThreshold(10000);
 * ```
 */
export function setWorkerIdleThreshold(thresholdMs: number): void {
  if (thresholdMs <= 0) {
    throw new Error('Idle threshold must be positive');
  }
  idleThresholdMs = thresholdMs;
}

/**
 * Starts tracking Worker threads, MessagePorts, and SharedArrayBuffers.
 * After calling this, use TrackedWorker instead of Worker to create tracked workers.
 *
 * @throws {Error} If leak detection is already set up. Call check() first.
 *
 * @remarks This function patches globalThis.SharedArrayBuffer to track allocations.
 * For Workers, you must use the TrackedWorker class exported by this module.
 *
 * @example
 * ```typescript
 * import { TrackedWorker, workerThreads } from 'leakspector';
 *
 * workerThreads.track();
 * const worker = new TrackedWorker('./worker.js'); // This will be tracked
 * await workerThreads.check();
 * ```
 */
/**
 * Wraps a Worker instance to track its lifecycle.
 *
 * @param worker - The Worker instance to wrap.
 * @returns The wrapped Worker.
 */
function wrapWorker(worker: Worker): Worker {
  const id = nextWorkerId++;
  const now = Date.now();
  const stack = captureStackTrace();

  const info: WorkerInfo = {
    worker,
    id,
    threadId: null,
    createdAt: now,
    stack,
    terminated: false,
    exitReceived: false,
    lastActivityAt: now,
  };

  trackedWorkers.set(id, info);
  workerToId.set(worker, id);

  // Try to get threadId (it may not be available immediately)
  // Use setImmediate to allow the worker to initialize
  setImmediate(() => {
    try {
      info.threadId = worker.threadId;
    } catch {
      // threadId might not be accessible if worker terminated quickly
    }
  });

  // Track exit event
  worker.on('exit', () => {
    info.exitReceived = true;
    info.lastActivityAt = Date.now();
  });

  // Track message events to update activity
  worker.on('message', () => {
    info.lastActivityAt = Date.now();
  });

  worker.on('error', () => {
    info.lastActivityAt = Date.now();
  });

  worker.on('messageerror', () => {
    info.lastActivityAt = Date.now();
  });

  worker.on('online', () => {
    info.lastActivityAt = Date.now();
  });

  return info;
}

/**
 * Tracks MessagePorts transferred via postMessage.
 */
function trackMessagePortsInTransferList(
  transferList:
    | Array<ArrayBuffer | MessagePort | FileHandle | X509Certificate | Blob>
    | undefined,
  workerId: number,
): void {
  if (transferList === undefined) {
    return;
  }

  for (const item of transferList) {
    if (item instanceof MessagePort) {
      const portId = nextMessagePortId++;
      const portStack = captureStackTrace();

      const portInfo: MessagePortInfo = {
        port: item,
        id: portId,
        createdAt: Date.now(),
        stack: portStack,
        closed: false,
        relatedWorker: workerId,
      };

      trackedMessagePorts.set(portId, portInfo);
      messagePortToId.set(item, portId);

      // Track close event
      item.on('close', () => {
        portInfo.closed = true;
      });
    }
  }
}

/**
 * Tracked Worker class that automatically instruments worker lifecycle.
 * Use this instead of the standard Worker class when tracking is enabled.
 *
 * @example
 * ```typescript
 * import { TrackedWorker, workerThreads } from 'leakspector';
 *
 * workerThreads.track();
 * const worker = new TrackedWorker('./worker.js');
 * // ... use worker ...
 * await workerThreads.check();
 * ```
 */
export class TrackedWorker extends Worker {
  private _workerId: number;

  constructor(
    filename: string | URL,
    options?: ConstructorParameters<typeof Worker>[1],
  ) {
    super(filename, options);

    wrapWorker(this);
    this._workerId = workerToId.get(this)!;
  }

  postMessage(
    value: unknown,
    transferList?: Array<
      ArrayBuffer | MessagePort | FileHandle | X509Certificate | Blob
    >,
  ): void {
    const info = trackedWorkers.get(this._workerId);
    if (info !== undefined) {
      info.lastActivityAt = Date.now();
    }

    // Track MessagePorts in transfer list
    trackMessagePortsInTransferList(transferList, this._workerId);

    return super.postMessage(
      value,
      transferList as readonly Transferable[] | undefined,
    );
  }

  async terminate(): Promise<number> {
    const info = trackedWorkers.get(this._workerId);
    if (info !== undefined) {
      info.terminated = true;
      info.lastActivityAt = Date.now();
    }
    return super.terminate();
  }
}

/**
 * Tracked SharedArrayBuffer class that automatically tracks allocations.
 * Use this instead of the standard SharedArrayBuffer when tracking is enabled.
 *
 * @example
 * ```typescript
 * import { TrackedSharedArrayBuffer, workerThreads} from 'leakspector';
 *
 * workerThreads.track();
 * const buffer = new TrackedSharedArrayBuffer(1024);
 * // ... use buffer ...
 * await workerThreads.check();
 * ```
 */
export class TrackedSharedArrayBuffer extends SharedArrayBuffer {
  constructor(length: number) {
    super(length);

    const id = nextSharedArrayBufferId++;
    const stack = captureStackTrace();

    const info: SharedArrayBufferInfo = {
      buffer: new WeakRef(this),
      id,
      byteLength: length,
      createdAt: Date.now(),
      stack,
    };

    trackedSharedArrayBuffers.set(id, info);
  }
}

/**
 * Starts tracking Worker threads and SharedArrayBuffers.
 * After calling this, use TrackedWorker and TrackedSharedArrayBuffer classes.
 *
 * @throws {Error} If leak detection is already set up.
 *
 * @example
 * ```typescript
 * import { TrackedWorker, workerThreads } from 'leakspector';
 *
 * workerThreads.track();
 * const worker = new TrackedWorker('./worker.js');
 * await workerThreads.check();
 * ```
 */
export function trackWorkerThreads(): void {
  if (originalWorkerConstructor !== null) {
    throw new Error(
      'Worker thread leak detection already set up. Call checkWorkerThreads() first.',
    );
  }

  originalWorkerConstructor = Worker;
  originalSharedArrayBufferConstructor = SharedArrayBuffer;

  // Patch global SharedArrayBuffer
  globalThis.SharedArrayBuffer =
    TrackedSharedArrayBuffer as typeof SharedArrayBuffer;
}

/**
 * Creates a snapshot of all currently tracked worker thread resources.
 *
 * @returns A snapshot containing counts of workers, message ports, and shared array buffers.
 *
 * @example
 * ```typescript
 * trackWorkerThreads();
 * const worker = new Worker('./worker.js');
 * const snapshot = snapshotWorkerThreads();
 * // snapshot = { workers: { total: 1, alive: 1, idle: 0, terminated: 0 }, ... }
 * ```
 */
export function snapshotWorkerThreads(): WorkerThreadsSnapshot {
  const now = Date.now();
  const snapshot: WorkerThreadsSnapshot = {
    workers: {
      total: 0,
      alive: 0,
      idle: 0,
      terminated: 0,
    },
    messagePorts: {
      total: 0,
      open: 0,
      closed: 0,
    },
    sharedArrayBuffers: {
      total: 0,
      totalBytes: 0,
    },
  };

  // Count workers
  for (const info of trackedWorkers.values()) {
    snapshot.workers.total++;

    if (info.exitReceived) {
      snapshot.workers.terminated++;
    } else {
      snapshot.workers.alive++;

      // Check if idle
      const inactiveTime = now - info.lastActivityAt;
      if (inactiveTime >= idleThresholdMs) {
        snapshot.workers.idle++;
      }
    }
  }

  // Count message ports
  for (const info of trackedMessagePorts.values()) {
    snapshot.messagePorts.total++;

    if (info.closed) {
      snapshot.messagePorts.closed++;
    } else {
      snapshot.messagePorts.open++;
    }
  }

  // Count SharedArrayBuffers (only those still alive)
  for (const info of trackedSharedArrayBuffers.values()) {
    const buffer = info.buffer.deref();
    if (buffer !== undefined) {
      snapshot.sharedArrayBuffers.total++;
      snapshot.sharedArrayBuffers.totalBytes += info.byteLength;
    }
  }

  return snapshot;
}

/**
 * Formats leak message in short format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(): string {
  const now = Date.now();
  const leaks: string[] = [];

  // Check for workers that should have been terminated
  let leakedWorkers = 0;
  for (const info of trackedWorkers.values()) {
    if (!info.exitReceived && !info.terminated) {
      leakedWorkers++;
    }
  }
  if (leakedWorkers > 0) {
    leaks.push(`${leakedWorkers} worker(s)`);
  }

  // Check for idle workers
  let idleWorkers = 0;
  for (const info of trackedWorkers.values()) {
    if (!info.exitReceived) {
      const inactiveTime = now - info.lastActivityAt;
      if (inactiveTime >= idleThresholdMs) {
        idleWorkers++;
      }
    }
  }
  if (idleWorkers > 0) {
    leaks.push(`${idleWorkers} idle worker(s)`);
  }

  // Check for unclosed message ports
  let unclosedPorts = 0;
  for (const info of trackedMessagePorts.values()) {
    if (!info.closed) {
      unclosedPorts++;
    }
  }
  if (unclosedPorts > 0) {
    leaks.push(`${unclosedPorts} open MessagePort(s)`);
  }

  // Check for SharedArrayBuffers still in memory
  let aliveBuffers = 0;
  for (const info of trackedSharedArrayBuffers.values()) {
    if (info.buffer.deref() !== undefined) {
      aliveBuffers++;
    }
  }
  if (aliveBuffers > 0) {
    leaks.push(`${aliveBuffers} SharedArrayBuffer(s)`);
  }

  if (leaks.length === 0) {
    return '';
  }

  return `Worker thread leaks detected: ${leaks.join(', ')}`;
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const now = Date.now();
  const lines: string[] = [];
  let hasLeaks = false;

  // Check for workers that should have been terminated
  const leakedWorkers: WorkerInfo[] = [];
  for (const info of trackedWorkers.values()) {
    if (!info.exitReceived && !info.terminated) {
      leakedWorkers.push(info);
    }
  }

  if (leakedWorkers.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (hasLeaks === false) {
      lines.push('Worker thread leaks detected:');
      hasLeaks = true;
    }
    lines.push(`  Workers not terminated: ${leakedWorkers.length}`);
    for (const info of leakedWorkers) {
      const threadId =
        info.threadId !== null ? ` (threadId: ${info.threadId})` : '';
      const formattedStack = formatStackTrace(info.stack);
      if (formattedStack !== '') {
        lines.push(`    Worker#${info.id}${threadId} ${formattedStack}`);
      } else {
        lines.push(`    Worker#${info.id}${threadId}`);
      }
    }
  }

  // Check for idle workers
  const idleWorkers: WorkerInfo[] = [];
  for (const info of trackedWorkers.values()) {
    if (!info.exitReceived) {
      const inactiveTime = now - info.lastActivityAt;
      if (inactiveTime >= idleThresholdMs) {
        idleWorkers.push(info);
      }
    }
  }

  if (idleWorkers.length > 0) {
    if (!hasLeaks) {
      lines.push('Worker thread leaks detected:');
      hasLeaks = true;
    }
    lines.push(
      `  Idle workers (inactive for >${idleThresholdMs}ms): ${idleWorkers.length}`,
    );
    for (const info of idleWorkers) {
      const inactiveTime = now - info.lastActivityAt;
      const threadId =
        info.threadId !== null ? ` (threadId: ${info.threadId})` : '';
      const formattedStack = formatStackTrace(info.stack);
      if (formattedStack !== '') {
        lines.push(
          `    Worker#${info.id}${threadId} (idle for ${inactiveTime}ms) ${formattedStack}`,
        );
      } else {
        lines.push(
          `    Worker#${info.id}${threadId} (idle for ${inactiveTime}ms)`,
        );
      }
    }
  }

  // Check for unclosed message ports
  const unclosedPorts: MessagePortInfo[] = [];
  for (const info of trackedMessagePorts.values()) {
    if (!info.closed) {
      unclosedPorts.push(info);
    }
  }

  if (unclosedPorts.length > 0) {
    if (!hasLeaks) {
      lines.push('Worker thread leaks detected:');
      hasLeaks = true;
    }
    lines.push(`  MessagePorts not closed: ${unclosedPorts.length}`);
    for (const info of unclosedPorts) {
      const relatedWorker =
        info.relatedWorker !== null
          ? ` (from Worker#${info.relatedWorker})`
          : '';
      const formattedStack = formatStackTrace(info.stack);
      if (formattedStack !== '') {
        lines.push(
          `    MessagePort#${info.id}${relatedWorker} ${formattedStack}`,
        );
      } else {
        lines.push(`    MessagePort#${info.id}${relatedWorker}`);
      }
    }
  }

  // Check for SharedArrayBuffers still in memory
  const aliveBuffers: SharedArrayBufferInfo[] = [];
  for (const info of trackedSharedArrayBuffers.values()) {
    if (info.buffer.deref() !== undefined) {
      aliveBuffers.push(info);
    }
  }

  if (aliveBuffers.length > 0) {
    if (!hasLeaks) {
      lines.push('Worker thread leaks detected:');
      hasLeaks = true;
    }
    const totalBytes = aliveBuffers.reduce(
      (sum, info) => sum + info.byteLength,
      0,
    );
    lines.push(
      `  SharedArrayBuffers still in memory: ${aliveBuffers.length} (${totalBytes} bytes)`,
    );
    for (const info of aliveBuffers) {
      const formattedStack = formatStackTrace(info.stack);
      if (formattedStack !== '') {
        lines.push(
          `    SharedArrayBuffer#${info.id} (${info.byteLength} bytes) ${formattedStack}`,
        );
      } else {
        lines.push(
          `    SharedArrayBuffer#${info.id} (${info.byteLength} bytes)`,
        );
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
  const now = Date.now();
  const lines: string[] = [];
  let hasLeaks = false;

  // Check for workers that should have been terminated
  const leakedWorkers: WorkerInfo[] = [];
  for (const info of trackedWorkers.values()) {
    if (!info.exitReceived && !info.terminated) {
      leakedWorkers.push(info);
    }
  }

  if (leakedWorkers.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (hasLeaks === false) {
      lines.push('Worker thread leaks detected:');
      lines.push('');
      hasLeaks = true;
    }
    lines.push(`Workers not terminated: ${leakedWorkers.length}`);
    for (const info of leakedWorkers) {
      const threadId =
        info.threadId !== null ? ` (threadId: ${info.threadId})` : '';
      const ageMs = now - info.createdAt;
      lines.push(`  Worker#${info.id}${threadId}`);
      lines.push(`    Age: ${ageMs}ms`);
      lines.push(`    Last activity: ${now - info.lastActivityAt}ms ago`);
      const formattedStack = formatStackTrace(info.stack);
      if (formattedStack !== '') {
        lines.push(`    Created at: ${formattedStack}`);
      }
      lines.push('');
    }
  }

  // Check for idle workers
  const idleWorkers: WorkerInfo[] = [];
  for (const info of trackedWorkers.values()) {
    if (!info.exitReceived) {
      const inactiveTime = now - info.lastActivityAt;
      if (inactiveTime >= idleThresholdMs) {
        idleWorkers.push(info);
      }
    }
  }

  if (idleWorkers.length > 0) {
    if (!hasLeaks) {
      lines.push('Worker thread leaks detected:');
      lines.push('');
      hasLeaks = true;
    }
    lines.push(
      `Idle workers (inactive for >${idleThresholdMs}ms): ${idleWorkers.length}`,
    );
    for (const info of idleWorkers) {
      const inactiveTime = now - info.lastActivityAt;
      const threadId =
        info.threadId !== null ? ` (threadId: ${info.threadId})` : '';
      const ageMs = now - info.createdAt;
      lines.push(`  Worker#${info.id}${threadId}`);
      lines.push(`    Age: ${ageMs}ms`);
      lines.push(`    Idle time: ${inactiveTime}ms`);
      const formattedStack = formatStackTrace(info.stack);
      if (formattedStack !== '') {
        lines.push(`    Created at: ${formattedStack}`);
      }
      lines.push('');
    }
  }

  // Check for unclosed message ports
  const unclosedPorts: MessagePortInfo[] = [];
  for (const info of trackedMessagePorts.values()) {
    if (!info.closed) {
      unclosedPorts.push(info);
    }
  }

  if (unclosedPorts.length > 0) {
    if (!hasLeaks) {
      lines.push('Worker thread leaks detected:');
      lines.push('');
      hasLeaks = true;
    }
    lines.push(`MessagePorts not closed: ${unclosedPorts.length}`);
    for (const info of unclosedPorts) {
      const relatedWorker =
        info.relatedWorker !== null
          ? ` (from Worker#${info.relatedWorker})`
          : '';
      const ageMs = now - info.createdAt;
      lines.push(`  MessagePort#${info.id}${relatedWorker}`);
      lines.push(`    Age: ${ageMs}ms`);
      const formattedStack = formatStackTrace(info.stack);
      if (formattedStack !== '') {
        lines.push(`    Created at: ${formattedStack}`);
      }
      lines.push('');
    }
  }

  // Check for SharedArrayBuffers still in memory
  const aliveBuffers: SharedArrayBufferInfo[] = [];
  for (const info of trackedSharedArrayBuffers.values()) {
    if (info.buffer.deref() !== undefined) {
      aliveBuffers.push(info);
    }
  }

  if (aliveBuffers.length > 0) {
    if (!hasLeaks) {
      lines.push('Worker thread leaks detected:');
      lines.push('');
      hasLeaks = true;
    }
    const totalBytes = aliveBuffers.reduce(
      (sum, info) => sum + info.byteLength,
      0,
    );
    lines.push(
      `SharedArrayBuffers still in memory: ${aliveBuffers.length} (${totalBytes} bytes)`,
    );
    for (const info of aliveBuffers) {
      const ageMs = now - info.createdAt;
      lines.push(`  SharedArrayBuffer#${info.id} (${info.byteLength} bytes)`);
      lines.push(`    Age: ${ageMs}ms`);
      const formattedStack = formatStackTrace(info.stack);
      if (formattedStack !== '') {
        lines.push(`    Created at: ${formattedStack}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Checks for worker thread resource leaks.
 * Detects workers not terminated, idle workers, unclosed MessagePorts, and leaked SharedArrayBuffers.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only
 * - `"summary"`: List of leaked resources with basic info
 * - `"details"`: Detailed output with full context and timestamps
 *
 * @throws {Error} If leak detection is not set up. Call trackWorkerThreads() first.
 * @throws {Error} If worker thread leaks are detected, with details about each leak.
 *
 * @remarks Restores original Worker constructor and clears tracking state.
 *
 * @example
 * ```typescript
 * trackWorkerThreads();
 * const worker = new Worker('./worker.js');
 * // ... later ...
 * await checkWorkerThreads({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkWorkerThreads(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
}): Promise<void> {
  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
  } = options ?? {};

  if (originalWorkerConstructor === null) {
    throw new Error(
      'Worker thread leak detection not set up. Call trackWorkerThreads() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
  }

  // Restore original constructors
  globalThis.SharedArrayBuffer = originalSharedArrayBufferConstructor!;

  originalWorkerConstructor = null;
  originalSharedArrayBufferConstructor = null;

  let message: string;
  if (format === 'short') {
    message = formatShortMessage();
  } else if (format === 'details') {
    message = formatDetailsMessage();
  } else {
    message = formatSummaryMessage();
  }

  // Clear tracking state
  trackedWorkers.clear();
  trackedMessagePorts.clear();
  trackedSharedArrayBuffers.clear();
  nextWorkerId = 1;
  nextMessagePortId = 1;
  nextSharedArrayBufferId = 1;

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Convenience object providing access to worker thread leak detection functions.
 *
 * @property track - Starts tracking worker threads. See {@link trackWorkerThreads}.
 * @property snapshot - Creates a snapshot of current worker threads. See {@link snapshotWorkerThreads}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkWorkerThreads}.
 */
export const workerThreads = {
  track: trackWorkerThreads,
  snapshot: snapshotWorkerThreads,
  check: checkWorkerThreads,
  setIdleThreshold: setWorkerIdleThreshold,
};
