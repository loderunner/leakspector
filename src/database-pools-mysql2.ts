import {
  type PoolAdapter,
  type PoolStats,
  registerPool,
} from './database-pools';
import { captureStackTrace } from './stack-trace';

type Mysql2Pool = {
  pool?: {
    _allConnections?: { length: number };
    _freeConnections?: { length: number };
    _connectionQueue?: { length: number };
  };
};

let originalCreatePool: any = null;

/**
 * Gets statistics from a mysql2 Pool instance.
 */
function getMysql2PoolStats(pool: Mysql2Pool): PoolStats {
  const poolData = pool.pool;
  if (poolData === undefined) {
    return { active: 0, idle: 0, pending: 0, total: 0 };
  }

  const total = poolData._allConnections?.length ?? 0;
  const idle = poolData._freeConnections?.length ?? 0;
  const pending = poolData._connectionQueue?.length ?? 0;
  const active = total - idle;

  return {
    active,
    idle,
    pending,
    total,
  };
}

/**
 * Adapter for mysql2 database pools.
 * Instruments the createPool function to track connection pool statistics.
 *
 * @example
 * ```typescript
 * import { registerPoolAdapter, trackDatabasePools } from 'leakspector';
 * import { mysql2Adapter } from 'leakspector/adapters/mysql2';
 * import mysql from 'mysql2';
 *
 * registerPoolAdapter(mysql2Adapter);
 * trackDatabasePools();
 *
 * const pool = mysql.createPool({ connectionLimit: 10 });
 * // Pool is now tracked
 * ```
 */
export const mysql2Adapter: PoolAdapter = {
  library: 'mysql2',

  instrument(): void {
    try {
      // Dynamically import mysql2 if available
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const mysql2 = require('mysql2');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (mysql2?.createPool === undefined) {
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      originalCreatePool = mysql2.createPool;

      // Patch createPool
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      mysql2.createPool = function patchedCreatePool(...args: unknown[]) {
        // Call original function
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        const pool = originalCreatePool.apply(this, args);

        // Capture stack trace at pool creation
        const stack = captureStackTrace();

        // Register the pool for tracking
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        registerPool(pool, 'mysql2', () => getMysql2PoolStats(pool), stack);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return pool;
      };

      // Copy properties from original function
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      for (const key of Object.keys(originalCreatePool)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        mysql2.createPool[key] = originalCreatePool[key];
      }
    } catch {
      // mysql2 not installed, skip
    }
  },

  restore(): void {
    if (originalCreatePool === null) {
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const mysql2 = require('mysql2');
      if (mysql2 !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        mysql2.createPool = originalCreatePool;
      }
      originalCreatePool = null;
    } catch {
      // mysql2 not available
    }
  },

  registerPool(pool: any, getStats: () => PoolStats, stack: string): void {
    registerPool(pool, 'mysql2', getStats, stack);
  },
};
