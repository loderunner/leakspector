import { MessagePort, Worker } from 'node:worker_threads';

import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

type WorkerState = 'running' | 'exited' | 'terminated';

type WorkerInfo = {
  worker: Worker;
  creationStack: string;
  state: WorkerState;
  exitCode: number | null;
  terminated: boolean;
  messagePorts: Set<MessagePort>;
  sharedArrayBuffers: Set<SharedArrayBuffer>;
  lastActivityTime: number;
  idle: boolean;
};

type MessagePortInfo = {
  port: MessagePort;
  creationStack: string;
  closed: boolean;
  workerId: string;
};

let originalWorkerConstructor: typeof Worker | null = null;
const trackedWorkers = new WeakMap<Worker, WorkerInfo>();
const allWorkers = new Set<Worker>();
const workerIds = new WeakMap<Worker, string>();
const constructorCounts = new Map<string, number>();
const trackedMessagePorts = new WeakMap<MessagePort, MessagePortInfo>();
const allMessagePorts = new Set<MessagePort>();
const trackedSharedArrayBuffers = new WeakSet<SharedArrayBuffer>();
const sharedArrayBufferCreationStacks = new WeakMap<
  SharedArrayBuffer,
  string
>();

let originalPostMessage: typeof Worker.prototype.postMessage | null = null;
let originalTerminate: typeof Worker.prototype.terminate | null = null;
let originalClose: typeof MessagePort.prototype.close | null = null;
let originalSharedArrayBufferConstructor:
  | typeof SharedArrayBuffer
  | null = null;

/**
 * Gets a unique identifier for a Worker instance.
 *
 * @param worker - The Worker instance to identify.
 * @returns A string identifier for the worker.
 */
function getWorkerId(worker: Worker): string {
  const existing = workerIds.get(worker);
  if (existing !== undefined) {
    return existing;
  }

  const threadId = worker.threadId;
  const currentCount = constructorCounts.get('Worker') ?? 0;
  const nextCount = currentCount + 1;
  constructorCounts.set('Worker', nextCount);

  const id = `Worker#${nextCount} (threadId: ${threadId})`;
  workerIds.set(worker, id);
  return id;
}

/**
 * Checks if a Worker is in an idle state (no recent activity).
 *
 * @param workerInfo - The worker info to check.
 * @param idleThresholdMs - Time threshold in milliseconds for idle detection. Defaults to 5000ms.
 * @returns True if the worker is idle.
 */
function isWorkerIdle(
  workerInfo: WorkerInfo,
  idleThresholdMs: number = 5000,
): boolean {
  if (workerInfo.state !== 'running') {
    return false;
  }
  const now = Date.now();
  return now - workerInfo.lastActivityTime > idleThresholdMs;
}

/**
 * Starts tracking Worker thread lifecycles and MessagePort communication channels.
 * Must be called before creating Worker instances to track.
 *
 * @throws {Error} If leak detection is already set up. Call checkWorkers() first.
 *
 * @remarks Patches Worker constructor and related methods to monitor worker creation,
 * termination, MessagePort channels, and SharedArrayBuffer allocations.
 *
 * @example
 * ```typescript
 * trackWorkers();
 * const worker = new Worker('./worker.js'); // This will be tracked
 * ```
 */
