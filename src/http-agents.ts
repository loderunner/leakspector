import http from 'node:http';
import https from 'node:https';

import { forceGarbageCollection } from './force-gc';
import { captureStackTrace, formatStackTrace } from './stack-trace';

type AgentType = 'http.Agent' | 'https.Agent';

/**
 * Snapshot of agent socket pool state.
 */
export type AgentPoolState = {
  sockets: number;
  freeSockets: number;
  requests: number;
};

/**
 * Snapshot of all tracked agents' socket pool states.
 */
export type HttpAgentsSnapshot = Record<string, AgentPoolState>;

type AgentInfo = {
  agent: http.Agent;
  type: AgentType;
  id: string;
  stack: string;
  isGlobal: boolean;
  destroyed: boolean;
  // Track socket pool state history
  stateHistory: AgentPoolState[];
  // Pre-GC state for comparison
  preGCState?: AgentPoolState;
};

// Tracking state
const trackedAgents = new Map<http.Agent, AgentInfo>();
const agentIds = new WeakMap<http.Agent, string>();
let agentCounter = 0;

// Original functions to restore
let originalHttpRequest: typeof http.request | null = null;
let originalHttpsRequest: typeof https.request | null = null;
let originalHttpGet: typeof http.get | null = null;
let originalHttpsGet: typeof https.get | null = null;
let originalAgentDestroy: typeof http.Agent.prototype.destroy | null = null;

/**
 * Gets the current socket pool state for an agent.
 *
 * @param agent - The agent to get state for.
 * @returns The current socket pool state.
 */
function getAgentPoolState(agent: http.Agent): AgentPoolState {
  let socketCount = 0;
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-unnecessary-condition
  if (agent.sockets) {
    for (const hostSockets of Object.values(agent.sockets)) {
      socketCount += hostSockets.length;
    }
  }

  let freeSocketCount = 0;
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-unnecessary-condition
  if (agent.freeSockets) {
    for (const hostFreeSockets of Object.values(agent.freeSockets)) {
      freeSocketCount += hostFreeSockets.length;
    }
  }

  let requestCount = 0;
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-unnecessary-condition
  if (agent.requests) {
    for (const hostRequests of Object.values(agent.requests)) {
      requestCount += hostRequests.length;
    }
  }

  return {
    sockets: socketCount,
    freeSockets: freeSocketCount,
    requests: requestCount,
  };
}

/**
 * Gets or creates an ID for an agent.
 *
 * @param agent - The agent to get ID for.
 * @param type - The type of agent.
 * @param isGlobal - Whether this is a global agent.
 * @returns The agent ID.
 */
function getAgentId(
  agent: http.Agent,
  type: AgentType,
  isGlobal: boolean,
): string {
  const existing = agentIds.get(agent);
  if (existing !== undefined) {
    return existing;
  }

  let id: string;
  if (isGlobal) {
    id = type === 'http.Agent' ? 'http.globalAgent' : 'https.globalAgent';
  } else {
    agentCounter++;
    id = `${type}#${agentCounter}`;
  }

  agentIds.set(agent, id);
  return id;
}

/**
 * Registers an agent for tracking.
 *
 * @param agent - The agent to track.
 * @param type - The type of agent.
 * @param stack - The stack trace where the agent was created.
 * @param isGlobal - Whether this is a global agent.
 */
function trackAgent(
  agent: http.Agent,
  type: AgentType,
  stack: string,
  isGlobal: boolean,
): void {
  if (trackedAgents.has(agent)) {
    return;
  }

  const id = getAgentId(agent, type, isGlobal);
  const initialState = getAgentPoolState(agent);

  trackedAgents.set(agent, {
    agent,
    type,
    id,
    stack,
    isGlobal,
    destroyed: false,
    stateHistory: [initialState],
  });
}

/**
 * Updates the socket pool state history for all tracked agents.
 * This should be called periodically to track state changes.
 */
function updateAgentStates(): void {
  for (const agentInfo of trackedAgents.values()) {
    if (!agentInfo.destroyed) {
      const currentState = getAgentPoolState(agentInfo.agent);
      agentInfo.stateHistory.push(currentState);
    }
  }
}

/**
 * Records the pre-GC state for all agents.
 */
function recordPreGCState(): void {
  for (const agentInfo of trackedAgents.values()) {
    if (!agentInfo.destroyed) {
      agentInfo.preGCState = getAgentPoolState(agentInfo.agent);
    }
  }
}

