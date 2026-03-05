/**
 * FORK: overseer/topology — In-memory graph store for agent/subagent hierarchy
 *
 * Maintains a live directed graph of `OverseerNode` entries (main session +
 * subagents) and parent-child `OverseerEdge` connections. Nodes are created on
 * subagent spawn or main session LLM activation, enriched with model/provider/token
 * data from gateway session polling, and removed on subagent end. Tracks per-node
 * phase, tool call counts, and staleness detection (marks nodes "stuck" when their
 * `updatedAt` timestamp stops advancing). Exports `TopologySnapshot` for
 * serialization by the persistence layer and for the `overseer.topology` gateway
 * method. Heartbeat sessions are excluded via the static `isHeartbeat()` guard.
 *
 * Wired in by: instantiated in `extensions/overseer/index.ts` as `TopologyStore`
 */
import type {
  PluginHookSubagentSpawnedEvent,
  PluginHookSubagentEndedEvent,
  PluginHookSubagentContext,
} from "../../src/plugins/types.js";

export type NodeStatus = "working" | "waiting" | "stuck" | "idle";

export interface OverseerNode {
  sessionKey: string;
  agentId: string;
  label: string;
  mode: "run" | "session" | "main";
  runId: string;
  parentKey: string | null;
  provider: string;
  model: string;
  status: NodeStatus;
  role: string;
  phase: string;
  tokens: number;
  depth: number;
  spawnedAt: number;
  updatedAt: number;
  lastSeenUpdatedAt: number;
  stalenessCount: number;
  /** Number of tool calls in the current run */
  toolCalls: number;
  /** Whether this is the main/root agent node */
  isMain: boolean;
}

export interface OverseerEdge {
  source: string;
  target: string;
}

export interface TopologySnapshot {
  nodes: OverseerNode[];
  edges: OverseerEdge[];
  updatedAt: number;
}

export class TopologyStore {
  private nodes = new Map<string, OverseerNode>();
  private edges: OverseerEdge[] = [];
  private changeCount = 0;

  addNode(event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext): void {
    const parentKey = ctx.requesterSessionKey ?? null;
    const parentNode = parentKey ? this.nodes.get(parentKey) : null;
    const depth = parentNode ? parentNode.depth + 1 : 1;

    const node: OverseerNode = {
      sessionKey: event.childSessionKey,
      agentId: event.agentId,
      label: event.label || event.agentId,
      mode: event.mode,
      runId: event.runId,
      parentKey,
      provider: "",
      model: "",
      status: "working",
      role: "",
      phase: "",
      tokens: 0,
      depth,
      spawnedAt: Date.now(),
      updatedAt: Date.now(),
      lastSeenUpdatedAt: 0,
      stalenessCount: 0,
      toolCalls: 0,
      isMain: false,
    };

    this.nodes.set(event.childSessionKey, node);
    if (parentKey) {
      this.edges.push({ source: parentKey, target: event.childSessionKey });
    }
    this.changeCount++;
  }

  removeNode(event: PluginHookSubagentEndedEvent): OverseerNode | undefined {
    const node = this.nodes.get(event.targetSessionKey);
    if (!node) return undefined;
    this.nodes.delete(event.targetSessionKey);
    this.edges = this.edges.filter(
      (e) => e.source !== event.targetSessionKey && e.target !== event.targetSessionKey,
    );
    this.changeCount++;
    return node;
  }

  enrichFromSessions(
    sessions: Array<{
      key: string;
      model?: string;
      modelProvider?: string;
      totalTokens?: number;
      updatedAt?: string;
      label?: string;
    }>,
  ): void {
    const sessionMap = new Map(sessions.map((s) => [s.key, s]));
    for (const [key, node] of this.nodes) {
      const session = sessionMap.get(key);
      if (!session) continue;
      if (session.model) node.model = session.model;
      if (session.modelProvider) node.provider = session.modelProvider;
      if (session.totalTokens != null) node.tokens = session.totalTokens;
      if (session.label) node.label = session.label;
      if (session.updatedAt) {
        const ts = new Date(session.updatedAt).getTime();
        if (ts > node.updatedAt) {
          node.updatedAt = ts;
        }
      }
    }
  }

