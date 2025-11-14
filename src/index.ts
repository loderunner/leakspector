import {
  type DatabasePoolsSnapshot,
  type PoolAdapter,
  clearPoolAdapters,
  databasePools,
  registerPoolAdapter,
} from './database-pools';
import { mysql2Adapter } from './database-pools-mysql2';
import { pgAdapter } from './database-pools-pg';
import {
  type EmitterStringifier,
  type ListenersSnapshot,
  clearEmitterStringifiers,
  eventListeners,
  registerEmitterStringifier,
} from './event-listeners';
import { type TimersSnapshot, timers } from './timers';

export { databasePools, eventListeners, timers };
export {
  type DatabasePoolsSnapshot,
  type EmitterStringifier,
  type ListenersSnapshot,
  type PoolAdapter,
  type TimersSnapshot,
  clearEmitterStringifiers,
  clearPoolAdapters,
  mysql2Adapter,
  pgAdapter,
  registerEmitterStringifier,
  registerPoolAdapter,
};

/**
 * Type representing available leak tracker names.
 */
export type TrackerName = 'eventListeners' | 'timers' | 'databasePools';

/**
 * Snapshot of all active trackers' current state.
 */
export type Snapshot = {
  eventListeners?: ListenersSnapshot;
  timers?: TimersSnapshot;
  databasePools?: DatabasePoolsSnapshot;
};

const activeTrackers = new Set<TrackerName>();

/**
 * Starts tracking leaks.
 *
 * @param options - Configuration options for which trackers to enable.
 * @param options.trackers - Which trackers to enable. Defaults to "all" if not provided.
 * - `"all"`: Enable all available trackers
 * - `TrackerName[]`: Array of specific tracker names to enable
 * @param options.databaseAdapters - Database pool adapters to register. Only used when databasePools tracker is enabled.
 * - Defaults to `[pgAdapter, mysql2Adapter]` if not provided
 * - Set to empty array to skip adapter registration
 *
 * @throws {Error} If leak detection is already set up. Call check() first.
 *
 * @example
 * ```typescript
 * // Enable all trackers (default)
 * track();
 *
 * // Explicitly enable all
 * track({ trackers: "all" });
 *
 * // Enable only event listeners
 * track({ trackers: ["eventListeners"] });
 *
 * // Enable multiple specific trackers
 * track({ trackers: ["eventListeners", "timers"] });
 *
 * // Enable database pools with custom adapters
 * track({ trackers: ["databasePools"], databaseAdapters: [pgAdapter] });
 * ```
 */
export function track(options?: {
  trackers?: 'all' | TrackerName[];
  databaseAdapters?: PoolAdapter[];
}): void {
  const trackersToEnable = options?.trackers ?? 'all';
  const databaseAdapters = options?.databaseAdapters ?? [
    pgAdapter,
    mysql2Adapter,
  ];

  if (
    trackersToEnable === 'all' ||
    trackersToEnable.includes('eventListeners')
  ) {
    eventListeners.track();
    activeTrackers.add('eventListeners');
  }

  if (trackersToEnable === 'all' || trackersToEnable.includes('timers')) {
    timers.track();
    activeTrackers.add('timers');
  }

  if (
    trackersToEnable === 'all' ||
    trackersToEnable.includes('databasePools')
  ) {
    // Register adapters
    for (const adapter of databaseAdapters) {
      registerPoolAdapter(adapter);
    }
    databasePools.track();
    activeTrackers.add('databasePools');
  }
}

/**
 * Creates a snapshot of all currently active trackers' state.
 * Returns a record mapping tracker names to their snapshots.
 * Only includes trackers that are currently active (i.e., have been started via track()).
 *
 * @returns A record of active tracker names to their snapshots.
 *
 * @example
 * ```typescript
 * track();
 * const emitter = new EventEmitter();
 * emitter.on('data', handler);
 * setTimeout(() => {}, 1000);
 *
 * const snap = snapshot();
 * // snap = {
 * //   eventListeners: { 'EventEmitter#1': { data: 1 } },
 * //   timers: { setTimeout: 1, setInterval: 0 },
 * //   databasePools: { 'pg#1': { active: 0, idle: 1, pending: 0, total: 1 } }
 * // }
 * ```
 */
export function snapshot(): Snapshot {
  const result: Snapshot = {};

  if (activeTrackers.has('eventListeners')) {
    result.eventListeners = eventListeners.snapshot();
  }

  if (activeTrackers.has('timers')) {
    result.timers = timers.snapshot();
  }

  if (activeTrackers.has('databasePools')) {
    result.databasePools = databasePools.snapshot();
  }

  return result;
}

/**
 * Checks for leaks across all active trackers.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking. Defaults to true if node was run with --expose-gc flag.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to "summary".
 * - `"short"`: Terse count only (e.g. `"Event listener leaks detected: 5 leaked listener(s)"`)
 * - `"summary"`: List of leaked items with counts (default behavior)
 * - `"details"`: Detailed output with stack traces
 *
 * @throws {Error} If leak detection is not set up. Call track() first.
 * @throws {Error} If leaks are detected and throwOnLeaks is true.
 *
 * @remarks Runs checks for all active trackers and aggregates results.
 */
export async function check(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
}): Promise<void> {
  if (activeTrackers.size === 0) {
    throw new Error('Leak detection not set up. Call track() first.');
  }

  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
  } = options ?? {};

  // Call forceGC once before checking all trackers
  if (forceGC) {
    const { forceGarbageCollection } = await import('./force-gc');
    await forceGarbageCollection();
  }

  const errors: string[] = [];

  const checkOptions = {
    forceGC: false, // Already called above
    throwOnLeaks: true, // We'll catch and aggregate errors ourselves
    format,
  };

  for (const trackerName of activeTrackers) {
    try {
      switch (trackerName) {
        case 'eventListeners':
          await eventListeners.check(checkOptions);
          break;
        case 'timers':
          await timers.check(checkOptions);
          break;
        case 'databasePools':
          await databasePools.check(checkOptions);
          break;
      }
    } catch (error) {
      if (error instanceof Error) {
        errors.push(error.message);
      } else {
        errors.push(String(error));
      }
    }
  }

  // Clear database pool adapters after checking
  if (activeTrackers.has('databasePools')) {
    clearPoolAdapters();
  }

  activeTrackers.clear();

  if (errors.length > 0) {
    const combinedMessage = errors.join('\n\n');
    if (throwOnLeaks) {
      throw new Error(combinedMessage);
    }
    console.error(combinedMessage);
  }
}

export const leakSpector = {
  track,
  snapshot,
  check,
};
