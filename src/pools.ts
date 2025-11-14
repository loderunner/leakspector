import { forceGarbageCollection } from './force-gc';
import {
  type PoolAdapter,
  type PoolSnapshot,
  type PoolStatistics,
  capturePoolCreationStack,
  clearPoolAdapters,
  findAdapter,
  registerPoolAdapter,
} from './pool-adapter';
import { mysql2Adapter } from './pool-adapters/mysql2';
import { pgAdapter } from './pool-adapters/pg';
import { formatStackTrace } from './stack-trace';

type TrackedPool = {
  pool: unknown;
  adapter: PoolAdapter;
  poolId: string;
  creationStack: string;
  initialStatistics: PoolStatistics;
  history: Array<{ timestamp: number; statistics: PoolStatistics }>;
  checkoutCount: number;
  releaseCount: number;
};

const trackedPools = new Map<unknown, TrackedPool>();
const poolIds = new WeakMap<unknown, string>();
const constructorCounts = new Map<string, number>();

let isTracking = false;

/**
 * Registers built-in pool adapters for common database libraries.
 * Called automatically when tracking starts.
 */
function registerBuiltInAdapters(): void {
  registerPoolAdapter(pgAdapter);
  registerPoolAdapter(mysql2Adapter);
}

/**
 * Generates a unique identifier for a pool.
 *
 * @param pool - The pool instance.
 * @param adapter - The adapter handling this pool.
 * @returns A unique pool identifier.
 */
function getPoolId(pool: unknown, adapter: PoolAdapter): string {
  const existing = poolIds.get(pool);
  if (existing !== undefined) {
    return existing;
  }

  const adapterType = adapter.getPoolId(pool, 0).split('#')[0] ?? 'Pool';
  const currentCount = constructorCounts.get(adapterType) ?? 0;
  const nextCount = currentCount + 1;
  constructorCounts.set(adapterType, nextCount);

  const id = adapter.getPoolId(pool, nextCount);
  poolIds.set(pool, id);
  return id;
}

/**
 * Instruments a pool for tracking and adds it to the tracked pools map.
 *
 * @param pool - The pool instance to track.
 */
function trackPool(pool: unknown): void {
  if (!isTracking) {
    return;
  }

  const adapter = findAdapter(pool);
  if (adapter === null) {
    return;
  }

  // Skip if already tracked
  if (trackedPools.has(pool)) {
    return;
  }

  const poolId = getPoolId(pool, adapter);
  const creationStack = capturePoolCreationStack();
  const initialStatistics = adapter.getStatistics(pool);

  let checkoutCount = 0;
  let releaseCount = 0;

  const onCheckout = () => {
    checkoutCount++;
  };

  const onRelease = () => {
    releaseCount++;
  };

  // Instrument the pool
  adapter.instrument(pool, onCheckout, onRelease);

  trackedPools.set(pool, {
    pool,
    adapter,
    poolId,
    creationStack,
    initialStatistics,
    history: [
      {
        timestamp: Date.now(),
        statistics: initialStatistics,
      },
    ],
    checkoutCount,
    releaseCount,
  });
}

/**
 * Patches common pool creation patterns to automatically track pools.
 * This hooks into constructors and factory functions.
 * Uses dynamic imports for ES module compatibility.
 * Note: This is fire-and-forget async; pools created immediately after
 * trackPools() might not be caught until the next check.
 */
function patchPoolCreation(): void {
  // Fire off async patching - don't wait for it
  void (async () => {
    // Try to patch pg.Pool
    try {
      // Try dynamic import first (ES modules)
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const pgModule = await import('pg');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (pgModule?.Pool !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const OriginalPool = pgModule.Pool;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          pgModule.Pool = function (this: unknown, ...args: unknown[]) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
            const pool = new OriginalPool(...args);
            trackPool(pool);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return pool;
          };
          // Copy static properties
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
          Object.setPrototypeOf(pgModule.Pool, OriginalPool);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-member-access
          Object.assign(pgModule.Pool, OriginalPool);
        }
      } catch {
        // Try CommonJS require as fallback
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const pgModule = require('pg');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (pgModule?.Pool !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const OriginalPool = pgModule.Pool;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          pgModule.Pool = function (this: unknown, ...args: unknown[]) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
            const pool = new OriginalPool(...args);
            trackPool(pool);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return pool;
          };
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
          Object.setPrototypeOf(pgModule.Pool, OriginalPool);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-member-access
          Object.assign(pgModule.Pool, OriginalPool);
        }
      }
    } catch {
      // pg not available, skip
    }

    // Try to patch mysql2.createPool
    try {
      // Try dynamic import first (ES modules)
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const mysql2Module = await import('mysql2');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (mysql2Module?.createPool !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const originalCreatePool = mysql2Module.createPool;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          mysql2Module.createPool = function (...args: unknown[]) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
            const pool = originalCreatePool.apply(this, args);
            trackPool(pool);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return pool;
          };
        }
        // Also patch mysql2.Pool constructor if it exists
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (mysql2Module?.Pool !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const OriginalPool = mysql2Module.Pool;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          mysql2Module.Pool = function (this: unknown, ...args: unknown[]) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
            const pool = new OriginalPool(...args);
            trackPool(pool);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return pool;
          };
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
          Object.setPrototypeOf(mysql2Module.Pool, OriginalPool);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-member-access
          Object.assign(mysql2Module.Pool, OriginalPool);
        }
      } catch {
        // Try CommonJS require as fallback
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const mysql2Module = require('mysql2');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (mysql2Module?.createPool !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const originalCreatePool = mysql2Module.createPool;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          mysql2Module.createPool = function (...args: unknown[]) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
            const pool = originalCreatePool.apply(this, args);
            trackPool(pool);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return pool;
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (mysql2Module?.Pool !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const OriginalPool = mysql2Module.Pool;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          mysql2Module.Pool = function (this: unknown, ...args: unknown[]) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
            const pool = new OriginalPool(...args);
            trackPool(pool);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return pool;
          };
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
          Object.setPrototypeOf(mysql2Module.Pool, OriginalPool);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-member-access
          Object.assign(mysql2Module.Pool, OriginalPool);
        }
      }
    } catch {
      // mysql2 not available, skip
    }
  })();
}

