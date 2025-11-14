import type { PoolAdapter, PoolStatistics } from '../pool-adapter';

/**
 * Adapter for mysql2 Pool instances.
 * Supports both callback and promise-based APIs.
 */
export const mysql2Adapter: PoolAdapter = {
  isPool(pool: unknown): boolean {
    // Check for mysql2.Pool by looking for characteristic properties
    // mysql2.Pool has methods like getConnection, end, query
    if (
      pool === null ||
      pool === undefined ||
      typeof pool !== 'object' ||
      !('getConnection' in pool) ||
      !('end' in pool)
    ) {
      return false;
    }

    const poolObj = pool as Record<string, unknown>;
    return (
      typeof poolObj.getConnection === 'function' &&
      typeof poolObj.end === 'function'
    );
  },

  getStatistics(pool: unknown): PoolStatistics {
    const poolObj = pool as {
      _allConnections?: unknown[];
      _acquiredConnections?: unknown[];
      _connectionQueue?: unknown[];
    };

    // mysql2 pool internal structure
    const allConnections = poolObj._allConnections ?? [];
    const acquiredConnections = poolObj._acquiredConnections ?? [];
    const connectionQueue = poolObj._connectionQueue ?? [];

    const totalConnections = allConnections.length;
    const activeConnections = acquiredConnections.length;
    const idleConnections = totalConnections - activeConnections;
    const pendingRequests = connectionQueue.length;

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
      getConnection: (
        callback?: (err: Error | null, connection: unknown) => void,
      ) => Promise<unknown> | void;
    };

    const originalGetConnection = poolObj.getConnection;

    // Wrap getConnection() to track checkout/release
    poolObj.getConnection = function (
      callback?: (err: Error | null, connection: unknown) => void,
    ) {
      // Callback-based API
      if (typeof callback === 'function') {
        return originalGetConnection.call(this, (err, connection) => {
          if (err === null && connection !== undefined) {
            onCheckout();

            // Wrap the connection's release method
            if (connection !== null && typeof connection === 'object') {
              const connObj = connection as { release?: () => void };
              if (typeof connObj.release === 'function') {
                const originalRelease = connObj.release;
                connObj.release = function () {
                  onRelease();
                  return originalRelease.call(this);
                };
              }
            }

            callback(err, connection);
          } else {
            callback(err, connection);
          }
        });
      }

      // Promise-based API
      const promise = originalGetConnection.call(this) as Promise<unknown>;
      return promise.then((connection) => {
        onCheckout();

        // Wrap the connection's release method
        if (connection !== null && typeof connection === 'object') {
          const connObj = connection as { release?: () => void };
          if (typeof connObj.release === 'function') {
            const originalRelease = connObj.release;
            connObj.release = function () {
              onRelease();
              return originalRelease.call(this);
            };
          }
        }

        return connection;
      });
    };

    return pool;
  },

  getPoolId(pool: unknown, index: number): string {
    // Try to get database name or connection config for identification
    const poolObj = pool as {
      config?: { database?: string; host?: string };
    };
    const dbName = poolObj.config?.database ?? 'unknown';
    const host = poolObj.config?.host ?? 'unknown';
    return `mysql2.Pool#${index} (${host}/${dbName})`;
  },
};