export function trackWorkers(): void {
  if (originalWorkerConstructor !== null) {
    throw new Error(
      'Worker leak detection already set up. Call checkWorkers() first.',
    );
  }

  // Get Worker constructor - try both CommonJS and ES module approaches
  let workerThreadsModule: typeof import('node:worker_threads');
  try {
    // Try CommonJS require first
    workerThreadsModule = require('node:worker_threads') as typeof import('node:worker_threads');
  } catch {
    // Fallback to dynamic import if require fails
    // Note: This is a workaround for ES modules
    workerThreadsModule = require('node:worker_threads') as typeof import('node:worker_threads');
  }

  originalWorkerConstructor = workerThreadsModule.Worker;
  originalPostMessage = Worker.prototype.postMessage;
  originalTerminate = Worker.prototype.terminate;

  // Create a Proxy to intercept Worker constructor calls
  const PatchedWorker = new Proxy(originalWorkerConstructor, {
    construct(
      target,
      args: [string | URL, import('node:worker_threads').WorkerOptions?],
    ) {
      // Call original constructor
      const worker = Reflect.construct(
        target,
        args,
      ) as Worker;

      const creationStack = captureStackTrace();
      const workerInfo: WorkerInfo = {
        worker,
        creationStack,
        state: 'running',
        exitCode: null,
        terminated: false,
        messagePorts: new Set(),
        sharedArrayBuffers: new Set(),
        lastActivityTime: Date.now(),
        idle: false,
      };

      trackedWorkers.set(worker, workerInfo);
      allWorkers.add(worker);
      getWorkerId(worker);

      // Track exit event
      worker.once('exit', (code: number) => {
        const info = trackedWorkers.get(worker);
        if (info !== undefined) {
          info.state = 'exited';
          info.exitCode = code;
          info.lastActivityTime = Date.now();
        }
      });

      // Track error event (activity)
      worker.on('error', () => {
        const info = trackedWorkers.get(worker);
        if (info !== undefined) {
          info.lastActivityTime = Date.now();
        }
      });

      // Track message event (activity)
      worker.on('message', () => {
        const info = trackedWorkers.get(worker);
        if (info !== undefined) {
          info.lastActivityTime = Date.now();
        }
      });

      // Track messageerror event (activity)
      worker.on('messageerror', () => {
        const info = trackedWorkers.get(worker);
        if (info !== undefined) {
          info.lastActivityTime = Date.now();
        }
      });

      return worker;
    },
  });

  // Replace the module export - this works for CommonJS require()
  workerThreadsModule.Worker = PatchedWorker as typeof Worker;
  
  // Also patch require.cache for CommonJS modules
  try {
    const Module = require('module');
    const workerThreadsId = require.resolve('node:worker_threads');
    if (Module._cache[workerThreadsId]) {
      Module._cache[workerThreadsId].exports.Worker = PatchedWorker;
    }
  } catch {
    // Ignore if require.cache is not available or patching fails
  }

  // For ES modules, we need to patch Worker.prototype.constructor or use a different approach
  // Since Worker is a class, we can't easily patch the constructor
  // Instead, we'll patch Worker.prototype to add tracking when instances are created
  // But actually, the Proxy should work if Worker is imported after track() is called
  // The issue is that ES module imports are cached, so we need to ensure the patch happens
  // before any Worker imports
  
  // Patch Worker at the prototype level to ensure tracking works
  // This is a workaround for ES modules that import Worker before track() is called
  const originalWorkerPrototype = Worker.prototype;
  
  // Store the patched constructor on the prototype so we can access it
  // This won't work directly, but we can use it as a fallback
  
  // Actually, the best approach is to ensure users import Worker after calling track()
  // For now, we'll rely on the Proxy approach which should work if Worker is imported after track()

  // Patch Worker.prototype.postMessage to track MessagePort channels
  Worker.prototype.postMessage = function (
    this: Worker,
    value: any,
    transferList?: readonly Transferable[],
  ): void {
    const info = trackedWorkers.get(this);
    if (info !== undefined) {
      info.lastActivityTime = Date.now();

      // Track MessagePort channels in transferList
      if (transferList !== undefined) {
        for (const transferable of transferList) {
          if (transferable instanceof MessagePort) {
            const portInfo: MessagePortInfo = {
              port: transferable,
              creationStack: captureStackTrace(),
              closed: false,
              workerId: getWorkerId(this),
            };
            trackedMessagePorts.set(transferable, portInfo);
            allMessagePorts.add(transferable);
            info.messagePorts.add(transferable);

            // Track close event
            transferable.once('close', () => {
              const portInfo = trackedMessagePorts.get(transferable);
              if (portInfo !== undefined) {
                portInfo.closed = true;
              }
              const workerInfo = trackedWorkers.get(this);
              if (workerInfo !== undefined) {
                workerInfo.messagePorts.delete(transferable);
              }
            });
          }

          // Track SharedArrayBuffer allocations
          if (transferable instanceof SharedArrayBuffer) {
            if (!trackedSharedArrayBuffers.has(transferable)) {
              trackedSharedArrayBuffers.add(transferable);
              sharedArrayBufferCreationStacks.set(
                transferable,
                captureStackTrace(),
              );
              if (info !== undefined) {
                info.sharedArrayBuffers.add(transferable);
              }
            }
          }
        }
      }
    }

    return originalPostMessage!.call(this, value, transferList);
  };

  // Patch Worker.prototype.terminate
  Worker.prototype.terminate = function (
    this: Worker,
  ): Promise<number> | void {
    const info = trackedWorkers.get(this);
    if (info !== undefined) {
      info.terminated = true;
      info.state = 'terminated';
      info.lastActivityTime = Date.now();
    }

    return originalTerminate!.call(this);
  };

  // Patch MessagePort.prototype.close if it exists
  if (MessagePort.prototype.close !== undefined) {
    originalClose = MessagePort.prototype.close;
    MessagePort.prototype.close = function (this: MessagePort): void {
      const portInfo = trackedMessagePorts.get(this);
      if (portInfo !== undefined) {
        portInfo.closed = true;
      }

      return originalClose!.call(this);
    };
  }

  // Track SharedArrayBuffer constructor
  originalSharedArrayBufferConstructor = globalThis.SharedArrayBuffer;
  globalThis.SharedArrayBuffer = class PatchedSharedArrayBuffer extends originalSharedArrayBufferConstructor {
    constructor(length: number) {
      super(length);
      if (!trackedSharedArrayBuffers.has(this)) {
        trackedSharedArrayBuffers.add(this);
        sharedArrayBufferCreationStacks.set(this, captureStackTrace());
      }
    }
  } as typeof SharedArrayBuffer;
}

