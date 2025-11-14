/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions */

import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

// Use require to get mutable exports
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess = require('node:child_process');

type SpawnMethod = 'spawn' | 'exec' | 'execFile' | 'fork';

type StreamState = {
  stream: Readable | Writable | null;
  open: boolean;
  closedAt: number | null;
};

type ProcessInfo = {
  pid: number | undefined;
  method: SpawnMethod;
  command: string;
  stack: string;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  killed: boolean;
  killedManually: boolean;
  gcSurvivalCount: number;
  stdout: StreamState;
  stderr: StreamState;
  stdin: StreamState;
  hasStreamLeaks: boolean;
};

const trackedProcesses = new Map<ChildProcess, ProcessInfo>();

let originalSpawn: any = null;
let originalExec: any = null;
let originalExecFile: any = null;
let originalFork: any = null;

/**
 * Creates a stream state object for tracking stdio streams.
 *
 * @param stream - The stream to track (stdout, stderr, or stdin).
 * @returns A StreamState object.
 */
function createStreamState(
  stream: Readable | Writable | null | undefined,
): StreamState {
  if (stream === null || stream === undefined) {
    return { stream: null, open: false, closedAt: null };
  }

  const state: StreamState = {
    stream,
    open: true,
    closedAt: null,
  };

  // Monitor close/end/finish events
  const onClose = () => {
    state.open = false;
    state.closedAt = Date.now();
  };

  if ('on' in stream) {
    stream.on('close', onClose);
    stream.on('end', onClose);
    if ('finish' in stream) {
      (stream as Writable).on('finish', onClose);
    }
  }

  return state;
}

/**
 * Tracks a child process by setting up event listeners and stream monitoring.
 *
 * @param child - The child process to track.
 * @param method - The spawn method used.
 * @param command - The command string for identification.
 * @param stack - The stack trace where the process was created.
 */
function trackProcess(
  child: ChildProcess,
  method: SpawnMethod,
  command: string,
  stack: string,
): void {
  const info: ProcessInfo = {
    pid: child.pid,
    method,
    command,
    stack,
    exited: false,
    exitCode: null,
    exitSignal: null,
    killed: false,
    killedManually: false,
    gcSurvivalCount: 0,
    stdout: createStreamState(child.stdout),
    stderr: createStreamState(child.stderr),
    stdin: createStreamState(child.stdin),
    hasStreamLeaks: false,
  };

  trackedProcesses.set(child, info);

  // Monitor exit event
  child.on('exit', (code, signal) => {
    info.exited = true;
    info.exitCode = code;
    info.exitSignal = signal;
  });

  // Monitor close event (stdio streams closed)
  child.on('close', (code, signal) => {
    info.exited = true;
    info.exitCode = code;
    info.exitSignal = signal;
  });

  // Hook into kill method to track manual kills
  const originalKill = child.kill.bind(child);
  child.kill = function (signal?: NodeJS.Signals | number): boolean {
    info.killedManually = true;
    info.killed = true;
    return originalKill(signal);
  };
}

/**
 * Formats a command string for display, truncating if too long.
 *
 * @param command - The command string.
 * @returns Formatted command string.
 */
function formatCommand(command: string): string {
  const maxLength = 60;
  if (command.length <= maxLength) {
    return command;
  }
  return command.substring(0, maxLength - 3) + '...';
}

/**
 * Starts tracking child processes by hooking into child_process module functions.
 * Must be called before spawning any child processes to track.
 *
 * @throws {Error} If leak detection is already set up. Call checkChildProcesses() first.
 *
 * @remarks Patches child_process module functions to monitor process creation.
 *
 * @example
 * ```typescript
 * trackChildProcesses();
 * const child = spawn('node', ['script.js']); // This will be tracked
 * ```
 */