/**
 * Starts tracking database connection pools.
 * Must be called before creating pools to track.
 *
 * @throws {Error} If leak detection is already set up. Call checkPools() first.
 *
 * @remarks Registers built-in adapters and patches pool creation functions.
 *
 * @example
 * ```typescript
 * trackPools();
 * const pool = new Pool(config); // This will be tracked
 * ```
 */
export function trackPools(): void {
  if (isTracking) {
    throw new Error(
      'Pool leak detection already set up. Call checkPools() first.',
    );
  }

  isTracking = true;
  trackedPools.clear();
  constructorCounts.clear();

  registerBuiltInAdapters();
  patchPoolCreation();
}

/**
 * Manually registers a pool for tracking.
 * Useful when automatic detection doesn't work or for custom pool implementations.
 *
 * @param pool - The pool instance to track.
 *
 * @example
 * ```typescript
 * trackPools();
 * const customPool = createCustomPool();
 * registerPool(customPool);
 * ```
 */
export function registerPool(pool: unknown): void {
  if (!isTracking) {
    throw new Error('Pool tracking not active. Call trackPools() first.');
  }

  trackPool(pool);
}

export type PoolsSnapshot = Record<string, PoolSnapshot>;

/**
 * Creates a snapshot of all currently tracked pools.
 * Returns a record mapping pool IDs to their snapshots.
 *
 * @returns A record of pool IDs to their snapshots.
 *
 * @example
 * ```typescript
 * trackPools();
 * const pool = new Pool(config);
 * const snapshot = snapshotPools();
 * // snapshot = { 'pg.Pool#1': { ... } }
 * ```
 */
export function snapshotPools(): PoolsSnapshot {
  const snapshot: PoolsSnapshot = {};

  // Update statistics for all tracked pools
  for (const tracked of trackedPools.values()) {
    const currentStats = tracked.adapter.getStatistics(tracked.pool);
    tracked.history.push({
      timestamp: Date.now(),
      statistics: currentStats,
    });

    snapshot[tracked.poolId] = {
      poolId: tracked.poolId,
      statistics: currentStats,
      creationStack: tracked.creationStack,
      history: tracked.history,
    };
  }

  return snapshot;
}

/**
 * Detects leaks in tracked pools.
 * Checks for:
 * - Active connection count growing over time
 * - Pending request queue growing unbounded
 * - Imbalance between checkout and release counts
 *
 * @param tracked - The tracked pool to check.
 * @returns Array of leak descriptions, empty if no leaks detected.
 */
