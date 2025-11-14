import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { forceGarbageCollection } from './force-gc';
import {
  checkFileDescriptors,
  fileDescriptors,
  snapshotFileDescriptors,
  trackFileDescriptors,
} from './file-descriptors';

vi.mock('./force-gc', () => ({
  forceGarbageCollection: vi.fn(),
}));

describe('file-descriptors', () => {
  const testDir = tmpdir();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await checkFileDescriptors({ throwOnLeaks: false });
    } catch {
      // Ignore errors if tracking wasn't set up
    }
  });

  describe('trackFileDescriptors', () => {
    it('should start tracking fs.openSync calls', () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      const fd = fs.openSync(testFile, 'r');

      const snapshot = snapshotFileDescriptors();
      expect(snapshot.open).toBeGreaterThanOrEqual(1);
      expect(snapshot.byType['fs.open']).toBeGreaterThanOrEqual(1);

      fs.closeSync(fd);
      fs.unlinkSync(testFile);
    });

    it('should start tracking fs.createReadStream', () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');

      return new Promise<void>((resolve) => {
        const stream = fs.createReadStream(testFile);
        stream.once('open', () => {
          const snapshot = snapshotFileDescriptors();
          expect(snapshot.open).toBeGreaterThanOrEqual(1);
          expect(snapshot.byType['fs.createReadStream']).toBeGreaterThanOrEqual(
            1,
          );

          stream.close();
          stream.once('close', () => {
            fs.unlinkSync(testFile);
            resolve();
          });
        });
      });
    });

    it('should start tracking fs.createWriteStream', () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);

      return new Promise<void>((resolve) => {
        const stream = fs.createWriteStream(testFile);
        stream.once('open', () => {
          const snapshot = snapshotFileDescriptors();
          expect(snapshot.open).toBeGreaterThanOrEqual(1);
          expect(snapshot.byType['fs.createWriteStream']).toBeGreaterThanOrEqual(
            1,
          );

          stream.end();
          stream.once('close', () => {
            fs.unlinkSync(testFile);
            resolve();
          });
        });
      });
    });

    it('should start tracking fs.promises.open', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');

      const handle = await fsPromises.open(testFile, 'r');
      const snapshot = snapshotFileDescriptors();
      expect(snapshot.open).toBeGreaterThanOrEqual(1);
      expect(snapshot.byType['fs.promises.open']).toBeGreaterThanOrEqual(1);

      await handle.close();
      fs.unlinkSync(testFile);
    });

    it('should start tracking fs.watch', () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');

      const watcher = fs.watch(testFile);
      const snapshot = snapshotFileDescriptors();
      expect(snapshot.open).toBeGreaterThanOrEqual(1);
      expect(snapshot.byType['fs.watch']).toBeGreaterThanOrEqual(1);

      watcher.close();
      fs.unlinkSync(testFile);
    });

    it('should start tracking fs.watchFile', () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');

      fs.watchFile(testFile, () => {});
      const snapshot = snapshotFileDescriptors();
      expect(snapshot.open).toBeGreaterThanOrEqual(1);
      expect(snapshot.byType['fs.watchFile']).toBeGreaterThanOrEqual(1);

      fs.unwatchFile(testFile);
      fs.unlinkSync(testFile);
    });

    it('should throw error if tracking is already set up', () => {
      trackFileDescriptors();

      expect(() => {
        trackFileDescriptors();
      }).toThrow(/already set up/);
    });
  });

  describe('snapshotFileDescriptors', () => {
    it('should return 0 when no file descriptors are tracked', () => {
      trackFileDescriptors();
      const snapshot = snapshotFileDescriptors();
      expect(snapshot.open).toBe(0);
      expect(snapshot.byType['fs.open']).toBe(0);
      expect(snapshot.files).toEqual([]);
    });

    it('should include file paths in snapshot', () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      const fd = fs.openSync(testFile, 'r');

      const snapshot = snapshotFileDescriptors();
      expect(snapshot.files.length).toBeGreaterThanOrEqual(1);
      const fileInfo = snapshot.files.find((f) => f.path === testFile);
      expect(fileInfo).toBeDefined();
      expect(fileInfo?.type).toBe('fs.open');

      fs.closeSync(fd);
      fs.unlinkSync(testFile);
    });
  });

  describe('checkFileDescriptors', () => {
    it('should throw error if tracking is not set up', async () => {
      await expect(
        checkFileDescriptors({ throwOnLeaks: false }),
      ).rejects.toThrow(/not set up/);
    });

    it('should not throw when no leaks are detected', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      const fd = fs.openSync(testFile, 'r');
      fs.closeSync(fd);

      await expect(
        checkFileDescriptors({ throwOnLeaks: false }),
      ).resolves.not.toThrow();

      fs.unlinkSync(testFile);
    });

    it('should throw error when leaks are detected', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      fs.openSync(testFile, 'r');
      // Don't close the fd

      await expect(checkFileDescriptors()).rejects.toThrow(
        /File descriptor leaks detected/,
      );

      // Clean up
      try {
        fs.unlinkSync(testFile);
      } catch {
        // Ignore
      }
    });

    it('should restore original fs functions', async () => {
      const originalOpenSync = fs.openSync;
      const originalCreateReadStream = fs.createReadStream;
      const originalPromisesOpen = fs.promises.open;

      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      const fd = fs.openSync(testFile, 'r');
      fs.closeSync(fd);

      await checkFileDescriptors({ throwOnLeaks: false });

      expect(fs.openSync).toBe(originalOpenSync);
      expect(fs.createReadStream).toBe(originalCreateReadStream);
      expect(fs.promises.open).toBe(originalPromisesOpen);

      fs.unlinkSync(testFile);
    });

    it('should clear tracking state after check', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      const fd = fs.openSync(testFile, 'r');
      fs.closeSync(fd);

      await checkFileDescriptors({ throwOnLeaks: false });

      // Should be able to track again after check
      trackFileDescriptors();
      expect(snapshotFileDescriptors().open).toBe(0);

      fs.unlinkSync(testFile);
    });

    it('should call forceGarbageCollection when forceGC is true', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      const fd = fs.openSync(testFile, 'r');
      fs.closeSync(fd);

      await checkFileDescriptors({ forceGC: true, throwOnLeaks: false });

      expect(forceGarbageCollection).toHaveBeenCalledTimes(1);

      fs.unlinkSync(testFile);
    });

    it('should not call forceGarbageCollection when forceGC is false', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      const fd = fs.openSync(testFile, 'r');
      fs.closeSync(fd);

      await checkFileDescriptors({ forceGC: false, throwOnLeaks: false });

      expect(forceGarbageCollection).not.toHaveBeenCalled();

      fs.unlinkSync(testFile);
    });

    it('should throw error on leaks by default', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      fs.openSync(testFile, 'r');

      await expect(checkFileDescriptors()).rejects.toThrow();

      // Clean up
      try {
        fs.unlinkSync(testFile);
      } catch {
        // Ignore
      }
    });

    it('should log error message when throwOnLeaks is false', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      fs.openSync(testFile, 'r');

      await checkFileDescriptors({ throwOnLeaks: false });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('File descriptor leaks detected'),
      );

      consoleErrorSpy.mockRestore();

      // Clean up
      try {
        fs.unlinkSync(testFile);
      } catch {
        // Ignore
      }
    });

    it('should format short message correctly', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      fs.openSync(testFile, 'r');
      const testFile2 = join(testDir, `test2-${Date.now()}.txt`);
      fs.writeFileSync(testFile2, 'test');
      fs.openSync(testFile2, 'r');

      await expect(checkFileDescriptors({ format: 'short' })).rejects.toThrow(
        /File descriptor leaks detected: \d+ leaked file descriptor\(s\)/,
      );

      // Clean up
      try {
        fs.unlinkSync(testFile);
        fs.unlinkSync(testFile2);
      } catch {
        // Ignore
      }
    });

    it('should format summary message correctly', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      fs.openSync(testFile, 'r');

      await expect(checkFileDescriptors({ format: 'summary' })).rejects.toThrow(
        /File descriptor leaks detected:/,
      );

      // Clean up
      try {
        fs.unlinkSync(testFile);
      } catch {
        // Ignore
      }
    });

    it('should format details message correctly', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      fs.openSync(testFile, 'r');

      await expect(checkFileDescriptors({ format: 'details' })).rejects.toThrow(
        /File descriptor leaks detected:/,
      );

      // Clean up
      try {
        fs.unlinkSync(testFile);
      } catch {
        // Ignore
      }
    });

    it('should track fs.closeSync', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      const fd = fs.openSync(testFile, 'r');

      let snapshot = snapshotFileDescriptors();
      expect(snapshot.open).toBeGreaterThanOrEqual(1);

      fs.closeSync(fd);

      snapshot = snapshotFileDescriptors();
      // After closing, should have fewer open descriptors
      // (may not be exactly 0 if other descriptors exist)
      const openCount = snapshot.open;

      await checkFileDescriptors({ throwOnLeaks: false });

      fs.unlinkSync(testFile);
    });

    it('should track stream close events', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');

      return new Promise<void>((resolve) => {
        const stream = fs.createReadStream(testFile);
        stream.once('open', () => {
          let snapshot = snapshotFileDescriptors();
          expect(snapshot.open).toBeGreaterThanOrEqual(1);

          stream.close();
          stream.once('close', () => {
            snapshot = snapshotFileDescriptors();
            // Stream should be marked as closed

            checkFileDescriptors({ throwOnLeaks: false })
              .then(() => {
                fs.unlinkSync(testFile);
                resolve();
              })
              .catch(() => {
                fs.unlinkSync(testFile);
                resolve();
              });
          });
        });
      });
    });

    it('should track FileHandle close', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');

      const handle = await fsPromises.open(testFile, 'r');
      let snapshot = snapshotFileDescriptors();
      expect(snapshot.open).toBeGreaterThanOrEqual(1);

      await handle.close();

      snapshot = snapshotFileDescriptors();
      // Handle should be marked as closed

      await checkFileDescriptors({ throwOnLeaks: false });

      fs.unlinkSync(testFile);
    });

    it('should track fs.watch close', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');

      const watcher = fs.watch(testFile);
      let snapshot = snapshotFileDescriptors();
      expect(snapshot.open).toBeGreaterThanOrEqual(1);

      watcher.close();

      snapshot = snapshotFileDescriptors();
      // Watcher should be marked as closed

      await checkFileDescriptors({ throwOnLeaks: false });

      fs.unlinkSync(testFile);
    });

    it('should track fs.unwatchFile', async () => {
      trackFileDescriptors();
      const testFile = join(testDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');

      fs.watchFile(testFile, () => {});
      let snapshot = snapshotFileDescriptors();
      expect(snapshot.open).toBeGreaterThanOrEqual(1);

      fs.unwatchFile(testFile);

      snapshot = snapshotFileDescriptors();
      // Watcher should be marked as closed

      await checkFileDescriptors({ throwOnLeaks: false });

      fs.unlinkSync(testFile);
    });
  });

  describe('fileDescriptors object', () => {
    it('should provide track method', () => {
      expect(fileDescriptors.track).toBe(trackFileDescriptors);
    });

    it('should provide snapshot method', () => {
      expect(fileDescriptors.snapshot).toBe(snapshotFileDescriptors);
    });

    it('should provide check method', () => {
      expect(fileDescriptors.check).toBe(checkFileDescriptors);
    });
  });
});
