import { captureStackTrace } from './stack-trace';

/**
 * Statistics for a database connection pool at a point in time.
 */
export type PoolStatistics = {
  /**
   * Number of active (checked out) connections.
   */
  activeConnections: number;
  /**
   * Number of idle (available) connections.
   */
  idleConnections: number;
  /**
   * Number of pending connection acquisition requests.
   */
  pendingRequests: number;
  /**
   * Total number of connections (active + idle).
   */
  totalConnections: number;
};

/**
 * Snapshot of pool statistics at a specific time.
 */
export type PoolSnapshot = {
  /**
   * Pool identifier (e.g., "pg.Pool#1" or "mysql2.Pool#1").
   */
  poolId: string;
  /**
   * Current pool statistics.
   */
  statistics: PoolStatistics;
  /**
   * Stack trace of where the pool was created.
   */
  creationStack: string;
  /**
   * History of statistics snapshots over time.
   */
  history: Array<{ timestamp: number; statistics: PoolStatistics }>;
};

/**
 * Interface for adapting different database pool implementations to a common API.
 * Each database library has different methods for creating pools and checking out connections,
 * so adapters normalize these differences.
 */
export type PoolAdapter = {
  /**
   * Checks if a given object is a pool instance that this adapter can handle.
   *
   * @param pool - The object to check.
   * @returns True if this adapter can handle the pool.
   */
  isPool(pool: unknown): boolean;

  /**
   * Gets current statistics from the pool.
   *
   * @param pool - The pool instance.
   * @returns Current pool statistics.
   */
  getStatistics(pool: unknown): PoolStatistics;

  /**
   * Instruments a pool to track checkout/release cycles.
   * Should wrap the pool's checkout/release methods to track when connections
   * are acquired and released.
   *
   * @param pool - The pool instance to instrument.
   * @param onCheckout - Callback invoked when a connection is checked out.
   * @param onRelease - Callback invoked when a connection is released.
   * @returns The instrumented pool (may be the same instance or a wrapper).
   */
  instrument(
    pool: unknown,
    onCheckout: () => void,
    onRelease: () => void,
  ): unknown;

  /**
   * Generates a unique identifier for the pool.
   *
   * @param pool - The pool instance.
   * @param index - Sequential index for pools of the same type.
   * @returns A string identifier for the pool.
   */
  getPoolId(pool: unknown, index: number): string;
};

/**
 * Registry of pool adapters.
 * Adapters are checked in registration order.
 */
const adapters: PoolAdapter[] = [];

/**
 * Registers a pool adapter.
 * Adapters are checked in registration order, so register more specific adapters first.
 *
 * @param adapter - The adapter to register.
 *
 * @example
 * ```typescript
 * registerPoolAdapter({
 *   isPool: (p) => p instanceof MyCustomPool,
 *   getStatistics: (p) => ({ ... }),
 *   instrument: (p, onCheckout, onRelease) => { ... },
 *   getPoolId: (p, idx) => `MyCustomPool#${idx}`,
 * });
 * ```
 */
export function registerPoolAdapter(adapter: PoolAdapter): void {
  adapters.push(adapter);
}

/**
 * Clears all registered pool adapters.
 * Useful for test isolation.
 */
export function clearPoolAdapters(): void {
  adapters.length = 0;
}

/**
 * Finds an adapter that can handle the given pool.
 *
 * @param pool - The pool instance to find an adapter for.
 * @returns The adapter, or null if none found.
 */
export function findAdapter(pool: unknown): PoolAdapter | null {
  for (const adapter of adapters) {
    if (adapter.isPool(pool)) {
      return adapter;
    }
  }
  return null;
}

/**
 * Captures a stack trace for pool creation tracking.
 *
 * @returns Stack trace string.
 */
export function capturePoolCreationStack(): string {
  return captureStackTrace();
}