export type WorkersSnapshot = {
  workers: Array<{
    id: string;
    state: WorkerState;
    exitCode: number | null;
    terminated: boolean;
    messagePorts: number;
    sharedArrayBuffers: number;
    idle: boolean;
  }>;
  messagePorts: Array<{
    workerId: string;
    closed: boolean;
  }>;
  sharedArrayBuffers: number;
  poolSize: number;
};

/**
 * Creates a snapshot of all currently tracked workers, MessagePorts, and SharedArrayBuffers.
 *
 * @returns A snapshot of all tracked resources.
 *
 * @example
 * ```typescript
 * trackWorkers();
 * const worker = new Worker('./worker.js');
 * const snapshot = snapshotWorkers();
 * // snapshot = { workers: [...], messagePorts: [...], sharedArrayBuffers: 0, poolSize: 1 }
 * ```
 */
export function snapshotWorkers(): WorkersSnapshot {
  const workers: WorkersSnapshot['workers'] = [];
  const messagePorts: WorkersSnapshot['messagePorts'] = [];

  for (const worker of allWorkers) {
    const info = trackedWorkers.get(worker);
    if (info === undefined) {
      continue;
    }

    const workerId = getWorkerId(worker);
    const idle = isWorkerIdle(info);

    workers.push({
      id: workerId,
      state: info.state,
      exitCode: info.exitCode,
      terminated: info.terminated,
      messagePorts: info.messagePorts.size,
      sharedArrayBuffers: info.sharedArrayBuffers.size,
      idle,
    });
  }

  for (const port of allMessagePorts) {
    const portInfo = trackedMessagePorts.get(port);
    if (portInfo === undefined) {
      continue;
    }

    messagePorts.push({
      workerId: portInfo.workerId,
      closed: portInfo.closed,
    });
  }

  // Count SharedArrayBuffers
  let sharedArrayBufferCount = 0;
  for (const worker of allWorkers) {
    const info = trackedWorkers.get(worker);
    if (info !== undefined) {
      sharedArrayBufferCount += info.sharedArrayBuffers.size;
    }
  }

  return {
    workers,
    messagePorts,
    sharedArrayBuffers: sharedArrayBufferCount,
    poolSize: allWorkers.size,
  };
}

