import type { PoolAdapter, PoolStatistics } from '../pool-adapter';

/**
 * Adapter for pg (node-postgres) Pool instances.
 * Supports both callback and promise-based APIs.
 */
export const pgAdapter: PoolAdapter = {
  isPool(pool: unknown): boolean {
    // Check for pg.Pool by looking for characteristic properties
    // pg.Pool has methods like connect, end, totalCount, idleCount, waitingCount
    if (
      pool === null ||
      pool === undefined ||
      typeof pool !== 'object' ||
      !('connect' in pool) ||
      !('end' in pool)
    ) {
      return false;
    }

    // Check for pg-specific properties
    const poolObj = pool as Record<string, unknown>;
    return (
      typeof poolObj.connect === 'function' &&
      typeof poolObj.end === 'function' &&
      ('totalCount' in poolObj ||
        'idleCount' in poolObj ||
        'waitingCount' in poolObj)
    );
  },

  getStatistics(pool: unknown): PoolStatistics {
    const poolObj = pool as {
      totalCount?: number;
      idleCount?: number;
      waitingCount?: number;
    };

    const totalConnections = poolObj.totalCount ?? 0;
    const idleConnections = poolObj.idleCount ?? 0;
    const activeConnections = totalConnections - idleConnections;
    const pendingRequests = poolObj.waitingCount ?? 0;

    return {
      activeConnections,
      idleConnections,
      totalConnections,
      pendingRequests,
    };
  },

  instrument(
    pool: unknown,
    onCheckout: () => void,
    onRelease: () => void,
  ): unknown {
    const poolObj = pool as {
      connect: (
        callback?: (
          err: Error | null,
          client: unknown,
          done: () => void,
        ) => void,
      ) => Promise<unknown> | void;
    };

    const originalConnect = poolObj.connect;

    // Wrap connect() to track checkout/release
    poolObj.connect = function (
      callback?: (err: Error | null, client: unknown, done: () => void) => void,
    ) {
      // Callback-based API
      if (typeof callback === 'function') {
        return originalConnect.call(this, (err, client, done) => {
          if (err === null && client !== undefined) {
            onCheckout();

            // Wrap the done callback to track release
            const originalDone = done;
            const wrappedDone = () => {
              onRelease();
              originalDone();
            };

            callback(err, client, wrappedDone);
          } else {
            callback(err, client, done);
          }
        });
      }

      // Promise-based API
      const promise = originalConnect.call(this) as Promise<unknown>;
      return promise.then((client) => {
        onCheckout();

        // Wrap the client's release method if it exists
        if (
          client !== null &&
          client !== undefined &&
          typeof client === 'object'
        ) {
          const clientObj = client as { release?: () => void };
          if (typeof clientObj.release === 'function') {
            const originalRelease = clientObj.release;
            clientObj.release = function () {
              onRelease();
              return originalRelease.call(this);
            };
          }
        }

        return client;
      });
    };

    return pool;
  },

  getPoolId(pool: unknown, index: number): string {
    // Try to get connection string or database name for identification
    const poolObj = pool as { options?: { database?: string; host?: string } };
    const dbName = poolObj.options?.database ?? 'unknown';
    const host = poolObj.options?.host ?? 'unknown';
    return `pg.Pool#${index} (${host}/${dbName})`;
  },
};