  detectStaleness(thresholdMs: number): string[] {
    const stuckKeys: string[] = [];
    for (const [key, node] of this.nodes) {
      if (node.updatedAt === node.lastSeenUpdatedAt) {
        node.stalenessCount++;
      } else {
        node.stalenessCount = 0;
        node.lastSeenUpdatedAt = node.updatedAt;
      }
      if (node.stalenessCount * thresholdMs > thresholdMs && node.status !== "stuck") {
        node.status = "stuck";
        stuckKeys.push(key);
        this.changeCount++;
      } else if (node.stalenessCount === 0 && node.status === "stuck") {
        node.status = "working";
        this.changeCount++;
      }
    }
    return stuckKeys;
  }

  snapshot(): TopologySnapshot {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
      updatedAt: Date.now(),
    };
  }

  restore(snap: TopologySnapshot): void {
    this.nodes.clear();
    this.edges = [];
    for (const n of snap.nodes) {
      // Skip heartbeat nodes that may have been persisted
      if (TopologyStore.isHeartbeat(n.sessionKey)) continue;
      // Update stale labels from before rename
      if (n.label === "Jarvis") n.label = "Main";
      this.nodes.set(n.sessionKey, n);
    }
    this.edges = snap.edges;
  }

  get size(): number {
    return this.nodes.size;
  }

  get changes(): number {
    return this.changeCount;
  }

  resetChangeCount(): void {
    this.changeCount = 0;
  }

  getNode(key: string): OverseerNode | undefined {
    return this.nodes.get(key);
  }

  allNodes(): OverseerNode[] {
    return Array.from(this.nodes.values());
  }

  // ─── Main Session Tracking ───

  /** Create or activate the main session node when LLM activity starts */
  activateMain(info: {
    sessionKey: string;
    provider: string;
    model: string;
    runId: string;
    trigger?: string;
  }): void {
    let node = this.nodes.get(info.sessionKey);
    if (node) {
      // Reactivate existing node
      node.status = "working";
      node.provider = info.provider;
      node.model = info.model;
      node.runId = info.runId;
      node.phase = "";
      node.toolCalls = 0;
      node.updatedAt = Date.now();
      node.stalenessCount = 0;
    } else {
      node = {
        sessionKey: info.sessionKey,
        agentId: "main",
        label: "Main",
        mode: "main",
        runId: info.runId,
        parentKey: null,
        provider: info.provider,
        model: info.model,
        status: "working",
        role: info.trigger || "main",
        phase: "",
        tokens: 0,
        depth: 0,
        spawnedAt: Date.now(),
        updatedAt: Date.now(),
        lastSeenUpdatedAt: 0,
        stalenessCount: 0,
        toolCalls: 0,
        isMain: true,
      };
      this.nodes.set(info.sessionKey, node);
    }
    this.changeCount++;
  }

  /** Update main node phase (e.g. tool calls, compaction) */
  updatePhase(sessionKey: string, phase: string): void {
    const node = this.nodes.get(sessionKey);
    if (!node) return;
    node.phase = phase;
    node.updatedAt = Date.now();
    this.changeCount++;
  }

  /** Increment tool call count for a session */
  addToolCall(sessionKey: string, toolName: string): void {
    const node = this.nodes.get(sessionKey);
    if (!node) return;
    node.toolCalls++;
    node.phase = `tool: ${toolName}`;
    node.updatedAt = Date.now();
  }

  /** Mark tool call finished for a session */
  finishToolCall(sessionKey: string): void {
    const node = this.nodes.get(sessionKey);
    if (!node) return;
    node.phase = node.toolCalls > 0 ? `${node.toolCalls} tools used` : "";
    node.updatedAt = Date.now();
  }

  /** Mark main session as completed (set to idle, keep visible) */
  endSession(sessionKey: string, success: boolean, durationMs?: number): void {
    const node = this.nodes.get(sessionKey);
    if (!node) return;
    node.status = "idle";
    const dur = durationMs ? ` (${(durationMs / 1000).toFixed(1)}s)` : "";
    node.phase = success ? `done${dur}` : `error${dur}`;
    node.updatedAt = Date.now();
    this.changeCount++;
  }

  /** Update token count and usage for a session after LLM output */
  updateUsage(sessionKey: string, usage?: { inputTokens?: number; outputTokens?: number }): void {
    const node = this.nodes.get(sessionKey);
    if (!node || !usage) return;
    node.tokens += (usage.inputTokens || 0) + (usage.outputTokens || 0);
    node.updatedAt = Date.now();
  }

  /** Check if a session key represents a heartbeat */
  static isHeartbeat(sessionKey?: string, trigger?: string): boolean {
    if (trigger === "heartbeat") return true;
    if (!sessionKey) return false;
    return sessionKey.includes("heartbeat");
  }
}