/**
 * Formats leak message in short format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(): string {
  let leakedWorkers = 0;
  let leakedPorts = 0;
  let leakedBuffers = 0;
  let idleWorkers = 0;

  for (const worker of allWorkers) {
    const info = trackedWorkers.get(worker);
    if (info === undefined) {
      continue;
    }

    if (info.state === 'running' && !info.terminated) {
      leakedWorkers++;
    }

    if (isWorkerIdle(info)) {
      idleWorkers++;
    }

    leakedPorts += Array.from(info.messagePorts).filter((port) => {
      const portInfo = trackedMessagePorts.get(port);
      return portInfo !== undefined && !portInfo.closed;
    }).length;

    leakedBuffers += info.sharedArrayBuffers.size;
  }

  const parts: string[] = [];
  if (leakedWorkers > 0) {
    parts.push(`${leakedWorkers} worker(s)`);
  }
  if (leakedPorts > 0) {
    parts.push(`${leakedPorts} MessagePort(s)`);
  }
  if (leakedBuffers > 0) {
    parts.push(`${leakedBuffers} SharedArrayBuffer(s)`);
  }
  if (idleWorkers > 0) {
    parts.push(`${idleWorkers} idle worker(s)`);
  }

  if (parts.length === 0) {
    return '';
  }

  return `Worker leaks detected: ${parts.join(', ')}`;
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const lines: string[] = [];
  let hasLeaks = false;

  // Check for leaked workers
  const leakedWorkers: Array<{ id: string; info: WorkerInfo }> = [];
  for (const worker of allWorkers) {
    const info = trackedWorkers.get(worker);
    if (info === undefined) {
      continue;
    }

    if (info.state === 'running' && !info.terminated) {
      leakedWorkers.push({ id: getWorkerId(worker), info });
    }
  }

  if (leakedWorkers.length > 0) {
    hasLeaks = true;
    lines.push('Worker leaks detected:');
    for (const { id, info } of leakedWorkers) {
      const formattedStack = formatStackTrace(info.creationStack, [
        'workers.ts',
      ]);
      const stackInfo = formattedStack !== '' ? ` ${formattedStack}` : '';
      const idleInfo = isWorkerIdle(info) ? ' (idle)' : '';
      lines.push(`  ${id}${idleInfo}${stackInfo}`);
    }
  }

  // Check for leaked MessagePorts
  const leakedPorts: Array<{ workerId: string; portInfo: MessagePortInfo }> =
    [];
  for (const port of allMessagePorts) {
    const portInfo = trackedMessagePorts.get(port);
    if (portInfo === undefined) {
      continue;
    }

    if (!portInfo.closed) {
      leakedPorts.push({ workerId: portInfo.workerId, portInfo });
    }
  }

  if (leakedPorts.length > 0) {
    if (!hasLeaks) {
      lines.push('Worker leaks detected:');
      hasLeaks = true;
    }
    lines.push('  Leaked MessagePort channels:');
    for (const { workerId, portInfo } of leakedPorts) {
      const formattedStack = formatStackTrace(portInfo.creationStack, [
        'workers.ts',
      ]);
      const stackInfo = formattedStack !== '' ? ` ${formattedStack}` : '';
      lines.push(`    ${workerId}${stackInfo}`);
    }
  }

  // Check for SharedArrayBuffers
  let totalBuffers = 0;
  for (const worker of allWorkers) {
    const info = trackedWorkers.get(worker);
    if (info !== undefined) {
      totalBuffers += info.sharedArrayBuffers.size;
    }
  }

  if (totalBuffers > 0) {
    if (!hasLeaks) {
      lines.push('Worker leaks detected:');
      hasLeaks = true;
    }
    lines.push(`  ${totalBuffers} SharedArrayBuffer(s) allocated`);
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
  let hasLeaks = false;

  // Check for leaked workers with full details
  const leakedWorkers: Array<{ id: string; info: WorkerInfo }> = [];
  for (const worker of allWorkers) {
    const info = trackedWorkers.get(worker);
    if (info === undefined) {
      continue;
    }

    if (info.state === 'running' && !info.terminated) {
      leakedWorkers.push({ id: getWorkerId(worker), info });
    }
  }

  if (leakedWorkers.length > 0) {
    hasLeaks = true;
    lines.push('Worker leaks detected:');
    for (const { id, info } of leakedWorkers) {
      lines.push(`  ${id}`);
      const formattedStack = formatStackTrace(info.creationStack, [
        'workers.ts',
      ]);
      if (formattedStack !== '') {
        lines.push(`    Created: ${formattedStack}`);
      }

      if (isWorkerIdle(info)) {
        lines.push(`    State: idle (no activity for ${Date.now() - info.lastActivityTime}ms)`);
      } else {
        lines.push(`    State: ${info.state}`);
      }

      if (info.messagePorts.size > 0) {
        lines.push(`    Open MessagePorts: ${info.messagePorts.size}`);
      }

      if (info.sharedArrayBuffers.size > 0) {
        lines.push(
          `    SharedArrayBuffers: ${info.sharedArrayBuffers.size}`,
        );
      }
    }
  }

  // Check for leaked MessagePorts
  const leakedPorts: Array<{ workerId: string; portInfo: MessagePortInfo }> =
    [];
  for (const port of allMessagePorts) {
    const portInfo = trackedMessagePorts.get(port);
    if (portInfo === undefined) {
      continue;
    }

    if (!portInfo.closed) {
      leakedPorts.push({ workerId: portInfo.workerId, portInfo });
    }
  }

  if (leakedPorts.length > 0) {
    if (!hasLeaks) {
      lines.push('Worker leaks detected:');
      hasLeaks = true;
    }
    lines.push('  Leaked MessagePort channels:');
    for (const { workerId, portInfo } of leakedPorts) {
      const formattedStack = formatStackTrace(portInfo.creationStack, [
        'workers.ts',
      ]);
      lines.push(`    Worker: ${workerId}`);
      if (formattedStack !== '') {
        lines.push(`      Created: ${formattedStack}`);
      }
    }
  }

  // Check for SharedArrayBuffers with creation stacks
  const bufferStacks: string[] = [];
  for (const worker of allWorkers) {
    const info = trackedWorkers.get(worker);
    if (info !== undefined) {
      for (const buffer of info.sharedArrayBuffers) {
        const stack = sharedArrayBufferCreationStacks.get(buffer);
        if (stack !== undefined) {
          const formattedStack = formatStackTrace(stack, ['workers.ts']);
          if (formattedStack !== '') {
            bufferStacks.push(formattedStack);
          }
        }
      }
    }
  }

  if (bufferStacks.length > 0) {
    if (!hasLeaks) {
      lines.push('Worker leaks detected:');
      hasLeaks = true;
    }
    lines.push(`  SharedArrayBuffer allocations (${bufferStacks.length}):`);
    for (const stack of bufferStacks) {
      lines.push(`    ${stack}`);
    }
  }

  return lines.join('\n');
}

/**
 * Checks for worker leaks by checking for non-terminated workers, open MessagePorts,
 * and SharedArrayBuffer allocations.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only
 * - `"summary"`: List of leaks with counts
 * - `"details"`: Detailed output with stack traces
 * @param options.idleThresholdMs - Time threshold in milliseconds for idle worker detection. Defaults to 5000ms.
 *
 * @throws {Error} If leak detection is not set up. Call trackWorkers() first.
 * @throws {Error} If worker leaks are detected, with details about each leak.
 *
 * @remarks Restores original Worker constructor and related methods and clears tracking state.
 *
 * @example
 * ```typescript
 * trackWorkers();
 * const worker = new Worker('./worker.js');
 * // ... later ...
 * await checkWorkers({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkWorkers(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
  idleThresholdMs?: number;
}): Promise<void> {
  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
    idleThresholdMs = 5000,
  } = options ?? {};

  if (originalWorkerConstructor === null) {
    throw new Error(
      'Worker leak detection not set up. Call trackWorkers() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
  }

  // Restore original implementations
  const workerThreads = require('node:worker_threads') as typeof import('node:worker_threads');
  if (originalWorkerConstructor !== null) {
    workerThreads.Worker = originalWorkerConstructor;
    
    // Also restore in require.cache if it was patched
    try {
      const Module = require('module');
      const workerThreadsId = require.resolve('node:worker_threads');
      if (Module._cache[workerThreadsId]) {
        Module._cache[workerThreadsId].exports.Worker = originalWorkerConstructor;
      }
    } catch {
      // Ignore if require.cache is not available
    }
  }
  if (originalPostMessage !== null) {
    Worker.prototype.postMessage = originalPostMessage;
  }
  if (originalTerminate !== null) {
    Worker.prototype.terminate = originalTerminate;
  }
  if (originalClose !== null) {
    MessagePort.prototype.close = originalClose;
  }
  if (originalSharedArrayBufferConstructor !== null) {
    globalThis.SharedArrayBuffer = originalSharedArrayBufferConstructor;
  }

  originalWorkerConstructor = null;
  originalPostMessage = null;
  originalTerminate = null;
  originalClose = null;
  originalSharedArrayBufferConstructor = null;

  // Update idle status before checking
  for (const worker of allWorkers) {
    const info = trackedWorkers.get(worker);
    if (info !== undefined) {
      info.idle = isWorkerIdle(info, idleThresholdMs);
    }
  }

  let message: string;
  if (format === 'short') {
    message = formatShortMessage();
  } else if (format === 'details') {
    message = formatDetailsMessage();
  } else {
    message = formatSummaryMessage();
  }

  // Clear tracking state
  // Note: WeakMap and WeakSet don't have clear(), so we just clear the Sets/Maps that track references
  allWorkers.clear();
  workerIds.clear();
  constructorCounts.clear();
  allMessagePorts.clear();
  trackedMessagePorts.clear();
  // WeakMap and WeakSet will be garbage collected when references are gone

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Convenience object providing access to worker leak detection functions.
 *
 * @property track - Starts tracking workers. See {@link trackWorkers}.
 * @property snapshot - Creates a snapshot of current workers. See {@link snapshotWorkers}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkWorkers}.
 */
export const workers = {
  track: trackWorkers,
  snapshot: snapshotWorkers,
  check: checkWorkers,
};
