import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type PoolAdapter,
  type PoolStats,
  checkDatabasePools,
  clearPoolAdapters,
  databasePools,
  registerPoolAdapter,
  snapshotDatabasePools,
  trackDatabasePools,
} from './database-pools';
import { forceGarbageCollection } from './force-gc';

vi.mock('./force-gc', () => ({
  forceGarbageCollection: vi.fn(),
}));

/**
 * Mock pool implementation for testing.
 */
class MockPool {
  public totalCount: number = 0;
  public idleCount: number = 0;
  public waitingCount: number = 0;
  private connections: Array<{ active: boolean }> = [];

  async connect() {
    // If no idle connections, create a new one
    if (this.idleCount === 0) {
      this.connections.push({ active: true });
      this.totalCount++;
    } else {
      // Take from idle
      this.idleCount--;
      const conn = this.connections.find((c) => !c.active);
      if (conn !== undefined) {
        conn.active = true;
      }
    }

    return {
      release: () => {
        const conn = this.connections.find((c) => c.active);
        if (conn !== undefined) {
          conn.active = false;
          this.idleCount++;
        }
      },
    };
  }

  updateStats() {
    const active = this.connections.filter((c) => c.active).length;
    this.idleCount = this.connections.length - active;
    this.totalCount = this.connections.length;
  }
}

