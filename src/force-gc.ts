/**
 * Forces garbage collection if available.
 * Requires Node.js to be run with the --expose-gc flag.
 * Performs two GC cycles and waits for them to complete.
 *
 * @returns Resolves after garbage collection completes (or immediately if GC is not available).
 *
 * @example
 * ```typescript
 * // Run node with: node --expose-gc your-script.js
 * await forceGarbageCollection();
 * ```
 */
export async function forceGarbageCollection(): Promise<void> {
  if (global.gc !== undefined) {
    global.gc();
    global.gc();
    return new Promise((resolve) => setImmediate(resolve));
  } else {
    console.warn(
      'Garbage collection not exposed. Run node with --expose-gc flag.',
    );
  }
}
