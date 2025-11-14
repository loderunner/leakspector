import { ChildProcess } from 'node:child_process';
import { Worker } from 'node:cluster';
import { EventEmitter } from 'node:events';
import { ReadStream, WriteStream } from 'node:fs';
import { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { Server, Socket } from 'node:net';

import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

type EventName = string | symbol;
type EventCounts = Record<EventName, number>;
export type ListenersSnapshot = Record<string, EventCounts>;

type ListenerAddition = {
  eventName: EventName;
  method: 'on' | 'once' | 'addListener';
  fn: (...args: unknown[]) => void;
  stack: string;
  removed: boolean;
};

let emitterInitialState = new WeakMap<EventEmitter<any>, EventCounts>();
const allEmitters = new Set<EventEmitter<any>>();
const emitterIds = new WeakMap<EventEmitter<any>, string>();
const constructorCounts = new Map<string, number>();
let listenerAdditions = new WeakMap<EventEmitter<any>, ListenerAddition[]>();

let originalOn: typeof EventEmitter.prototype.on | null = null;
let originalAddListener: typeof EventEmitter.prototype.addListener | null =
  null;
let originalOnce: typeof EventEmitter.prototype.once | null = null;
let originalRemoveListener:
  | typeof EventEmitter.prototype.removeListener
  | null = null;
let originalOff: typeof EventEmitter.prototype.off | null = null;

/**
 * Custom stringifier function for identifying EventEmitter instances.
 * Return a string to identify the emitter, or null/undefined to pass to the next stringifier.
 */
export type EmitterStringifier = (
  emitter: EventEmitter<any>,
) => string | null | undefined;

const customStringifiers: EmitterStringifier[] = [];

/**
 * Registers a custom stringifier function for identifying EventEmitter instances.
 * Custom stringifiers are checked before built-in stringifiers.
 *
 * @param stringifier - Function that takes an EventEmitter and returns a string identifier, or null/undefined to pass through.
 *
 * @example
 * ```typescript
 * registerEmitterStringifier((emitter) => {
 *   if (emitter instanceof MyCustomEmitter) {
 *     return `MyCustomEmitter (id: ${emitter.id})`;
 *   }
 *   return null; // or undefined, or implicit return
 * });
 * ```
 */
export function registerEmitterStringifier(
  stringifier: EmitterStringifier,
): void {
  customStringifiers.push(stringifier);
}

/**
 * Clears all registered custom stringifiers.
 * Useful for test isolation.
 */
export function clearEmitterStringifiers(): void {
  customStringifiers.length = 0;
}

function stringifyKnownEmitter(emitter: EventEmitter<any>): string | null {
  try {
    // Check custom stringifiers first
    for (const stringifier of customStringifiers) {
      const result = stringifier(emitter);
      if (result !== null && result !== undefined) {
        return result;
      }
    }

    // net.Socket - check first since Socket might have address() method too
    if (emitter instanceof Socket) {
      if (
        emitter.remoteAddress !== undefined &&
        emitter.remotePort !== undefined
      ) {
        return `Socket (${emitter.remoteAddress}:${emitter.remotePort})`;
      }
      if (emitter.localPort !== undefined) {
        const addr = emitter.localAddress ?? '0.0.0.0';
        return `Socket (${addr}:${emitter.localPort})`;
      }
      return 'Socket (not connected)';
    }

    // net.Server
    if (emitter instanceof Server) {
      const address = emitter.address();
      if (address !== null) {
        if (typeof address === 'string') {
          return `Server (${address})`;
        }
        return `Server (${address.address}:${address.port})`;
      }
      return 'Server (not listening)';
    }

    // fs.ReadStream
    if (emitter instanceof ReadStream) {
      const path =
        typeof emitter.path === 'string'
          ? emitter.path
          : emitter.path.toString();
      return `ReadStream (${path})`;
    }

    // fs.WriteStream
    if (emitter instanceof WriteStream) {
      const path =
        typeof emitter.path === 'string'
          ? emitter.path
          : emitter.path.toString();
      return `WriteStream (${path})`;
    }

    // child_process.ChildProcess
    if (emitter instanceof ChildProcess) {
      return `ChildProcess (pid ${emitter.pid})`;
    }

    // cluster.Worker
    if (emitter instanceof Worker) {
      return `Worker (id ${emitter.id})`;
    }

    // http.ServerResponse
    if (emitter instanceof ServerResponse) {
      return `ServerResponse (${emitter.statusCode})`;
    }

    // http.ClientRequest
    if (emitter instanceof ClientRequest) {
      const method = emitter.method;
      const hostHeader = emitter.getHeader('host');
      const host =
        typeof hostHeader === 'string'
          ? hostHeader
          : Array.isArray(hostHeader)
            ? hostHeader[0]
            : 'unknown';
      const path = emitter.path;
      return `ClientRequest (${method} ${host}${path})`;
    }

    // http.IncomingMessage
    if (emitter instanceof IncomingMessage) {
      if (emitter.url !== undefined && emitter.method !== undefined) {
        return `IncomingMessage (${emitter.method} ${emitter.url})`;
      }
      return 'IncomingMessage';
    }
  } catch {
    // Property access might throw, fall through to generic ID
  }

  return null;
}

function getEmitterId(emitter: EventEmitter<any>): string {
  const existing = emitterIds.get(emitter);
  if (existing !== undefined) {
    return existing;
  }

  // Try to get a meaningful identifier from known types
  const knownId = stringifyKnownEmitter(emitter);
  if (knownId !== null) {
    emitterIds.set(emitter, knownId);
    return knownId;
  }

  // Fallback to constructor name + sequential number
  const constructorName = emitter.constructor.name;
  const currentCount = constructorCounts.get(constructorName) ?? 0;
  const nextCount = currentCount + 1;
  constructorCounts.set(constructorName, nextCount);

  const id = `${constructorName}#${nextCount}`;
  emitterIds.set(emitter, id);
  return id;
}

/**
 * Starts tracking event listeners on all EventEmitter instances.
 * Must be called before creating EventEmitter instances to track.
 *
 * @throws {Error} If leak detection is already set up. Call checkEventListeners() first.
 *
 * @remarks Patches EventEmitter prototype methods to monitor listener registration.
 *
 * @example
 * ```typescript
 * trackEventListeners();
 * const emitter = new EventEmitter();
 * emitter.on('data', handler); // This will be tracked
 * ```
 */
export function trackEventListeners(): void {
  if (originalOn !== null) {
    throw new Error(
      'Event listener leak detection already set up. Call checkEventListeners() first.',
    );
  }

  originalOn = EventEmitter.prototype.on;
  originalAddListener = EventEmitter.prototype.addListener;
  originalOnce = EventEmitter.prototype.once;
  originalRemoveListener = EventEmitter.prototype.removeListener;
  originalOff = EventEmitter.prototype.off;

  EventEmitter.prototype.on = EventEmitter.prototype.addListener = function (
    ...args: Parameters<typeof EventEmitter.prototype.on>
  ) {
    // For emitters created before tracking started, initialize them now
    if (!allEmitters.has(this)) {
      allEmitters.add(this);
      getEmitterId(this);
      const initialState: Record<string | symbol, number> = {};
      const eventNames = this.eventNames();
      for (const eventName of eventNames) {
        initialState[eventName] = this.listenerCount(eventName);
      }
      emitterInitialState.set(this, initialState);
      listenerAdditions.set(this, []);
    }

    const [eventName, listener] = args;
    if (eventName !== undefined) {
      const stack = captureStackTrace();
      const additions = listenerAdditions.get(this) ?? [];
      additions.push({
        eventName: eventName as EventName,
        method: 'on',
        fn: listener as (...args: unknown[]) => void,
        stack,
        removed: false,
      });
      listenerAdditions.set(this, additions);
    }

    return originalOn!.apply(this, args);
  };

  EventEmitter.prototype.once = function (
    ...args: Parameters<typeof EventEmitter.prototype.once>
  ) {
    // For emitters created before tracking started, initialize them now
    if (!allEmitters.has(this)) {
      allEmitters.add(this);
      getEmitterId(this);
      const initialState: Record<string | symbol, number> = {};
      const eventNames = this.eventNames();
      for (const eventName of eventNames) {
        initialState[eventName] = this.listenerCount(eventName);
      }
      emitterInitialState.set(this, initialState);
      listenerAdditions.set(this, []);
    }

    const [eventName, listener] = args;
    if (eventName !== undefined) {
      const stack = captureStackTrace();
      const additions = listenerAdditions.get(this) ?? [];
      additions.push({
        eventName: eventName as EventName,
        method: 'once',
        fn: listener as (...args: unknown[]) => void,
        stack,
        removed: false,
      });
      listenerAdditions.set(this, additions);
    }

    return originalOnce!.apply(this, args);
  };

  EventEmitter.prototype.removeListener = EventEmitter.prototype.off =
    function (
      ...args: Parameters<typeof EventEmitter.prototype.removeListener>
    ) {
      const [eventName, listener] = args;
      if (eventName !== undefined) {
        const additions = listenerAdditions.get(this);
        if (additions !== undefined) {
          // Find the first matching addition that hasn't been removed
          const addition = additions.find(
            (a) => a.eventName === eventName && a.fn === listener && !a.removed,
          );
          if (addition !== undefined) {
            addition.removed = true;
          }
        }
      }
      return originalRemoveListener!.apply(this, args);
    };
}

/**
 * Creates a snapshot of all currently tracked event listeners.
 * Returns a record mapping emitter names to their event listener counts.
 *
 * @returns A snapshot of all tracked listeners, keyed by emitter constructor name.
 *
 * @example
 * ```typescript
 * trackEventListeners();
 * const emitter = new EventEmitter();
 * emitter.on('data', handler);
 * const snapshot = snapshotEventListeners();
 * // snapshot = { 'EventEmitter#1': { 'data': 1 } }
 * ```
 */
export function snapshotEventListeners(): ListenersSnapshot {
  const snapshot: ListenersSnapshot = {};

  for (const emitter of allEmitters) {
    const eventNames = emitter.eventNames();
    const emitterSnapshot: EventCounts = {};

    for (const eventName of eventNames) {
      emitterSnapshot[eventName] = emitter.listenerCount(eventName);
    }

    const emitterId = getEmitterId(emitter);
    snapshot[emitterId] = emitterSnapshot;
  }

  return snapshot;
}

/**
 * Checks for event listener leaks by comparing current listener counts against initial state.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only (e.g. `"Event listener leaks detected: 5 leaked listener(s)"`)
 * - `"summary"`: List of leaked events with counts
 * - `"details"`: Detailed output with stack traces showing where EventEmitters were created and where listeners were added
 *
 * @throws {Error} If leak detection is not set up. Call trackEventListeners() first.
 * @throws {Error} If event listener leaks are detected, with details about each leak.
 *
 * @remarks Restores original EventEmitter prototype methods and clears tracking state.
 *
 * @example
 * ```typescript
 * trackEventListeners();
 * const emitter = new EventEmitter();
 * emitter.on('data', handler);
 * // ... later ...
 * await checkEventListeners({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkEventListeners(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
}): Promise<void> {
  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
  } = options ?? {};

  if (originalOn === null) {
    throw new Error(
      'Event listener leak detection not set up. Call trackEventListeners() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
  }

  EventEmitter.prototype.on = originalOn;
  EventEmitter.prototype.addListener = originalAddListener!;
  EventEmitter.prototype.once = originalOnce!;
  EventEmitter.prototype.removeListener = originalRemoveListener!;
  EventEmitter.prototype.off = originalOff!;

  originalOn = null;
  originalAddListener = null;
  originalOnce = null;
  originalRemoveListener = null;
  originalOff = null;

  let message: string;
  if (format === 'short') {
    message = formatShortMessage();
  } else if (format === 'details') {
    message = formatDetailsMessage();
  } else {
    message = formatSummaryMessage();
  }

  allEmitters.clear();
  emitterInitialState = new WeakMap<EventEmitter<any>, EventCounts>();
  constructorCounts.clear();
  listenerAdditions = new WeakMap<EventEmitter<any>, ListenerAddition[]>();

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Formats leak message in short format.
 * Iterates over emitters directly to count leaked listeners.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(): string {
  let totalLeaked = 0;

  for (const emitter of allEmitters) {
    const initialState = emitterInitialState.get(emitter);
    if (initialState === undefined) {
      continue;
    }

    const currentEvents = emitter.eventNames();
    for (const eventName of currentEvents) {
      const expectedCount = initialState[eventName] ?? 0;
      const actualCount = emitter.listenerCount(eventName);
      if (actualCount > expectedCount) {
        totalLeaked += actualCount - expectedCount;
      }
    }
  }

  if (totalLeaked === 0) {
    return '';
  }

  return `Event listener leaks detected: ${totalLeaked} leaked listener(s)`;
}

/**
 * Formats leak message in summary format.
 * Iterates over emitters directly to format each leak.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const lines: string[] = [];
  let hasLeaks = false;

  for (const emitter of allEmitters) {
    const initialState = emitterInitialState.get(emitter);
    if (initialState === undefined) {
      continue;
    }

    const emitterId = getEmitterId(emitter);
    const currentEvents = emitter.eventNames();

    for (const eventName of currentEvents) {
      const expectedCount = initialState[eventName] ?? 0;
      const actualCount = emitter.listenerCount(eventName);

      if (actualCount > expectedCount) {
        if (!hasLeaks) {
          lines.push('Event listener leaks detected:');
          hasLeaks = true;
        }
        lines.push(
          `  '${emitterId}.${String(eventName)}': expected ${expectedCount} listener(s), found ${actualCount} (+${actualCount - expectedCount} leaked)`,
        );
      }
    }
  }

  return lines.join('\n');
}

/**
 * Formats leak message in details format with stack traces.
 * Iterates over emitters directly, grouping by emitter and event.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatDetailsMessage(): string {
  const lines: string[] = [];
  let hasLeaks = false;

  // Iterate over all tracked emitters
  for (const emitter of allEmitters) {
    const initialState = emitterInitialState.get(emitter);
    if (initialState === undefined) {
      continue;
    }

    const emitterId = getEmitterId(emitter);
    // All listener additions for this emitter (includes removed ones)
    const additions = listenerAdditions.get(emitter) ?? [];
    const eventNames = emitter.eventNames();
    // Collect leaks for this emitter: events with more listeners than expected
    const leaks: Array<{
      eventName: EventName;
      expected: number;
      actual: number;
    }> = [];

    // First pass: identify which events have leaks
    for (const eventName of eventNames) {
      const expectedCount = initialState[eventName] ?? 0;
      const actualCount = emitter.listenerCount(eventName);

      if (actualCount > expectedCount) {
        leaks.push({
          eventName,
          expected: expectedCount,
          actual: actualCount,
        });
      }
    }

    // If this emitter has leaks, output emitter header and leak details
    if (leaks.length > 0) {
      if (!hasLeaks) {
        lines.push('Event listener leaks detected:');
        hasLeaks = true;
      }

      lines.push(`  ${emitterId}`);

      // Second pass: for each leaked event, show which listeners leaked
      for (const leak of leaks) {
        const leakedCount = leak.actual - leak.expected;
        lines.push(
          `  > '${String(leak.eventName)}': expected ${leak.expected} listener(s), found ${leak.actual} (+${leakedCount} leaked)`,
        );

        // Filter additions to find only the ones that weren't removed (i.e., leaked)
        const leakedAdditions = additions.filter(
          (a) => a.eventName === leak.eventName && !a.removed,
        );
        // Output stack trace for each leaked listener addition
        for (const addition of leakedAdditions) {
          const formattedAdditionStack = formatStackTrace(addition.stack);
          if (formattedAdditionStack !== '') {
            lines.push(
              `      * ${addition.method}('${String(leak.eventName)}') ${formattedAdditionStack}`,
            );
          } else {
            lines.push(
              `      * ${addition.method}('${String(leak.eventName)}')`,
            );
          }
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Convenience object providing access to event listener leak detection functions.
 *
 * @property track - Starts tracking event listeners. See {@link trackEventListeners}.
 * @property snapshot - Creates a snapshot of current listeners. See {@link snapshotEventListeners}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkEventListeners}.
 */
export const eventListeners = {
  track: trackEventListeners,
  snapshot: snapshotEventListeners,
  check: checkEventListeners,
};
