import * as async_hooks from 'node:async_hooks';
import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

type PromiseState = 'pending' | 'resolved' | 'rejected' | 'handled';

type PromiseInfo = {
  id: number;
  state: PromiseState;
  createdAt: number;
  settledAt: number | null;
  creationStack: string;
  contextId: number | null;
  contextType: string | null;
  gcCyclesSurvived: number;
  lastSeenAt: number;
};

type UnhandledRejection = {
  promiseId: number;
  reason: unknown;
  stack: string;
  timestamp: number;
};

// Track all promises using WeakMap to avoid preventing GC
const promiseInfoMap = new WeakMap<Promise<unknown>, PromiseInfo>();
const promiseIdMap = new WeakMap<Promise<unknown>, number>();
let nextPromiseId = 1;

// Track promises by ID for leak detection (only pending ones)
const pendingPromises = new Map<number, Promise<unknown>>();
let initialPendingPromiseIds = new Set<number>();

// Track unhandled rejections
const unhandledRejections = new Map<number, UnhandledRejection>();

// async_hooks for context tracking
let asyncHook: async_hooks.AsyncHook | null = null;
const asyncIdToPromise = new Map<number, Promise<unknown>>();
const contextMap = new Map<number, { type: string; resource: unknown }>();
let currentContextId: number | null = null;

// GC cycle tracking
let gcCycleCount = 0;
let lastGCCycleTime = Date.now();

// Original Promise constructor and prototype methods
let OriginalPromise: typeof Promise | null = null;
let originalThen: typeof Promise.prototype.then | null = null;
let originalCatch: typeof Promise.prototype.catch | null = null;
let originalFinally: typeof Promise.prototype.finally | null = null;

// Track unhandled rejection handler
let unhandledRejectionHandler: ((reason: unknown, promise: Promise<unknown>) => void) | null = null;

/**
 * Marks a promise as settled (resolved or rejected).
 */
function markPromiseSettled(
  promise: Promise<unknown>,
  state: 'resolved' | 'rejected',
): void {
  const info = promiseInfoMap.get(promise);
  if (info !== undefined) {
    info.state = state;
    info.settledAt = Date.now();
    pendingPromises.delete(info.id);
  }
}

/**
 * Starts tracking Promise creation and settlement patterns.
 * Uses async_hooks for efficient tracking and Promise prototype hooking for settlement detection.
 *
 * @throws {Error} If leak detection is already set up. Call checkPromises() first.
 *
 * @remarks
 * - Tracks all Promise instances created after tracking starts via async_hooks
 * - Monitors settlement (resolve/reject) via Promise.prototype.then/catch/finally hooks
 * - Uses async_hooks to correlate promises with their creating context
 * - Tracks unhandled rejections separately
 * - Minimizes performance overhead by using WeakMap and efficient hooks
 *
 * @example
 * ```typescript
 * trackPromises();
 * const promise = new Promise((resolve) => setTimeout(resolve, 1000));
 * // This will be tracked
 * ```
 */