export function trackChildProcesses(): void {
  if (originalSpawn !== null) {
    throw new Error(
      'Child process leak detection already set up. Call checkChildProcesses() first.',
    );
  }

  originalSpawn = childProcess.spawn;
  originalExec = childProcess.exec;
  originalExecFile = childProcess.execFile;
  originalFork = childProcess.fork;

  // Hook spawn - use direct assignment which works better with some module systems
  childProcess.spawn = function (
    ...args: Parameters<typeof childProcess.spawn>
  ): ChildProcess {
    const child = originalSpawn!.apply(this, args);
    const [command, argsArray] = args;
    const commandStr = Array.isArray(argsArray)
      ? `${command} ${argsArray.join(' ')}`
      : String(command);
    const stack = captureStackTrace();
    trackProcess(child, 'spawn', commandStr, stack);
    return child;
  };

  // Hook exec
  childProcess.exec = function (
    ...args: Parameters<typeof childProcess.exec>
  ): ReturnType<typeof childProcess.exec> {
    const result = originalExec!.apply(this, args);
    const [command] = args;
    const stack = captureStackTrace();
    trackProcess(result, 'exec', command, stack);
    return result;
  };

  // Hook execFile
  childProcess.execFile = function (
    ...args: Parameters<typeof childProcess.execFile>
  ): ReturnType<typeof childProcess.execFile> {
    const result = originalExecFile!.apply(this, args);
    const [file, argsArray] = args;
    const commandStr =
      Array.isArray(argsArray) && argsArray.length > 0
        ? `${file} ${argsArray.join(' ')}`
        : String(file);
    const stack = captureStackTrace();
    trackProcess(result, 'execFile', commandStr, stack);
    return result;
  };

  // Hook fork
  childProcess.fork = function (
    ...args: Parameters<typeof childProcess.fork>
  ): ReturnType<typeof childProcess.fork> {
    const child = originalFork!.apply(this, args);
    const [modulePath, argsArray] = args;
    const commandStr = Array.isArray(argsArray)
      ? `${modulePath} ${argsArray.join(' ')}`
      : String(modulePath);
    const stack = captureStackTrace();
    trackProcess(child, 'fork', commandStr, stack);
    return child;
  };
}

export type ChildProcessesSnapshot = {
  active: number;
  exited: number;
  withOpenStreams: number;
};

/**
 * Creates a snapshot of all currently tracked child processes.
 * Returns counts of processes by state.
 *
 * @returns A snapshot of tracked child processes.
 *
 * @example
 * ```typescript
 * trackChildProcesses();
 * const child = spawn('node', ['script.js']);
 * const snapshot = snapshotChildProcesses();
 * // snapshot = { active: 1, exited: 0, withOpenStreams: 1 }
 * ```
 */
export function snapshotChildProcesses(): ChildProcessesSnapshot {
  const snapshot: ChildProcessesSnapshot = {
    active: 0,
    exited: 0,
    withOpenStreams: 0,
  };

  for (const info of trackedProcesses.values()) {
    if (!info.exited) {
      snapshot.active++;
    } else {
      snapshot.exited++;
    }

    const hasOpenStreams =
      info.stdout.open || info.stderr.open || info.stdin.open;
    if (hasOpenStreams) {
      snapshot.withOpenStreams++;
    }
  }

  return snapshot;
}

/**
 * Detects leaked processes.
 * A process is considered leaked if:
 * - It hasn't exited and wasn't killed manually
 * - It has exited but its stdio streams are still open
 * - It has survived multiple GC cycles without proper cleanup
 *
 * @returns Array of leaked ProcessInfo objects.
 */
function detectLeakedProcesses(): ProcessInfo[] {
  const leaks: ProcessInfo[] = [];

  for (const info of trackedProcesses.values()) {
    // Check for stream leaks (process exited but streams still open)
    if (info.exited) {
      const hasOpenStreams =
        info.stdout.open || info.stderr.open || info.stdin.open;
      if (hasOpenStreams) {
        info.hasStreamLeaks = true;
        leaks.push(info);
        continue;
      }
    }

    // Check for processes that haven't exited and weren't killed
    if (!info.exited && !info.killedManually) {
      // Increment GC survival count
      info.gcSurvivalCount++;

      // Flag as leak if survived multiple GC cycles (threshold: 1)
      if (info.gcSurvivalCount > 0) {
        leaks.push(info);
      }
    }
  }

  return leaks;
}

