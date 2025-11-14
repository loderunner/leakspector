import {
  type PoolAdapter,
  type PoolStats,
  registerPool,
} from './database-pools';
import { captureStackTrace } from './stack-trace';

type PgPool = {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
};

let OriginalPool: any = null;

/**
 * Gets statistics from a pg Pool instance.
 */
function getPgPoolStats(pool: PgPool): PoolStats {
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const pending = pool.waitingCount;
  const active = total - idle;

  return {
    active,
    idle,
    pending,
    total,
  };
}

/**
 * Adapter for pg (node-postgres) database pools.
 * Instruments the Pool constructor to track connection pool statistics.
 *
 * @example
 * ```typescript
 * import { registerPoolAdapter, trackDatabasePools } from 'leakspector';
 * import { pgAdapter } from 'leakspector/adapters/pg';
 * import { Pool } from 'pg';
 *
 * registerPoolAdapter(pgAdapter);
 * trackDatabasePools();
 *
 * const pool = new Pool({ max: 10 });
 * // Pool is now tracked
 * ```
 */
export const pgAdapter: PoolAdapter = {
  library: 'pg',

  instrument(): void {
    try {
      // Dynamically import pg if available
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const pg = require('pg');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (pg?.Pool === undefined) {
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      OriginalPool = pg.Pool;

      // Patch the Pool constructor
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      pg.Pool = function PatchedPool(this: unknown, ...args: unknown[]) {
        // Call original constructor
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
        const pool = new OriginalPool(...args);

        // Capture stack trace at pool creation
        const stack = captureStackTrace();

        // Register the pool for tracking
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        registerPool(pool, 'pg', () => getPgPoolStats(pool), stack);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return pool;
      };

      // Preserve prototype chain
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      pg.Pool.prototype = OriginalPool.prototype;

      // Copy static properties
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      for (const key of Object.keys(OriginalPool)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        pg.Pool[key] = OriginalPool[key];
      }
    } catch {
      // pg not installed, skip
    }
  },

  restore(): void {
    if (OriginalPool === null) {
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const pg = require('pg');
      if (pg !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        pg.Pool = OriginalPool;
      }
      OriginalPool = null;
    } catch {
      // pg not available
    }
  },

  registerPool(pool: any, getStats: () => PoolStats, stack: string): void {
    registerPool(pool, 'pg', getStats, stack);
  },
};
