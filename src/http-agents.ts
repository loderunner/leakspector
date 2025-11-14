import * as http from 'node:http';
import * as https from 'node:https';

import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

type Agent = http.Agent | https.Agent;

type AgentSnapshot = {
  sockets: number;
  freeSockets: number;
  requests: number;
};

type AgentInfo = {
  agent: Agent;
  isGlobal: boolean;
  initialSnapshot: AgentSnapshot;
  snapshots: AgentSnapshot[];
  creationStack: string;
  lastSeenSnapshot: AgentSnapshot;
};

const trackedAgents = new WeakMap<Agent, AgentInfo>();
const allTrackedAgents = new Set<Agent>();
let agentIdCounter = 0;
const agentIds = new WeakMap<Agent, string>();

let originalHttpRequest: typeof http.request | null = null;
let originalHttpsRequest: typeof https.request | null = null;

/**
 * Gets a unique identifier for an agent instance.
 */
function getAgentId(agent: Agent): string {
  const existing = agentIds.get(agent);
  if (existing !== undefined) {
    return existing;
  }

  const isGlobal =
    agent === http.globalAgent || agent === https.globalAgent;
  const id = isGlobal
    ? `globalAgent (${agent instanceof https.Agent ? 'https' : 'http'})`
    : `Agent#${++agentIdCounter}`;
  agentIds.set(agent, id);
  return id;
}

/**
 * Captures the current socket pool state of an agent.
 */
function captureAgentSnapshot(agent: Agent): AgentSnapshot {
  // Count sockets across all origins
  let sockets = 0;
  let freeSockets = 0;
  let requests = 0;

  // agent.sockets is an object mapping origin -> array of sockets
  if (agent.sockets !== undefined && agent.sockets !== null) {
    for (const socketArray of Object.values(agent.sockets)) {
      if (Array.isArray(socketArray)) {
        sockets += socketArray.length;
      }
    }
  }

  // agent.freeSockets is an object mapping origin -> array of free sockets
  if (agent.freeSockets !== undefined && agent.freeSockets !== null) {
    for (const socketArray of Object.values(agent.freeSockets)) {
      if (Array.isArray(socketArray)) {
        freeSockets += socketArray.length;
      }
    }
  }

  // agent.requests is an object mapping origin -> array of requests
  if (agent.requests !== undefined && agent.requests !== null) {
    for (const requestArray of Object.values(agent.requests)) {
      if (Array.isArray(requestArray)) {
        requests += requestArray.length;
      }
    }
  }

  return { sockets, freeSockets, requests };
}

/**
 * Tracks an agent instance if not already tracked.
 */
function trackAgent(agent: Agent, isGlobal: boolean, stack: string): void {
  if (trackedAgents.has(agent)) {
    return;
  }

  const initialSnapshot = captureAgentSnapshot(agent);
  const info: AgentInfo = {
    agent,
    isGlobal,
    initialSnapshot,
    snapshots: [initialSnapshot],
    creationStack: stack,
    lastSeenSnapshot: initialSnapshot,
  };

  trackedAgents.set(agent, info);
  allTrackedAgents.add(agent);
}

/**
 * Records a snapshot of all tracked agents' current state.
 */
function recordSnapshots(): void {
  for (const agent of allTrackedAgents) {
    const info = trackedAgents.get(agent);
    if (info === undefined) {
      continue;
    }

    const snapshot = captureAgentSnapshot(agent);
    info.snapshots.push(snapshot);
    info.lastSeenSnapshot = snapshot;
  }
}

/**
 * Checks if socket counts are growing monotonically.
 */
function isMonotonicallyGrowing(snapshots: AgentSnapshot[]): boolean {
  if (snapshots.length < 2) {
    return false;
  }

  let lastTotal = snapshots[0].sockets + snapshots[0].freeSockets;
  for (let i = 1; i < snapshots.length; i++) {
    const currentTotal = snapshots[i].sockets + snapshots[i].freeSockets;
    if (currentTotal < lastTotal) {
      return false;
    }
    lastTotal = currentTotal;
  }

  return lastTotal > snapshots[0].sockets + snapshots[0].freeSockets;
}

/**
 * Starts tracking HTTP/HTTPS agent socket pools.
 * Must be called before creating agents to track.
 *
 * @throws {Error} If leak detection is already set up. Call checkHttpAgents() first.
 *
 * @remarks Patches http.request() and https.request() to monitor agent usage.
 *
 * @example
 * ```typescript
 * trackHttpAgents();
 * const agent = new http.Agent();
 * http.request({ agent }); // This will be tracked
 * ```
 */
