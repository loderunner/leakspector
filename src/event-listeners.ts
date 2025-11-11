import { ChildProcess } from 'node:child_process';
import { Worker } from 'node:cluster';
import { EventEmitter } from 'node:events';
import { ReadStream, WriteStream } from 'node:fs';
import { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { Server, Socket } from 'node:net';

import { forceGarbageCollection } from './force-gc';

type EventName = string | symbol;
type EventCounts = Record<EventName, number>;
type ListenersSnapshot = Record<string, EventCounts>;

let emitterInitialState = new WeakMap<EventEmitter<any>, EventCounts>();
const allEmitters = new Set<EventEmitter<any>>();
const emitterIds = new WeakMap<EventEmitter<any>, string>();
const constructorCounts = new Map<string, number>();

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
    if (!allEmitters.has(this)) {
      allEmitters.add(this);
      getEmitterId(this);
      const initialState: Record<string | symbol, number> = {};
      const eventNames = this.eventNames();
      for (const eventName of eventNames) {
        initialState[eventName] = this.listenerCount(eventName);
      }
      emitterInitialState.set(this, initialState);
    }
    return originalOn!.apply(this, args);
  };

  EventEmitter.prototype.once = function (
    ...args: Parameters<typeof EventEmitter.prototype.once>
  ) {
    if (!allEmitters.has(this)) {
      allEmitters.add(this);
      getEmitterId(this);
      const initialState: Record<string | symbol, number> = {};
      const eventNames = this.eventNames();
      for (const eventName of eventNames) {
        initialState[eventName] = this.listenerCount(eventName);
      }
      emitterInitialState.set(this, initialState);
    }
    return originalOnce!.apply(this, args);
  };

  EventEmitter.prototype.removeListener = EventEmitter.prototype.off =
    function (
      ...args: Parameters<typeof EventEmitter.prototype.removeListener>
    ) {
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

type ListenerLeak = {
  emitter: EventEmitter<any>;
  eventName: EventName;
  expected: number;
  actual: number;
};

/**
 * Checks for event listener leaks by comparing current listener counts against initial state.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
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
 * await checkEventListeners({ forceGC: true });
 * ```
 */
export async function checkEventListeners(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
}): Promise<void> {
  const { forceGC = global.gc !== undefined, throwOnLeaks = true } =
    options ?? {};
  if (originalOn === null) {
    throw new Error(
      'Event listener leak detection not set up. Call trackEventListeners() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
  }

  const leaks: ListenerLeak[] = [];

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
        leaks.push({
          emitter,
          eventName,
          expected: expectedCount,
          actual: actualCount,
        });
      }
    }
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

  allEmitters.clear();
  emitterInitialState = new WeakMap<EventEmitter<any>, EventCounts>();
  constructorCounts.clear();

  if (leaks.length > 0) {
    const message =
      'Event listener leaks detected:\n' +
      leaks
        .map(
          (leak) =>
            `  Event '${getEmitterId(leak.emitter)}.${String(leak.eventName)}': expected ${
              leak.expected
            } listener(s), found ${leak.actual} (+${leak.actual - leak.expected} leaked)`,
        )
        .join('\n');

    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
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