/**
 * Starts tracking HTTP/HTTPS agent socket pools.
 * Patches http.request, https.request, http.get, https.get to detect custom agents.
 * Also tracks the global agents (http.globalAgent and https.globalAgent).
 *
 * @throws {Error} If leak detection is already set up. Call checkHttpAgents() first.
 *
 * @example
 * ```typescript
 * trackHttpAgents();
 * const agent = new http.Agent({ keepAlive: true });
 * http.request({ host: 'example.com', agent });
 * ```
 */
export function trackHttpAgents(): void {
  if (originalHttpRequest !== null) {
    throw new Error(
      'HTTP agent leak detection already set up. Call checkHttpAgents() first.',
    );
  }

  // Clear tracking state
  trackedAgents.clear();
  agentCounter = 0;

  // Track global agents
  trackAgent(http.globalAgent, 'http.Agent', '', true);
  trackAgent(https.globalAgent, 'https.Agent', '', true);

  // Save original functions
  originalHttpRequest = http.request;
  originalHttpsRequest = https.request;
  originalHttpGet = http.get;
  originalHttpsGet = https.get;
  originalAgentDestroy = http.Agent.prototype.destroy;

  // Patch Agent.prototype.destroy to track destruction
  http.Agent.prototype.destroy = function (this: http.Agent): void {
    const agentInfo = trackedAgents.get(this);
    if (agentInfo !== undefined) {
      agentInfo.destroyed = true;
    }
    return originalAgentDestroy!.call(this);
  };

  // Helper function to extract agent from options
  function extractAgent(
    options: string | URL | http.RequestOptions,
  ): http.Agent | undefined {
    if (typeof options === 'string' || options instanceof URL) {
      return undefined;
    }
    return options.agent as http.Agent | undefined;
  }

  // Patch http.request
  http.request = function (
    this: typeof http,
    ...args: Parameters<typeof http.request>
  ): http.ClientRequest {
    const [firstArg] = args;
    const agent = extractAgent(firstArg);

    if (agent !== undefined && agent !== false) {
      if (!trackedAgents.has(agent)) {
        const stack = captureStackTrace();
        trackAgent(agent, 'http.Agent', stack, false);
      }
    }

    return originalHttpRequest!.apply(this, args);
  };

  // Patch https.request
  https.request = function (
    this: typeof https,
    ...args: Parameters<typeof https.request>
  ): http.ClientRequest {
    const [firstArg] = args;
    const agent = extractAgent(firstArg);

    if (agent !== undefined && agent !== false) {
      if (!trackedAgents.has(agent)) {
        const stack = captureStackTrace();
        trackAgent(agent, 'https.Agent', stack, false);
      }
    }

    return originalHttpsRequest!.apply(this, args);
  };

  // Patch http.get
  http.get = function (
    this: typeof http,
    ...args: Parameters<typeof http.get>
  ): http.ClientRequest {
    const [firstArg] = args;
    const agent = extractAgent(firstArg);

    if (agent !== undefined && agent !== false) {
      if (!trackedAgents.has(agent)) {
        const stack = captureStackTrace();
        trackAgent(agent, 'http.Agent', stack, false);
      }
    }

    return originalHttpGet!.apply(this, args);
  };

  // Patch https.get
  https.get = function (
    this: typeof https,
    ...args: Parameters<typeof https.get>
  ): http.ClientRequest {
    const [firstArg] = args;
    const agent = extractAgent(firstArg);

    if (agent !== undefined && agent !== false) {
      if (!trackedAgents.has(agent)) {
        const stack = captureStackTrace();
        trackAgent(agent, 'https.Agent', stack, false);
      }
    }

    return originalHttpsGet!.apply(this, args);
  };
}

/**
 * Creates a snapshot of all currently tracked agent socket pool states.
 *
 * @returns A record mapping agent IDs to their current socket pool state.
 *
 * @example
 * ```typescript
 * trackHttpAgents();
 * const agent = new http.Agent({ keepAlive: true });
 * // ... make requests ...
 * const snapshot = snapshotHttpAgents();
 * // snapshot = { 'http.Agent#1': { sockets: 1, freeSockets: 0, requests: 0 } }
 * ```
 */
export function snapshotHttpAgents(): HttpAgentsSnapshot {
  // Update states before snapshotting
  updateAgentStates();

  const snapshot: HttpAgentsSnapshot = {};

  for (const agentInfo of trackedAgents.values()) {
    if (!agentInfo.destroyed) {
      const currentState = getAgentPoolState(agentInfo.agent);
      snapshot[agentInfo.id] = currentState;
    }
  }

  return snapshot;
}