export function trackPromises(): void {
  if (OriginalPromise !== null) {
    throw new Error(
      'Promise leak detection already set up. Call checkPromises() first.',
    );
  }

  // Reset tracking state
  // Note: WeakMap doesn't support clear(), entries will be GC'd naturally
  pendingPromises.clear();
  unhandledRejections.clear();
  asyncIdToPromise.clear();
  contextMap.clear();
  initialPendingPromiseIds.clear();
  nextPromiseId = 1;
  gcCycleCount = 0;
  lastGCCycleTime = Date.now();
  currentContextId = null;

  // Store original Promise constructor and methods
  OriginalPromise = globalThis.Promise;
  originalThen = Promise.prototype.then;
  originalCatch = Promise.prototype.catch;
  originalFinally = Promise.prototype.finally;

  // Set up async_hooks for promise tracking
  asyncHook = async_hooks.createHook({
    init(asyncId: number, type: string, triggerAsyncId: number, resource: unknown): void {
      // Track all async resources for context
      contextMap.set(asyncId, { type, resource });

      // Track PROMISE resources specifically
      if (type === 'PROMISE') {
        const promise = resource as Promise<unknown>;
        // Skip if we already have info for this promise (might be from our wrapper)
        if (!promiseInfoMap.has(promise)) {
          const promiseId = nextPromiseId++;
          const now = Date.now();
          const creationStack = captureStackTrace();

          // Get context info from trigger
          const contextInfo =
            triggerAsyncId !== 0 ? contextMap.get(triggerAsyncId) : null;

          // Filter out internal Node.js promises by checking stack trace
          // Skip promises created from internal Node.js files or our own tracking code
          // But allow test files and user code
          const stackLines = creationStack.split('\n');
          let hasUserCode = false;
          let isInternalPromise = false;
          
          for (const line of stackLines) {
            // Skip empty lines and error message
            if (line.trim() === '' || line.includes('Error:')) {
              continue;
            }
            
            // Check if this is user code (test files or non-internal code)
            if (
              line.includes('.test.') ||
              line.includes('.spec.') ||
              (!line.includes('node:') &&
                !line.includes('internal/') &&
                !line.includes('stack-trace.ts') &&
                !(line.includes('promises.ts') && !line.includes('.test.')))
            ) {
              hasUserCode = true;
              break;
            }
            
            // Check if this is clearly internal
            if (
              line.includes('node:internal') ||
              line.includes('internal/') ||
              (line.includes('stack-trace.ts') && !line.includes('.test.')) ||
              (line.includes('promises.ts') &&
                !line.includes('.test.') &&
                !line.includes('.spec.'))
            ) {
              isInternalPromise = true;
            }
          }

          // Only skip if it's clearly internal and has no user code
          if (isInternalPromise && !hasUserCode) {
            return;
          }

          const promiseInfo: PromiseInfo = {
            id: promiseId,
            state: 'pending',
            createdAt: now,
            settledAt: null,
            creationStack,
            contextId: triggerAsyncId !== 0 ? triggerAsyncId : null,
            contextType: contextInfo?.type ?? null,
            gcCyclesSurvived: 0,
            lastSeenAt: now,
          };

          promiseInfoMap.set(promise, promiseInfo);
          promiseIdMap.set(promise, promiseId);
          asyncIdToPromise.set(asyncId, promise);
          pendingPromises.set(promiseId, promise);
        }
      }
    },
    before(asyncId: number): void {
      currentContextId = asyncId;
    },
    after(asyncId: number): void {
      currentContextId = null;
    },
    destroy(asyncId: number): void {
      contextMap.delete(asyncId);
      asyncIdToPromise.delete(asyncId);
    },
  });
  asyncHook.enable();

  // Hook Promise.prototype.then to detect settlement
  Promise.prototype.then = function <TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): Promise<TResult1 | TResult2> {
    const promise = this as Promise<unknown>;
    const info = promiseInfoMap.get(promise);

    // If promise is being handled, mark rejection as handled
    if (info !== undefined && onrejected !== null && onrejected !== undefined) {
      if (info.state === 'rejected') {
        info.state = 'handled';
      }
    }

    // Call original then
    const result = originalThen!.call(this, onfulfilled, onrejected);

    // Check if this promise resolves the original promise
    // We can detect settlement by checking if the result is a new promise
    if (info !== undefined && info.state === 'pending') {
      // Wrap the result promise to detect when it settles
      const resultInfo = promiseInfoMap.get(result);
      if (resultInfo === undefined) {
        // This is a chained promise, track it too
        const resultId = nextPromiseId++;
        const resultPromiseInfo: PromiseInfo = {
          id: resultId,
          state: 'pending',
          createdAt: Date.now(),
          settledAt: null,
          creationStack: info.creationStack,
          contextId: info.contextId,
          contextType: info.contextType,
          gcCyclesSurvived: 0,
          lastSeenAt: Date.now(),
        };
        promiseInfoMap.set(result, resultPromiseInfo);
        promiseIdMap.set(result, resultId);
        pendingPromises.set(resultId, result);
      }

      // If onfulfilled is provided, the original promise will resolve when this chain resolves
      // We'll detect this via the result promise's settlement
    }

    return result;
  };

  // Hook Promise.prototype.catch to detect settlement and handle rejections
  Promise.prototype.catch = function <TResult = never>(
    onrejected?:
      | ((reason: unknown) => TResult | PromiseLike<TResult>)
      | null
      | undefined,
  ): Promise<unknown | TResult> {
    const promise = this as Promise<unknown>;
    const info = promiseInfoMap.get(promise);

    // Mark as handled if there's a rejection handler
    if (info !== undefined && onrejected !== null && onrejected !== undefined) {
      if (info.state === 'rejected') {
        info.state = 'handled';
      }
    }

    return originalCatch!.call(this, onrejected);
  };

  // Hook Promise.prototype.finally to detect settlement
  Promise.prototype.finally = function (
    onfinally?: (() => void) | null | undefined,
  ): Promise<unknown> {
    return originalFinally!.call(this, onfinally);
  };

  // Track unhandled rejections
  const originalUnhandledRejectionHandlers = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');

  unhandledRejectionHandler = (reason: unknown, promise: Promise<unknown>): void => {
    const promiseId = promiseIdMap.get(promise);
    if (promiseId !== undefined) {
      const info = promiseInfoMap.get(promise);
      if (info !== undefined && info.state === 'rejected') {
        unhandledRejections.set(promiseId, {
          promiseId,
          reason,
          stack: captureStackTrace(),
          timestamp: Date.now(),
        });
      }
    }

    // Call original handlers
    for (const handler of originalUnhandledRejectionHandlers) {
      handler(reason, promise);
    }
  };

  process.on('unhandledRejection', unhandledRejectionHandler);

  // Use a more direct approach: wrap Promise constructor to track settlement
  // We'll detect settlement by wrapping resolve/reject in the executor
  // Note: async_hooks will track the PROMISE resource from OriginalPromiseConstructor
  // We need to ensure our settlement tracking matches the promise tracked by async_hooks
  const OriginalPromiseConstructor = OriginalPromise;
  globalThis.Promise = function Promise<T>(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: unknown) => void,
    ) => void,
  ): Promise<T> {
    // Create promise first - async_hooks will track this via PROMISE resource
    const promise = new OriginalPromiseConstructor<T>((resolve, reject) => {
      // Wrap resolve to detect settlement
      const wrappedResolve = (value: T | PromiseLike<T>): void => {
        markPromiseSettled(promise as Promise<unknown>, 'resolved');
        resolve(value);
      };

      // Wrap reject to detect settlement
      const wrappedReject = (reason?: unknown): void => {
        markPromiseSettled(promise as Promise<unknown>, 'rejected');
        reject(reason);
      };

      try {
        executor(wrappedResolve, wrappedReject);
      } catch (error) {
        // If executor throws synchronously, mark as rejected
        markPromiseSettled(promise as Promise<unknown>, 'rejected');
        reject(error);
      }
    }) as Promise<T>;

    // If async_hooks didn't track this promise yet, track it manually
    // This can happen if the promise is created synchronously before async_hooks processes it
    if (!promiseInfoMap.has(promise)) {
      const promiseId = nextPromiseId++;
      const now = Date.now();
      const creationStack = captureStackTrace();
      const contextInfo =
        currentContextId !== null ? contextMap.get(currentContextId) : null;

      // Filter out internal promises (same logic as async_hooks)
      const stackLines = creationStack.split('\n');
      let hasUserCode = false;
      let isInternalPromise = false;
      
      for (const line of stackLines) {
        if (line.trim() === '' || line.includes('Error:')) {
          continue;
        }
        
        if (
          line.includes('.test.') ||
          line.includes('.spec.') ||
          (!line.includes('node:') &&
            !line.includes('internal/') &&
            !line.includes('stack-trace.ts') &&
            !(line.includes('promises.ts') && !line.includes('.test.')))
        ) {
          hasUserCode = true;
          break;
        }
        
        if (
          line.includes('node:internal') ||
          line.includes('internal/') ||
          (line.includes('stack-trace.ts') && !line.includes('.test.')) ||
          (line.includes('promises.ts') &&
            !line.includes('.test.') &&
            !line.includes('.spec.'))
        ) {
          isInternalPromise = true;
        }
      }

      if (!(isInternalPromise && !hasUserCode)) {
        const promiseInfo: PromiseInfo = {
          id: promiseId,
          state: 'pending',
          createdAt: now,
          settledAt: null,
          creationStack,
          contextId: currentContextId,
          contextType: contextInfo?.type ?? null,
          gcCyclesSurvived: 0,
          lastSeenAt: now,
        };

        promiseInfoMap.set(promise, promiseInfo);
        promiseIdMap.set(promise, promiseId);
        pendingPromises.set(promiseId, promise);
      }
    }

    return promise;
  } as typeof Promise;

  // Copy static methods and properties
  Object.setPrototypeOf(globalThis.Promise, OriginalPromiseConstructor);
  Object.defineProperty(globalThis.Promise, 'prototype', {
    value: OriginalPromiseConstructor.prototype,
    writable: false,
  });

  // Wrap static methods to track settlement
  const originalResolve = OriginalPromiseConstructor.resolve.bind(OriginalPromiseConstructor);
  const originalReject = OriginalPromiseConstructor.reject.bind(OriginalPromiseConstructor);
  
  (globalThis.Promise as typeof Promise).resolve = function <T>(
    value: T | PromiseLike<T>,
  ): Promise<T> {
    const promise = originalResolve(value);
    // Mark as resolved immediately
    markPromiseSettled(promise as Promise<unknown>, 'resolved');
    return promise;
  };

  (globalThis.Promise as typeof Promise).reject = function <T = never>(
    reason?: unknown,
  ): Promise<T> {
    const promise = originalReject(reason);
    // Mark as rejected immediately
    markPromiseSettled(promise as Promise<unknown>, 'rejected');
    return promise;
  };

  // Copy other static methods
  for (const key of Object.getOwnPropertyNames(OriginalPromiseConstructor)) {
    if (
      key !== 'prototype' &&
      key !== 'length' &&
      key !== 'name' &&
      key !== 'constructor' &&
      key !== 'resolve' &&
      key !== 'reject'
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(
        OriginalPromiseConstructor,
        key,
      );
      if (descriptor !== undefined) {
        Object.defineProperty(globalThis.Promise, key, descriptor);
      }
    }
  }
}

