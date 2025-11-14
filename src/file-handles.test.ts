import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fileHandles } from './file-handles';

describe('fileHandles', () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'leakspector-'));
    testFile = path.join(tempDir, 'test.txt');
    await fsPromises.writeFile(testFile, 'test content');
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore errors during cleanup
    }
  });

  describe('fs.open and fs.close', () => {
    it('should track opened and closed file descriptors', async () => {
      fileHandles.track();

      const fd = await new Promise<number>((resolve, reject) => {
        fs.open(testFile, 'r', (err, fd) => {
          if (err) {
            reject(err);
          } else {
            resolve(fd);
          }
        });
      });

      const snapshot1 = fileHandles.snapshot();
      expect(snapshot1.open).toBe(1);
      expect(snapshot1.total).toBe(1);

      await new Promise<void>((resolve, reject) => {
        fs.close(fd, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      await expect(fileHandles.check()).resolves.toBeUndefined();
    });

    it('should detect unclosed file descriptors', async () => {
      fileHandles.track();

      await new Promise<number>((resolve, reject) => {
        fs.open(testFile, 'r', (err, fd) => {
          if (err) {
            reject(err);
          } else {
            resolve(fd);
          }
        });
      });

      await expect(fileHandles.check()).rejects.toThrow(
        'File handle leaks detected',
      );
    });

    it('should show details with stack traces', async () => {
      fileHandles.track();

      await new Promise<number>((resolve, reject) => {
        fs.open(testFile, 'r', (err, fd) => {
          if (err) {
            reject(err);
          } else {
            resolve(fd);
          }
        });
      });

      await expect(fileHandles.check({ format: 'details' })).rejects.toThrow(
        /opened at.*file-handles\.test\.ts/,
      );
    });
  });

  describe('fs.createReadStream', () => {
    it('should track read streams', async () => {
      fileHandles.track();

      const stream = fs.createReadStream(testFile);

      const snapshot = fileHandles.snapshot();
      expect(snapshot.readStream).toBe(1);
      expect(snapshot.total).toBe(1);

      // Close the stream
      stream.close();
      await new Promise((resolve) => stream.on('close', resolve));

      await expect(fileHandles.check()).resolves.toBeUndefined();
    });

    it('should detect unclosed read streams', async () => {
      fileHandles.track();

      fs.createReadStream(testFile);

      await expect(fileHandles.check()).rejects.toThrow(
        'File handle leaks detected',
      );
    });

    it('should track multiple read streams', async () => {
      fileHandles.track();

      const stream1 = fs.createReadStream(testFile);
      const stream2 = fs.createReadStream(testFile);

      const snapshot = fileHandles.snapshot();
      expect(snapshot.readStream).toBe(2);
      expect(snapshot.total).toBe(2);

      stream1.close();
      stream2.close();
      await Promise.all([
        new Promise((resolve) => stream1.on('close', resolve)),
        new Promise((resolve) => stream2.on('close', resolve)),
      ]);

      await expect(fileHandles.check()).resolves.toBeUndefined();
    });
  });

  describe('fs.createWriteStream', () => {
    it('should track write streams', async () => {
      fileHandles.track();

      const outFile = path.join(tempDir, 'output.txt');
      const stream = fs.createWriteStream(outFile);

      const snapshot = fileHandles.snapshot();
      expect(snapshot.writeStream).toBe(1);
      expect(snapshot.total).toBe(1);

      // Close the stream
      stream.close();
      await new Promise((resolve) => stream.on('close', resolve));

      await expect(fileHandles.check()).resolves.toBeUndefined();
    });

    it('should detect unclosed write streams', async () => {
      fileHandles.track();

      const outFile = path.join(tempDir, 'output.txt');
      fs.createWriteStream(outFile);

      await expect(fileHandles.check()).rejects.toThrow(
        'File handle leaks detected',
      );
    });
  });

  describe('fs.promises.open', () => {
    it('should track promise-based file handles', async () => {
      fileHandles.track();

      const handle = await fsPromises.open(testFile, 'r');

      const snapshot = fileHandles.snapshot();
      expect(snapshot.promiseHandle).toBe(1);
      expect(snapshot.total).toBe(1);

      await handle.close();

      await expect(fileHandles.check()).resolves.toBeUndefined();
    });

    it('should detect unclosed promise-based file handles', async () => {
      fileHandles.track();

      await fsPromises.open(testFile, 'r');

      await expect(fileHandles.check()).rejects.toThrow(
        'File handle leaks detected',
      );
    });

    it('should track multiple promise-based handles', async () => {
      fileHandles.track();

      const handle1 = await fsPromises.open(testFile, 'r');
      const handle2 = await fsPromises.open(testFile, 'r');

      const snapshot = fileHandles.snapshot();
      expect(snapshot.promiseHandle).toBe(2);
      expect(snapshot.total).toBe(2);

      await handle1.close();
      await handle2.close();

      await expect(fileHandles.check()).resolves.toBeUndefined();
    });
  });

  describe('fs.watch', () => {
    it('should track file watchers', async () => {
      fileHandles.track();

      const watcher = fs.watch(testFile, () => {});

      const snapshot = fileHandles.snapshot();
      expect(snapshot.watch).toBe(1);
      expect(snapshot.total).toBe(1);

      watcher.close();

      await expect(fileHandles.check()).resolves.toBeUndefined();
    });

    it('should detect unclosed watchers', async () => {
      fileHandles.track();

      fs.watch(testFile, () => {});

      await expect(fileHandles.check()).rejects.toThrow(
        'File handle leaks detected',
      );
    });

    it('should track multiple watchers', async () => {
      fileHandles.track();

      const watcher1 = fs.watch(testFile, () => {});
      const watcher2 = fs.watch(tempDir, () => {});

      const snapshot = fileHandles.snapshot();
      expect(snapshot.watch).toBe(2);
      expect(snapshot.total).toBe(2);

      watcher1.close();
      watcher2.close();

      await expect(fileHandles.check()).resolves.toBeUndefined();
    });
  });

  describe('fs.watchFile', () => {
    it('should track file watchers', async () => {
      fileHandles.track();

      fs.watchFile(testFile, () => {});

      const snapshot = fileHandles.snapshot();
      expect(snapshot.watchFile).toBe(1);
      expect(snapshot.total).toBe(1);

      fs.unwatchFile(testFile);

      await expect(fileHandles.check()).resolves.toBeUndefined();
    });

    it('should detect unclosed file watchers', async () => {
      fileHandles.track();

      fs.watchFile(testFile, () => {});

      await expect(fileHandles.check()).rejects.toThrow(
        'File handle leaks detected',
      );
    });
  });

  describe('mixed handles', () => {
    it('should track multiple types of handles', async () => {
      fileHandles.track();

      // Create various handles
      const fd = await new Promise<number>((resolve, reject) => {
        fs.open(testFile, 'r', (err, fd) => {
          if (err) {
            reject(err);
          } else {
            resolve(fd);
          }
        });
      });
      const readStream = fs.createReadStream(testFile);
      const writeStream = fs.createWriteStream(
        path.join(tempDir, 'output.txt'),
      );
      const promiseHandle = await fsPromises.open(testFile, 'r');
      const watcher = fs.watch(testFile, () => {});
      fs.watchFile(testFile, () => {});

      const snapshot = fileHandles.snapshot();
      expect(snapshot.open).toBe(1);
      expect(snapshot.readStream).toBe(1);
      expect(snapshot.writeStream).toBe(1);
      expect(snapshot.promiseHandle).toBe(1);
      expect(snapshot.watch).toBe(1);
      expect(snapshot.watchFile).toBe(1);
      expect(snapshot.total).toBe(6);

      // Close all handles
      await new Promise<void>((resolve, reject) => {
        fs.close(fd, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      readStream.close();
      writeStream.close();
      await promiseHandle.close();
      watcher.close();
      fs.unwatchFile(testFile);

      await Promise.all([
        new Promise((resolve) => readStream.on('close', resolve)),
        new Promise((resolve) => writeStream.on('close', resolve)),
      ]);

      await expect(fileHandles.check()).resolves.toBeUndefined();
    });

    it('should show summary with multiple types leaked', async () => {
      fileHandles.track();

      await fsPromises.open(testFile, 'r');
      fs.createReadStream(testFile);

      await expect(fileHandles.check({ format: 'summary' })).rejects.toThrow(
        /promiseHandle: 1 leaked[\s\S]*readStream: 1 leaked/,
      );
    });

    it('should show short format with multiple types leaked', async () => {
      fileHandles.track();

      await fsPromises.open(testFile, 'r');
      fs.createReadStream(testFile);

      await expect(fileHandles.check({ format: 'short' })).rejects.toThrow(
        'File handle leaks detected: 2 open handle(s)',
      );
    });
  });

  describe('error handling', () => {
    it('should throw if tracking not started', async () => {
      await expect(fileHandles.check()).rejects.toThrow(
        'File handle leak detection not set up',
      );
    });

    it('should throw if tracking already started', () => {
      fileHandles.track();
      expect(() => fileHandles.track()).toThrow(
        'File handle leak detection already set up',
      );

      // Clean up
      fileHandles.check({ throwOnLeaks: false }).catch(() => {});
    });

    it('should not throw if throwOnLeaks is false', async () => {
      fileHandles.track();

      fs.createReadStream(testFile);

      await expect(
        fileHandles.check({ throwOnLeaks: false }),
      ).resolves.toBeUndefined();
    });
  });

  describe('snapshots', () => {
    it('should return empty snapshot initially', () => {
      fileHandles.track();

      const snapshot = fileHandles.snapshot();
      expect(snapshot.open).toBe(0);
      expect(snapshot.readStream).toBe(0);
      expect(snapshot.writeStream).toBe(0);
      expect(snapshot.promiseHandle).toBe(0);
      expect(snapshot.watch).toBe(0);
      expect(snapshot.watchFile).toBe(0);
      expect(snapshot.total).toBe(0);

      fileHandles.check({ throwOnLeaks: false }).catch(() => {});
    });

    it('should update snapshot as handles are created', async () => {
      fileHandles.track();

      let snapshot = fileHandles.snapshot();
      expect(snapshot.total).toBe(0);

      fs.createReadStream(testFile);
      snapshot = fileHandles.snapshot();
      expect(snapshot.total).toBe(1);

      fs.createWriteStream(path.join(tempDir, 'output.txt'));
      snapshot = fileHandles.snapshot();
      expect(snapshot.total).toBe(2);

      await fileHandles.check({ throwOnLeaks: false });
    });
  });
});