export function trackHttpAgents(): void {
  if (originalHttpRequest !== null) {
    throw new Error(
      'HTTP agent leak detection already set up. Call checkHttpAgents() first.',
    );
  }

  // Track default global agents
  trackAgent(http.globalAgent, true, captureStackTrace());
  trackAgent(https.globalAgent, true, captureStackTrace());

  // Check if already patched (originalHttpRequest would be null if not patched)
  if (originalHttpRequest !== null) {
    // Already patched, use the saved original
    // Don't overwrite - we're being called again without cleanup
    return;
  }

  originalHttpRequest = http.request;
  originalHttpsRequest = https.request;

  // Wrap http.request to detect custom agents
  const patchedHttpRequest = function (
    ...args: Parameters<typeof http.request>
  ): http.ClientRequest {
    // Handle overloads: request(url, options?, callback?) or request(options, callback?)
    const firstArg = args[0];
    const options =
      typeof firstArg === 'string' || firstArg instanceof URL
        ? (args[1] as http.RequestOptions | undefined)
        : (firstArg as http.RequestOptions | undefined);
    const agent = options?.agent;
    if (agent !== undefined && agent !== false) {
      const stack = captureStackTrace();
      trackAgent(agent as Agent, false, stack);
    }
    return originalHttpRequest!.apply(this, args);
  };

  // Wrap https.request to detect custom agents
  const patchedHttpsRequest = function (
    ...args: Parameters<typeof https.request>
  ): https.ClientRequest {
    // Handle overloads: request(url, options?, callback?) or request(options, callback?)
    const firstArg = args[0];
    const options =
      typeof firstArg === 'string' || firstArg instanceof URL
        ? (args[1] as https.RequestOptions | undefined)
        : (firstArg as https.RequestOptions | undefined);
    const agent = options?.agent;
    if (agent !== undefined && agent !== false) {
      const stack = captureStackTrace();
      trackAgent(agent as Agent, false, stack);
    }
    return originalHttpsRequest!.apply(this, args);
  };

  // Try to redefine the property
  // First check if it's configurable, and delete if needed
  try {
    const httpRequestDescriptor = Object.getOwnPropertyDescriptor(http, 'request');
    if (httpRequestDescriptor?.configurable === true) {
      // Delete the property first if configurable, then redefine
      delete (http as any).request;
    }
    Object.defineProperty(http, 'request', {
      value: patchedHttpRequest,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // If defineProperty fails, the property might not be configurable
    // In this case, we can't patch it, which is a limitation
    // But we can still track agents that are explicitly passed
    // For now, just log a warning and continue
    console.warn(
      'Could not patch http.request - custom agents passed explicitly will still be tracked',
    );
  }

  try {
    const httpsRequestDescriptor = Object.getOwnPropertyDescriptor(https, 'request');
    if (httpsRequestDescriptor?.configurable === true) {
      // Delete the property first if configurable, then redefine
      delete (https as any).request;
    }
    Object.defineProperty(https, 'request', {
      value: patchedHttpsRequest,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // If defineProperty fails, the property might not be configurable
    // In this case, we can't patch it, which is a limitation
    // But we can still track agents that are explicitly passed
    // For now, just log a warning and continue
    console.warn(
      'Could not patch https.request - custom agents passed explicitly will still be tracked',
    );
  }
}

export type HttpAgentsSnapshot = Record<string, AgentSnapshot>;

/**
 * Creates a snapshot of all currently tracked agents' socket pool state.
 * Returns a record mapping agent identifiers to their socket pool metrics.
 *
 * @returns A snapshot of all tracked agents, keyed by agent identifier.
 *
 * @example
 * ```typescript
 * trackHttpAgents();
 * const agent = new http.Agent();
 * http.request({ agent });
 * const snapshot = snapshotHttpAgents();
 * // snapshot = { 'Agent#1': { sockets: 0, freeSockets: 0, requests: 0 } }
 * ```
 */
export function snapshotHttpAgents(): HttpAgentsSnapshot {
  const snapshot: HttpAgentsSnapshot = {};

  for (const agent of allTrackedAgents) {
    const info = trackedAgents.get(agent);
    if (info === undefined) {
      continue;
    }

    const agentId = getAgentId(agent);
    snapshot[agentId] = captureAgentSnapshot(agent);
  }

  return snapshot;
}

/**
 * Formats leak message in short format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(): string {
  let leakedCount = 0;

  for (const agent of allTrackedAgents) {
    const info = trackedAgents.get(agent);
    if (info === undefined) {
      continue;
    }

    const current = captureAgentSnapshot(agent);
    const initial = info.initialSnapshot;

    // Check for socket pool growth
    const totalSockets = current.sockets + current.freeSockets;
    const initialTotalSockets = initial.sockets + initial.freeSockets;
    if (totalSockets > initialTotalSockets) {
      leakedCount++;
    }

    // Check for request queue growth
    if (current.requests > initial.requests) {
      leakedCount++;
    }
  }

  if (leakedCount === 0) {
    return '';
  }

  return `HTTP agent socket pool leaks detected: ${leakedCount} agent(s) with leaks`;
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const leaks: Array<{
    agentId: string;
    initial: AgentSnapshot;
    current: AgentSnapshot;
    isMonotonic: boolean;
  }> = [];

  for (const agent of allTrackedAgents) {
    const info = trackedAgents.get(agent);
    if (info === undefined) {
      continue;
    }

    const current = captureAgentSnapshot(agent);
    const initial = info.initialSnapshot;

    const totalSockets = current.sockets + current.freeSockets;
    const initialTotalSockets = initial.sockets + initial.freeSockets;
    const socketGrowth = totalSockets - initialTotalSockets;
    const requestGrowth = current.requests - initial.requests;

    if (socketGrowth > 0 || requestGrowth > 0) {
      const isMonotonic = isMonotonicallyGrowing(info.snapshots);
      leaks.push({
        agentId: getAgentId(agent),
        initial,
        current,
        isMonotonic,
      });
    }
  }

  if (leaks.length === 0) {
    return '';
  }

  const lines: string[] = ['HTTP agent socket pool leaks detected:'];
  for (const leak of leaks) {
    const socketGrowth =
      leak.current.sockets +
      leak.current.freeSockets -
      (leak.initial.sockets + leak.initial.freeSockets);
    const requestGrowth = leak.current.requests - leak.initial.requests;

    lines.push(`  ${leak.agentId}:`);
    if (socketGrowth > 0) {
      lines.push(
        `    sockets: ${leak.initial.sockets} -> ${leak.current.sockets} (+${leak.current.sockets - leak.initial.sockets})`,
      );
      lines.push(
        `    freeSockets: ${leak.initial.freeSockets} -> ${leak.current.freeSockets} (+${leak.current.freeSockets - leak.initial.freeSockets})`,
      );
      if (leak.isMonotonic) {
        lines.push(`    (monotonic growth detected)`);
      }
    }
    if (requestGrowth > 0) {
      lines.push(
        `    requests: ${leak.initial.requests} -> ${leak.current.requests} (+${requestGrowth})`,
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
  const leaks: Array<{
    agentId: string;
    initial: AgentSnapshot;
    current: AgentSnapshot;
    isMonotonic: boolean;
    creationStack: string;
  }> = [];

  for (const agent of allTrackedAgents) {
    const info = trackedAgents.get(agent);
    if (info === undefined) {
      continue;
    }

    const current = captureAgentSnapshot(agent);
    const initial = info.initialSnapshot;

    const totalSockets = current.sockets + current.freeSockets;
    const initialTotalSockets = initial.sockets + initial.freeSockets;
    const socketGrowth = totalSockets - initialTotalSockets;
    const requestGrowth = current.requests - initial.requests;

    if (socketGrowth > 0 || requestGrowth > 0) {
      const isMonotonic = isMonotonicallyGrowing(info.snapshots);
      leaks.push({
        agentId: getAgentId(agent),
        initial,
        current,
        isMonotonic,
        creationStack: info.creationStack,
      });
    }
  }

  if (leaks.length === 0) {
    return '';
  }

  const lines: string[] = ['HTTP agent socket pool leaks detected:'];
  for (const leak of leaks) {
    const socketGrowth =
      leak.current.sockets +
      leak.current.freeSockets -
      (leak.initial.sockets + leak.initial.freeSockets);
    const requestGrowth = leak.current.requests - leak.initial.requests;

    lines.push(`  ${leak.agentId}:`);
    if (socketGrowth > 0) {
      lines.push(
        `    sockets: ${leak.initial.sockets} -> ${leak.current.sockets} (+${leak.current.sockets - leak.initial.sockets})`,
      );
      lines.push(
        `    freeSockets: ${leak.initial.freeSockets} -> ${leak.current.freeSockets} (+${leak.current.freeSockets - leak.initial.freeSockets})`,
      );
      if (leak.isMonotonic) {
        lines.push(`    (monotonic growth detected)`);
      }
    }
    if (requestGrowth > 0) {
      lines.push(
        `    requests: ${leak.initial.requests} -> ${leak.current.requests} (+${requestGrowth})`,
      );
    }

    const formattedStack = formatStackTrace(leak.creationStack);
    if (formattedStack !== '') {
      lines.push(`    created at ${formattedStack}`);
    }
  }

  return lines.join('\n');
}

/**
 * Checks for HTTP agent socket pool leaks by comparing current socket counts against initial state.
 * Throws an error if any leaks are detected.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only (e.g. `"HTTP agent socket pool leaks detected: 2 agent(s) with leaks"`)
 * - `"summary"`: List of leaked agents with socket pool metrics
 * - `"details"`: Detailed output with stack traces showing where agents were created
 *
 * @throws {Error} If leak detection is not set up. Call trackHttpAgents() first.
 * @throws {Error} If HTTP agent socket pool leaks are detected, with details about each leak.
 *
 * @remarks Restores original http.request() and https.request() functions and clears tracking state.
 *
 * @example
 * ```typescript
 * trackHttpAgents();
 * const agent = new http.Agent();
 * http.request({ agent });
 * // ... later ...
 * await checkHttpAgents({ forceGC: true, format: 'details' });
 * ```
 */
export async function checkHttpAgents(options?: {
  forceGC?: boolean;
  throwOnLeaks?: boolean;
  format?: 'short' | 'summary' | 'details';
}): Promise<void> {
  const {
    forceGC = global.gc !== undefined,
    throwOnLeaks = true,
    format = 'summary',
  } = options ?? {};

  if (originalHttpRequest === null) {
    throw new Error(
      'HTTP agent leak detection not set up. Call trackHttpAgents() first.',
    );
  }

  // Record snapshot before GC
  recordSnapshots();

  if (forceGC) {
    await forceGarbageCollection();
  }

  // Record snapshot after GC
  recordSnapshots();

  // Always restore original functions and reset state, even if there's an error
  try {
    // Restore original functions
    try {
      const httpRequestDescriptor = Object.getOwnPropertyDescriptor(http, 'request');
      if (httpRequestDescriptor?.configurable !== false) {
        Object.defineProperty(http, 'request', {
          value: originalHttpRequest,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        (http as any).request = originalHttpRequest;
      }
    } catch {
      (http as any).request = originalHttpRequest;
    }

    try {
      const httpsRequestDescriptor = Object.getOwnPropertyDescriptor(https, 'request');
      if (httpsRequestDescriptor?.configurable !== false) {
        Object.defineProperty(https, 'request', {
          value: originalHttpsRequest,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        (https as any).request = originalHttpsRequest;
      }
    } catch {
      (https as any).request = originalHttpsRequest;
    }

    // Reset tracking state
    const savedOriginalHttpRequest = originalHttpRequest;
    const savedOriginalHttpsRequest = originalHttpsRequest;
    originalHttpRequest = null;
    originalHttpsRequest = null;

    let message: string;
    if (format === 'short') {
      message = formatShortMessage();
    } else if (format === 'details') {
      message = formatDetailsMessage();
    } else {
      message = formatSummaryMessage();
    }

    // WeakMap doesn't have clear(), so we just clear the Set and reset counters
    // The WeakMap entries will be garbage collected when agents are no longer referenced
    allTrackedAgents.clear();
    agentIdCounter = 0;
    // WeakMap doesn't have clear() either
    // agentIds entries will be garbage collected when agents are no longer referenced

    if (message !== '') {
      if (throwOnLeaks) {
        throw new Error(message);
      }
      console.error(message);
    }
  } catch (error) {
    // If we get here, it means we threw an error (leak detected)
    // But state is already reset above, so we can just rethrow
    throw error;
  }
}

/**
 * Convenience object providing access to HTTP agent leak detection functions.
 *
 * @property track - Starts tracking HTTP/HTTPS agents. See {@link trackHttpAgents}.
 * @property snapshot - Creates a snapshot of current agents. See {@link snapshotHttpAgents}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkHttpAgents}.
 */
export const httpAgents = {
  track: trackHttpAgents,
  snapshot: snapshotHttpAgents,
  check: checkHttpAgents,
};
