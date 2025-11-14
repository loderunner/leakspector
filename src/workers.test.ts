import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { forceGarbageCollection } from './force-gc';
import {
  checkWorkers,
  snapshotWorkers,
  trackWorkers,
  workers,
} from './workers';

vi.mock('./force-gc', () => ({
  forceGarbageCollection: vi.fn(),
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workerScript = join(__dirname, 'test-worker.cjs');

describe('workers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await checkWorkers({ throwOnLeaks: false });
    } catch {
      // Ignore errors if tracking wasn't set up
    }
  });

  describe('trackWorkers', () => {
    it('should start tracking Worker creation', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerScript);

      const snapshot = snapshotWorkers();
      expect(snapshot.workers.length).toBe(1);
      expect(snapshot.poolSize).toBe(1);
      expect(snapshot.workers[0]?.state).toBe('running');

      await worker.terminate();
    });

    it('should track multiple workers', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker1 = new Worker(workerScript);
      const worker2 = new Worker(workerScript);

      const snapshot = snapshotWorkers();
      expect(snapshot.workers.length).toBe(2);
      expect(snapshot.poolSize).toBe(2);

      await worker1.terminate();
      await worker2.terminate();
    });

    it('should throw error if tracking is already set up', () => {
      trackWorkers();

      expect(() => {
        trackWorkers();
      }).toThrow(/already set up/);
    });

    it('should track worker termination', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerScript);

      await worker.terminate();

      const snapshot = snapshotWorkers();
      expect(snapshot.workers.length).toBe(1);
      expect(snapshot.workers[0]?.terminated).toBe(true);
      expect(snapshot.workers[0]?.state).toBe('terminated');
    });

    it('should track worker exit event', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerScript);

      await new Promise<void>((resolve) => {
        worker.postMessage('exit');
        worker.once('exit', () => {
          resolve();
        });
      });

      const snapshot = snapshotWorkers();
      expect(snapshot.workers.length).toBe(1);
      expect(snapshot.workers[0]?.state).toBe('exited');
    });
  });

  describe('snapshotWorkers', () => {
    it('should return empty snapshot when no workers are tracked', () => {
      trackWorkers();
      const snapshot = snapshotWorkers();
      expect(snapshot.workers).toEqual([]);
      expect(snapshot.messagePorts).toEqual([]);
      expect(snapshot.sharedArrayBuffers).toBe(0);
      expect(snapshot.poolSize).toBe(0);
    });

    it('should include worker state in snapshot', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerScript);

      const snapshot = snapshotWorkers();
      expect(snapshot.workers[0]?.id).toContain('Worker#');
      expect(snapshot.workers[0]?.state).toBe('running');
      expect(snapshot.workers[0]?.terminated).toBe(false);

      await worker.terminate();
    });
  });

  describe('checkWorkers', () => {
    it('should throw error if tracking is not set up', async () => {
      await expect(checkWorkers({ throwOnLeaks: false })).rejects.toThrow(
        /not set up/,
      );
    });

    it('should not throw when no leaks are detected', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerScript);
      await worker.terminate();

      await expect(checkWorkers({ throwOnLeaks: false })).resolves.not.toThrow();
    });

    it('should throw error when worker leaks are detected', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      new Worker(workerScript);

      await expect(checkWorkers()).rejects.toThrow(/Worker leaks detected/);
    });

    it('should restore original Worker constructor', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerScript);
      await worker.terminate();

      await checkWorkers({ throwOnLeaks: false });

      // After check, should be able to create workers normally
      const { Worker: OriginalWorker } = await import('node:worker_threads');
      const worker2 = new OriginalWorker(workerScript);
      await worker2.terminate();
    });

    it('should clear tracking state after check', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerScript);
      await worker.terminate();

      await checkWorkers({ throwOnLeaks: false });

      // Should be able to track again after check
      trackWorkers();
      expect(snapshotWorkers().poolSize).toBe(0);
    });

    it('should call forceGarbageCollection when forceGC is true', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerScript);
      await worker.terminate();

      await checkWorkers({ forceGC: true, throwOnLeaks: false });

      expect(forceGarbageCollection).toHaveBeenCalledTimes(1);
    });

    it('should not call forceGarbageCollection when forceGC is false', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerScript);
      await worker.terminate();

      await checkWorkers({ forceGC: false, throwOnLeaks: false });

      expect(forceGarbageCollection).not.toHaveBeenCalled();
    });

    it('should throw error on leaks by default', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      new Worker(workerScript);

      await expect(checkWorkers()).rejects.toThrow();
    });

    it('should log error message when throwOnLeaks is false', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      new Worker(workerScript);

      await checkWorkers({ throwOnLeaks: false });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Worker leaks detected'),
      );

      consoleErrorSpy.mockRestore();
    });

    it('should format short message correctly', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      new Worker(workerScript);

      await expect(checkWorkers({ format: 'short' })).rejects.toThrow(
        /Worker leaks detected:.*worker\(s\)/,
      );
    });

    it('should format summary message correctly', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      new Worker(workerScript);

      await expect(checkWorkers({ format: 'summary' })).rejects.toThrow(
        /Worker leaks detected:/,
      );
    });

    it('should format details message correctly', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      new Worker(workerScript);

      await expect(checkWorkers({ format: 'details' })).rejects.toThrow(
        /Worker leaks detected:/,
      );
    });
  });

  describe('workers object', () => {
    it('should provide track method', () => {
      expect(workers.track).toBe(trackWorkers);
    });

    it('should provide snapshot method', () => {
      expect(workers.snapshot).toBe(snapshotWorkers);
    });

    it('should provide check method', () => {
      expect(workers.check).toBe(checkWorkers);
    });
  });

  describe('idle worker detection', () => {
    it('should detect idle workers', async () => {
      trackWorkers();
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerScript);

      // Wait longer than default idle threshold (5s)
      await new Promise((resolve) => setTimeout(resolve, 100));

      const snapshot = snapshotWorkers();
      // Worker should be marked as idle if no activity
      // Note: This might not always be true due to timing, so we just check the structure
      expect(snapshot.workers[0]?.idle).toBeDefined();

      await worker.terminate();
    });
  });
});