/**
 * Formats leak message in short format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(): string {
  const leaks = detectLeakedProcesses();

  if (leaks.length === 0) {
    return '';
  }

  return `Child process leaks detected: ${leaks.length} leaked process(es)`;
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const leaks = detectLeakedProcesses();

  if (leaks.length === 0) {
    return '';
  }

  const lines: string[] = ['Child process leaks detected:'];

  for (const leak of leaks) {
    const pidStr = leak.pid !== undefined ? `pid ${leak.pid}` : 'unknown pid';
    const commandStr = formatCommand(leak.command);

    if (leak.hasStreamLeaks) {
      const openStreams: string[] = [];
      if (leak.stdout.open) {
        openStreams.push('stdout');
      }
      if (leak.stderr.open) {
        openStreams.push('stderr');
      }
      if (leak.stdin.open) {
        openStreams.push('stdin');
      }
      lines.push(
        `  ${leak.method}('${commandStr}') [${pidStr}]: exited but streams still open (${openStreams.join(', ')})`,
      );
    } else {
      lines.push(
        `  ${leak.method}('${commandStr}') [${pidStr}]: process not terminated (survived ${leak.gcSurvivalCount} GC cycle(s))`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Formats leak message in details format with stack traces.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatDetailsMessage(): string {
  const leaks = detectLeakedProcesses();

  if (leaks.length === 0) {
    return '';
  }

  const lines: string[] = ['Child process leaks detected:'];

  for (const leak of leaks) {
    const pidStr = leak.pid !== undefined ? `pid ${leak.pid}` : 'unknown pid';
    const commandStr = formatCommand(leak.command);

    lines.push(`  ${leak.method}('${commandStr}') [${pidStr}]`);

    if (leak.hasStreamLeaks) {
      const openStreams: string[] = [];
      if (leak.stdout.open) {
        openStreams.push('stdout');
      }
      if (leak.stderr.open) {
        openStreams.push('stderr');
      }
      if (leak.stdin.open) {
        openStreams.push('stdin');
      }
      lines.push(
        `    Status: exited (code ${leak.exitCode}, signal ${leak.exitSignal}) but streams still open: ${openStreams.join(', ')}`,
      );
    } else {
      lines.push(
        `    Status: process not terminated (survived ${leak.gcSurvivalCount} GC cycle(s))`,
      );
      lines.push(`    Killed manually: ${leak.killedManually}`);
      lines.push(`    Exited: ${leak.exited}`);
    }

    const formattedStack = formatStackTrace(leak.stack, ['child-processes.ts']);
    if (formattedStack !== '') {
      lines.push(`    Created at: ${formattedStack}`);
    }
  }

  return lines.join('\n');
}

/**
 * Checks for child process leaks by analyzing process and stream states.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only (e.g. `"Child process leaks detected: 2 leaked process(es)"`)
 * - `"summary"`: List of leaked processes with issue descriptions
 * - `"details"`: Detailed output with stack traces and full state information
 *
 * @throws {Error} If leak detection is not set up. Call trackChildProcesses() first.
 * @throws {Error} If child process leaks are detected, with details about each leak.
 *
 * @remarks Restores original child_process functions and clears tracking state.
 *
 * @example
 * ```typescript
 * trackChildProcesses();
 * const child = spawn('node', ['script.js']);
 * // ... later ...
 * await checkChildProcesses({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkChildProcesses(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
}): Promise<void> {
  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
  } = options ?? {};

  if (originalSpawn === null) {
    throw new Error(
      'Child process leak detection not set up. Call trackChildProcesses() first.',
    );
  }

  if (forceGC) {
    await forceGarbageCollection();
  }

  // Give streams a moment to close after process exit
  await new Promise((resolve) => setTimeout(resolve, 50));

  childProcess.spawn = originalSpawn;
  childProcess.exec = originalExec;
  childProcess.execFile = originalExecFile;
  childProcess.fork = originalFork;

  originalSpawn = null;
  originalExec = null;
  originalExecFile = null;
  originalFork = null;

  let message: string;
  if (format === 'short') {
    message = formatShortMessage();
  } else if (format === 'details') {
    message = formatDetailsMessage();
  } else {
    message = formatSummaryMessage();
  }

  trackedProcesses.clear();

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Convenience object providing access to child process leak detection functions.
 *
 * @property track - Starts tracking child processes. See {@link trackChildProcesses}.
 * @property snapshot - Creates a snapshot of current child processes. See {@link snapshotChildProcesses}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkChildProcesses}.
 */
export const childProcesses = {
  track: trackChildProcesses,
  snapshot: snapshotChildProcesses,
  check: checkChildProcesses,
};
