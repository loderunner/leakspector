import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forceGarbageCollection } from './force-gc';
import { checkTimers, snapshotTimers, timers, trackTimers } from './timers';

vi.mock('./force-gc', () => ({
  forceGarbageCollection: vi.fn(),
}));

describe('timers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await checkTimers({ throwOnLeaks: false });
    } catch {
      // Ignore errors if tracking wasn't set up
    }
  });

  describe('trackTimers', () => {
    it('should start tracking setTimeout calls', () => {
      trackTimers();
      const id = setTimeout(() => {}, 1000);

      const snapshot = snapshotTimers();
      expect(snapshot).toEqual({ setTimeout: 1, setInterval: 0 });

      clearTimeout(id);
    });

    it('should start tracking setInterval calls', () => {
      trackTimers();
      const id = setInterval(() => {}, 1000);

      const snapshot = snapshotTimers();
      expect(snapshot).toEqual({ setTimeout: 0, setInterval: 1 });

      clearInterval(id);
    });

    it('should start tracking both setTimeout and setInterval calls', () => {
      trackTimers();
      const id1 = setTimeout(() => {}, 1000);
      const id2 = setInterval(() => {}, 1000);

      const snapshot = snapshotTimers();
      expect(snapshot).toEqual({ setTimeout: 1, setInterval: 1 });

      clearTimeout(id1);
      clearInterval(id2);
    });

    it('should throw error if tracking is already set up', () => {
      trackTimers();

      expect(() => {
        trackTimers();
      }).toThrow(/already set up/);
    });

    it('should track multiple timers', () => {
      trackTimers();
      const id1 = setTimeout(() => {}, 1000);
      const id2 = setTimeout(() => {}, 2000);
      const id3 = setInterval(() => {}, 1000);

      const snapshot = snapshotTimers();
      expect(snapshot).toEqual({ setTimeout: 2, setInterval: 1 });

      clearTimeout(id1);
      clearTimeout(id2);
      clearInterval(id3);
    });

    it('should not count cleared timers as leaks', () => {
      trackTimers();
      const id1 = setTimeout(() => {}, 1000);
      const id2 = setTimeout(() => {}, 2000);

      clearTimeout(id1);

      const snapshot = snapshotTimers();
      expect(snapshot).toEqual({ setTimeout: 1, setInterval: 0 });

      clearTimeout(id2);
    });

    it('should handle clearTimeout on tracked timers', () => {
      trackTimers();
      const id = setTimeout(() => {}, 1000);

      expect(snapshotTimers()).toEqual({ setTimeout: 1, setInterval: 0 });

      clearTimeout(id);

      expect(snapshotTimers()).toEqual({ setTimeout: 0, setInterval: 0 });
    });

    it('should handle clearInterval on tracked timers', () => {
      trackTimers();
      const id = setInterval(() => {}, 1000);

      expect(snapshotTimers()).toEqual({ setTimeout: 0, setInterval: 1 });

      clearInterval(id);

      expect(snapshotTimers()).toEqual({ setTimeout: 0, setInterval: 0 });
    });

    it('should handle clearing timers created before tracking', () => {
      const id = setTimeout(() => {}, 1000);

      trackTimers();
      // Clearing a timer that wasn't tracked shouldn't cause issues
      clearTimeout(id);

      expect(snapshotTimers()).toEqual({ setTimeout: 0, setInterval: 0 });
    });
  });

  describe('snapshotTimers', () => {
    it('should return 0 when no timers are tracked', () => {
      trackTimers();
      expect(snapshotTimers()).toEqual({ setTimeout: 0, setInterval: 0 });
    });
  });

  describe('checkTimers', () => {
    it('should throw error if tracking is not set up', async () => {
      await expect(checkTimers({ throwOnLeaks: false })).rejects.toThrow(
        /not set up/,
      );
    });

    it('should not throw when no leaks are detected', async () => {
      trackTimers();
      const id = setTimeout(() => {}, 1000);
      clearTimeout(id);

      await expect(checkTimers({ throwOnLeaks: false })).resolves.not.toThrow();
    });

    it('should throw error when leaks are detected', async () => {
      trackTimers();
      setTimeout(() => {}, 1000);

      await expect(checkTimers()).rejects.toThrow(/Timer leaks detected/);
    });

    it('should restore original timer functions', async () => {
      const originalSetTimeout = globalThis.setTimeout;
      const originalSetInterval = globalThis.setInterval;
      const originalClearTimeout = globalThis.clearTimeout;
      const originalClearInterval = globalThis.clearInterval;

      trackTimers();
      const id = setTimeout(() => {}, 1000);
      clearTimeout(id);

      await checkTimers({ throwOnLeaks: false });

      expect(globalThis.setTimeout).toBe(originalSetTimeout);
      expect(globalThis.setInterval).toBe(originalSetInterval);
      expect(globalThis.clearTimeout).toBe(originalClearTimeout);
      expect(globalThis.clearInterval).toBe(originalClearInterval);
    });

    it('should clear tracking state after check', async () => {
      trackTimers();
      const id = setTimeout(() => {}, 1000);
      clearTimeout(id);

      await checkTimers({ throwOnLeaks: false });

      // Should be able to track again after check
      trackTimers();
      expect(snapshotTimers()).toEqual({ setTimeout: 0, setInterval: 0 });
    });

    it('should call forceGarbageCollection when forceGC is true', async () => {
      trackTimers();
      const id = setTimeout(() => {}, 1000);
      clearTimeout(id);

      await checkTimers({ forceGC: true, throwOnLeaks: false });

      expect(forceGarbageCollection).toHaveBeenCalledTimes(1);
    });

    it('should not call forceGarbageCollection when forceGC is false', async () => {
      trackTimers();
      const id = setTimeout(() => {}, 1000);
      clearTimeout(id);

      await checkTimers({ forceGC: false, throwOnLeaks: false });

      expect(forceGarbageCollection).not.toHaveBeenCalled();
    });

    it('should throw error on leaks by default', async () => {
      trackTimers();
      setTimeout(() => {}, 1000);

      await expect(checkTimers()).rejects.toThrow();
    });

    it('should log error message when throwOnLeaks is false', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackTimers();
      setTimeout(() => {}, 1000);

      await checkTimers({ throwOnLeaks: false });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Timer leaks detected'),
      );

      consoleErrorSpy.mockRestore();
    });

    it('should format short message correctly', async () => {
      trackTimers();
      setTimeout(() => {}, 1000);
      setTimeout(() => {}, 2000);

      await expect(checkTimers({ format: 'short' })).rejects.toThrow(
        /Timer leaks detected: 2 leaked timer\(s\)/,
      );
    });

    it('should format summary message correctly', async () => {
      trackTimers();
      setTimeout(() => {}, 1000);

      await expect(checkTimers({ format: 'summary' })).rejects.toThrow(
        /Timer leaks detected:/,
      );
    });

    it('should format details message correctly', async () => {
      trackTimers();
      setTimeout(() => {}, 1000);

      await expect(checkTimers({ format: 'details' })).rejects.toThrow(
        /Timer leaks detected:/,
      );
    });

    it('should include stack traces in summary error messages', async () => {
      trackTimers();
      setTimeout(() => {}, 1000);

      try {
        await checkTimers({ format: 'summary' });
        expect.fail('Should have thrown');
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/setTimeout.*:\d+:\d+/);
        }
      }
    });
  });

  describe('timers object', () => {
    it('should provide track method', () => {
      expect(timers.track).toBe(trackTimers);
    });

    it('should provide snapshot method', () => {
      expect(timers.snapshot).toBe(snapshotTimers);
    });

    it('should provide check method', () => {
      expect(timers.check).toBe(checkTimers);
    });
  });

  describe('this binding', () => {
    it('should bind timer as this to setTimeout callback', async () => {
      trackTimers();
      await new Promise<void>((resolve) => {
        setTimeout(function (this: NodeJS.Timeout) {
          expect(this).toBeDefined();
          expect(typeof this.refresh).toBe('function');
          expect(typeof this.unref).toBe('function');
          clearTimeout(this);
          resolve();
        }, 10);
      });
    });

    it('should bind timer as this to setInterval callback', async () => {
      trackTimers();
      await new Promise<void>((resolve) => {
        const intervalId = setInterval(function (this: NodeJS.Timeout) {
          expect(this).toBeDefined();
          expect(typeof this.refresh).toBe('function');
          expect(typeof this.unref).toBe('function');

          // Clear current timer + initial timer
          clearInterval(this);
          clearInterval(intervalId);
          resolve();
        }, 10);
      });
    });
  });

  describe('callback arguments', () => {
    it('should pass arguments to setTimeout callback', async () => {
      trackTimers();
      await new Promise<void>((resolve) => {
        setTimeout(
          function (this: NodeJS.Timeout, arg1: string, arg2: number) {
            expect(arg1).toBe('test');
            expect(arg2).toBe(1138);
            expect(this).toBeDefined();
            clearTimeout(this);
            resolve();
          },
          10,
          'test',
          1138,
        );
      });
    });

    it('should pass arguments to setInterval callback', async () => {
      trackTimers();
      await new Promise<void>((resolve) => {
        let callCount = 0;
        const intervalId = setInterval(
          function (this: NodeJS.Timeout, arg1: string, arg2: number) {
            callCount++;
            expect(arg1).toBe('test');
            expect(arg2).toBe(1138);
            expect(this).toBeDefined();
            if (callCount === 1) {
              // Clear current timer + initial timer
              clearInterval(this);
              clearInterval(intervalId);
              resolve();
            }
          },
          10,
          'test',
          1138,
        );
      });
    });

    it('should handle void-accepting callback overload', async () => {
      trackTimers();
      await new Promise<void>((resolve) => {
        setTimeout(function (this: NodeJS.Timeout, _: void) {
          expect(this).toBeDefined();
          clearTimeout(this);
          resolve();
        }, 10);
      });
    });
  });

  describe('setTimeout callback execution', () => {
    it('should mark setTimeout as cleared when callback fires', async () => {
      trackTimers();
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          // After callback fires, timer should be marked as cleared
          const snapshot = snapshotTimers();
          expect(snapshot.setTimeout).toBe(0);
          expect(snapshot.setInterval).toBe(0);
          resolve();
        }, 10);
      });
    });

    it('should not report setTimeout as leak after callback fires', async () => {
      trackTimers();
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 10);
      });

      await expect(checkTimers()).resolves.not.toThrow();
    });

    it('should still track setTimeout before callback fires', async () => {
      trackTimers();
      setTimeout(() => {}, 100);

      // Wait an initial delay to ensure the timer is tracked
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Before callback fires, timer should still be tracked
      const snapshot = snapshotTimers();
      expect(snapshot.setTimeout).toBe(1);

      // Wait for callback to fire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // After callback fires, timer should be cleared
      const snapshotAfter = snapshotTimers();
      expect(snapshotAfter.setTimeout).toBe(0);
    });
  });

  describe('numeric ID handling', () => {
    it('should track timer using numeric ID from Timeout object', () => {
      trackTimers();
      const id = setTimeout(() => {}, 1000);
      const snapshot = snapshotTimers();
      expect(snapshot.setTimeout).toBe(1);
      clearTimeout(id);
    });

    it('should handle clearTimeout with numeric ID', () => {
      trackTimers();
      const id = setTimeout(() => {}, 1000);
      const numericId = Number(id);
      clearTimeout(numericId);
      const snapshot = snapshotTimers();
      expect(snapshot.setTimeout).toBe(0);
    });

    it('should handle clearTimeout with Timeout object', () => {
      trackTimers();
      const id = setTimeout(() => {}, 1000);
      clearTimeout(id);
      const snapshot = snapshotTimers();
      expect(snapshot.setTimeout).toBe(0);
    });

    it('should handle clearInterval with numeric ID', () => {
      trackTimers();
      const id = setInterval(() => {}, 1000);
      const numericId = Number(id);
      clearInterval(numericId);
      const snapshot = snapshotTimers();
      expect(snapshot.setInterval).toBe(0);
    });

    it('should handle clearInterval with Timeout object', () => {
      trackTimers();
      const id = setInterval(() => {}, 1000);
      clearInterval(id);
      const snapshot = snapshotTimers();
      expect(snapshot.setInterval).toBe(0);
    });

    it('should handle clearing with string ID (converted to number)', () => {
      trackTimers();
      const id = setTimeout(() => {}, 1000);
      const numericId = Number(id);
      const stringId = String(numericId);
      clearTimeout(stringId);
      const snapshot = snapshotTimers();
      expect(snapshot.setTimeout).toBe(0);
    });
  });
});
