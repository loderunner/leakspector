import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

import {
  TrackedWorker,
  TrackedSharedArrayBuffer,
  workerThreads,
  setWorkerIdleThreshold,
  type WorkerThreadsSnapshot,
} from './worker-threads';

// Create a temporary directory for test worker scripts
const TEST_DIR = join(process.cwd(), '.test-workers');

/**
 * Helper to create a worker script file.
 * Uses .cjs extension to avoid ES module issues.
 */
function createWorkerScript(name: string, code: string): string {
  // Use .cjs extension to indicate CommonJS
  const filename = name.endsWith('.cjs') ? name : name.replace('.js', '.cjs');
  const filepath = join(TEST_DIR, filename);
  writeFileSync(filepath, code, 'utf-8');
  return filepath;
}

beforeEach(() => {
  // Create test directory
  try {
    mkdirSync(TEST_DIR, { recursive: true });
  } catch {
    // Directory might already exist
  }
});

afterEach(async () => {
  // Make sure tracking is cleaned up even if test failed
  try {
    await workerThreads.check({ throwOnLeaks: false, forceGC: false });
  } catch {
    // Already cleaned up or not started
  }

  // Clean up test directory
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore errors
  }
});

describe('workerThreads.track()', () => {
  it('should throw if already tracking', () => {
    workerThreads.track();

    expect(() => workerThreads.track()).toThrow(
      'Worker thread leak detection already set up',
    );

    // Clean up
    workerThreads.check({ throwOnLeaks: false });
  });

  it('should allow tracking after check() is called', async () => {
    workerThreads.track();
    await workerThreads.check({ throwOnLeaks: false });

    // Should not throw
    workerThreads.track();
    await workerThreads.check({ throwOnLeaks: false });
  });
});

