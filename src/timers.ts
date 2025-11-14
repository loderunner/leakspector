import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

type TimerType = 'setTimeout' | 'setInterval';

type TimerInfo = {
  id: number;
  type: TimerType;
  stack: string;
  cleared: boolean;
};

let initialTimerIds = new Set<number>();
const trackedTimers = new Map<number, TimerInfo>();

let originalSetTimeout: typeof setTimeout | null = null;
let originalSetInterval: typeof setInterval | null = null;
let originalClearTimeout: typeof clearTimeout | null = null;
let originalClearInterval: typeof clearInterval | null = null;

/**
 * Starts tracking setTimeout and setInterval calls.
 * Must be called before creating timers to track.
 *
 * @throws {Error} If leak detection is already set up. Call checkTimers() first.
 *
 * @remarks Patches global setTimeout/setInterval to monitor timer creation.
 *
 * @example
 * ```typescript
 * trackTimers();
 * setTimeout(() => {}, 1000); // This will be tracked
 * ```
 */
export function trackTimers(): void {
  if (originalSetTimeout !== null) {
    throw new Error(
      'Timer leak detection already set up. Call checkTimers() first.',
    );
  }

  // Capture all existing timers as initial state
  initialTimerIds = new Set<number>();
  trackedTimers.clear();

  originalSetTimeout = globalThis.setTimeout;
  originalSetInterval = globalThis.setInterval;
  originalClearTimeout = globalThis.clearTimeout;
  originalClearInterval = globalThis.clearInterval;

  /**
   * Converts a timer ID to a numeric ID for Map storage.
   * Handles NodeJS.Timeout objects (which can be coerced to numbers),
   * numbers, and strings.
   */
  function timerToNumericId(
    timer: NodeJS.Timeout | string | number | undefined,
  ): number | undefined {
    if (timer === undefined) {
      return undefined;
    }
    if (typeof timer === 'number') {
      return timer;
    }
    if (typeof timer === 'string') {
      const num = Number(timer);
      return Number.isNaN(num) ? undefined : num;
    }
    // NodeJS.Timeout has [Symbol.toPrimitive]() that returns a number
    return Number(timer);
  }

  // Define patched setTimeout with explicit overload signatures
  function patchedSetTimeout<TArgs extends any[]>(
    this: void,
    callback: (...args: TArgs) => void,
    delay?: number,
    ...args: TArgs
  ): NodeJS.Timeout;
  function patchedSetTimeout(
    this: void,
    callback: (_: void) => void,
    delay?: number,
  ): NodeJS.Timeout;
  function patchedSetTimeout<TArgs extends any[]>(
    this: void,
    callback: ((...args: TArgs) => void) | ((_: void) => void),
    delay?: number,
    ...args: TArgs
  ): NodeJS.Timeout {
    // Wrap callback to preserve `this` binding that Node.js provides.
    // Node.js binds the timer object as `this` when calling the callback.
    // Our wrapper captures that `this` and passes it to the original callback.
    const wrappedCallback =
      args.length === 0 && callback.length === 1
        ? function (this: NodeJS.Timeout, _: void): void {
            (callback as (_: void) => void).call(this, _);
          }
        : function (this: NodeJS.Timeout, ...callbackArgs: TArgs): void {
            (callback as (...args: TArgs) => void).call(this, ...callbackArgs);
          };

    // Use Function.prototype.apply to handle variable arguments
    // Construct arguments array: [callback, delay?, ...args]
    const applyArgs: unknown[] = [wrappedCallback];
    if (delay !== undefined) {
      applyArgs.push(delay);
    }
    for (let i = 0; i < args.length; i++) {
      applyArgs.push(args[i]);
    }
    const timer = Function.prototype.apply.call(
      originalSetTimeout!,
      this,
      applyArgs,
    ) as NodeJS.Timeout;

    const numericId = timerToNumericId(timer)!;
    const stack = captureStackTrace();
    trackedTimers.set(numericId, {
      id: numericId,
      type: 'setTimeout',
      stack,
      cleared: false,
    });
    return timer;
  }
  patchedSetTimeout.__promisify__ = originalSetTimeout.__promisify__;
  globalThis.setTimeout = patchedSetTimeout as typeof setTimeout;

  // Define patched setInterval with explicit overload signatures
  function patchedSetInterval<TArgs extends any[]>(
    this: void,
    callback: (...args: TArgs) => void,
    delay?: number,
    ...args: TArgs
  ): NodeJS.Timeout;
  function patchedSetInterval(
    this: void,
    callback: (_: void) => void,
    delay?: number,
  ): NodeJS.Timeout;
  function patchedSetInterval<TArgs extends any[]>(
    this: void,
    callback: ((...args: TArgs) => void) | ((_: void) => void),
    delay?: number,
    ...args: TArgs
  ): NodeJS.Timeout {
    // Wrap callback to preserve `this` binding that Node.js provides
    const wrappedCallback =
      args.length === 0 && callback.length === 1
        ? function (this: NodeJS.Timeout, _: void): void {
            (callback as (_: void) => void).call(this, _);
          }
        : function (this: NodeJS.Timeout, ...callbackArgs: TArgs): void {
            (callback as (...args: TArgs) => void).call(this, ...callbackArgs);
          };

    // Use Function.prototype.apply to handle variable arguments
    // Construct arguments array: [callback, delay?, ...args]
    const applyArgs: unknown[] = [wrappedCallback];
    if (delay !== undefined) {
      applyArgs.push(delay);
    }
    for (let i = 0; i < args.length; i++) {
      applyArgs.push(args[i]);
    }
    const timer = Function.prototype.apply.call(
      originalSetInterval!,
      this,
      applyArgs,
    ) as NodeJS.Timeout;

    const numericId = timerToNumericId(timer)!;
    const stack = captureStackTrace();
    trackedTimers.set(numericId, {
      id: numericId,
      type: 'setInterval',
      stack,
      cleared: false,
    });
    return timer;
  }
  globalThis.setInterval = patchedSetInterval as typeof setInterval;

  globalThis.clearTimeout = function (
    this: void,
    timeout: NodeJS.Timeout | string | number | undefined,
  ): void {
    const numericId = timerToNumericId(timeout);
    if (numericId !== undefined) {
      const timerInfo = trackedTimers.get(numericId);
      if (timerInfo !== undefined) {
        timerInfo.cleared = true;
      }
    }
    return originalClearTimeout!.call(this, timeout);
  };

  globalThis.clearInterval = function (
    this: void,
    timeout: NodeJS.Timeout | string | number | undefined,
  ): void {
    const numericId = timerToNumericId(timeout);
    if (numericId !== undefined) {
      const timerInfo = trackedTimers.get(numericId);
      if (timerInfo !== undefined) {
        timerInfo.cleared = true;
      }
    }
    return originalClearInterval!.call(this, timeout);
  };
}

