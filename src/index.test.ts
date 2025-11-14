import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventListeners } from './event-listeners';
import { forceGarbageCollection } from './force-gc';
import { httpAgents } from './http-agents';
import { timers } from './timers';

import { check, track } from './index';

vi.mock('./force-gc');
vi.mock('./event-listeners');
vi.mock('./http-agents');
vi.mock('./timers');

const mockEventListenersTrack = vi.mocked(eventListeners.track);
const mockEventListenersCheck = vi.mocked(eventListeners.check);
const mockHttpAgentsTrack = vi.mocked(httpAgents.track);
const mockHttpAgentsCheck = vi.mocked(httpAgents.check);
const mockTimersTrack = vi.mocked(timers.track);
const mockTimersCheck = vi.mocked(timers.check);

describe('index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEventListenersTrack.mockReset();
    mockEventListenersCheck.mockReset();
    mockHttpAgentsTrack.mockReset();
    mockHttpAgentsCheck.mockReset();
    mockTimersTrack.mockReset();
    mockTimersCheck.mockReset();
  });

  afterEach(async () => {
    // Clear active trackers after each test
    try {
      await check({ throwOnLeaks: false });
    } catch {
      // Ignore all errors - tracking might not be set up or might have already been cleared
    }
  });

  describe('track', () => {
    it('should call all trackers when no options provided', () => {
      track();

      expect(mockEventListenersTrack).toHaveBeenCalledTimes(1);
      expect(mockHttpAgentsTrack).toHaveBeenCalledTimes(1);
      expect(mockTimersTrack).toHaveBeenCalledTimes(1);
    });

    it('should call all trackers when trackers is "all"', () => {
      track({ trackers: 'all' });

      expect(mockEventListenersTrack).toHaveBeenCalledTimes(1);
      expect(mockHttpAgentsTrack).toHaveBeenCalledTimes(1);
      expect(mockTimersTrack).toHaveBeenCalledTimes(1);
    });

    it('should call only eventListeners when specified', () => {
      track({ trackers: ['eventListeners'] });

      expect(mockEventListenersTrack).toHaveBeenCalledTimes(1);
      expect(mockTimersTrack).not.toHaveBeenCalled();
    });

    it('should call only timers when specified', () => {
      track({ trackers: ['timers'] });

      expect(mockEventListenersTrack).not.toHaveBeenCalled();
      expect(mockTimersTrack).toHaveBeenCalledTimes(1);
    });

    it('should call multiple specific trackers', () => {
      track({ trackers: ['eventListeners', 'timers'] });

      expect(mockEventListenersTrack).toHaveBeenCalledTimes(1);
      expect(mockTimersTrack).toHaveBeenCalledTimes(1);
    });
  });

  describe('check', () => {
    it('should throw error if tracking is not set up', async () => {
      await expect(check({ throwOnLeaks: false })).rejects.toThrow(
        /not set up/,
      );
    });

    it('should call check on all active trackers', async () => {
      track();
      await check();

      expect(mockEventListenersCheck).toHaveBeenCalledTimes(1);
      expect(mockHttpAgentsCheck).toHaveBeenCalledTimes(1);
      expect(mockTimersCheck).toHaveBeenCalledTimes(1);
    });

    it('should only check enabled trackers', async () => {
      track({ trackers: ['eventListeners'] });
      await check();

      expect(mockEventListenersCheck).toHaveBeenCalledTimes(1);
      expect(mockTimersCheck).not.toHaveBeenCalled();
    });

    const checkOptionsCases: {
      checkOptions: Parameters<typeof check>[0];
      expectEventListeners: Parameters<typeof eventListeners.check>[0];
      expectHttpAgents: Parameters<typeof httpAgents.check>[0];
      expectTimers: Parameters<typeof timers.check>[0];
    }[] = [
      {
        checkOptions: undefined,
        expectEventListeners: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'summary',
        },
        expectHttpAgents: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'summary',
        },
        expectTimers: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'summary',
        },
      },
      {
        checkOptions: { forceGC: true },
        expectEventListeners: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'summary',
        },
        expectHttpAgents: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'summary',
        },
        expectTimers: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'summary',
        },
      },
      {
        checkOptions: { throwOnLeaks: false },
        expectEventListeners: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'summary',
        },
        expectHttpAgents: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'summary',
        },
        expectTimers: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'summary',
        },
      },
      {
        checkOptions: { format: 'short' },
        expectEventListeners: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'short',
        },
        expectHttpAgents: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'short',
        },
        expectTimers: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'short',
        },
      },
      {
        checkOptions: { format: 'details' },
        expectEventListeners: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'details',
        },
        expectHttpAgents: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'details',
        },
        expectTimers: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'details',
        },
      },
      {
        checkOptions: { forceGC: true, throwOnLeaks: false, format: 'details' },
        expectEventListeners: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'details',
        },
        expectHttpAgents: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'details',
        },
        expectTimers: {
          forceGC: false,
          throwOnLeaks: true,
          format: 'details',
        },
      },
    ];
    it.each(checkOptionsCases)(
      'should pass correct options to tracker checks - $checkOptions',
      async ({
        checkOptions,
        expectEventListeners,
        expectHttpAgents,
        expectTimers,
      }) => {
        track();
        await check(checkOptions);

        expect(mockEventListenersCheck).toHaveBeenCalledWith(
          expectEventListeners,
        );
        expect(mockHttpAgentsCheck).toHaveBeenCalledWith(expectHttpAgents);
        expect(mockTimersCheck).toHaveBeenCalledWith(expectTimers);
      },
    );

    it('should call forceGarbageCollection when forceGC is true', async () => {
      track();
      await check({ forceGC: true });

      expect(forceGarbageCollection).toHaveBeenCalledTimes(1);
    });

    it('should aggregate errors from multiple trackers', async () => {
      track();
      mockEventListenersCheck.mockRejectedValue(
        new Error('Event listener leaks detected'),
      );
      mockHttpAgentsCheck.mockRejectedValue(
        new Error('HTTP agent socket pool leaks detected'),
      );
      mockTimersCheck.mockRejectedValue(new Error('Timer leaks detected'));

      try {
        await check();
        expect.fail('Should have thrown');
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toContain('Event listener leaks detected');
          expect(error.message).toContain('HTTP agent socket pool leaks detected');
          expect(error.message).toContain('Timer leaks detected');
        }
      }
    });

    it('should not throw when no errors occur', async () => {
      track();
      await expect(check()).resolves.not.toThrow();
    });

    it('should console.error when throwOnLeaks is false and errors occur', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      track();
      mockEventListenersCheck.mockRejectedValue(
        new Error('Event listener leaks detected'),
      );
      mockTimersCheck.mockResolvedValue(undefined);

      await check({ throwOnLeaks: false });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Event listener leaks detected',
      );

      consoleErrorSpy.mockRestore();
    });

    it('should clear active trackers after check', async () => {
      track();
      await check();

      // After check, activeTrackers should be cleared, so calling check again should fail
      await expect(check({ throwOnLeaks: false })).rejects.toThrow(
        /not set up/,
      );
    });

    it('should continue checking other trackers if one throws', async () => {
      track();
      mockEventListenersCheck.mockRejectedValue(
        new Error('Event listener leaks detected'),
      );

      await expect(check()).rejects.toThrow();

      // All should have been called
      expect(mockEventListenersCheck).toHaveBeenCalledTimes(1);
      expect(mockHttpAgentsCheck).toHaveBeenCalledTimes(1);
      expect(mockTimersCheck).toHaveBeenCalledTimes(1);
    });
  });
});
