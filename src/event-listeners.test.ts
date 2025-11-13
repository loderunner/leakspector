import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
} from 'node:http';
import { createConnection, createServer } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkEventListeners,
  clearEmitterStringifiers,
  eventListeners,
  registerEmitterStringifier,
  snapshotEventListeners,
  trackEventListeners,
} from './event-listeners';
import { forceGarbageCollection } from './force-gc';

vi.mock('./force-gc', () => ({
  forceGarbageCollection: vi.fn(),
}));

describe('event-listeners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await checkEventListeners({ throwOnLeaks: false });
    } catch {
      // Ignore errors if tracking wasn't set up
    }
  });

  describe('trackEventListeners', () => {
    it('should start tracking event listeners', () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);

      const snapshot = snapshotEventListeners();
      expect(snapshot['EventEmitter#1']).toBeDefined();
      expect(snapshot['EventEmitter#1'].test).toBe(1);
    });

    it('should throw error if tracking is already set up', () => {
      trackEventListeners();

      expect(() => {
        trackEventListeners();
      }).toThrow(/already set up/);
    });

    it('should track listeners added via addListener', () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.addListener('test', handler);

      const snapshot = snapshotEventListeners();
      expect(snapshot['EventEmitter#1'].test).toBe(1);
    });

    it('should track listeners added via once', () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.once('test', handler);

      const snapshot = snapshotEventListeners();
      expect(snapshot['EventEmitter#1'].test).toBe(1);
    });

    it('should capture initial state when emitter already has listeners', () => {
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      emitter.on('existing', handler1);

      trackEventListeners();
      const handler2 = vi.fn();
      emitter.on('existing', handler2);

      const snapshot = snapshotEventListeners();
      expect(snapshot['EventEmitter#1'].existing).toBe(2);
    });

    it('should track multiple emitters', () => {
      trackEventListeners();
      class Emitter1 extends EventEmitter {}
      class Emitter2 extends EventEmitter {}
      const emitter1 = new Emitter1();
      const emitter2 = new Emitter2();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter1.on('event1', handler1);
      emitter2.on('event2', handler2);

      const snapshot = snapshotEventListeners();
      expect(snapshot['Emitter1#1'].event1).toBe(1);
      expect(snapshot['Emitter2#1'].event2).toBe(1);
    });

    it('should track multiple events on same emitter', () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('event1', handler1);
      emitter.on('event2', handler2);

      const snapshot = snapshotEventListeners();
      expect(snapshot['EventEmitter#1'].event1).toBe(1);
      expect(snapshot['EventEmitter#1'].event2).toBe(1);
    });
  });

  describe('snapshotListeners', () => {
    it('should create snapshot of current listeners', () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('test', handler1);
      emitter.on('test', handler2);

      const snapshot = snapshotEventListeners();
      expect(snapshot['EventEmitter#1'].test).toBe(2);
    });

    it('should return empty snapshot when no listeners', () => {
      trackEventListeners();
      const snapshot = snapshotEventListeners();
      expect(snapshot).toEqual({});
    });

    it('should snapshot listeners by emitter constructor name', () => {
      trackEventListeners();

      class CustomEmitter extends EventEmitter {}
      const customEmitter = new CustomEmitter();
      const handler = vi.fn();

      customEmitter.on('custom', handler);

      const snapshot = snapshotEventListeners();
      expect(snapshot['CustomEmitter#1']).toBeDefined();
      expect(snapshot['CustomEmitter#1'].custom).toBe(1);
    });

    it('should handle symbol event names', () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const symbolEvent = Symbol('test');
      const handler = vi.fn();

      emitter.on(symbolEvent, handler);

      const snapshot = snapshotEventListeners();
      expect(snapshot['EventEmitter#1'][symbolEvent]).toBe(1);
    });
  });

  describe('checkListeners', () => {
    it('should throw error if tracking not set up', async () => {
      await expect(checkEventListeners()).rejects.toThrow(/not set up/);
    });

    it('should not throw when no leaks detected', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);
      emitter.off('test', handler);

      await expect(checkEventListeners()).resolves.not.toThrow();
    });

    it('should detect listener leaks', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);
      // Don't remove handler - this is a leak

      await expect(checkEventListeners()).rejects.toThrow(/leaks detected/);
    });

    it('should restore original EventEmitter methods', async () => {
      // Capture originals before tracking starts
      const originalOn = EventEmitter.prototype.on;
      const originalAddListener = EventEmitter.prototype.addListener;
      const originalOnce = EventEmitter.prototype.once;
      const originalRemoveListener = EventEmitter.prototype.removeListener;
      const originalOff = EventEmitter.prototype.off;

      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();
      emitter.on('test', handler);
      emitter.off('test', handler);

      await checkEventListeners({ throwOnLeaks: false });

      expect(EventEmitter.prototype.on).toBe(originalOn);
      expect(EventEmitter.prototype.addListener).toBe(originalAddListener);
      expect(EventEmitter.prototype.once).toBe(originalOnce);
      expect(EventEmitter.prototype.removeListener).toBe(
        originalRemoveListener,
      );
      expect(EventEmitter.prototype.off).toBe(originalOff);
    });

    it('should clear tracking state after check', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);
      emitter.off('test', handler);

      await checkEventListeners({ throwOnLeaks: false });

      // Should be able to track again after check
      trackEventListeners();
      const snapshot = snapshotEventListeners();
      expect(snapshot).toEqual({});
    });

    it('should call forceGarbageCollection when forceGC is true', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);
      emitter.off('test', handler);

      await checkEventListeners({ forceGC: true, throwOnLeaks: false });

      expect(forceGarbageCollection).toHaveBeenCalledTimes(1);
    });

    it('should not call forceGarbageCollection when forceGC is false', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);
      emitter.off('test', handler);

      await checkEventListeners({ forceGC: false, throwOnLeaks: false });

      expect(forceGarbageCollection).not.toHaveBeenCalled();
    });

    it('should not call forceGarbageCollection when forceGC is undefined', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);
      emitter.off('test', handler);

      await checkEventListeners({ throwOnLeaks: false });

      expect(forceGarbageCollection).not.toHaveBeenCalled();
    });

    it('should throw error on leaks by default', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);

      await expect(checkEventListeners()).rejects.toThrow();
    });

    it('should log error message when throwOnLeaks is false', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);

      await expect(
        checkEventListeners({ throwOnLeaks: false }),
      ).resolves.not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/leaks detected/),
      );

      consoleErrorSpy.mockRestore();
    });

    it('should detect leaks for multiple events', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('event1', handler1);
      emitter.on('event2', handler2);

      await expect(checkEventListeners()).rejects.toThrow(
        /event1[\s\S]*event2/,
      );
    });

    it('should detect leaks for multiple emitters', async () => {
      trackEventListeners();
      class Emitter1 extends EventEmitter {}
      class Emitter2 extends EventEmitter {}
      const emitter1 = new Emitter1();
      const emitter2 = new Emitter2();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter1.on('test', handler1);
      emitter2.on('test', handler2);

      await expect(checkEventListeners()).rejects.toThrow(
        /Emitter1#1.test[\s\S]*Emitter2#1.test/,
      );
    });

    it('should correctly calculate leak count', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      emitter.on('test', handler1);
      emitter.on('test', handler2);
      emitter.on('test', handler3);

      try {
        await checkEventListeners();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain('found 3 (+3 leaked)');
      }
    });

    it('should handle emitters with initial listeners', async () => {
      const emitter = new EventEmitter();
      const initialHandler = vi.fn();
      emitter.on('test', initialHandler);

      trackEventListeners();
      const newHandler = vi.fn();
      emitter.on('test', newHandler);
      emitter.off('test', newHandler);

      // Should not throw because we only leaked the new handler, which was removed
      await expect(checkEventListeners()).resolves.not.toThrow();
    });

    it('should handle emitters with initial listeners that leak', async () => {
      const emitter = new EventEmitter();
      const initialHandler = vi.fn();
      emitter.on('test', initialHandler);

      trackEventListeners();
      const newHandler = vi.fn();
      emitter.on('test', newHandler);
      // Don't remove newHandler - this is a leak

      await expect(checkEventListeners()).rejects.toThrow(
        /found 2 \(\+1 leaked\)/,
      );
    });

    it('should handle symbol event names in leak detection', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const symbolEvent = Symbol('test');
      const handler = vi.fn();

      emitter.on(symbolEvent, handler);

      await expect(checkEventListeners()).rejects.toThrow(/Symbol\(test\)/);
    });
  });

  describe('multiple emitters with same constructor name', () => {
    it('should detect leaks from all emitters even with same constructor', async () => {
      trackEventListeners();
      const emitter1 = new EventEmitter();
      const emitter2 = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter1.on('event1', handler1);
      emitter2.on('event2', handler2);

      // Both should be detected as leaks with unique IDs
      await expect(checkEventListeners()).rejects.toThrow(
        /EventEmitter#1.event1[\s\S]*EventEmitter#2.event2/,
      );
    });

    it('should snapshot all emitters even when they have same constructor name', () => {
      trackEventListeners();
      const emitter1 = new EventEmitter();
      const emitter2 = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter1.on('event1', handler1);
      emitter2.on('event2', handler2);

      const snapshot = snapshotEventListeners();
      // Now both emitters are captured with unique IDs
      expect(snapshot['EventEmitter#1'].event1).toBe(1);
      expect(snapshot['EventEmitter#2'].event2).toBe(1);
    });

    it('should show unique IDs in error messages for same constructor emitters', async () => {
      trackEventListeners();
      const emitter1 = new EventEmitter();
      const emitter2 = new EventEmitter();
      const emitter3 = new EventEmitter();
      const handler = vi.fn();

      emitter1.on('leak', handler);
      emitter2.on('leak', handler);
      emitter3.on('leak', handler);

      try {
        await checkEventListeners();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain('EventEmitter#1.leak');
        expect(message).toContain('EventEmitter#2.leak');
        expect(message).toContain('EventEmitter#3.leak');
      }
    });
  });

  describe('known emitter type identification', () => {
    it('should identify net.Server', async () => {
      trackEventListeners();
      const server = createServer();
      const handler = vi.fn();
      server.on('connection', handler);

      // Check snapshot before listening
      let snapshot = snapshotEventListeners();
      let keys = Object.keys(snapshot);
      let serverKey = keys.find((k) => k.startsWith('Server ('));
      expect(serverKey).toBeDefined();
      // Before listening, should show "not listening"
      expect(serverKey).toContain('Server (not listening)');

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          // After listening, ID is already cached, but we verify it's a Server
          snapshot = snapshotEventListeners();
          keys = Object.keys(snapshot);
          serverKey = keys.find((k) => k.startsWith('Server ('));
          expect(serverKey).toBeDefined();
          expect(serverKey).toMatch(/^Server \(/);

          server.close(() => resolve());
        });
      });
    });

    it('should identify net.Socket', async () => {
      trackEventListeners();
      const server = createServer();
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port;
          const socket = createConnection(port, '127.0.0.1');
          const handler = vi.fn();
          socket.on('data', handler);
          socket.on('error', () => {}); // Ignore connection errors

          // Check before connect - should show "not connected"
          let snapshot = snapshotEventListeners();
          let keys = Object.keys(snapshot);
          let socketKey = keys.find((k) => k.startsWith('Socket ('));
          expect(socketKey).toBeDefined();
          expect(socketKey).toContain('Socket (not connected)');

          socket.on('connect', () => {
            // After connect, ID is already cached, but we verify it's a Socket
            snapshot = snapshotEventListeners();
            keys = Object.keys(snapshot);
            socketKey = keys.find((k) => k.startsWith('Socket ('));
            expect(socketKey).toBeDefined();
            expect(socketKey).toMatch(/^Socket \(/);

            socket.end();
            server.close(() => resolve());
          });
        });
      });
    });

    it('should identify fs.ReadStream with path', async () => {
      trackEventListeners();
      // Use a file that definitely exists
      const stream = createReadStream('package.json');
      const handler = vi.fn();
      stream.on('data', handler);
      stream.on('error', () => {}); // Ignore read errors

      const snapshot = snapshotEventListeners();
      const keys = Object.keys(snapshot);
      const readStreamKey = keys.find((k) => k.startsWith('ReadStream ('));
      expect(readStreamKey).toBeDefined();
      expect(readStreamKey).toContain('ReadStream');
      expect(readStreamKey).toContain('package.json');

      // Close the stream
      await new Promise<void>((resolve) => {
        stream.on('close', () => resolve());
        stream.on('end', () => resolve());
        stream.close();
      });
    });

    it('should identify child_process.ChildProcess with pid', async () => {
      trackEventListeners();
      // Use a simple command that exits quickly
      const proc = spawn('echo', ['test'], { shell: true });
      const handler = vi.fn();
      proc.on('exit', handler);

      const snapshot = snapshotEventListeners();
      const keys = Object.keys(snapshot);
      const procKey = keys.find((k) => k.startsWith('ChildProcess (pid '));
      expect(procKey).toBeDefined();
      expect(procKey).toMatch(/ChildProcess \(pid \d+\)/);

      await new Promise<void>((resolve) => {
        proc.on('exit', () => resolve());
      });
    });

    it('should identify http.IncomingMessage', async () => {
      trackEventListeners();
      let snapshot = {};
      const server = createHttpServer((req, res) => {
        const handler = vi.fn();
        req.on('data', handler);

        snapshot = snapshotEventListeners();

        res.statusCode = 200;
        res.end();
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port;
          const req = httpRequest(`http://127.0.0.1:${port}/api/users`, () => {
            server.close(() => resolve());
          });
          req.on('error', () => {
            server.close(() => resolve());
          });
          req.end();
        });
      });

      const keys = Object.keys(snapshot);
      const reqKey = keys.find((k) => k.startsWith('IncomingMessage ('));
      expect(reqKey).toBeDefined();
      expect(reqKey).toContain('IncomingMessage (');
      expect(reqKey).toContain('GET');
      expect(reqKey).toContain('/api/users');
    });

    it('should identify http.ServerResponse', async () => {
      trackEventListeners();
      let snapshot = {};
      const server = createHttpServer((_req, res) => {
        res.statusCode = 200;
        const handler = vi.fn();
        res.on('finish', handler);

        snapshot = snapshotEventListeners();
        res.end();
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port;
          const req = httpRequest(`http://127.0.0.1:${port}/`, () => {
            server.close(() => resolve());
          });
          req.on('error', () => {
            server.close(() => resolve());
          });
          req.end();
        });
      });

      const keys = Object.keys(snapshot);
      const resKey = keys.find((k) => k.startsWith('ServerResponse ('));
      expect(resKey).toBeDefined();
      expect(resKey).toBe('ServerResponse (200)');
    });

    it('should fallback to generic ID for unknown types', () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();
      emitter.on('test', handler);

      const snapshot = snapshotEventListeners();
      expect(snapshot['EventEmitter#1']).toBeDefined();
      expect(snapshot['EventEmitter#1'].test).toBe(1);
    });
  });

  describe('custom emitter stringifiers', () => {
    afterEach(() => {
      clearEmitterStringifiers();
    });

    it('should use custom stringifier for custom emitter type', () => {
      class MyCustomEmitter extends EventEmitter {
        constructor(public id: string) {
          super();
        }
      }

      registerEmitterStringifier((emitter) => {
        if (emitter instanceof MyCustomEmitter) {
          return `MyCustomEmitter (id: ${emitter.id})`;
        }
      });

      trackEventListeners();
      const emitter = new MyCustomEmitter('test-123');
      const handler = vi.fn();
      emitter.on('data', handler);

      const snapshot = snapshotEventListeners();
      expect(snapshot['MyCustomEmitter (id: test-123)']).toBeDefined();
      expect(snapshot['MyCustomEmitter (id: test-123)'].data).toBe(1);
    });

    it('should check custom stringifiers before built-in ones', () => {
      registerEmitterStringifier((emitter) => {
        if (emitter instanceof EventEmitter) {
          return `CustomOverride (${emitter.constructor.name})`;
        }
      });

      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();
      emitter.on('test', handler);

      const snapshot = snapshotEventListeners();
      // Should use custom stringifier, not fallback to EventEmitter#1
      const keys = Object.keys(snapshot);
      expect(keys[0]).toBe('CustomOverride (EventEmitter)');
    });

    it('should support multiple custom stringifiers', () => {
      class EmitterA extends EventEmitter {
        constructor(public name: string) {
          super();
        }
      }

      class EmitterB extends EventEmitter {
        constructor(public id: number) {
          super();
        }
      }

      registerEmitterStringifier((emitter) => {
        if (emitter instanceof EmitterA) {
          return `EmitterA (${emitter.name})`;
        }
      });

      registerEmitterStringifier((emitter) => {
        if (emitter instanceof EmitterB) {
          return `EmitterB (${emitter.id})`;
        }
      });

      trackEventListeners();
      const emitterA = new EmitterA('test');
      const emitterB = new EmitterB(42);
      const handler = vi.fn();
      emitterA.on('event', handler);
      emitterB.on('event', handler);

      const snapshot = snapshotEventListeners();
      expect(snapshot['EmitterA (test)']).toBeDefined();
      expect(snapshot['EmitterB (42)']).toBeDefined();
    });

    it('should clear all custom stringifiers', () => {
      registerEmitterStringifier((_emitter) => {
        return 'Custom';
      });

      clearEmitterStringifiers();

      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();
      emitter.on('test', handler);

      const snapshot = snapshotEventListeners();
      // Should use generic ID since custom stringifier was cleared
      expect(snapshot['EventEmitter#1']).toBeDefined();
    });

    it('should use custom stringifier in error messages', async () => {
      class MyEmitter extends EventEmitter {
        constructor(public id: string) {
          super();
        }
      }

      registerEmitterStringifier((emitter) => {
        if (emitter instanceof MyEmitter) {
          return `MyEmitter (${emitter.id})`;
        }
        return null;
      });

      trackEventListeners();
      const emitter = new MyEmitter('leak-test');
      const handler = vi.fn();
      emitter.on('data', handler);

      try {
        await checkEventListeners();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain('MyEmitter (leak-test)');
      }
    });
  });

  describe('eventListeners convenience object', () => {
    it('should provide track method', () => {
      expect(eventListeners.track).toBe(trackEventListeners);
    });

    it('should provide snapshot method', () => {
      expect(eventListeners.snapshot).toBe(snapshotEventListeners);
    });

    it('should provide check method', () => {
      expect(eventListeners.check).toBe(checkEventListeners);
    });

    it('should work through convenience object', async () => {
      eventListeners.track();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);

      const snapshot = eventListeners.snapshot();
      expect(snapshot['EventEmitter#1'].test).toBe(1);

      await expect(eventListeners.check({})).rejects.toThrow();
    });
  });

  describe('output format options', () => {
    it('should support "short" format', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackEventListeners();
      const emitter1 = new EventEmitter();
      const emitter2 = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      emitter1.on('event1', handler1);
      emitter1.on('event2', handler2);
      emitter2.on('event1', handler3);

      await checkEventListeners({ format: 'short', throwOnLeaks: false });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Event listener leaks detected: 3 leaked listener(s)',
      );

      consoleErrorSpy.mockRestore();
    });

    it('should support "summary" format (default)', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackEventListeners();
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('event1', handler1);
      emitter.on('event2', handler2);

      await checkEventListeners({ format: 'summary', throwOnLeaks: false });

      const message = consoleErrorSpy.mock.calls[0][0] as string;
      expect(message).toContain("'EventEmitter#1.event1'");
      expect(message).toContain("'EventEmitter#1.event2'");
      expect(message).toContain('expected 0 listener(s), found 1');

      consoleErrorSpy.mockRestore();
    });

    it('should default to "summary" format', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('test', handler);

      await checkEventListeners({ throwOnLeaks: false });

      const message = consoleErrorSpy.mock.calls[0][0] as string;
      expect(message).toContain("'EventEmitter#1.test'");
      expect(message).toContain('expected 0 listener(s), found 1');

      consoleErrorSpy.mockRestore();
    });

    it('should support "details" format with stack traces', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackEventListeners();
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('error', handler1);
      emitter.once('data', handler2);

      await checkEventListeners({ format: 'details', throwOnLeaks: false });

      const message = consoleErrorSpy.mock.calls[0][0] as string;
      expect(message).toContain('Event listener leaks detected:');
      expect(message).toContain('EventEmitter#1');
      expect(message).toContain("> 'error'");
      expect(message).toContain("> 'data'");
      expect(message).toMatch(/\* on\('error'\)/);
      expect(message).toMatch(/\* once\('data'\)/);

      consoleErrorSpy.mockRestore();
    });

    it('should track once() auto-removal', async () => {
      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.once('data', handler);
      emitter.emit('data', 'test');

      // Should not detect a leak since once() auto-removed it
      await expect(checkEventListeners()).resolves.not.toThrow();
    });

    it('should track same function added multiple times correctly', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackEventListeners();
      const emitter = new EventEmitter();
      const handler = vi.fn();

      emitter.on('data', handler);
      emitter.on('data', handler);
      emitter.off('data', handler); // Removes one instance

      await checkEventListeners({ format: 'details', throwOnLeaks: false });

      const message = consoleErrorSpy.mock.calls[0][0] as string;
      // Should show only one leaked listener (the second addition)
      expect(message).toContain('found 1 (+1 leaked)');
      expect(message).toMatch(/\* on\('data'\)/);

      consoleErrorSpy.mockRestore();
    });

    it('should match removals to correct additions', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackEventListeners();
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('data', handler1);
      emitter.on('data', handler2);
      emitter.off('data', handler1); // Remove first one

      await checkEventListeners({ format: 'details', throwOnLeaks: false });

      const message = consoleErrorSpy.mock.calls[0][0] as string;
      // Should show handler2 as leaked (handler1 was removed)
      expect(message).toContain('found 1 (+1 leaked)');
      expect(message).toMatch(/\* on\('data'\)/);

      consoleErrorSpy.mockRestore();
    });

    it('should show stack traces in details format', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackEventListeners();
      const handler = vi.fn();
      const emitter = new EventEmitter();
      emitter.on('test', handler);

      await checkEventListeners({ format: 'details', throwOnLeaks: false });

      const message = consoleErrorSpy.mock.calls[0][0] as string;
      // Verify emitter ID is present (without stack trace)
      expect(message).toMatch(/EventEmitter#1/);

      // Verify listener addition stack trace: * on('test') followed by file:line:col format
      expect(message).toMatch(
        /\* on\('test'\)\s+[^\s]+event-listeners\.test\.ts:\d+:\d+/,
      );

      consoleErrorSpy.mockRestore();
    });

    it('should handle multiple emitters in details format', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackEventListeners();
      const emitter1 = new EventEmitter();
      const emitter2 = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter1.on('event1', handler1);
      emitter2.on('event2', handler2);

      await checkEventListeners({ format: 'details', throwOnLeaks: false });

      const message = consoleErrorSpy.mock.calls[0][0] as string;
      // expect(message).toContain('EventEmitter#1');
      // expect(message).toContain('EventEmitter#2');
      // expect(message).toContain("> 'event1'");
      // expect(message).toContain("> 'event2'");
      expect(message).toMatch(
        /EventEmitter#1[\s\S]*> 'event1'[\s\S]*EventEmitter#2[\s\S]*> 'event2'/,
      );

      consoleErrorSpy.mockRestore();
    });

    it('should handle multiple events on same emitter in details format', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackEventListeners();
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('error', handler1);
      emitter.on('data', handler2);

      await checkEventListeners({ format: 'details', throwOnLeaks: false });

      const message = consoleErrorSpy.mock.calls[0][0] as string;
      expect(message).toContain('EventEmitter#1');
      expect(message).toContain("> 'error'");
      expect(message).toContain("> 'data'");

      consoleErrorSpy.mockRestore();
    });
  });
});