/**
 * Updates GC cycle tracking for pending promises.
 * Should be called after each GC cycle.
 */
function updateGCCycleTracking(): void {
  gcCycleCount++;
  const now = Date.now();

  for (const [promiseId, promise] of pendingPromises.entries()) {
    const info = promiseInfoMap.get(promise);
    if (info !== undefined) {
      // If promise survived since last GC, increment counter
      if (now - info.lastSeenAt > 100) {
        // Approximate: if promise is old, it likely survived GC
        info.gcCyclesSurvived++;
      }
      info.lastSeenAt = now;
    }
  }

  lastGCCycleTime = now;
}

export type PromisesSnapshot = {
  pending: number;
  resolved: number;
  rejected: number;
  unhandledRejections: number;
  pendingByContext: Record<string, number>;
};

/**
 * Creates a snapshot of all currently tracked promises.
 * Returns counts of promises by state and unhandled rejections.
 *
 * @returns A snapshot of promise states and unhandled rejections.
 *
 * @example
 * ```typescript
 * trackPromises();
 * new Promise((resolve) => setTimeout(resolve, 1000));
 * const snapshot = snapshotPromises();
 * // snapshot = { pending: 1, resolved: 0, rejected: 0, unhandledRejections: 0, pendingByContext: {} }
 * ```
 */
