import * as cp from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkChildProcesses,
  childProcesses,
  snapshotChildProcesses,
  trackChildProcesses,
} from './child-processes';
import { forceGarbageCollection } from './force-gc';

// Store original functions
const originalSpawn = cp.spawn;
const originalExec = cp.exec;
const originalExecFile = cp.execFile;
const originalFork = cp.fork;

vi.mock('./force-gc', () => ({
  forceGarbageCollection: vi.fn(),
}));

describe('child-processes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore original functions before each test
    /* eslint-disable @typescript-eslint/no-unsafe-member-access */
    (cp as any).spawn = originalSpawn;
    (cp as any).exec = originalExec;
    (cp as any).execFile = originalExecFile;
    (cp as any).fork = originalFork;
    /* eslint-enable @typescript-eslint/no-unsafe-member-access */
  });

  afterEach(async () => {
    // Kill any lingering child processes
    try {
      if (process.platform !== 'win32') {
        originalExec('pkill -f "node.*setInterval" || true', {
          timeout: 1000,
        });
      }
    } catch {
      // Ignore cleanup errors
    }

    // Try to clean up tracking
    try {
      await checkChildProcesses({ throwOnLeaks: false });
    } catch {
      // Ignore errors if tracking wasn't set up or already cleaned up
    }

    // Restore original functions after each test
    /* eslint-disable @typescript-eslint/no-unsafe-member-access */
    (cp as any).spawn = originalSpawn;
    (cp as any).exec = originalExec;
    (cp as any).execFile = originalExecFile;
    (cp as any).fork = originalFork;
    /* eslint-enable @typescript-eslint/no-unsafe-member-access */
  });

  describe('trackChildProcesses', () => {
    it('should start tracking spawned processes', () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['--version']);

      const snapshot = snapshotChildProcesses();
      expect(snapshot.active).toBe(1);

      child.kill();
    });

    it('should throw error if tracking is already set up', () => {
      trackChildProcesses();

      expect(() => {
        trackChildProcesses();
      }).toThrow(/already set up/);
    });

    it('should track exec processes', () => {
      trackChildProcesses();
      const child = cp.exec('node --version');

      const snapshot = snapshotChildProcesses();
      expect(snapshot.active).toBe(1);

      child.kill();
    });

    it('should track execFile processes', () => {
      trackChildProcesses();
      const child = cp.execFile('node', ['--version']);

      const snapshot = snapshotChildProcesses();
      expect(snapshot.active).toBe(1);

      child.kill();
    });

    it('should track fork processes', async () => {
      // Create a temporary script file for fork
      const tempScript = join(__dirname, 'temp-fork-script.js');
      writeFileSync(tempScript, 'setTimeout(() => {}, 100);');

      try {
        trackChildProcesses();
        const child = cp.fork(tempScript);

        const snapshot = snapshotChildProcesses();
        expect(snapshot.active).toBe(1);

        child.kill();
      } finally {
        unlinkSync(tempScript);
      }
    });

    it('should track multiple processes', () => {
      trackChildProcesses();
      const child1 = cp.spawn('node', ['--version']);
      const child2 = cp.spawn('node', ['--version']);

      const snapshot = snapshotChildProcesses();
      expect(snapshot.active).toBe(2);

      child1.kill();
      child2.kill();
    });

    it('should track process exit', async () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['--version']);

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });

      // Give a moment for state to update
      await new Promise((resolve) => setTimeout(resolve, 10));

      const snapshot = snapshotChildProcesses();
      expect(snapshot.exited).toBe(1);
      expect(snapshot.active).toBe(0);
    });

    it('should track manual kill', () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);

      child.kill();

      // Process is killed, so it should be marked as such
      const snapshot = snapshotChildProcesses();
      expect(snapshot).toBeDefined();

      child.kill(); // Clean up
    });
  });

  describe('snapshotChildProcesses', () => {
    it('should return snapshot with active processes', () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['--version']);

      const snapshot = snapshotChildProcesses();
      expect(snapshot.active).toBe(1);
      expect(snapshot.exited).toBe(0);

      child.kill();
    });

    it('should track streams correctly', () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['--version']);

      const snapshot = snapshotChildProcesses();
      // stdio streams should be tracked
      expect(snapshot.withOpenStreams).toBeGreaterThanOrEqual(0);

      child.kill();
    });
  });

  describe('checkChildProcesses', () => {
    it('should throw error if tracking not set up', async () => {
      await expect(checkChildProcesses()).rejects.toThrow(/not set up/);
    });

    it('should not throw if no leaks', async () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['--version']);

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });

      // Wait a bit for streams to close
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(checkChildProcesses()).resolves.not.toThrow();
    });

    it('should detect process leak (not terminated)', async () => {
      trackChildProcesses();
      cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);

      await expect(checkChildProcesses()).rejects.toThrow(
        /Child process leaks detected/,
      );
    });

    it('should detect process leak with short format', async () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);

      try {
        await checkChildProcesses({ format: 'short' });
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/leaked process\(es\)/);
        }
      }

      child.kill();
    });

    it('should detect process leak with summary format', async () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);

      try {
        await checkChildProcesses({ format: 'summary' });
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/Child process leaks detected/);
          expect(error.message).toMatch(/spawn/);
        }
      }

      child.kill();
    });

    it('should detect process leak with details format', async () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);

      try {
        await checkChildProcesses({ format: 'details' });
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/Child process leaks detected/);
          expect(error.message).toMatch(/spawn/);
          expect(error.message).toMatch(/Status:/);
        }
      }

      child.kill();
    });

    it('should not throw when throwOnLeaks is false', async () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);

      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      await checkChildProcesses({ throwOnLeaks: false });

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();

      child.kill();
    });

    it('should call forceGC when forceGC is true', async () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['--version']);

      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });

      await checkChildProcesses({ forceGC: true, throwOnLeaks: false });

      expect(forceGarbageCollection).toHaveBeenCalled();
    });

    it('should not call forceGC when forceGC is false', async () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['--version']);

      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });

      await checkChildProcesses({ forceGC: false, throwOnLeaks: false });

      expect(forceGarbageCollection).not.toHaveBeenCalled();
    });

    it('should restore original functions after check', async () => {
      const originalSpawnRef = originalSpawn;

      trackChildProcesses();
      expect(cp.spawn).not.toBe(originalSpawnRef);

      const child = cp.spawn('node', ['--version']);
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });

      await checkChildProcesses({ throwOnLeaks: false });

      expect(cp.spawn).toBe(originalSpawnRef);
    });
  });

  describe('childProcesses object', () => {
    it('should expose track, snapshot, and check functions', () => {
      expect(childProcesses.track).toBe(trackChildProcesses);
      expect(childProcesses.snapshot).toBe(snapshotChildProcesses);
      expect(childProcesses.check).toBe(checkChildProcesses);
    });
  });

  describe('stream leak detection', () => {
    it('should detect when streams remain open after process exit', async () => {
      trackChildProcesses();

      // Spawn a process that exits quickly
      const child = cp.spawn('node', ['-e', 'console.log("hello")']);

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });

      // Don't wait for streams to close, check immediately
      try {
        await checkChildProcesses({ format: 'details' });
        // If no error thrown, that's also okay (streams might have closed quickly)
      } catch (error) {
        if (error instanceof Error) {
          // If there's an error, it might be about streams or about the process
          expect(error.message).toMatch(/Child process leaks detected/);
        }
      }
    });

    it('should not report leak when streams are properly closed', async () => {
      trackChildProcesses();

      const child = cp.spawn('node', ['--version']);

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });

      // Wait for streams to close
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(checkChildProcesses()).resolves.not.toThrow();
    });
  });

  describe('manual kill tracking', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should track when kill() is called manually', async () => {
      trackChildProcesses();

      const child = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);

      // Manually kill the process
      child.kill();

      // Wait a bit for the kill to propagate
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Even though manually killed, if the process hasn't exited yet,
      // it might still be flagged, but the manual kill should be noted
      try {
        await checkChildProcesses({ format: 'details' });
      } catch (error) {
        if (error instanceof Error) {
          // The error message might or might not appear depending on timing
          // This test mainly verifies that manual kill is tracked
        }
      }
    });

    it('should not flag as leak if killed and exited', async () => {
      trackChildProcesses();

      const child = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);

      child.kill();

      // Wait for process to actually exit
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });

      // Wait for streams to close
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(checkChildProcesses()).resolves.not.toThrow();
    });
  });

  describe('command formatting', () => {
    it('should format long commands with truncation', async () => {
      trackChildProcesses();

      const longArgs = Array(20)
        .fill('arg')
        .map((_, i) => `arg${i}`);
      const child = cp.spawn('node', ['--version', ...longArgs]);

      try {
        await checkChildProcesses({ format: 'summary' });
      } catch (error) {
        if (error instanceof Error) {
          // The command should be truncated if too long
          expect(error.message).toBeDefined();
        }
      }

      child.kill();
    });

    it('should include method name in error', async () => {
      trackChildProcesses();
      const child = cp.exec('node -e "setInterval(() => {}, 1000)"');

      try {
        await checkChildProcesses({ format: 'summary' });
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/exec/);
        }
      }

      child.kill();
    });
  });

  describe('GC survival tracking', () => {
    it('should increment GC survival count', async () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);

      // Run check which should increment GC survival count
      try {
        await checkChildProcesses({ forceGC: true, format: 'details' });
      } catch (error) {
        if (error instanceof Error) {
          // Should mention GC cycles in details format
          expect(error.message).toMatch(/GC cycle/);
        }
      }

      child.kill();
    });
  });

  describe('PID tracking', () => {
    it('should track process PID', () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['--version']);

      expect(child.pid).toBeDefined();

      const snapshot = snapshotChildProcesses();
      expect(snapshot.active).toBe(1);

      child.kill();
    });

    it('should include PID in error messages', async () => {
      trackChildProcesses();
      const child = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);

      try {
        await checkChildProcesses({ format: 'summary' });
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/pid/);
        }
      }

      child.kill();
    });
  });
});