/**
 * Checks if an agent's socket pool is growing monotonically.
 * An agent is considered leaking if:
 * 1. Socket count (sockets + freeSockets) increased after GC, OR
 * 2. Free socket count grew monotonically over time, OR
 * 3. Request queue depth is non-zero and growing
 *
 * @param agentInfo - The agent info to check.
 * @returns True if the agent is leaking.
 */
function isAgentLeaking(agentInfo: AgentInfo): boolean {
  if (agentInfo.destroyed) {
    return false;
  }

  const currentState = getAgentPoolState(agentInfo.agent);
  const { preGCState, stateHistory } = agentInfo;

  // Check 1: Did socket count increase after GC?
  if (preGCState !== undefined) {
    const preGCTotal = preGCState.sockets + preGCState.freeSockets;
    const currentTotal = currentState.sockets + currentState.freeSockets;

    // If sockets grew after GC, that's a strong indicator of a leak
    if (currentTotal > preGCTotal) {
      return true;
    }
  }

  // Check 2: Are free sockets accumulating monotonically?
  if (stateHistory.length >= 3) {
    let freeSocketsGrowing = true;
    for (let i = 1; i < stateHistory.length; i++) {
      if (stateHistory[i].freeSockets <= stateHistory[i - 1].freeSockets) {
        freeSocketsGrowing = false;
        break;
      }
    }

    // If free sockets have been growing consistently, that's a leak
    if (freeSocketsGrowing && currentState.freeSockets > 0) {
      return true;
    }
  }

  // Check 3: Are requests piling up?
  if (stateHistory.length >= 2) {
    const lastState = stateHistory[stateHistory.length - 2];
    // Requests growing and non-zero indicates they're not being serviced
    if (
      currentState.requests > 0 &&
      currentState.requests > lastState.requests
    ) {
      return true;
    }
  }

  // Check 4: Do we have any resources that aren't cleaned up?
  // If an agent has ANY sockets or requests after GC, it might be leaking
  // But we need to be careful not to flag normal keep-alive usage
  if (
    !agentInfo.isGlobal &&
    (currentState.sockets > 0 ||
      currentState.freeSockets > 0 ||
      currentState.requests > 0)
  ) {
    // For custom agents, having any resources is suspicious
    return true;
  }

  return false;
}

/**
 * Formats leak message in short format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatShortMessage(): string {
  const leakedAgents: AgentInfo[] = [];

  for (const agentInfo of trackedAgents.values()) {
    if (isAgentLeaking(agentInfo)) {
      leakedAgents.push(agentInfo);
    }
  }

  if (leakedAgents.length === 0) {
    return '';
  }

  return `HTTP agent leaks detected: ${leakedAgents.length} agent(s) with socket pool leaks`;
}

/**
 * Formats leak message in summary format.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatSummaryMessage(): string {
  const leakedAgents: AgentInfo[] = [];

  for (const agentInfo of trackedAgents.values()) {
    if (isAgentLeaking(agentInfo)) {
      leakedAgents.push(agentInfo);
    }
  }

  if (leakedAgents.length === 0) {
    return '';
  }

  const lines: string[] = ['HTTP agent socket pool leaks detected:'];

  for (const agentInfo of leakedAgents) {
    const currentState = getAgentPoolState(agentInfo.agent);
    const { preGCState } = agentInfo;

    let leakDescription = '';

    // Describe what's leaking
    const parts: string[] = [];
    if (currentState.sockets > 0) {
      parts.push(`${currentState.sockets} active socket(s)`);
    }
    if (currentState.freeSockets > 0) {
      parts.push(`${currentState.freeSockets} free socket(s)`);
    }
    if (currentState.requests > 0) {
      parts.push(`${currentState.requests} queued request(s)`);
    }

    leakDescription = parts.join(', ');

    // Show before/after GC comparison if available
    if (preGCState !== undefined) {
      const preGCTotal = preGCState.sockets + preGCState.freeSockets;
      const currentTotal = currentState.sockets + currentState.freeSockets;
      const delta = currentTotal - preGCTotal;

      if (delta > 0) {
        leakDescription += ` (+${delta} since GC)`;
      }
    }

    const formattedStack = formatStackTrace(agentInfo.stack, [
      'http-agents.ts',
    ]);
    if (formattedStack !== '' && !agentInfo.isGlobal) {
      lines.push(`  '${agentInfo.id}': ${leakDescription} ${formattedStack}`);
    } else {
      lines.push(`  '${agentInfo.id}': ${leakDescription}`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats leak message in details format with socket pool history.
 *
 * @returns Formatted message string, or empty string if no leaks detected.
 */
