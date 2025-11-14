import { EventEmitter } from 'node:events';
import http from 'node:http';

import { describe, expect, it } from 'vitest';

import { check, snapshot, track } from './index';

describe('leakspector integration', () => {
  it('should track all resources when using "all"', async () => {
    track({ trackers: 'all' });

    // Create various resources
    const emitter = new EventEmitter();
    emitter.on('data', () => {});

    const timer = setTimeout(() => {}, 10000);

    const agent = new http.Agent({ keepAlive: true });
    const req = http.request({ host: 'example.com', agent });
    req.on('error', () => {});
    req.destroy();

    // Take a snapshot
    const snap = snapshot();

    expect(snap.eventListeners).toBeDefined();
    expect(snap.timers).toBeDefined();
    expect(snap.httpAgents).toBeDefined();

    // Clean up
    emitter.removeAllListeners();
    clearTimeout(timer);
    agent.destroy();

    await check({ forceGC: false, throwOnLeaks: false });
  });

  it('should track only specified trackers', async () => {
    track({ trackers: ['eventListeners', 'httpAgents'] });

    const emitter = new EventEmitter();
    emitter.on('data', () => {});

    const agent = new http.Agent({ keepAlive: true });
    const req = http.request({ host: 'example.com', agent });
    req.on('error', () => {});
    req.destroy();

    const snap = snapshot();

    expect(snap.eventListeners).toBeDefined();
    expect(snap.timers).toBeUndefined();
    expect(snap.httpAgents).toBeDefined();

    emitter.removeAllListeners();
    agent.destroy();

    await check({ forceGC: false, throwOnLeaks: false });
  });

  it('should detect multiple types of leaks', async () => {
    track({ trackers: 'all' });

    // Create leaked resources
    const emitter = new EventEmitter();
    emitter.on('data', () => {});

    setTimeout(() => {}, 10000);

    const agent = new http.Agent({ keepAlive: true });
    const req = http.request({ host: 'example.com', agent });
    req.on('error', () => {});
    req.destroy();

    // Don't clean up - should detect all leaks
    try {
      await check({ forceGC: false, throwOnLeaks: true });
      expect.fail('Should have detected leaks');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('Event listener leaks detected');
      expect(message).toContain('Timer leaks detected');
      expect(message).toContain('HTTP agent socket pool leaks detected');
    }
  });

  it('should support different format options', async () => {
    track({ trackers: 'all' });

    const emitter = new EventEmitter();
    emitter.on('data', () => {});

    const agent = new http.Agent({ keepAlive: true });
    const req = http.request({ host: 'example.com', agent });
    req.on('error', () => {});
    req.destroy();

    try {
      await check({ forceGC: false, throwOnLeaks: true, format: 'short' });
      expect.fail('Should have detected leaks');
    } catch (error) {
      const message = (error as Error).message;
      // Short format should have terse messages
      expect(message).toMatch(/\d+ leaked/);
    }
  });

  it('should work with no leaks', async () => {
    // Test without http agents to avoid internal event listener complexity
    track({ trackers: ['eventListeners', 'timers'] });

    const emitter = new EventEmitter();
    const handler = () => {};
    emitter.on('data', handler);

    const timer = setTimeout(() => {}, 10000);

    // Clean up
    emitter.removeListener('data', handler);
    clearTimeout(timer);

    // Should not throw
    await expect(
      check({ forceGC: false, throwOnLeaks: true }),
    ).resolves.not.toThrow();
  });

  it('should throw if track not called', async () => {
    await expect(check()).rejects.toThrow('Leak detection not set up');
  });

  it('should allow tracking individual trackers separately', async () => {
    // Track only httpAgents
    track({ trackers: ['httpAgents'] });

    const agent = new http.Agent({ keepAlive: true });
    const req = http.request({ host: 'example.com', agent });
    req.on('error', () => {});
    req.destroy();

    const snap = snapshot();

    expect(snap.eventListeners).toBeUndefined();
    expect(snap.timers).toBeUndefined();
    expect(snap.httpAgents).toBeDefined();

    try {
      await check({ forceGC: false, throwOnLeaks: true });
      expect.fail('Should have detected HTTP agent leak');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('HTTP agent socket pool leaks detected');
      expect(message).not.toContain('Event listener');
      expect(message).not.toContain('Timer');
    }
  });
});