export function snapshotPromises(): PromisesSnapshot {
  const snapshot: PromisesSnapshot = {
    pending: 0,
    resolved: 0,
    rejected: 0,
    unhandledRejections: unhandledRejections.size,
    pendingByContext: {},
  };

  for (const [promiseId, promise] of pendingPromises.entries()) {
    const info = promiseInfoMap.get(promise);
    if (info !== undefined) {
      snapshot.pending++;

      // Group by context type
      const contextType = info.contextType ?? 'unknown';
      snapshot.pendingByContext[contextType] =
        (snapshot.pendingByContext[contextType] ?? 0) + 1;
    }
  }

  // Count settled promises
  // Note: WeakMap doesn't support iteration, so we track settled promises
  // by checking pendingPromises - if a promise isn't pending, it's settled
  // We can't accurately count all settled promises without iterating WeakMap,
  // so we'll only count pending ones here

  return snapshot;
}

/**
 * Formats leak message in short format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(
  leakedPromises: Array<{ info: PromiseInfo; promiseId: number }>,
  unhandledCount: number,
): string {
  const lines: string[] = [];

  if (leakedPromises.length > 0) {
    lines.push(
      `Promise leaks detected: ${leakedPromises.length} leaked promise(s)`,
    );
  }

  if (unhandledCount > 0) {
    lines.push(
      `Unhandled promise rejections detected: ${unhandledCount} unhandled rejection(s)`,
    );
  }

  return lines.join('\n');
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(
  leakedPromises: Array<{ info: PromiseInfo; promiseId: number }>,
  unhandledRejectionsList: UnhandledRejection[],
): string {
  const lines: string[] = [];
  let hasLeaks = false;

  if (leakedPromises.length > 0) {
    hasLeaks = true;
    lines.push('Promise leaks detected:');
    for (const { info } of leakedPromises) {
      const formattedStack = formatStackTrace(info.creationStack, ['promises.ts']);
      const contextInfo =
        info.contextType !== null ? ` [context: ${info.contextType}]` : '';
      const gcInfo =
        info.gcCyclesSurvived > 0
          ? ` (survived ${info.gcCyclesSurvived} GC cycle(s))`
          : '';

      if (formattedStack !== '') {
        lines.push(`  Promise${contextInfo}${gcInfo} ${formattedStack}`);
      } else {
        lines.push(`  Promise${contextInfo}${gcInfo}`);
      }
    }
  }

  if (unhandledRejectionsList.length > 0) {
    hasLeaks = true;
    lines.push('Unhandled promise rejections detected:');
    for (const rejection of unhandledRejectionsList) {
      const promise = pendingPromises.get(rejection.promiseId);
      const info =
        promise !== undefined ? promiseInfoMap.get(promise) : undefined;
      const formattedStack =
        info !== undefined
          ? formatStackTrace(info.creationStack, ['promises.ts'])
          : '';

      if (formattedStack !== '') {
        lines.push(`  Unhandled rejection ${formattedStack}`);
      } else {
        lines.push('  Unhandled rejection');
      }
    }
  }

  return hasLeaks ? lines.join('\n') : '';
}

/**
 * Formats leak message in details format with stack traces.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatDetailsMessage(
  leakedPromises: Array<{ info: PromiseInfo; promiseId: number }>,
  unhandledRejectionsList: UnhandledRejection[],
): string {
  const lines: string[] = [];
  let hasLeaks = false;

  if (leakedPromises.length > 0) {
    hasLeaks = true;
    lines.push('Promise leaks detected:');
    for (const { info } of leakedPromises) {
      const formattedStack = formatStackTrace(info.creationStack, ['promises.ts']);
      const contextInfo =
        info.contextType !== null ? ` [context: ${info.contextType}]` : '';
      const gcInfo =
        info.gcCyclesSurvived > 0
          ? ` (survived ${info.gcCyclesSurvived} GC cycle(s))`
          : '';

      lines.push(`  Promise${contextInfo}${gcInfo}`);
      if (formattedStack !== '') {
        lines.push(`    Created at: ${formattedStack}`);
      }
      if (info.contextId !== null) {
        const contextInfo = contextMap.get(info.contextId);
        if (contextInfo !== null && contextInfo !== undefined) {
          lines.push(`    Context: ${contextInfo.type}`);
        }
      }
    }
  }

  if (unhandledRejectionsList.length > 0) {
    hasLeaks = true;
    lines.push('Unhandled promise rejections detected:');
    for (const rejection of unhandledRejectionsList) {
      const promise = pendingPromises.get(rejection.promiseId);
      const info =
        promise !== undefined ? promiseInfoMap.get(promise) : undefined;

      lines.push(`  Promise #${rejection.promiseId}`);
      if (info !== undefined) {
        const formattedStack = formatStackTrace(info.creationStack, ['promises.ts']);
        if (formattedStack !== '') {
          lines.push(`    Created at: ${formattedStack}`);
        }
      }
      const rejectionStack = formatStackTrace(rejection.stack, ['promises.ts']);
      if (rejectionStack !== '') {
        lines.push(`    Rejected at: ${rejectionStack}`);
      }
      if (rejection.reason !== null && rejection.reason !== undefined) {
        const reasonStr =
          rejection.reason instanceof Error
            ? rejection.reason.message
            : String(rejection.reason);
        lines.push(`    Reason: ${reasonStr}`);
      }
    }
  }

  return hasLeaks ? lines.join('\n') : '';
}

/**
 * Checks for promise leaks by identifying promises that never resolve or reject.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only
 * - `"summary"`: List of leaked promises with stack traces
 * - `"details"`: Detailed output with full context information
 *
 * @throws {Error} If leak detection is not set up. Call trackPromises() first.
 * @throws {Error} If promise leaks are detected, with details about each leak.
 *
 * @remarks Restores original Promise constructor and clears tracking state.
 *
 * @example
 * ```typescript
 * trackPromises();
 * new Promise((resolve) => setTimeout(resolve, 1000));
 * // ... later ...
 * await checkPromises({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkPromises(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
}): Promise<void> {
  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
  } = options ?? {};

  if (OriginalPromise === null) {
    throw new Error(
      'Promise leak detection not set up. Call trackPromises() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
    updateGCCycleTracking();
  }

  // Disable async_hooks
  if (asyncHook !== null) {
    asyncHook.disable();
    asyncHook = null;
  }

  // Restore original Promise constructor and prototype methods
  globalThis.Promise = OriginalPromise;
  Promise.prototype.then = originalThen!;
  Promise.prototype.catch = originalCatch!;
  Promise.prototype.finally = originalFinally!;

  // Remove unhandled rejection handler
  if (unhandledRejectionHandler !== null) {
    process.removeListener('unhandledRejection', unhandledRejectionHandler);
    unhandledRejectionHandler = null;
  }

  OriginalPromise = null;
  originalThen = null;
  originalCatch = null;
  originalFinally = null;

  // Collect leaked promises (all pending ones are considered leaks)
  const leakedPromises: Array<{ info: PromiseInfo; promiseId: number }> = [];

  for (const [promiseId, promise] of pendingPromises.entries()) {
    const info = promiseInfoMap.get(promise);
    if (info !== undefined) {
      leakedPromises.push({ info, promiseId });
    }
  }

  // Collect unhandled rejections
  const unhandledRejectionsList = Array.from(unhandledRejections.values());

  let message: string;
  if (format === 'short') {
    message = formatShortMessage(leakedPromises, unhandledRejectionsList.length);
  } else if (format === 'details') {
    message = formatDetailsMessage(leakedPromises, unhandledRejectionsList);
  } else {
    message = formatSummaryMessage(leakedPromises, unhandledRejectionsList);
  }

  // Clear tracking state
  // Note: WeakMap doesn't support clear(), entries will be GC'd naturally
  pendingPromises.clear();
  unhandledRejections.clear();
  asyncIdToPromise.clear();
  contextMap.clear();
  initialPendingPromiseIds.clear();
  currentContextId = null;

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Convenience object providing access to promise leak detection functions.
 *
 * @property track - Starts tracking promises. See {@link trackPromises}.
 * @property snapshot - Creates a snapshot of current promises. See {@link snapshotPromises}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkPromises}.
 */
export const promises = {
  track: trackPromises,
  snapshot: snapshotPromises,
  check: checkPromises,
};
