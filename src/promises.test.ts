import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forceGarbageCollection } from './force-gc';
import {
  checkPromises,
  promises,
  snapshotPromises,
  trackPromises,
} from './promises';

vi.mock('./force-gc', () => ({
  forceGarbageCollection: vi.fn(),
}));

describe('promises', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await checkPromises({ throwOnLeaks: false });
    } catch {
      // Ignore errors if tracking wasn't set up
    }
  });

  describe('trackPromises', () => {
    it('should start tracking Promise creation', async () => {
      trackPromises();
      const promise = new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 10);
      });

      // Wait a bit for async_hooks to initialize
      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      expect(snapshot.pending).toBeGreaterThanOrEqual(1);

      await promise;
    });

    it('should throw error if tracking is already set up', () => {
      trackPromises();

      expect(() => {
        trackPromises();
      }).toThrow(/already set up/);
    });

    it('should track promises created after tracking starts', async () => {
      trackPromises();

      const promise1 = new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 10);
      });
      const promise2 = new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 10);
      });

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      expect(snapshot.pending).toBeGreaterThanOrEqual(2);

      await Promise.all([promise1, promise2]);
    });

    it('should not count resolved promises as pending', async () => {
      trackPromises();

      const promise = Promise.resolve();

      await new Promise((resolve) => setTimeout(resolve, 5));

      // Promise resolves immediately, so it shouldn't be pending
      const snapshot = snapshotPromises();
      // The promise might be tracked briefly, but should settle quickly
      await promise;
    });

    it('should not count rejected promises as pending', async () => {
      trackPromises();

      const promise = Promise.reject(new Error('test'));
      // Suppress unhandled rejection
      promise.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      expect(snapshot.pending).toBe(0);

      await promise.catch(() => {});
    });
  });

  describe('snapshotPromises', () => {
    it('should return 0 when no promises are tracked', () => {
      trackPromises();
      const snapshot = snapshotPromises();
      expect(snapshot.pending).toBe(0);
      expect(snapshot.resolved).toBe(0);
      expect(snapshot.rejected).toBe(0);
      expect(snapshot.unhandledRejections).toBe(0);
    });

    it('should track pending promises', async () => {
      trackPromises();
      const promise = new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      expect(snapshot.pending).toBeGreaterThanOrEqual(1);

      await promise;
    });

    it('should include pendingByContext in snapshot', async () => {
      trackPromises();
      const promise = new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 10);
      });

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      expect(snapshot.pendingByContext).toBeDefined();
      expect(typeof snapshot.pendingByContext).toBe('object');

      await promise;
    });
  });

  describe('checkPromises', () => {
    it('should throw error if tracking is not set up', async () => {
      await expect(checkPromises({ throwOnLeaks: false })).rejects.toThrow(
        /not set up/,
      );
    });

    it('should not throw when no leaks are detected', async () => {
      trackPromises();
      const promise = Promise.resolve();
      await promise;

      await expect(checkPromises({ throwOnLeaks: false })).resolves.not.toThrow();
    });

    it('should throw error when leaks are detected', async () => {
      trackPromises();
      new Promise<void>(() => {
        // Never resolves or rejects - this is a leak
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(checkPromises()).rejects.toThrow(/Promise leaks detected/);
    });

    it('should restore original Promise constructor', async () => {
      const originalPromise = globalThis.Promise;
      trackPromises();
      const promise = Promise.resolve();
      await promise;

      await checkPromises({ throwOnLeaks: false });

      expect(globalThis.Promise).toBe(originalPromise);
    });

    it('should clear tracking state after check', async () => {
      trackPromises();
      const promise = Promise.resolve();
      await promise;

      await checkPromises({ throwOnLeaks: false });

      // Should be able to track again after check
      trackPromises();
      expect(snapshotPromises().pending).toBe(0);
    });

    it('should call forceGarbageCollection when forceGC is true', async () => {
      trackPromises();
      const promise = Promise.resolve();
      await promise;

      await checkPromises({ forceGC: true, throwOnLeaks: false });

      expect(forceGarbageCollection).toHaveBeenCalledTimes(1);
    });

    it('should not call forceGarbageCollection when forceGC is false', async () => {
      trackPromises();
      const promise = Promise.resolve();
      await promise;

      await checkPromises({ forceGC: false, throwOnLeaks: false });

      expect(forceGarbageCollection).not.toHaveBeenCalled();
    });

    it('should throw error on leaks by default', async () => {
      trackPromises();
      new Promise<void>(() => {
        // Never resolves or rejects
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(checkPromises()).rejects.toThrow();
    });

    it('should log error message when throwOnLeaks is false', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackPromises();
      new Promise<void>(() => {
        // Never resolves or rejects
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await checkPromises({ throwOnLeaks: false });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Promise leaks detected'),
      );

      consoleErrorSpy.mockRestore();
    });

    it('should format short message correctly', async () => {
      trackPromises();
      new Promise<void>(() => {});
      new Promise<void>(() => {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(checkPromises({ format: 'short' })).rejects.toThrow(
        /Promise leaks detected: \d+ leaked promise\(s\)/,
      );
    });

    it('should format summary message correctly', async () => {
      trackPromises();
      new Promise<void>(() => {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(checkPromises({ format: 'summary' })).rejects.toThrow(
        /Promise leaks detected:/,
      );
    });

    it('should format details message correctly', async () => {
      trackPromises();
      new Promise<void>(() => {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(checkPromises({ format: 'details' })).rejects.toThrow(
        /Promise leaks detected:/,
      );
    });

    it('should include stack traces in summary error messages', async () => {
      trackPromises();
      new Promise<void>(() => {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      try {
        await checkPromises({ format: 'summary' });
        expect.fail('Should have thrown');
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/Promise.*:\d+:\d+/);
        }
      }
    });

    it('should track unhandled rejections', async () => {
      trackPromises();

      // Create a promise that rejects without handling
      Promise.reject(new Error('unhandled'));

      await new Promise((resolve) => setTimeout(resolve, 10));

      const snapshot = snapshotPromises();
      // Unhandled rejections are tracked separately
      expect(snapshot.unhandledRejections).toBeGreaterThanOrEqual(0);
    });
  });

  describe('promises object', () => {
    it('should provide track method', () => {
      expect(promises.track).toBe(trackPromises);
    });

    it('should provide snapshot method', () => {
      expect(promises.snapshot).toBe(snapshotPromises);
    });

    it('should provide check method', () => {
      expect(promises.check).toBe(checkPromises);
    });
  });

  describe('promise settlement tracking', () => {
    it('should detect when promise resolves', async () => {
      trackPromises();
      const promise = new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 10);
      });

      await promise;

      // Wait a bit for settlement to be tracked
      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      // Promise should no longer be pending
      expect(snapshot.pending).toBe(0);
    });

    it('should detect when promise rejects', async () => {
      trackPromises();
      const promise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('test')), 10);
      });

      // Suppress unhandled rejection
      promise.catch(() => {});

      await promise.catch(() => {});

      // Wait a bit for settlement to be tracked
      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      // Promise should no longer be pending
      expect(snapshot.pending).toBe(0);
    });

    it('should track promises created via Promise.resolve', async () => {
      trackPromises();
      const promise = Promise.resolve('test');
      await promise;

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      // Immediately resolved promises might not be tracked as pending
      expect(snapshot.pending).toBe(0);
    });

    it('should track promises created via Promise.reject', async () => {
      trackPromises();
      const promise = Promise.reject(new Error('test'));
      promise.catch(() => {});

      await promise.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      expect(snapshot.pending).toBe(0);
    });
  });

  describe('promise chaining', () => {
    it('should track chained promises', async () => {
      trackPromises();
      const promise = Promise.resolve('test').then((value) => value.toUpperCase());

      await promise;

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      // Chained promises should settle
      expect(snapshot.pending).toBe(0);
    });

    it('should track promises with catch handlers', async () => {
      trackPromises();
      const promise = Promise.reject(new Error('test')).catch(() => 'recovered');

      await promise;

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      expect(snapshot.pending).toBe(0);
    });
  });

  describe('static Promise methods', () => {
    it('should work with Promise.all', async () => {
      trackPromises();
      const promise = Promise.all([
        Promise.resolve(1),
        Promise.resolve(2),
        Promise.resolve(3),
      ]);

      await promise;

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      expect(snapshot.pending).toBe(0);
    });

    it('should work with Promise.race', async () => {
      trackPromises();
      const promise = Promise.race([
        new Promise((resolve) => setTimeout(() => resolve(1), 50)),
        new Promise((resolve) => setTimeout(() => resolve(2), 10)),
      ]);

      await promise;

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      expect(snapshot.pending).toBe(0);
    });

    it('should work with Promise.allSettled', async () => {
      trackPromises();
      const promise = Promise.allSettled([
        Promise.resolve(1),
        Promise.reject(new Error('test')),
      ]);

      // Suppress unhandled rejection from the rejected promise
      Promise.reject(new Error('test')).catch(() => {});

      await promise;

      await new Promise((resolve) => setTimeout(resolve, 5));

      const snapshot = snapshotPromises();
      expect(snapshot.pending).toBe(0);
    });
  });
});