export type TimersSnapshot = Record<TimerType, number>;

/**
 * Creates a snapshot of all currently tracked timers.
 * Returns a count of active (non-cleared) timers by type.
 *
 * @returns A record of active timers by type.
 *
 * @example
 * ```typescript
 * trackTimers();
 * setTimeout(() => {}, 1000);
 * const snapshot = snapshotTimers();
 * // snapshot = { setTimeout: 1, setInterval: 0 }
 * ```
 */
export function snapshotTimers(): TimersSnapshot {
  const snapshot: TimersSnapshot = {
    setTimeout: 0,
    setInterval: 0,
  };
  for (const timerInfo of trackedTimers.values()) {
    if (!timerInfo.cleared) {
      snapshot[timerInfo.type]++;
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
  let leakedCount = 0;
  for (const timerInfo of trackedTimers.values()) {
    if (!timerInfo.cleared) {
      leakedCount++;
    }
  }

  if (leakedCount === 0) {
    return '';
  }

  return `Timer leaks detected: ${leakedCount} leaked timer(s)`;
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const leakedTimers: TimerInfo[] = [];
  for (const timerInfo of trackedTimers.values()) {
    if (!timerInfo.cleared) {
      leakedTimers.push(timerInfo);
    }
  }

  if (leakedTimers.length === 0) {
    return '';
  }

  const lines: string[] = ['Timer leaks detected:'];
  for (const timerInfo of leakedTimers) {
    const formattedStack = formatStackTrace(timerInfo.stack);
    if (formattedStack !== '') {
      lines.push(`  ${timerInfo.type} ${formattedStack}`);
    } else {
      lines.push(`  ${timerInfo.type}`);
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
  const leakedTimers: TimerInfo[] = [];
  for (const timerInfo of trackedTimers.values()) {
    if (!timerInfo.cleared) {
      leakedTimers.push(timerInfo);
    }
  }

  if (leakedTimers.length === 0) {
    return '';
  }

  const lines: string[] = ['Timer leaks detected:'];
  for (const timerInfo of leakedTimers) {
    const formattedStack = formatStackTrace(timerInfo.stack);
    if (formattedStack !== '') {
      lines.push(`  ${timerInfo.type} ${formattedStack}`);
    } else {
      lines.push(`  ${timerInfo.type}`);
    }
  }

  return lines.join('\n');
}

/**
 * Checks for timer leaks by checking for non-cleared timers.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only (e.g. `"Timer leaks detected: 5 leaked timer(s)"`)
 * - `"summary"`: List of leaked timers with stack traces
 * - `"details"`: Same as summary (timers don't have additional details like event listeners)
 *
 * @throws {Error} If leak detection is not set up. Call trackTimers() first.
 * @throws {Error} If timer leaks are detected, with details about each leak.
 *
 * @remarks Restores original timer functions and clears tracking state.
 *
 * @example
 * ```typescript
 * trackTimers();
 * setTimeout(() => {}, 1000);
 * // ... later ...
 * await checkTimers({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkTimers(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
}): Promise<void> {
  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
  } = options ?? {};

  if (originalSetTimeout === null) {
    throw new Error(
      'Timer leak detection not set up. Call trackTimers() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
  }

  globalThis.setTimeout = originalSetTimeout;
  globalThis.setInterval = originalSetInterval!;
  globalThis.clearTimeout = originalClearTimeout!;
  globalThis.clearInterval = originalClearInterval!;

  originalSetTimeout = null;
  originalSetInterval = null;
  originalClearTimeout = null;
  originalClearInterval = null;

  let message: string;
  if (format === 'short') {
    message = formatShortMessage();
  } else if (format === 'details') {
    message = formatDetailsMessage();
  } else {
    message = formatSummaryMessage();
  }

  initialTimerIds.clear();
  trackedTimers.clear();

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Convenience object providing access to timer leak detection functions.
 *
 * @property track - Starts tracking timers. See {@link trackTimers}.
 * @property snapshot - Creates a snapshot of current timers. See {@link snapshotTimers}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkTimers}.
 */
export const timers = {
  track: trackTimers,
  snapshot: snapshotTimers,
  check: checkTimers,
};
