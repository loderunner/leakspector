import { forceGarbageCollection } from './force-gc';
import { formatStackTrace } from './stack-trace';

/**
 * Statistics for a database connection pool at a point in time.
 */
export type PoolStats = {
  /** Number of connections actively in use */
  active: number;
  /** Number of idle connections available in the pool */
  idle: number;
  /** Number of pending acquisition requests waiting for a connection */
  pending: number;
  /** Total pool size (active + idle) */
  total: number;
};

/**
 * Snapshot of pool statistics at a point in time.
 */
type PoolSample = {
  timestamp: number;
  stats: PoolStats;
};

/**
 * Information tracked for each database pool.
 */
type PoolInfo = {
  id: string;
  library: string;
  pool: unknown;
  stack: string;
  samples: PoolSample[];
  getStats: () => PoolStats;
};

/**
 * Adapter interface for different database pool implementations.
 */
export type PoolAdapter = {
  /** Name of the database library (e.g., 'pg', 'mysql2') */
  library: string;
  /** Hook to patch pool creation for this library */
  instrument: () => void;
  /** Restore original pool creation behavior */
  restore: () => void;
  /** Register a pool with the tracker */
  registerPool: (pool: any, getStats: () => PoolStats, stack: string) => void;
};

const trackedPools = new Map<any, PoolInfo>();
const poolIds = new WeakMap<any, string>();
const libraryPoolCounts = new Map<string, number>();
const activeAdapters = new Set<PoolAdapter>();

let isTracking = false;

/**
 * Generates a unique identifier for a pool.
 */
function getPoolId(pool: any, library: string): string {
  const existing = poolIds.get(pool);
  if (existing !== undefined) {
    return existing;
  }

  const currentCount = libraryPoolCounts.get(library) ?? 0;
  const nextCount = currentCount + 1;
  libraryPoolCounts.set(library, nextCount);

  const id = `${library}#${nextCount}`;
  poolIds.set(pool, id);
  return id;
}

/**
 * Registers a database pool for tracking.
 */
export function registerPool(
  pool: any,
  library: string,
  getStats: () => PoolStats,
  stack: string,
): void {
  if (!isTracking) {
    return;
  }

  const id = getPoolId(pool, library);
  const initialStats = getStats();
  const poolInfo: PoolInfo = {
    id,
    library,
    pool,
    stack,
    samples: [
      {
        timestamp: Date.now(),
        stats: initialStats,
      },
    ],
    getStats,
  };

  trackedPools.set(pool, poolInfo);
}

/**
 * Registers a custom adapter for a database library.
 * Adapters must be registered before calling track().
 *
 * @param adapter - Adapter for a specific database library
 *
 * @example
 * ```typescript
 * import { registerPoolAdapter } from 'leakspector';
 * import { pgAdapter } from 'leakspector/adapters/pg';
 *
 * registerPoolAdapter(pgAdapter);
 * ```
 */
export function registerPoolAdapter(adapter: PoolAdapter): void {
  activeAdapters.add(adapter);
}

/**
 * Clears all registered pool adapters.
 * Useful for test isolation.
 */
export function clearPoolAdapters(): void {
  activeAdapters.clear();
}

/**
 * Starts tracking database connection pools.
 * Must be called before creating pools to track.
 * Requires at least one adapter to be registered.
 *
 * @throws {Error} If leak detection is already set up. Call checkDatabasePools() first.
 * @throws {Error} If no adapters are registered.
 *
 * @remarks Instruments pool creation for all registered adapters.
 *
 * @example
 * ```typescript
 * import { registerPoolAdapter, trackDatabasePools } from 'leakspector';
 * import { pgAdapter } from 'leakspector/adapters/pg';
 *
 * registerPoolAdapter(pgAdapter);
 * trackDatabasePools();
 * const pool = new Pool({ ... }); // This will be tracked
 * ```
 */
export function trackDatabasePools(): void {
  if (isTracking) {
    throw new Error(
      'Database pool leak detection already set up. Call checkDatabasePools() first.',
    );
  }

  if (activeAdapters.size === 0) {
    throw new Error(
      'No database pool adapters registered. Register at least one adapter with registerPoolAdapter() before calling trackDatabasePools().',
    );
  }

  isTracking = true;

  for (const adapter of activeAdapters) {
    adapter.instrument();
  }
}

/**
 * Snapshot of all tracked database pools.
 */
export type DatabasePoolsSnapshot = Record<string, PoolStats>;

/**
 * Creates a snapshot of all currently tracked database pools.
 * Returns current statistics for each pool.
 * Also records a sample for leak detection.
 *
 * @returns A record of pool IDs to their current statistics.
 *
 * @example
 * ```typescript
 * trackDatabasePools();
 * const pool = new Pool({ max: 10 });
 * await pool.query('SELECT 1');
 * const snapshot = snapshotDatabasePools();
 * // snapshot = { 'pg#1': { active: 0, idle: 1, pending: 0, total: 1 } }
 * ```
 */
export function snapshotDatabasePools(): DatabasePoolsSnapshot {
  const snapshot: DatabasePoolsSnapshot = {};
  const now = Date.now();

  for (const poolInfo of trackedPools.values()) {
    const currentStats = poolInfo.getStats();
    snapshot[poolInfo.id] = currentStats;

    // Record this sample for trend analysis
    poolInfo.samples.push({
      timestamp: now,
      stats: currentStats,
    });
  }

  return snapshot;
}

/**
 * Analyzes pool samples to detect leaks.
 * Returns information about detected issues.
 */
