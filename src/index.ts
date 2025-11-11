import {
  type EmitterStringifier,
  clearEmitterStringifiers,
  eventListeners,
  registerEmitterStringifier,
} from './event-listeners';

export { eventListeners };
export {
  type EmitterStringifier,
  clearEmitterStringifiers,
  registerEmitterStringifier,
};

/**
 * Starts tracking leaks.
 *
 * @throws {Error} If leak detection is already set up. Call check() first.
 
 */
export function track(): void {
  eventListeners.track();
}

/**
 * Checks for leaks.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking. Defaults to true if node was run with --expose-gc flag.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 *
 * @throws {Error} If leak detection is not set up. Call track() first.
 * @throws {Error} If leaks are detected and throwOnLeaks is true.
 
 */
export function check(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
}): Promise<void> {
  return eventListeners.check(options);
}

export const leakSpector = {
  track,
  check,
};
