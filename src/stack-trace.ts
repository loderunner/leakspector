function extractLocationFromLine(line: string): string | null {
  // Try format with parentheses first (most common)
  const matchWithParens = line.match(/at .+ \((.+):(\d+):(\d+)\)/);
  if (matchWithParens !== null) {
    const file = matchWithParens[1];
    const lineNum = matchWithParens[2];
    const col = matchWithParens[3];
    return `${file}:${lineNum}:${col}`;
  }

  // Try format without parentheses
  const matchWithoutParens = line.match(/at (.+):(\d+):(\d+)/);
  if (matchWithoutParens !== null) {
    const file = matchWithoutParens[1];
    const lineNum = matchWithoutParens[2];
    const col = matchWithoutParens[3];
    return `${file}:${lineNum}:${col}`;
  }

  return null;
}

function shouldSkipStackLine(line: string): boolean {
  // Skip Error message line
  if (line.trim().startsWith('Error:')) {
    return true;
  }

  // Skip empty lines
  if (line.trim() === '') {
    return true;
  }

  // Skip Node.js internal frames
  if (
    line.includes('node:') ||
    line.includes(' internal/') ||
    line.includes('(node:')
  ) {
    return true;
  }

  // Skip leakspector frames (but allow test files)
  if (
    (line.includes('leakspector') ||
      line.includes('event-listeners.ts') ||
      line.includes('http-agents.ts') ||
      line.includes('timers.ts')) &&
    !line.includes('.test.')
  ) {
    return true;
  }

  return false;
}

/**
 * Formats a stack trace to show only the first relevant user code frame.
 * Filters out Node.js internal frames and leakspector frames.
 * Includes node_modules frames if they're the first non-internal frame.
 *
 * @param stack - The full stack trace string.
 * @param skipFiles - Additional file patterns to skip (e.g., ['event-listeners.ts', 'timers.ts']).
 * @returns Formatted frame as `path/to/file.ts:line:col`, or empty string if no relevant frame found.
 */
export function formatStackTrace(
  stack: string,
  skipFiles: string[] = [],
): string {
  if (stack === '') {
    return '';
  }

  const lines = stack.split('\n');

  for (const line of lines) {
    if (shouldSkipStackLine(line)) {
      continue;
    }

    const location = extractLocationFromLine(line);
    if (location === null) {
      continue;
    }

    // Skip if it's still a leakspector internal file
    const file = location.split(':')[0];
    const shouldSkip =
      (file.includes('event-listeners.ts') ||
        file.includes('http-agents.ts') ||
        file.includes('timers.ts') ||
        file.includes('stack-trace-utils.ts')) &&
      !file.includes('.test.');

    if (shouldSkip) {
      continue;
    }

    // Skip additional files if provided
    if (skipFiles.length > 0) {
      const shouldSkipAdditional = skipFiles.some((skipFile) =>
        file.includes(skipFile),
      );
      if (shouldSkipAdditional) {
        continue;
      }
    }

    return location;
  }

  return '';
}

/**
 * Captures the full stack trace without filtering.
 *
 * @returns The full stack trace string, or empty string if unavailable.
 */
export function captureStackTrace(): string {
  const error = new Error();
  return error.stack ?? '';
}