type PoolLeak = {
  poolInfo: PoolInfo;
  issues: string[];
};

/**
 * Analyzes pool statistics to detect potential leaks.
 */
function analyzePoolLeaks(): PoolLeak[] {
  const leaks: PoolLeak[] = [];

  for (const poolInfo of trackedPools.values()) {
    // Take a final sample
    const finalStats = poolInfo.getStats();
    poolInfo.samples.push({
      timestamp: Date.now(),
      stats: finalStats,
    });

    const issues: string[] = [];
    const samples = poolInfo.samples;

    if (samples.length < 2) {
      continue;
    }

    const firstStats = samples[0].stats;
    const lastStats = samples[samples.length - 1].stats;

    // Check for growing active connections
    if (lastStats.active > firstStats.active && lastStats.active > 0) {
      issues.push(
        `Active connections grew from ${firstStats.active} to ${lastStats.active} (not released)`,
      );
    }

    // Check for growing pending requests
    if (lastStats.pending > firstStats.pending && lastStats.pending > 0) {
      issues.push(
        `Pending requests grew from ${firstStats.pending} to ${lastStats.pending} (connections not returned)`,
      );
    }

    // Check for sustained high active connections
    const avgActive =
      samples.reduce((sum, s) => sum + s.stats.active, 0) / samples.length;
    if (samples.length >= 3 && avgActive > firstStats.active * 1.5) {
      issues.push(
        `Average active connections (${avgActive.toFixed(1)}) significantly higher than initial (${firstStats.active})`,
      );
    }

    // Check for unreleased connections at end
    if (lastStats.active > 0 && samples.length >= 2) {
      // Allow time for connections to be released
      const secondLastStats = samples[samples.length - 2].stats;
      if (lastStats.active === secondLastStats.active && lastStats.active > 0) {
        issues.push(
          `${lastStats.active} connection(s) remain active and were not released`,
        );
      }
    }

    if (issues.length > 0) {
      leaks.push({ poolInfo, issues });
    }
  }

  return leaks;
}

/**
 * Formats leak message in short format.
 */
function formatShortMessage(leaks: PoolLeak[]): string {
  if (leaks.length === 0) {
    return '';
  }

  const totalIssues = leaks.reduce((sum, leak) => sum + leak.issues.length, 0);
  return `Database pool leaks detected: ${leaks.length} pool(s) with ${totalIssues} issue(s)`;
}

/**
 * Formats leak message in summary format.
 */
function formatSummaryMessage(leaks: PoolLeak[]): string {
  if (leaks.length === 0) {
    return '';
  }

  const lines: string[] = ['Database pool leaks detected:'];

  for (const leak of leaks) {
    lines.push(`  ${leak.poolInfo.id}:`);
    for (const issue of leak.issues) {
      lines.push(`    - ${issue}`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats leak message in details format with stack traces.
 */
function formatDetailsMessage(leaks: PoolLeak[]): string {
  if (leaks.length === 0) {
    return '';
  }

  const lines: string[] = ['Database pool leaks detected:'];

  for (const leak of leaks) {
    const formattedStack = formatStackTrace(leak.poolInfo.stack);
    if (formattedStack !== '') {
      lines.push(`  ${leak.poolInfo.id} created at ${formattedStack}`);
    } else {
      lines.push(`  ${leak.poolInfo.id}`);
    }

    for (const issue of leak.issues) {
      lines.push(`    - ${issue}`);
    }

    // Show sample history
    lines.push(`    Sample history:`);
    for (const sample of leak.poolInfo.samples) {
      const { active, idle, pending, total } = sample.stats;
      lines.push(
        `      [${new Date(sample.timestamp).toISOString()}] active: ${active}, idle: ${idle}, pending: ${pending}, total: ${total}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Checks for database pool leaks.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only
 * - `"summary"`: List of leaked pools with issues
 * - `"details"`: Detailed output with stack traces and sample history
 *
 * @throws {Error} If leak detection is not set up. Call trackDatabasePools() first.
 * @throws {Error} If database pool leaks are detected.
 *
 * @remarks Restores original pool creation behavior and clears tracking state.
 *
 * @example
 * ```typescript
 * trackDatabasePools();
 * const pool = new Pool({ max: 10 });
 * const client = await pool.connect();
 * // Forgot to release: client.release()
 * await checkDatabasePools({ forceGC: true, format: 'details' });
 * // Throws: Database pool leaks detected: pg#1: 1 connection(s) remain active...
 * ```
 */
export async function checkDatabasePools(options?: {
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
    throw new Error(
      'Database pool leak detection not set up. Call trackDatabasePools() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
  }

  // Restore original behavior
  for (const adapter of activeAdapters) {
    adapter.restore();
  }

  isTracking = false;

  // Analyze for leaks
  const leaks = analyzePoolLeaks();

  // Format message
  let message: string;
  if (format === 'short') {
    message = formatShortMessage(leaks);
  } else if (format === 'details') {
    message = formatDetailsMessage(leaks);
  } else {
    message = formatSummaryMessage(leaks);
  }

  // Clear state
  trackedPools.clear();
  libraryPoolCounts.clear();

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Convenience object providing access to database pool leak detection functions.
 *
 * @property track - Starts tracking database pools. See {@link trackDatabasePools}.
 * @property snapshot - Creates a snapshot of current pool statistics. See {@link snapshotDatabasePools}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkDatabasePools}.
 */
export const databasePools = {
  track: trackDatabasePools,
  snapshot: snapshotDatabasePools,
  check: checkDatabasePools,
};