describe('database-pools', () => {
  let mockAdapter: PoolAdapter;
  let pools: MockPool[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    pools = [];
    clearPoolAdapters();

    // Create a mock adapter
    mockAdapter = {
      library: 'mock-db',
      instrument: vi.fn(() => {
        // Mock instrumentation - we'll manually register pools in tests
      }),
      restore: vi.fn(),
      registerPool: vi.fn(),
    };
  });

  afterEach(async () => {
    try {
      await checkDatabasePools({ throwOnLeaks: false });
    } catch {
      // Ignore errors if tracking wasn't set up
    }
    clearPoolAdapters();
  });

  describe('registerPoolAdapter', () => {
    it('should register a pool adapter', () => {
      registerPoolAdapter(mockAdapter);
      expect(() => trackDatabasePools()).not.toThrow();
    });

    it('should allow multiple adapters', () => {
      const adapter1: PoolAdapter = {
        library: 'db1',
        instrument: vi.fn(),
        restore: vi.fn(),
        registerPool: vi.fn(),
      };
      const adapter2: PoolAdapter = {
        library: 'db2',
        instrument: vi.fn(),
        restore: vi.fn(),
        registerPool: vi.fn(),
      };

      registerPoolAdapter(adapter1);
      registerPoolAdapter(adapter2);

      trackDatabasePools();

      expect(adapter1.instrument).toHaveBeenCalled();
      expect(adapter2.instrument).toHaveBeenCalled();
    });
  });

  describe('trackDatabasePools', () => {
    it('should throw error if no adapters registered', () => {
      expect(() => trackDatabasePools()).toThrow(/No database pool adapters/);
    });

    it('should throw error if tracking is already set up', () => {
      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      expect(() => trackDatabasePools()).toThrow(/already set up/);
    });

    it('should call instrument on all registered adapters', () => {
      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      expect(mockAdapter.instrument).toHaveBeenCalled();
    });
  });

  describe('snapshotDatabasePools', () => {
    it('should return empty snapshot when no pools tracked', () => {
      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const snapshot = snapshotDatabasePools();
      expect(snapshot).toEqual({});
    });

    it('should capture current pool statistics', async () => {
      const pool = new MockPool();
      pools.push(pool);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      // Manually register the pool
      const { registerPool } = await import('./database-pools');
      const getStats = (): PoolStats => ({
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        pending: pool.waitingCount,
        total: pool.totalCount,
      });
      registerPool(pool, 'mock-db', getStats, 'test stack');

      // Create a connection
      await pool.connect();
      pool.updateStats();

      const snapshot = snapshotDatabasePools();
      expect(snapshot['mock-db#1']).toEqual({
        active: 1,
        idle: 0,
        pending: 0,
        total: 1,
      });
    });

    it('should track multiple pools', async () => {
      const pool1 = new MockPool();
      const pool2 = new MockPool();
      pools.push(pool1, pool2);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats1 = (): PoolStats => ({
        active: pool1.totalCount - pool1.idleCount,
        idle: pool1.idleCount,
        pending: pool1.waitingCount,
        total: pool1.totalCount,
      });
      const getStats2 = (): PoolStats => ({
        active: pool2.totalCount - pool2.idleCount,
        idle: pool2.idleCount,
        pending: pool2.waitingCount,
        total: pool2.totalCount,
      });

      registerPool(pool1, 'mock-db', getStats1, 'test stack 1');
      registerPool(pool2, 'mock-db', getStats2, 'test stack 2');

      await pool1.connect();
      pool1.updateStats();

      const snapshot = snapshotDatabasePools();
      expect(snapshot['mock-db#1']).toBeDefined();
      expect(snapshot['mock-db#2']).toBeDefined();
      expect(snapshot['mock-db#1'].active).toBe(1);
      expect(snapshot['mock-db#2'].active).toBe(0);
    });
  });

  describe('checkDatabasePools', () => {
    it('should throw error if tracking not set up', async () => {
      await expect(checkDatabasePools()).rejects.toThrow(/not set up/);
    });

    it('should not throw when no leaks detected', async () => {
      const pool = new MockPool();
      pools.push(pool);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats = (): PoolStats => ({
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        pending: pool.waitingCount,
        total: pool.totalCount,
      });
      registerPool(pool, 'mock-db', getStats, 'test stack');

      // Create and release connection properly
      const client = await pool.connect();
      pool.updateStats();
      client.release();
      pool.updateStats();

      await expect(checkDatabasePools()).resolves.not.toThrow();
    });

    it('should detect unreleased connections', async () => {
      const pool = new MockPool();
      pools.push(pool);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats = (): PoolStats => ({
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        pending: pool.waitingCount,
        total: pool.totalCount,
      });
      registerPool(pool, 'mock-db', getStats, 'test stack');

      // Create connection but don't release it
      await pool.connect();
      pool.updateStats();

      // Take another snapshot to show sustained active connections
      snapshotDatabasePools();

      await expect(checkDatabasePools()).rejects.toThrow(
        /Database pool leaks detected/,
      );
    });

    it('should detect growing active connections', async () => {
      const pool = new MockPool();
      pools.push(pool);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats = (): PoolStats => ({
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        pending: pool.waitingCount,
        total: pool.totalCount,
      });
      registerPool(pool, 'mock-db', getStats, 'test stack');

      // Take initial snapshot
      snapshotDatabasePools();

      // Create multiple connections without releasing
      await pool.connect();
      await pool.connect();
      await pool.connect();
      pool.updateStats();

      await expect(checkDatabasePools()).rejects.toThrow(/grew from 0 to 3/);
    });

    it('should detect growing pending requests', async () => {
      const pool = new MockPool();
      pools.push(pool);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats = (): PoolStats => ({
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        pending: pool.waitingCount,
        total: pool.totalCount,
      });
      registerPool(pool, 'mock-db', getStats, 'test stack');

      // Take initial snapshot
      snapshotDatabasePools();

      // Simulate pending requests
      pool.waitingCount = 5;

      await expect(checkDatabasePools()).rejects.toThrow(
        /Pending requests grew from 0 to 5/,
      );
    });

    it('should call restore on all adapters', async () => {
      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      await checkDatabasePools({ throwOnLeaks: false });

      expect(mockAdapter.restore).toHaveBeenCalled();
    });

    it('should call forceGC when requested', async () => {
      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      await checkDatabasePools({ forceGC: true, throwOnLeaks: false });

      expect(forceGarbageCollection).toHaveBeenCalled();
    });

    it('should format message in short format', async () => {
      const pool = new MockPool();
      pools.push(pool);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats = (): PoolStats => ({
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        pending: pool.waitingCount,
        total: pool.totalCount,
      });
      registerPool(pool, 'mock-db', getStats, 'test stack');

      await pool.connect();
      pool.updateStats();
      snapshotDatabasePools();

      try {
        await checkDatabasePools({ format: 'short' });
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/Database pool leaks detected: 1 pool/);
          expect(error.message).not.toMatch(/mock-db#1/);
        }
      }
    });

    it('should format message in summary format', async () => {
      const pool = new MockPool();
      pools.push(pool);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats = (): PoolStats => ({
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        pending: pool.waitingCount,
        total: pool.totalCount,
      });
      registerPool(pool, 'mock-db', getStats, 'test stack');

      await pool.connect();
      pool.updateStats();
      snapshotDatabasePools();

      try {
        await checkDatabasePools({ format: 'summary' });
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/Database pool leaks detected:/);
          expect(error.message).toMatch(/mock-db#1/);
          expect(error.message).not.toMatch(/created at/);
        }
      }
    });

    it('should format message in details format', async () => {
      const pool = new MockPool();
      pools.push(pool);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats = (): PoolStats => ({
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        pending: pool.waitingCount,
        total: pool.totalCount,
      });
      registerPool(pool, 'mock-db', getStats, 'test stack');

      await pool.connect();
      pool.updateStats();
      snapshotDatabasePools();

      try {
        await checkDatabasePools({ format: 'details' });
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/Database pool leaks detected:/);
          expect(error.message).toMatch(/mock-db#1/);
          expect(error.message).toMatch(/Sample history:/);
        }
      }
    });

    it('should not throw when throwOnLeaks is false', async () => {
      const pool = new MockPool();
      pools.push(pool);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats = (): PoolStats => ({
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        pending: pool.waitingCount,
        total: pool.totalCount,
      });
      registerPool(pool, 'mock-db', getStats, 'test stack');

      await pool.connect();
      pool.updateStats();
      snapshotDatabasePools();

      await expect(
        checkDatabasePools({ throwOnLeaks: false }),
      ).resolves.not.toThrow();
    });
  });

  describe('databasePools convenience object', () => {
    it('should provide track, snapshot, and check methods', () => {
      expect(databasePools.track).toBe(trackDatabasePools);
      expect(databasePools.snapshot).toBe(snapshotDatabasePools);
      expect(databasePools.check).toBe(checkDatabasePools);
    });
  });

  describe('leak detection scenarios', () => {
    it('should detect connection checkout without release', async () => {
      const pool = new MockPool();
      pools.push(pool);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats = (): PoolStats => ({
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        pending: pool.waitingCount,
        total: pool.totalCount,
      });
      registerPool(pool, 'mock-db', getStats, 'test stack');

      // Simulate proper usage
      const client1 = await pool.connect();
      pool.updateStats();
      client1.release();
      pool.updateStats();

      // Simulate leaked connection
      await pool.connect();
      pool.updateStats();

      // Take snapshot to show sustained leak
      snapshotDatabasePools();

      await expect(checkDatabasePools()).rejects.toThrow(
        /connection\(s\) remain active/,
      );
    });

    it('should handle multiple pools with mixed behavior', async () => {
      const pool1 = new MockPool();
      const pool2 = new MockPool();
      pools.push(pool1, pool2);

      registerPoolAdapter(mockAdapter);
      trackDatabasePools();

      const { registerPool } = await import('./database-pools');
      const getStats1 = (): PoolStats => ({
        active: pool1.totalCount - pool1.idleCount,
        idle: pool1.idleCount,
        pending: pool1.waitingCount,
        total: pool1.totalCount,
      });
      const getStats2 = (): PoolStats => ({
        active: pool2.totalCount - pool2.idleCount,
        idle: pool2.idleCount,
        pending: pool2.waitingCount,
        total: pool2.totalCount,
      });

      registerPool(pool1, 'mock-db', getStats1, 'test stack 1');
      registerPool(pool2, 'mock-db', getStats2, 'test stack 2');

      // Pool1: proper usage
      const client1 = await pool1.connect();
      pool1.updateStats();
      client1.release();
      pool1.updateStats();

      // Pool2: leaked connection
      await pool2.connect();
      pool2.updateStats();
      snapshotDatabasePools();

      try {
        await checkDatabasePools();
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/mock-db#2/);
          expect(error.message).not.toMatch(/mock-db#1/);
        }
      }
    });
  });
});