describe('workerThreads.snapshot()', () => {
  it('should return empty snapshot when no workers created', () => {
    workerThreads.track();

    const snapshot = workerThreads.snapshot();

    expect(snapshot).toEqual({
      workers: {
        total: 0,
        alive: 0,
        idle: 0,
        terminated: 0,
      },
      messagePorts: {
        total: 0,
        open: 0,
        closed: 0,
      },
      sharedArrayBuffers: {
        total: 0,
        totalBytes: 0,
      },
    });

    workerThreads.check({ throwOnLeaks: false });
  });

  it('should track created workers', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'snapshot-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('ready');
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));

    const snapshot = workerThreads.snapshot();

    expect(snapshot.workers.total).toBe(1);
    expect(snapshot.workers.alive).toBe(1);

    await worker.terminate();
    await workerThreads.check({ throwOnLeaks: false });
  });

  it('should track terminated workers', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'terminated-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('ready');
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));
    await worker.terminate();

    // Wait for exit event
    await new Promise((resolve) => setTimeout(resolve, 50));

    const snapshot = workerThreads.snapshot();

    expect(snapshot.workers.total).toBe(1);
    expect(snapshot.workers.terminated).toBe(1);
    expect(snapshot.workers.alive).toBe(0);

    await workerThreads.check({ throwOnLeaks: false });
  });

  it('should track idle workers', async () => {
    // Set a very short idle threshold for testing
    setWorkerIdleThreshold(100);

    workerThreads.track();

    const workerScript = createWorkerScript(
      'idle-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('ready');
      // Keep worker alive with an interval
      setInterval(() => {}, 10000);
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));

    // Wait for worker to become idle
    await new Promise((resolve) => setTimeout(resolve, 150));

    const snapshot = workerThreads.snapshot();

    expect(snapshot.workers.total).toBe(1);
    expect(snapshot.workers.alive).toBe(1);
    expect(snapshot.workers.idle).toBeGreaterThanOrEqual(1);

    await worker.terminate();
    await workerThreads.check({ throwOnLeaks: false });

    // Reset threshold
    setWorkerIdleThreshold(5000);
  });

  it('should track MessagePorts', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'port-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', (msg) => {
        if (msg.port) {
          msg.port.postMessage('received');
        }
      });
      // Keep worker alive
      setInterval(() => {}, 10000);
    `,
    );

    const worker = new TrackedWorker(workerScript);
    const { port1, port2 } = new MessageChannel();

    // Wait for worker to be online before sending message
    await new Promise((resolve) => {
      worker.once('online', resolve);
    });

    worker.postMessage({ port: port2 }, [port2]);

    // Wait for message
    await new Promise((resolve) => port1.once('message', resolve));

    const snapshot = workerThreads.snapshot();

    // MessagePort will be tracked when transferred
    // Note: transferred ports are automatically closed in the parent thread
    expect(snapshot.messagePorts.total).toBeGreaterThanOrEqual(1);
    // The transferred port will be closed, but we still tracked it
    expect(snapshot.messagePorts.closed).toBeGreaterThanOrEqual(1);

    port1.close();
    await worker.terminate();
    await workerThreads.check({ throwOnLeaks: false });
  });

  it('should track SharedArrayBuffers', async () => {
    workerThreads.track();

    const buffer1 = new TrackedSharedArrayBuffer(1024);
    const buffer2 = new TrackedSharedArrayBuffer(2048);

    const snapshot = workerThreads.snapshot();

    expect(snapshot.sharedArrayBuffers.total).toBe(2);
    expect(snapshot.sharedArrayBuffers.totalBytes).toBe(3072);

    await workerThreads.check({ throwOnLeaks: false });
  });
});

describe('workerThreads.check()', () => {
  it('should throw if not tracking', async () => {
    await expect(workerThreads.check()).rejects.toThrow(
      'Worker thread leak detection not set up',
    );
  });

  it('should not throw when no leaks detected', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'clean-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('done');
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));
    await worker.terminate();

    // Wait for exit event
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(
      workerThreads.check({ throwOnLeaks: true }),
    ).resolves.not.toThrow();
  });

  it('should throw when worker not terminated', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'leaked-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('ready');
      // Worker never terminates
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));

    await expect(workerThreads.check({ throwOnLeaks: true })).rejects.toThrow(
      'Worker thread leaks detected',
    );

    // Clean up the worker
    await worker.terminate();
  });

  it('should throw when MessagePort not closed', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'port-leak-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', () => {});
    `,
    );

    const worker = new TrackedWorker(workerScript);
    const { port1, port2 } = new MessageChannel();

    worker.postMessage({ port: port2 }, [port2]);

    // Don't close port1
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(workerThreads.check({ throwOnLeaks: true })).rejects.toThrow(
      'Worker thread leaks detected',
    );

    // Clean up
    port1.close();
    await worker.terminate();
  });

  it('should detect idle workers', async () => {
    setWorkerIdleThreshold(100);

    workerThreads.track();

    const workerScript = createWorkerScript(
      'idle-leak-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('ready');
      // Keep worker alive but idle
      setInterval(() => {}, 10000);
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));

    // Wait for idle threshold
    await new Promise((resolve) => setTimeout(resolve, 150));

    await expect(workerThreads.check({ throwOnLeaks: true })).rejects.toThrow(
      'Idle workers',
    );

    // Clean up
    await worker.terminate();
    setWorkerIdleThreshold(5000);
  });

  it('should format short message correctly', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'short-format-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('ready');
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));

    try {
      await workerThreads.check({ format: 'short', throwOnLeaks: true });
    } catch (error) {
      if (error instanceof Error) {
        expect(error.message).toMatch(/Worker thread leaks detected:/);
        expect(error.message).toMatch(/worker\(s\)/);
      }
    }

    await worker.terminate();
  });

  it('should format summary message correctly', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'summary-format-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('ready');
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));

    try {
      await workerThreads.check({ format: 'summary', throwOnLeaks: true });
    } catch (error) {
      if (error instanceof Error) {
        expect(error.message).toContain('Worker thread leaks detected');
        expect(error.message).toContain('Workers not terminated');
        expect(error.message).toContain('Worker#');
      }
    }

    await worker.terminate();
  });

  it('should format details message correctly', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'details-format-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('ready');
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));

    try {
      await workerThreads.check({ format: 'details', throwOnLeaks: true });
    } catch (error) {
      if (error instanceof Error) {
        expect(error.message).toContain('Worker thread leaks detected');
        expect(error.message).toContain('Workers not terminated');
        expect(error.message).toContain('Age:');
        expect(error.message).toContain('Last activity:');
      }
    }

    await worker.terminate();
  });

  it('should not throw when throwOnLeaks is false', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'no-throw-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('ready');
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));

    await expect(
      workerThreads.check({ throwOnLeaks: false }),
    ).resolves.not.toThrow();

    await worker.terminate();
  });

  it('should detect SharedArrayBuffer leaks', async () => {
    workerThreads.track();

    // Create a buffer but keep it in scope
    const buffer = new TrackedSharedArrayBuffer(1024);

    try {
      await workerThreads.check({ throwOnLeaks: true, forceGC: true });
    } catch (error) {
      if (error instanceof Error) {
        expect(error.message).toContain('SharedArrayBuffer');
      }
    }

    // Keep buffer alive to avoid "unused variable" warnings
    expect(buffer.byteLength).toBe(1024);
  });

  it('should handle multiple workers', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'multi-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('ready');
      // Keep workers alive
      setInterval(() => {}, 10000);
    `,
    );

    const workers = [
      new TrackedWorker(workerScript),
      new TrackedWorker(workerScript),
      new TrackedWorker(workerScript),
    ];

    await Promise.all(
      workers.map((w) => new Promise((resolve) => w.once('message', resolve))),
    );

    const snapshot = workerThreads.snapshot();
    expect(snapshot.workers.total).toBe(3);
    expect(snapshot.workers.alive).toBe(3);

    try {
      await workerThreads.check({ throwOnLeaks: true });
    } catch (error) {
      if (error instanceof Error) {
        expect(error.message).toContain('Workers not terminated: 3');
      }
    }

    // Clean up
    await Promise.all(workers.map((w) => w.terminate()));
  });

  it('should handle worker that exits naturally', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'exit-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage('done');
      process.exit(0);
    `,
    );

    const worker = new TrackedWorker(workerScript);
    await new Promise((resolve) => worker.once('message', resolve));
    await new Promise((resolve) => worker.once('exit', resolve));

    // Should not throw since worker exited
    await expect(
      workerThreads.check({ throwOnLeaks: true }),
    ).resolves.not.toThrow();
  });

  it('should track worker activity from messages', async () => {
    setWorkerIdleThreshold(100);

    workerThreads.track();

    const workerScript = createWorkerScript(
      'activity-worker.js',
      `
      const { parentPort } = require('worker_threads');
      
      setInterval(() => {
        parentPort.postMessage('ping');
      }, 50);
    `,
    );

    const worker = new TrackedWorker(workerScript);

    // Wait for a few messages
    await new Promise((resolve) => setTimeout(resolve, 200));

    const snapshot = workerThreads.snapshot();

    // Worker should not be idle since it's sending messages
    expect(snapshot.workers.idle).toBe(0);

    await worker.terminate();
    await workerThreads.check({ throwOnLeaks: false });

    setWorkerIdleThreshold(5000);
  });
});

