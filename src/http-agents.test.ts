import * as http from 'node:http';
import * as https from 'node:https';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkHttpAgents,
  httpAgents,
  snapshotHttpAgents,
  trackHttpAgents,
} from './http-agents';
import { forceGarbageCollection } from './force-gc';

vi.mock('./force-gc', () => ({
  forceGarbageCollection: vi.fn(),
}));

describe('http-agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Always try to clean up, but be lenient about errors
    try {
      await checkHttpAgents({ throwOnLeaks: false });
    } catch (error) {
      // Ignore "not set up" errors - tracking was already cleared
      if (
        error instanceof Error &&
        error.message.includes('not set up')
      ) {
        // This is fine - tracking was already cleared
        return;
      }
      // For "already set up" errors, we need to force cleanup
      // This can happen if a test failed before calling checkHttpAgents
      if (
        error instanceof Error &&
        error.message.includes('already set up')
      ) {
        // Try to get the module and force cleanup
        // This is a workaround for tests that might have left state inconsistent
        const mod = await import('./http-agents');
        // The module exports checkHttpAgents, but if tracking is "already set up",
        // it means originalHttpRequest is not null, so we should be able to call checkHttpAgents
        // But if it throws "already set up", that means trackHttpAgents was called twice
        // without checkHttpAgents in between, which shouldn't happen in normal flow
        // For now, just ignore this error
        return;
      }
      // For other errors, just ignore - might be leak detection errors which are expected
    }
  });

  describe('trackHttpAgents', () => {
    it('should start tracking global agents', () => {
      trackHttpAgents();

      const snapshot = snapshotHttpAgents();
      expect(snapshot['globalAgent (http)']).toBeDefined();
      expect(snapshot['globalAgent (https)']).toBeDefined();
    });

    it('should throw error if tracking is already set up', () => {
      trackHttpAgents();

      expect(() => {
        trackHttpAgents();
      }).toThrow(/already set up/);
    });

    it('should track custom agent passed to http.request', () => {
      trackHttpAgents();
      const agent = new http.Agent();

      http.request({ agent, hostname: 'example.com' });

      const snapshot = snapshotHttpAgents();
      expect(snapshot['Agent#1']).toBeDefined();
    });

    it('should track custom agent passed to https.request', () => {
      trackHttpAgents();
      const agent = new https.Agent();

      https.request({ agent, hostname: 'example.com' });

      const snapshot = snapshotHttpAgents();
      expect(snapshot['Agent#1']).toBeDefined();
    });

    it('should track agent when passed as second argument to http.request', () => {
      trackHttpAgents();
      const agent = new http.Agent();

      http.request('http://example.com', { agent });

      const snapshot = snapshotHttpAgents();
      expect(snapshot['Agent#1']).toBeDefined();
    });

    it('should track agent when passed as second argument to https.request', () => {
      trackHttpAgents();
      const agent = new https.Agent();

      https.request('https://example.com', { agent });

      const snapshot = snapshotHttpAgents();
      expect(snapshot['Agent#1']).toBeDefined();
    });

    it('should track multiple custom agents', () => {
      trackHttpAgents();
      const agent1 = new http.Agent();
      const agent2 = new https.Agent();

      http.request({ agent: agent1, hostname: 'example.com' });
      https.request({ agent: agent2, hostname: 'example.com' });

      const snapshot = snapshotHttpAgents();
      expect(snapshot['Agent#1']).toBeDefined();
      expect(snapshot['Agent#2']).toBeDefined();
    });

    it('should not track agent when agent is false', () => {
      trackHttpAgents();

      http.request({ agent: false, hostname: 'example.com' });

      const snapshot = snapshotHttpAgents();
      // Should only have global agents
      expect(Object.keys(snapshot).length).toBe(2);
      expect(snapshot['globalAgent (http)']).toBeDefined();
      expect(snapshot['globalAgent (https)']).toBeDefined();
    });

    it('should not duplicate tracking of same agent', () => {
      trackHttpAgents();
      const agent = new http.Agent();

      http.request({ agent, hostname: 'example.com' });
      http.request({ agent, hostname: 'example.org' });

      const snapshot = snapshotHttpAgents();
      // Should only have one custom agent tracked
      const customAgents = Object.keys(snapshot).filter(
        (key) => !key.startsWith('globalAgent'),
      );
      expect(customAgents.length).toBe(1);
    });
  });

  describe('snapshotHttpAgents', () => {
    it('should capture socket pool state', () => {
      trackHttpAgents();
      const agent = new http.Agent();

      const snapshot = snapshotHttpAgents();
      const agentSnapshot = snapshot['Agent#1'] || snapshot['globalAgent (http)'];

      expect(agentSnapshot).toHaveProperty('sockets');
      expect(agentSnapshot).toHaveProperty('freeSockets');
      expect(agentSnapshot).toHaveProperty('requests');
      expect(typeof agentSnapshot.sockets).toBe('number');
      expect(typeof agentSnapshot.freeSockets).toBe('number');
      expect(typeof agentSnapshot.requests).toBe('number');
    });

    it('should include all tracked agents', () => {
      trackHttpAgents();
      const agent1 = new http.Agent();
      const agent2 = new https.Agent();

      http.request({ agent: agent1, hostname: 'example.com' });
      https.request({ agent: agent2, hostname: 'example.com' });

      const snapshot = snapshotHttpAgents();
      expect(snapshot['globalAgent (http)']).toBeDefined();
      expect(snapshot['globalAgent (https)']).toBeDefined();
      expect(snapshot['Agent#1']).toBeDefined();
      expect(snapshot['Agent#2']).toBeDefined();
    });
  });

  describe('checkHttpAgents', () => {
    it('should throw error if tracking is not set up', async () => {
      await expect(checkHttpAgents({ throwOnLeaks: false })).rejects.toThrow(
        /not set up/,
      );
    });

    it('should not throw when no leaks detected', async () => {
      trackHttpAgents();
      await expect(
        checkHttpAgents({ throwOnLeaks: true }),
      ).resolves.not.toThrow();
    });

    it('should detect socket pool growth', async () => {
      trackHttpAgents();
      const agent = new http.Agent({ keepAlive: true });

      // Create a request that will leave sockets in the pool
      const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('OK');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, () => {
          const port = (server.address() as { port: number }).port;
          const req = http.request(
            {
              agent,
              hostname: 'localhost',
              port,
              path: '/',
            },
            () => {},
          );
          req.end();
          req.on('response', (res) => {
            res.on('end', () => {
              server.close();
              resolve();
            });
            res.resume();
          });
        });
      });

      // Wait a bit for socket to be added to free pool
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(
        checkHttpAgents({ throwOnLeaks: true, forceGC: false }),
      ).rejects.toThrow(/socket pool leaks detected/i);
    });

    it('should call forceGarbageCollection when forceGC is true', async () => {
      trackHttpAgents();
      await checkHttpAgents({ forceGC: true, throwOnLeaks: false });

      expect(forceGarbageCollection).toHaveBeenCalledTimes(1);
    });

    it('should restore original http.request and https.request', async () => {
      trackHttpAgents();
      const originalHttp = http.request;
      const originalHttps = https.request;

      await checkHttpAgents({ throwOnLeaks: false });

      expect(http.request).toBe(originalHttp);
      expect(https.request).toBe(originalHttps);
    });

    it('should format short message correctly', async () => {
      trackHttpAgents();
      const agent = new http.Agent({ keepAlive: true });

      const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('OK');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, () => {
          const port = (server.address() as { port: number }).port;
          const req = http.request(
            {
              agent,
              hostname: 'localhost',
              port,
              path: '/',
            },
            () => {},
          );
          req.end();
          req.on('response', (res) => {
            res.on('end', () => {
              server.close();
              resolve();
            });
            res.resume();
          });
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      try {
        await checkHttpAgents({ format: 'short', forceGC: false });
        expect.fail('Should have thrown');
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/HTTP agent socket pool leaks detected/i);
          expect(error.message).toMatch(/agent\(s\) with leaks/);
        }
      }
    });

    it('should format summary message correctly', async () => {
      trackHttpAgents();
      const agent = new http.Agent({ keepAlive: true });

      const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('OK');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, () => {
          const port = (server.address() as { port: number }).port;
          const req = http.request(
            {
              agent,
              hostname: 'localhost',
              port,
              path: '/',
            },
            () => {},
          );
          req.end();
          req.on('response', (res) => {
            res.on('end', () => {
              server.close();
              resolve();
            });
            res.resume();
          });
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      try {
        await checkHttpAgents({ format: 'summary', forceGC: false });
        expect.fail('Should have thrown');
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/HTTP agent socket pool leaks detected/i);
          expect(error.message).toMatch(/sockets:/);
          expect(error.message).toMatch(/freeSockets:/);
        }
      }
    });

    it('should format details message with stack traces', async () => {
      trackHttpAgents();
      const agent = new http.Agent({ keepAlive: true });

      const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('OK');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, () => {
          const port = (server.address() as { port: number }).port;
          const req = http.request(
            {
              agent,
              hostname: 'localhost',
              port,
              path: '/',
            },
            () => {},
          );
          req.end();
          req.on('response', (res) => {
            res.on('end', () => {
              server.close();
              resolve();
            });
            res.resume();
          });
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      try {
        await checkHttpAgents({ format: 'details', forceGC: false });
        expect.fail('Should have thrown');
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toMatch(/HTTP agent socket pool leaks detected/i);
          expect(error.message).toMatch(/created at/);
        }
      }
    });

    it('should not throw when throwOnLeaks is false', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      trackHttpAgents();
      const agent = new http.Agent({ keepAlive: true });

      const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('OK');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, () => {
          const port = (server.address() as { port: number }).port;
          const req = http.request(
            {
              agent,
              hostname: 'localhost',
              port,
              path: '/',
            },
            () => {},
          );
          req.end();
          req.on('response', (res) => {
            res.on('end', () => {
              server.close();
              resolve();
            });
            res.resume();
          });
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(
        checkHttpAgents({ throwOnLeaks: false, forceGC: false }),
      ).resolves.not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('httpAgents convenience object', () => {
    it('should provide track, snapshot, and check methods', () => {
      expect(httpAgents.track).toBe(trackHttpAgents);
      expect(httpAgents.snapshot).toBe(snapshotHttpAgents);
      expect(httpAgents.check).toBe(checkHttpAgents);
    });
  });
});