function formatDetailsMessage(): string {
  const leakedAgents: AgentInfo[] = [];

  for (const agentInfo of trackedAgents.values()) {
    if (isAgentLeaking(agentInfo)) {
      leakedAgents.push(agentInfo);
    }
  }

  if (leakedAgents.length === 0) {
    return '';
  }

  const lines: string[] = ['HTTP agent socket pool leaks detected:'];

  for (const agentInfo of leakedAgents) {
    const currentState = getAgentPoolState(agentInfo.agent);
    const { preGCState, stateHistory } = agentInfo;

    lines.push(`  ${agentInfo.id}`);

    // Show current state
    lines.push(
      `  > Current: ${currentState.sockets} active, ${currentState.freeSockets} free, ${currentState.requests} queued`,
    );

    // Show pre-GC state if available
    if (preGCState !== undefined) {
      const preGCTotal = preGCState.sockets + preGCState.freeSockets;
      const currentTotal = currentState.sockets + currentState.freeSockets;
      const delta = currentTotal - preGCTotal;

      lines.push(
        `  > Before GC: ${preGCState.sockets} active, ${preGCState.freeSockets} free, ${preGCState.requests} queued`,
      );
      if (delta > 0) {
        lines.push(`  > Socket count increased by ${delta} after GC`);
      }
    }

    // Show state history if we have multiple snapshots
    if (stateHistory.length > 1) {
      lines.push('  > State history:');
      for (let i = 0; i < stateHistory.length; i++) {
        const state = stateHistory[i];
        lines.push(
          `      [${i}] sockets: ${state.sockets}, free: ${state.freeSockets}, requests: ${state.requests}`,
        );
      }
    }

    // Show stack trace for custom agents
    if (!agentInfo.isGlobal) {
      const formattedStack = formatStackTrace(agentInfo.stack, [
        'http-agents.ts',
      ]);
      if (formattedStack !== '') {
        lines.push(`  > Created at: ${formattedStack}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Checks for HTTP agent socket pool leaks.
 * Compares socket pool states before and after garbage collection.
 *
 * @param options - Configuration options for leak checking.
 * @param options.forceGC - Whether to force garbage collection before checking.
 * @param options.throwOnLeaks - Whether to throw an error if leaks are detected. Defaults to true.
 * @param options.format - Output format for error messages. Defaults to `"summary"`.
 * - `"short"`: Terse count only
 * - `"summary"`: List of leaked agents with current state
 * - `"details"`: Detailed output with state history and stack traces
 *
 * @throws {Error} If leak detection is not set up. Call trackHttpAgents() first.
 * @throws {Error} If HTTP agent leaks are detected.
 *
 * @remarks Restores original http/https functions and clears tracking state.
 *
 * @example
 * ```typescript
 * trackHttpAgents();
 * const agent = new http.Agent({ keepAlive: true });
 * // ... make requests but don't destroy agent ...
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

  // Update states before GC
  updateAgentStates();

  // Record pre-GC state
  recordPreGCState();

  // Force GC if requested
  if (forceGC) {
    await forceGarbageCollection();
  }

  // Update states after GC
  updateAgentStates();

  // Restore original functions
  http.request = originalHttpRequest;
  https.request = originalHttpsRequest!;
  http.get = originalHttpGet!;
  https.get = originalHttpsGet!;
  http.Agent.prototype.destroy = originalAgentDestroy!;

  originalHttpRequest = null;
  originalHttpsRequest = null;
  originalHttpGet = null;
  originalHttpsGet = null;
  originalAgentDestroy = null;

  // Format message
  let message: string;
  if (format === 'short') {
    message = formatShortMessage();
  } else if (format === 'details') {
    message = formatDetailsMessage();
  } else {
    message = formatSummaryMessage();
  }

  // Clear tracking state
  trackedAgents.clear();

  if (message !== '') {
    if (throwOnLeaks) {
      throw new Error(message);
    }
    console.error(message);
  }
}

/**
 * Convenience object providing access to HTTP agent leak detection functions.
 *
 * @property track - Starts tracking HTTP agents. See {@link trackHttpAgents}.
 * @property snapshot - Creates a snapshot of current agent states. See {@link snapshotHttpAgents}.
 * @property check - Checks for leaks and restores original behavior. See {@link checkHttpAgents}.
 */
export const httpAgents = {
  track: trackHttpAgents,
  snapshot: snapshotHttpAgents,
  check: checkHttpAgents,
};