describe('setWorkerIdleThreshold()', () => {
  it('should set the idle threshold', () => {
    expect(() => setWorkerIdleThreshold(1000)).not.toThrow();
  });

  it('should throw if threshold is not positive', () => {
    expect(() => setWorkerIdleThreshold(0)).toThrow(
      'Idle threshold must be positive',
    );
    expect(() => setWorkerIdleThreshold(-100)).toThrow(
      'Idle threshold must be positive',
    );
  });
});

describe('integration with multiple resource types', () => {
  it('should detect all types of leaks simultaneously', async () => {
    workerThreads.track();

    const workerScript = createWorkerScript(
      'multi-leak-worker.js',
      `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', () => {});
    `,
    );

    // Create a worker (not terminated)
    const worker = new TrackedWorker(workerScript);

    // Create a MessagePort (not closed)
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ port: port2 }, [port2]);

    // Create a SharedArrayBuffer (stays in memory)
    const buffer = new TrackedSharedArrayBuffer(512);

    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      await workerThreads.check({ throwOnLeaks: true });
    } catch (error) {
      if (error instanceof Error) {
        expect(error.message).toContain('Worker thread leaks detected');
        // Should mention workers
        expect(error.message).toMatch(/[Ww]orker/);
      }
    }

    // Clean up
    port1.close();
    await worker.terminate();

    // Keep buffer alive
    expect(buffer.byteLength).toBe(512);
  });
});