function detectPoolLeaks(tracked: TrackedPool): string[] {
  const leaks: string[] = [];
  const currentStats = tracked.adapter.getStatistics(tracked.pool);

  // Check if active connections are growing
  if (tracked.history.length >= 2) {
    const firstEntry = tracked.history[0];
    const lastEntry = tracked.history[tracked.history.length - 1];

    if (firstEntry !== undefined && lastEntry !== undefined) {
      const firstStats = firstEntry.statistics;
      const lastStats = lastEntry.statistics;
      const activeGrowth =
        lastStats.activeConnections - firstStats.activeConnections;
      if (activeGrowth > 0) {
        leaks.push(
          `active connections grew from ${firstStats.activeConnections} to ${lastStats.activeConnections} (+${activeGrowth})`,
        );
      }
    }
  }

  // Check if pending requests are growing unbounded
  if (currentStats.pendingRequests > 0) {
    const maxPending = Math.max(
      ...tracked.history.map((h) => h.statistics.pendingRequests),
    );
    if (currentStats.pendingRequests === maxPending && maxPending > 5) {
      leaks.push(
        `pending acquisition requests: ${currentStats.pendingRequests} (may indicate connection leaks)`,
      );
    }
  }

  // Check for imbalance between checkouts and releases
  const imbalance = tracked.checkoutCount - tracked.releaseCount;
  if (imbalance > 0) {
    leaks.push(
      `checkout/release imbalance: ${tracked.checkoutCount} checkouts, ${tracked.releaseCount} releases (+${imbalance} leaked)`,
    );
  }

  // Check if current active connections exceed initial by a significant margin
  const activeGrowth =
    currentStats.activeConnections -
    tracked.initialStatistics.activeConnections;
  if (activeGrowth > 5) {
    leaks.push(
      `active connections exceed initial count: ${tracked.initialStatistics.activeConnections} -> ${currentStats.activeConnections} (+${activeGrowth})`,
    );
  }

  return leaks;
}

/**
 * Formats leak message in short format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(): string {
  let totalLeaked = 0;

  for (const tracked of trackedPools.values()) {
    const leaks = detectPoolLeaks(tracked);
    totalLeaked += leaks.length;
  }

  if (totalLeaked === 0) {
    return '';
  }

  return `Database pool leaks detected: ${totalLeaked} leak indicator(s)`;
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const lines: string[] = [];
  let hasLeaks = false;

  for (const tracked of trackedPools.values()) {
    const leaks = detectPoolLeaks(tracked);
    if (leaks.length === 0) {
      continue;
    }

    if (!hasLeaks) {
      lines.push('Database pool leaks detected:');
      hasLeaks = true;
    }

    lines.push(`  ${tracked.poolId}:`);
    for (const leak of leaks) {
      lines.push(`    - ${leak}`);
    }

    const currentStats = tracked.adapter.getStatistics(tracked.pool);
    lines.push(
      `    Current stats: active=${currentStats.activeConnections}, idle=${currentStats.idleConnections}, pending=${currentStats.pendingRequests}`,
    );
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

  for (const tracked of trackedPools.values()) {
    const leaks = detectPoolLeaks(tracked);
    if (leaks.length === 0) {
      continue;
    }

    if (!hasLeaks) {
      lines.push('Database pool leaks detected:');
      hasLeaks = true;
    }

    lines.push(`  ${tracked.poolId}`);
    const formattedStack = formatStackTrace(tracked.creationStack);
    if (formattedStack !== '') {
      lines.push(`    Created at: ${formattedStack}`);
    }

    for (const leak of leaks) {
      lines.push(`    - ${leak}`);
    }

    const currentStats = tracked.adapter.getStatistics(tracked.pool);
    lines.push(
      `    Current stats: active=${currentStats.activeConnections}, idle=${currentStats.idleConnections}, pending=${currentStats.pendingRequests}`,
    );
    lines.push(
      `    Checkout/release: ${tracked.checkoutCount} checkouts, ${tracked.releaseCount} releases`,
    );
  }

  return lines.join('\n');
}

/**
 * Checks for database pool leaks by analyzing statistics over time.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only
 * - `"summary"`: List of leaks with counts
 * - `"details"`: Detailed output with stack traces
 *
 * @throws {Error} If leak detection is not set up. Call trackPools() first.
 * @throws {Error} If pool leaks are detected, with details about each leak.
 *
 * @remarks Clears tracking state after checking.
 *
 * @example
 * ```typescript
 * trackPools();
 * const pool = new Pool(config);
 * // ... use pool ...
 * await checkPools({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkPools(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
}): Promise<void> {
  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
  } = options ?? {};

  if (!isTracking) {
    throw new Error('Pool leak detection not set up. Call trackPools() first.');
  }

  if (forceGC) {
    await forceGarbageCollection();
  }

  // Take final snapshot
  snapshotPools();

  let message: string;
  if (format === 'short') {
    message = formatShortMessage();
  } else if (format === 'details') {
    message = formatDetailsMessage();
  } else {
    message = formatSummaryMessage();
  }

  // Cleanup
  isTracking = false;
  trackedPools.clear();
  constructorCounts.clear();
  clearPoolAdapters();

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Convenience object providing access to pool leak detection functions.
 *
 * @property track - Starts tracking pools. See {@link trackPools}.
 * @property snapshot - Creates a snapshot of current pools. See {@link snapshotPools}.
 * @property check - Checks for leaks and clears tracking state. See {@link checkPools}.
 * @property registerPool - Manually register a pool for tracking. See {@link registerPool}.
 */
export const pools = {
  track: trackPools,
  snapshot: snapshotPools,
  check: checkPools,
  registerPool: registerPool,
};
