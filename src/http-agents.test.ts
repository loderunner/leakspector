import http from 'node:http';
import https from 'node:https';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { httpAgents } from './http-agents';

describe('httpAgents', () => {
  describe('trackHttpAgents', () => {
    it('should throw if already tracking', async () => {
      httpAgents.track();
      expect(() => httpAgents.track()).toThrow(
        'HTTP agent leak detection already set up',
      );
      await httpAgents.check({ forceGC: false, throwOnLeaks: false });
    });

    it('should track global agents', async () => {
      httpAgents.track();
      const snapshot = httpAgents.snapshot();

      expect(snapshot).toHaveProperty('http.globalAgent');
      expect(snapshot).toHaveProperty('https.globalAgent');

      await httpAgents.check({ forceGC: false, throwOnLeaks: false });
    });
  });

  describe('snapshotHttpAgents', () => {
    beforeEach(() => {
      httpAgents.track();
    });

    afterEach(async () => {
      await httpAgents.check({ forceGC: false, throwOnLeaks: false });
    });

    it('should snapshot global agent states', () => {
      const snapshot = httpAgents.snapshot();

      expect(snapshot['http.globalAgent']).toBeDefined();
      expect(snapshot['http.globalAgent']).toHaveProperty('sockets');
      expect(snapshot['http.globalAgent']).toHaveProperty('freeSockets');
      expect(snapshot['http.globalAgent']).toHaveProperty('requests');

      expect(snapshot['https.globalAgent']).toBeDefined();
      expect(snapshot['https.globalAgent']).toHaveProperty('sockets');
      expect(snapshot['https.globalAgent']).toHaveProperty('freeSockets');
      expect(snapshot['https.globalAgent']).toHaveProperty('requests');
    });

    it('should track custom http agent', () => {
      const agent = new http.Agent({ keepAlive: true });

      // Make a request with the agent to trigger tracking
      const req = http.request({
        host: 'example.com',
        agent,
      });
      req.on('error', () => {}); // Suppress expected errors
      req.destroy(); // Don't actually send the request

      const snapshot = httpAgents.snapshot();
      expect(snapshot['http.Agent#1']).toBeDefined();
    });

    it('should track custom https agent', () => {
      const agent = new https.Agent({ keepAlive: true });

      // Make a request with the agent to trigger tracking
      const req = https.request({
        host: 'example.com',
        agent,
      });
      req.on('error', () => {}); // Suppress expected errors
      req.destroy(); // Don't actually send the request

      const snapshot = httpAgents.snapshot();
      expect(snapshot['https.Agent#1']).toBeDefined();
    });

    it('should track agent used with http.get', () => {
      const agent = new http.Agent({ keepAlive: true });

      // Make a request with the agent to trigger tracking
      const req = http.get({
        host: 'example.com',
        agent,
      });
      req.on('error', () => {}); // Suppress expected errors
      req.destroy(); // Don't actually send the request

      const snapshot = httpAgents.snapshot();
      expect(snapshot['http.Agent#1']).toBeDefined();
    });

    it('should track agent used with https.get', () => {
      const agent = new https.Agent({ keepAlive: true });

      // Make a request with the agent to trigger tracking
      const req = https.get({
        host: 'example.com',
        agent,
      });
      req.on('error', () => {}); // Suppress expected errors
      req.destroy(); // Don't actually send the request

      const snapshot = httpAgents.snapshot();
      expect(snapshot['https.Agent#1']).toBeDefined();
    });

    it('should not track the same agent twice', () => {
      const agent = new http.Agent({ keepAlive: true });

      // Make two requests with the same agent
      const req1 = http.request({ host: 'example.com', agent });
      req1.on('error', () => {});
      req1.destroy();
      const req2 = http.request({ host: 'example.com', agent });
      req2.on('error', () => {});
      req2.destroy();

      const snapshot = httpAgents.snapshot();
      // Should only have one http.Agent#1
      expect(snapshot['http.Agent#1']).toBeDefined();
      expect(snapshot['http.Agent#2']).toBeUndefined();
    });

    it('should track multiple custom agents', () => {
      const agent1 = new http.Agent({ keepAlive: true });
      const agent2 = new http.Agent({ keepAlive: true });

      const req1 = http.request({ host: 'example.com', agent: agent1 });
      req1.on('error', () => {});
      req1.destroy();
      const req2 = http.request({ host: 'example.com', agent: agent2 });
      req2.on('error', () => {});
      req2.destroy();

      const snapshot = httpAgents.snapshot();
      expect(snapshot['http.Agent#1']).toBeDefined();
      expect(snapshot['http.Agent#2']).toBeDefined();
    });

    it('should not include destroyed agents in snapshot', () => {
      const agent = new http.Agent({ keepAlive: true });

      const req = http.request({ host: 'example.com', agent });
      req.on('error', () => {});
      req.destroy();

      let snapshot = httpAgents.snapshot();
      expect(snapshot['http.Agent#1']).toBeDefined();

      // Destroy the agent
      agent.destroy();

      snapshot = httpAgents.snapshot();
      expect(snapshot['http.Agent#1']).toBeUndefined();
    });
  });

  describe('checkHttpAgents', () => {
    it('should throw if not tracking', async () => {
      await expect(httpAgents.check()).rejects.toThrow(
        'HTTP agent leak detection not set up',
      );
    });

    it('should not throw if no leaks detected', async () => {
      httpAgents.track();
      await expect(
        httpAgents.check({ forceGC: false, throwOnLeaks: true }),
      ).resolves.not.toThrow();
    });

    it('should detect leaked custom agent', async () => {
      httpAgents.track();

      // Create an agent but don't destroy it
      const agent = new http.Agent({ keepAlive: true });
      const req = http.request({ host: 'example.com', agent });
      req.on('error', () => {});
      req.destroy();

      await expect(
        httpAgents.check({ forceGC: false, throwOnLeaks: true }),
      ).rejects.toThrow('HTTP agent socket pool leaks detected');
    });

    it('should not detect leak if agent is destroyed', async () => {
      httpAgents.track();

      const agent = new http.Agent({ keepAlive: true });
      const req = http.request({ host: 'example.com', agent });
      req.on('error', () => {});
      req.destroy();

      // Destroy the agent before checking
      agent.destroy();

      await expect(
        httpAgents.check({ forceGC: false, throwOnLeaks: true }),
      ).resolves.not.toThrow();
    });

    it('should support short format', async () => {
      httpAgents.track();

      const agent = new http.Agent({ keepAlive: true });
      const req = http.request({ host: 'example.com', agent });
      req.on('error', () => {});
      req.destroy();

      await expect(
        httpAgents.check({
          forceGC: false,
          throwOnLeaks: true,
          format: 'short',
        }),
      ).rejects.toThrow(/HTTP agent leaks detected: \d+ agent\(s\)/);
    });

    it('should support summary format', async () => {
      httpAgents.track();

      const agent = new http.Agent({ keepAlive: true });
      const req = http.request({ host: 'example.com', agent });
      req.on('error', () => {});
      req.destroy();

      await expect(
        httpAgents.check({
          forceGC: false,
          throwOnLeaks: true,
          format: 'summary',
        }),
      ).rejects.toThrow('HTTP agent socket pool leaks detected');
    });

    it('should support details format', async () => {
      httpAgents.track();

      const agent = new http.Agent({ keepAlive: true });
      const req = http.request({ host: 'example.com', agent });
      req.on('error', () => {});
      req.destroy();

      await expect(
        httpAgents.check({
          forceGC: false,
          throwOnLeaks: true,
          format: 'details',
        }),
      ).rejects.toThrow(/State history/);
    });

    it('should not throw if throwOnLeaks is false', async () => {
      httpAgents.track();

      const agent = new http.Agent({ keepAlive: true });
      const req = http.request({ host: 'example.com', agent });
      req.on('error', () => {});
      req.destroy();

      await expect(
        httpAgents.check({ forceGC: false, throwOnLeaks: false }),
      ).resolves.not.toThrow();
    });

    it('should restore original functions after check', async () => {
      const originalRequest = http.request;
      const originalGet = http.get;

      httpAgents.track();

      // Functions should be patched
      expect(http.request).not.toBe(originalRequest);
      expect(http.get).not.toBe(originalGet);

      await httpAgents.check({ forceGC: false, throwOnLeaks: false });

      // Functions should be restored
      expect(http.request).toBe(originalRequest);
      expect(http.get).toBe(originalGet);
    });
  });

  describe('leak detection scenarios', () => {
    it('should detect agent with accumulated free sockets', async () => {
      httpAgents.track();

      const agent = new http.Agent({ keepAlive: true, maxSockets: 10 });
      const req = http.request({ host: 'example.com', agent });
      req.on('error', () => {});
      req.destroy();

      // Take multiple snapshots to build state history
      httpAgents.snapshot();
      httpAgents.snapshot();
      httpAgents.snapshot();

      await expect(
        httpAgents.check({ forceGC: false, throwOnLeaks: true }),
      ).rejects.toThrow('HTTP agent socket pool leaks detected');
    });

    it('should detect multiple leaked agents', async () => {
      httpAgents.track();

      const agent1 = new http.Agent({ keepAlive: true });
      const agent2 = new https.Agent({ keepAlive: true });

      const req1 = http.request({ host: 'example.com', agent: agent1 });
      req1.on('error', () => {});
      req1.destroy();
      const req2 = https.request({ host: 'example.com', agent: agent2 });
      req2.on('error', () => {});
      req2.destroy();

      await expect(
        httpAgents.check({ forceGC: false, throwOnLeaks: true }),
      ).rejects.toThrow('HTTP agent socket pool leaks detected');
    });

    it('should include agent IDs in error message', async () => {
      httpAgents.track();

      const agent = new http.Agent({ keepAlive: true });
      const req = http.request({ host: 'example.com', agent });
      req.on('error', () => {});
      req.destroy();

      try {
        await httpAgents.check({ forceGC: false, throwOnLeaks: true });
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('http.Agent#1');
      }
    });
  });

  describe('integration with forceGC', () => {
    it('should support forceGC option', async () => {
      httpAgents.track();

      const agent = new http.Agent({ keepAlive: true });
      const req = http.request({ host: 'example.com', agent });
      req.on('error', () => {});
      req.destroy();

      // This should work whether or not --expose-gc is enabled
      await expect(
        httpAgents.check({ forceGC: true, throwOnLeaks: true }),
      ).rejects.toThrow('HTTP agent socket pool leaks detected');
    });
  });
});
