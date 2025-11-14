/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import {
  Duplex,
  PassThrough,
  Readable,
  Transform,
  Writable,
} from 'node:stream';

import { describe, expect, it } from 'vitest';

import { checkStreams, snapshotStreams, trackStreams } from './streams';

describe('streams', () => {
  describe('trackStreams', () => {
    it('should throw if already tracking', () => {
      trackStreams();
      expect(() => trackStreams()).toThrow(
        'Stream leak detection already set up',
      );
      // Clean up
      checkStreams({ throwOnLeaks: false }).catch(() => {});
    });
  });

  describe('Readable streams', () => {
    it('should track Readable stream creation', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
          this.push(null);
        },
      });

      // Trigger stream registration by reading
      readable.read();

      const snapshot = snapshotStreams();
      expect(snapshot.total).toBe(1);
      expect(snapshot.byType.Readable).toBe(1);
      expect(snapshot.active).toBe(1);

      readable.destroy();
      await checkStreams({ throwOnLeaks: false });
    });

    it('should detect leaked Readable streams', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
        },
      });
      readable.read(); // Trigger registration

      await expect(checkStreams()).rejects.toThrow('Stream leaks detected');
    });

    it('should not report destroyed Readable streams as leaks', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
          this.push(null);
        },
      });

      readable.destroy();

      await expect(checkStreams()).resolves.not.toThrow();
    });

    it('should track Readable stream that ends naturally', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
          this.push(null);
        },
      });

      // Trigger registration
      readable.read();

      // Consume the stream
      readable.on('data', () => {});
      await new Promise((resolve) => readable.on('end', resolve));

      // Destroy after end - stream should be marked as ended
      readable.destroy();

      // Should not throw even if there was some buffering
      const result = await checkStreams({ throwOnLeaks: false });
      expect(result).toBeUndefined();
    });
  });

  describe('Writable streams', () => {
    it('should track Writable stream creation', async () => {
      trackStreams();
      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });

      // Trigger stream registration by writing
      writable.write('test');

      const snapshot = snapshotStreams();
      expect(snapshot.total).toBe(1);
      expect(snapshot.byType.Writable).toBe(1);
      expect(snapshot.active).toBe(1);

      writable.destroy();
      await checkStreams({ throwOnLeaks: false });
    });

    it('should detect leaked Writable streams', async () => {
      trackStreams();
      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });
      writable.write('test'); // Trigger registration

      await expect(checkStreams()).rejects.toThrow('Stream leaks detected');
    });

    it('should not report destroyed Writable streams as leaks', async () => {
      trackStreams();
      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });

      writable.destroy();

      await expect(checkStreams()).resolves.not.toThrow();
    });

    it('should track Writable stream that finishes naturally', async () => {
      trackStreams();
      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });

      writable.write('test');
      writable.end();

      await new Promise((resolve) => writable.on('finish', resolve));

      // Even after finish, writable should be closed/destroyed
      writable.destroy();

      await expect(checkStreams()).resolves.not.toThrow();
    });
  });

  describe('Transform streams', () => {
    it('should track Transform stream creation', async () => {
      trackStreams();
      const transform = new Transform({
        transform(chunk, encoding, callback) {
          this.push(chunk.toString().toUpperCase());
          callback();
        },
      });

      // Trigger stream registration
      transform.write('test');

      const snapshot = snapshotStreams();
      expect(snapshot.total).toBe(1);
      expect(snapshot.byType.Transform).toBe(1);
      expect(snapshot.active).toBe(1);

      transform.destroy();
      await checkStreams({ throwOnLeaks: false });
    });

    it('should detect leaked Transform streams', async () => {
      trackStreams();
      const transform = new Transform({
        transform(chunk, encoding, callback) {
          this.push(chunk);
          callback();
        },
      });
      transform.write('test'); // Trigger registration

      await expect(checkStreams()).rejects.toThrow('Stream leaks detected');
    });

    it('should not report destroyed Transform streams as leaks', async () => {
      trackStreams();
      const transform = new Transform({
        transform(chunk, encoding, callback) {
          this.push(chunk);
          callback();
        },
      });

      transform.destroy();

      await expect(checkStreams()).resolves.not.toThrow();
    });
  });

  describe('Duplex streams', () => {
    it('should track Duplex stream creation', async () => {
      trackStreams();
      const duplex = new Duplex({
        read() {
          this.push('test');
          this.push(null);
        },
        write(chunk, encoding, callback) {
          callback();
        },
      });

      // Trigger stream registration
      duplex.read();

      const snapshot = snapshotStreams();
      expect(snapshot.total).toBe(1);
      expect(snapshot.byType.Duplex).toBe(1);
      expect(snapshot.active).toBe(1);

      duplex.destroy();
      await checkStreams({ throwOnLeaks: false });
    });

    it('should detect leaked Duplex streams', async () => {
      trackStreams();
      const duplex = new Duplex({
        read() {
          this.push('test');
        },
        write(chunk, encoding, callback) {
          callback();
        },
      });
      duplex.read(); // Trigger registration

      await expect(checkStreams()).rejects.toThrow('Stream leaks detected');
    });

    it('should not report destroyed Duplex streams as leaks', async () => {
      trackStreams();
      const duplex = new Duplex({
        read() {
          this.push('test');
          this.push(null);
        },
        write(chunk, encoding, callback) {
          callback();
        },
      });

      duplex.destroy();

      await expect(checkStreams()).resolves.not.toThrow();
    });
  });

  describe('Pipe chains', () => {
    it('should track pipe chains', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
          this.push(null);
        },
      });

      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });

      readable.pipe(writable);

      const snapshot = snapshotStreams();
      expect(snapshot.total).toBe(2);

      readable.destroy();
      writable.destroy();

      await checkStreams({ throwOnLeaks: false });
    });

    it('should detect broken pipe chains', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
        },
      });

      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });

      readable.pipe(writable);

      // Destroy destination but keep source alive
      writable.destroy();

      // Should detect leak (source still alive) and/or broken pipe
      await expect(checkStreams()).rejects.toThrow();
    });

    it('should not report broken pipes if both are destroyed', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
          this.push(null);
        },
      });

      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });

      readable.pipe(writable);

      // Destroy both - should not report as leak
      writable.destroy();
      readable.destroy();

      // Since both are destroyed, shouldn't throw
      const result = await checkStreams({ throwOnLeaks: false });
      expect(result).toBeUndefined();
    });
  });

  describe('Buffer growth detection', () => {
    it('should detect streams with growing readable buffers', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          // Push lots of data without consuming it
          for (let i = 0; i < 100; i++) {
            this.push(`chunk-${i}`);
          }
        },
      });

      // Pause the stream to let buffer grow
      readable.pause();
      readable.read();

      // Give some time for buffer to accumulate
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should detect buffer growth and/or leak
      await expect(checkStreams()).rejects.toThrow();
    });

    it('should detect streams with growing writable buffers', async () => {
      trackStreams();
      let callbackQueue: Array<() => void> = [];
      const writable = new Writable({
        write(chunk, encoding, callback) {
          // Don't call callback immediately to let buffer grow
          callbackQueue.push(callback);
        },
      });

      // Write lots of data without draining
      for (let i = 0; i < 20; i++) {
        writable.write(`chunk-${i}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should detect buffer growth and/or leak
      await expect(checkStreams()).rejects.toThrow();

      // Clean up callbacks (after test)
      for (const cb of callbackQueue) {
        cb();
      }
      callbackQueue = [];
    });
  });

  describe('Multiple streams', () => {
    it('should track multiple streams of different types', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
          this.push(null);
        },
      });
      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });
      const transform = new Transform({
        transform(chunk, encoding, callback) {
          this.push(chunk);
          callback();
        },
      });

      // Trigger registration
      readable.read();
      writable.write('test');
      transform.write('test');

      const snapshot = snapshotStreams();
      expect(snapshot.total).toBe(3);
      expect(snapshot.byType.Readable).toBe(1);
      expect(snapshot.byType.Writable).toBe(1);
      expect(snapshot.byType.Transform).toBe(1);

      readable.destroy();
      writable.destroy();
      transform.destroy();

      await checkStreams({ throwOnLeaks: false });
    });

    it('should detect multiple leaked streams', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
        },
      });
      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });
      readable.read(); // Trigger registration
      writable.write('test'); // Trigger registration

      await expect(checkStreams()).rejects.toThrow('Stream leaks detected');
    });
  });

  describe('Output formats', () => {
    it('should format short message', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
        },
      });
      readable.read(); // Trigger registration

      const error = await checkStreams({ format: 'short' }).catch((e) => e);
      expect(error.message).toMatch(/Stream leaks detected: \d+ leaked stream/);
    });

    it('should format summary message', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
        },
      });
      readable.read(); // Trigger registration

      const error = await checkStreams({ format: 'summary' }).catch((e) => e);
      expect(error.message).toContain('Stream leaks detected');
      expect(error.message).toContain('Readable');
    });

    it('should format details message', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
        },
      });
      readable.read(); // Trigger registration

      const error = await checkStreams({ format: 'details' }).catch((e) => e);
      expect(error.message).toContain('Stream leaks detected');
      expect(error.message).toContain('Readable');
      expect(error.message).toContain('State:');
    });
  });

  describe('Snapshot', () => {
    it('should create accurate snapshots', async () => {
      trackStreams();
      const readable1 = new Readable({ read() {} });
      const readable2 = new Readable({ read() {} });
      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });

      // Trigger registration
      readable1.read();
      readable2.read();
      writable.write('test');

      let snapshot = snapshotStreams();
      expect(snapshot.total).toBe(3);
      expect(snapshot.byType.Readable).toBe(2);
      expect(snapshot.byType.Writable).toBe(1);
      expect(snapshot.active).toBe(3);
      expect(snapshot.destroyed).toBe(0);

      readable1.destroy();

      snapshot = snapshotStreams();
      expect(snapshot.total).toBe(3);
      expect(snapshot.active).toBe(2);
      expect(snapshot.destroyed).toBe(1);

      readable2.destroy();
      writable.destroy();

      await checkStreams({ throwOnLeaks: false });
    });
  });

  describe('GC cycle tracking', () => {
    it('should track streams surviving GC cycles', async () => {
      if (global.gc === undefined) {
        // Skip if GC is not exposed
        return;
      }

      trackStreams();
      new Readable({
        read() {
          this.push('test');
        },
      });

      const error = await checkStreams({
        forceGC: true,
        format: 'summary',
      }).catch((e) => e);
      expect(error.message).toContain('Stream leaks detected');
      // The message might include GC cycle info
    });
  });

  describe('Error handling', () => {
    it('should throw if check is called without track', async () => {
      await expect(checkStreams()).rejects.toThrow(
        'Stream leak detection not set up',
      );
    });

    it('should handle streams with custom properties', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
          this.push(null);
        },
      });

      // Add custom properties that might interfere
      (readable as any).customProp = { nested: { deep: 'value' } };

      readable.destroy();

      await expect(checkStreams()).resolves.not.toThrow();
    });
  });

  describe('PassThrough streams', () => {
    it('should track PassThrough streams (Transform subclass)', async () => {
      trackStreams();
      const passThrough = new PassThrough();

      // Trigger stream registration
      passThrough.write('test');

      const snapshot = snapshotStreams();
      expect(snapshot.total).toBe(1);
      expect(snapshot.byType.Transform).toBe(1);

      passThrough.destroy();
      await checkStreams({ throwOnLeaks: false });
    });

    it('should detect leaked PassThrough streams', async () => {
      trackStreams();
      const passThrough = new PassThrough();
      passThrough.write('test'); // Trigger registration

      await expect(checkStreams()).rejects.toThrow('Stream leaks detected');
    });
  });

  describe('Complex pipe chains', () => {
    it('should handle multi-stage pipe chains', async () => {
      trackStreams();
      const readable = new Readable({
        read() {
          this.push('test');
          this.push(null);
        },
      });
      const transform1 = new Transform({
        transform(chunk, encoding, callback) {
          this.push(chunk.toString().toUpperCase());
          callback();
        },
      });
      const transform2 = new Transform({
        transform(chunk, encoding, callback) {
          this.push(chunk.toString() + '!');
          callback();
        },
      });
      const writable = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });

      readable.pipe(transform1).pipe(transform2).pipe(writable);

      const snapshot = snapshotStreams();
      expect(snapshot.total).toBe(4);

      readable.destroy();
      transform1.destroy();
      transform2.destroy();
      writable.destroy();

      await checkStreams({ throwOnLeaks: false });
    });
  });
});
