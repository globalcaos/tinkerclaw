/**
 * FORK: prefrontal/index — Plugin entry point for the Prefrontal real-time agent topology tracker
 *
 * Registers the Prefrontal plugin with the OpenClaw plugin API, wiring up hooks
 * for subagent spawn/end, LLM input/output, tool calls, and agent completion to
 * build a live topology graph of all running agents and the main session.
 * Enriches subagent nodes by polling the gateway session store on a timer, detects
 * stale/stuck agents, and broadcasts markdown status updates to the Tinker UI via
 * `agent` lifecycle events through the ChatEmitter. Persists topology state across
 * gateway restarts. Exposes `prefrontal.topology`, `prefrontal.status`, `prefrontal.tree`,
 * and `prefrontal.config` gateway methods for external queries. Serves the call tree
 * at `GET /api/prefrontal/tree` via the HTTP handler. Checks for crash recovery state
 * on startup and clears it after reading. Heartbeat sessions are filtered out at
 * every hook.
 *
 * Wired in by: OpenClaw plugin system via `plugins.entries.prefrontal` in openclaw.json
 */
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { loadCombinedSessionStoreForGateway } from "../../src/gateway/session-utils.js";
import type {
  PluginHookSubagentSpawnedEvent,
  PluginHookSubagentEndedEvent,
  PluginHookSubagentContext,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
  PluginHookGatewayContext,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookAgentEndEvent,
  PluginHookAgentContext,
  PluginHookBeforeToolCallEvent,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from "../../src/plugins/types.js";
import { ChatEmitter } from "./chat-emitter.js";
import { saveState, loadState } from "./persistence.js";
import { createPrefrontalHttpHandler } from "./prefrontal-http.js";
import { createPrefrontalMonitor } from "./prefrontal-monitor.js";
import type { SubagentRunInfo } from "./prefrontal-monitor.js";
import { readRecoveryState, clearRecoveryState } from "./prefrontal-recovery.js";
import { DEFAULT_PREFRONTAL_CONFIG } from "./prefrontal-types.js";
import { TopologyStore } from "./topology.js";

const PLUGIN_ID = "prefrontal";

// Module-level singletons — shared across all register() calls.
// The gateway loads this plugin multiple times (gateway + per-agent),
// but hooks and gateway methods must operate on the SAME state.
let sharedMonitor: ReturnType<typeof createPrefrontalMonitor> | null = null;
const sharedSubagentRuns = new Map<string, SubagentRunInfo>();
const sharedLastEventTimestamps = new Map<string, number>();
let sharedPrefrontalSessionKey: string | null = null;

export default function register(api: OpenClawPluginApi) {
  const config = api.config as Record<string, any>;
  const pluginConfig = (config.plugins as any)?.entries?.[PLUGIN_ID]?.config ?? {};

  // ─── Config: merge plugin config with defaults ───
  const prefrontalConfig = {
    ...DEFAULT_PREFRONTAL_CONFIG,
    ...(pluginConfig.prefrontal ?? {}),
  };

  // Initialize shared monitor singleton on first registration
  if (!sharedMonitor) {
    sharedMonitor = createPrefrontalMonitor(prefrontalConfig);
  }

  const pollIntervalMs = pluginConfig.pollIntervalMs ?? 5000;
  const stalenessThresholdMs = pluginConfig.stalenessThresholdMs ?? 60000;
  const chatMinMs = pluginConfig.chatMinIntervalMs ?? 30000;
  const chatMaxMs = pluginConfig.chatMaxIntervalMs ?? 180000;
  const monitorIntervalMs = prefrontalConfig.monitorIntervalMs ?? 5000;

  const homeDir = process.env.HOME || "/tmp";
  const persistPath = pluginConfig.persistPath
    ? String(pluginConfig.persistPath).replace("~", homeDir)
    : join(homeDir, ".openclaw", "prefrontal-state.json");

  const log = api.logger ?? { info: console.log, warn: console.warn, error: console.error };

  // ─── Topology Store (existing live graph) ───
  const topology = new TopologyStore();

  // ─── Monitor (new call tree builder) ───
  const monitor = sharedMonitor!;

  // ─── HTTP Handler ───
  const httpHandler = createPrefrontalHttpHandler((sessionFilter) =>
    monitor.getTreeState(sessionFilter),
  );

  // Register HTTP route for /api/prefrontal/tree
  try {
    api.registerHttpRoute({
      path: "/api/prefrontal",
      auth: "gateway",
      match: "prefix",
      handler: (req: any, res: any) => {
        if (!httpHandler(req, res)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      },
    });
  } catch {
    log.warn?.(`[prefrontal] HTTP route registration failed`);
  }

  // ─── Subagent run tracking (shared singletons) ───
  const subagentRuns = sharedSubagentRuns;
  const lastEventTimestamps = sharedLastEventTimestamps;
  // Use module-level session key so all register() calls share it
  const getPrefrontalSessionKey = () => sharedPrefrontalSessionKey;
  const setPrefrontalSessionKey = (v: string | null) => {
    sharedPrefrontalSessionKey = v;
  };

  // ─── Chat Emitter ───
  const chatEmitter = new ChatEmitter({
    minIntervalMs: chatMinMs,
    maxIntervalMs: chatMaxMs,
    emitFn: (markdown: string) => {
      // Broadcast prefrontal update as agent event so Tinker UI can display it
      try {
        (api as any).broadcast?.("agent", {
          stream: "lifecycle",
          data: {
            phase: "prefrontal-update",
            markdown,
            ts: Date.now(),
          },
        });
      } catch {
        log.warn?.(`[prefrontal] Failed to broadcast chat update`);
      }
    },
  });

  // ─── Hooks ───
  api.on(
    "subagent_spawned",
    (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => {
      topology.addNode(event, ctx);
      const node = topology.getNode(event.childSessionKey);
      if (node) chatEmitter.onSpawned(node);
      log.info?.(
        `[prefrontal] Agent spawned: ${event.label || event.agentId} (${event.childSessionKey})`,
      );

      // Track in subagentRuns for monitor tree
      const run: SubagentRunInfo = {
        runId: event.runId,
        childSessionKey: event.childSessionKey,
        requesterSessionKey: ctx.requesterSessionKey ?? "",
        task: event.label || event.agentId,
        label: event.label,
        model: (event as any).model,
        createdAt: Date.now(),
        startedAt: Date.now(),
      };
      subagentRuns.set(event.runId, run);
      lastEventTimestamps.set(event.runId, Date.now());

      // If the spawning session is main, mark it as prefrontal session
      if (!getPrefrontalSessionKey() && ctx.requesterSessionKey?.includes("main")) {
        setPrefrontalSessionKey(ctx.requesterSessionKey);
      }
    },
  );

  api.on(
    "subagent_ended",
    (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => {
      const removed = topology.removeNode(event);
      if (removed) {
        chatEmitter.onEnded(removed, event.outcome);
        log.info?.(`[prefrontal] Agent ended: ${removed.label} (${event.outcome || "ok"})`);
      }

      // Update subagentRun record for monitor
      for (const [runId, run] of subagentRuns) {
        if (run.childSessionKey === event.targetSessionKey) {
          run.endedAt = Date.now();
          run.outcome = { status: event.outcome ?? "ok" };
          lastEventTimestamps.set(runId, Date.now());
          break;
        }
      }
    },
  );

  // ─── Main Session Tracking ───
  api.on("llm_input", (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => {
    log.info?.(
      `[prefrontal] HOOK llm_input sessionKey=${ctx.sessionKey} trigger=${ctx.trigger} provider=${event.provider} model=${event.model}`,
    );
    if (TopologyStore.isHeartbeat(ctx.sessionKey, ctx.trigger)) return;
    const sessionKey = ctx.sessionKey || "agent:main:main";
    topology.activateMain({
      sessionKey,
      provider: event.provider,
      model: event.model,
      runId: event.runId,
      trigger: ctx.trigger,
    });
    // Tell the monitor about the active main session so it always shows a root node
    monitor.setActiveMain({
      sessionKey,
      provider: event.provider,
      model: event.model,
      phase: "thinking",
    });
    // Immediately broadcast tree so UI shows the node without waiting for interval
    rebuildAndBroadcastTree();
    log.info?.(
      `[prefrontal] Main activated: ${sessionKey} (${event.provider}/${event.model}) topo.size=${topology.size}`,
    );
  });

  api.on("llm_output", (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => {
    log.info?.(`[prefrontal] HOOK llm_output sessionKey=${ctx.sessionKey} trigger=${ctx.trigger}`);
    if (TopologyStore.isHeartbeat(ctx.sessionKey, ctx.trigger)) return;
    const sessionKey = ctx.sessionKey || "agent:main:main";
    topology.updateUsage(sessionKey, event.usage);
    topology.updatePhase(sessionKey, "responding");
    // Update monitor phase to "responding"
    if (monitor.setActiveMain) {
      const existing = (monitor as any).activeMain;
      // Only update phase if main is already set (from llm_input)
      monitor.setActiveMain({
        sessionKey,
        provider: (event as any).provider ?? "unknown",
        model: (event as any).model ?? "unknown",
        phase: "responding",
      });
    }

    // Update last event timestamp for any matching subagent
    for (const [runId, run] of subagentRuns) {
      if (run.childSessionKey === sessionKey) {
        lastEventTimestamps.set(runId, Date.now());
        break;
      }
    }
  });

  api.on("before_tool_call", (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
    log.info?.(
      `[prefrontal] HOOK before_tool_call sessionKey=${ctx.sessionKey} tool=${event.toolName}`,
    );
    const sessionKey = ctx.sessionKey || "agent:main:main";
    if (TopologyStore.isHeartbeat(sessionKey)) return;
    topology.addToolCall(sessionKey, event.toolName);

    // Update last event timestamp for any matching subagent
    for (const [runId, run] of subagentRuns) {
      if (run.childSessionKey === sessionKey) {
        lastEventTimestamps.set(runId, Date.now());
        break;
      }
    }
  });

  api.on("after_tool_call", (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
    log.info?.(
      `[prefrontal] HOOK after_tool_call sessionKey=${ctx.sessionKey} tool=${event.toolName}`,
    );
    const sessionKey = ctx.sessionKey || "agent:main:main";
    if (TopologyStore.isHeartbeat(sessionKey)) return;
    topology.finishToolCall(sessionKey);
  });

  api.on("agent_end", (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
    log.info?.(
      `[prefrontal] HOOK agent_end sessionKey=${ctx.sessionKey} trigger=${ctx.trigger} success=${event.success} duration=${event.durationMs}`,
    );
    if (TopologyStore.isHeartbeat(ctx.sessionKey, ctx.trigger)) return;
    const sessionKey = ctx.sessionKey || "agent:main:main";
    topology.endSession(sessionKey, event.success, event.durationMs);
    // Clear active main after a short delay so the UI poll catches the completed state.
    // Mark as completed first, then clear after 10s.
    const endedModel = topology.getNode(sessionKey);
    if (endedModel) {
      monitor.setActiveMain({
        sessionKey,
        provider: endedModel.provider ?? "unknown",
        model: endedModel.model ?? "unknown",
        phase: "completed",
      });
      rebuildAndBroadcastTree();
    }
    setTimeout(() => {
      monitor.setActiveMain(null);
      rebuildAndBroadcastTree();
    }, 10_000);
  });

  api.on("gateway_start", (_event: PluginHookGatewayStartEvent, _ctx: PluginHookGatewayContext) => {
    // ─── Topology restore ───
    const snap = loadState(persistPath);
    if (snap && snap.nodes.length > 0) {
      topology.restore(snap);
      log.info?.(`[prefrontal] Restored ${snap.nodes.length} nodes from ${persistPath}`);
    }

    // ─── Recovery state check ───
    try {
      const recovery = readRecoveryState();
      if (recovery) {
        log.info?.(
          `[prefrontal] Prefrontal recovery state found from ${recovery.timestamp}: ` +
            `${recovery.activeSubagents.length} subagents, session=${recovery.prefrontalSessionKey}`,
        );
        // Restore prefrontal session key from recovery
        if (recovery.prefrontalSessionKey) {
          setPrefrontalSessionKey(recovery.prefrontalSessionKey);
        }
        // Reconstruct subagent runs from recovery
        for (const sub of recovery.activeSubagents) {
          const run: SubagentRunInfo = {
            runId: sub.runId,
            childSessionKey: sub.childSessionKey,
            requesterSessionKey: recovery.prefrontalSessionKey,
            task: sub.task,
            model: sub.model,
            createdAt: Date.now(),
            startedAt: Date.now(),
          };
          subagentRuns.set(sub.runId, run);
          lastEventTimestamps.set(sub.runId, Date.now());
        }
        clearRecoveryState();
        log.info?.(`[prefrontal] Recovery state cleared after loading`);
      }
    } catch (e) {
      log.warn?.(`[prefrontal] Recovery state read failed: ${e}`);
    }
  });

  api.on("gateway_stop", (_event: PluginHookGatewayStopEvent, _ctx: PluginHookGatewayContext) => {
    const snap = topology.snapshot();
    if (snap.nodes.length > 0) {
      saveState(persistPath, snap);
      log.info?.(`[prefrontal] Persisted ${snap.nodes.length} nodes to ${persistPath}`);
    }
    chatEmitter.destroy();
    if (pollTimer) clearInterval(pollTimer);
    if (stalenessTimer) clearInterval(stalenessTimer);
    if (monitorTimer) clearInterval(monitorTimer);
  });

  // ─── Enrichment Poll ───
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stalenessTimer: ReturnType<typeof setInterval> | null = null;
  let monitorTimer: ReturnType<typeof setInterval> | null = null;

  function enrichTopology() {
    // Only enrich non-main nodes (main node gets data from hooks directly)
    if (topology.allNodes().filter((n) => !n.isMain).length === 0) return;
    try {
      const { store } = loadCombinedSessionStoreForGateway(config as any);
      const sessions = Object.entries(store).map(([key, entry]: [string, any]) => ({
        key,
        model: entry.model,
        modelProvider: entry.modelProvider,
        totalTokens: entry.totalTokens,
        updatedAt: entry.updatedAt,
        label: entry.label,
      }));
      topology.enrichFromSessions(sessions);

      // Also update subagent run models from session store
      for (const [runId, run] of subagentRuns) {
        if (!run.endedAt) {
          const session = sessions.find((s) => s.key === run.childSessionKey);
          if (session?.model) run.model = session.model;
        }
      }
    } catch (e) {
      log.warn?.(`[prefrontal] Enrichment failed: ${e}`);
    }
  }

  function checkStaleness() {
    const stuck = topology.detectStaleness(stalenessThresholdMs);
    for (const key of stuck) {
      const node = topology.getNode(key);
      if (node) chatEmitter.onStuck(node);
    }
  }

  function rebuildAndBroadcastTree() {
    try {
      const runs = Array.from(subagentRuns.values());
      const tree = monitor.buildTree(runs, getPrefrontalSessionKey());
      if (tree.active) {
        log.info?.(
          `[prefrontal] Tree active: root=${tree.root?.model} children=${tree.root?.children?.length ?? 0}`,
        );
      }
      const now = Date.now();
      const stalled = monitor.detectStalls(tree, lastEventTimestamps, now);

      if (stalled.length > 0) {
        log.warn?.(`[prefrontal] Stalled agents detected: ${stalled.join(", ")}`);
      }

      // Broadcast tree update to Tinker UI via the "agent" event stream
      // (same stream used by lifecycle events — known to work with Tinker UI)
      try {
        (api as any).broadcast?.("agent", {
          stream: "lifecycle",
          data: {
            phase: "prefrontal-tree",
            tree,
            ts: now,
          },
        });
      } catch {
        // broadcast not available — non-fatal
      }
    } catch (e) {
      log.warn?.(`[prefrontal] Monitor rebuild failed: ${e}`);
    }
  }

  // Start timers after a short delay to let gateway finish booting
  setTimeout(() => {
    pollTimer = setInterval(enrichTopology, pollIntervalMs);
    stalenessTimer = setInterval(checkStaleness, stalenessThresholdMs / 6);
    monitorTimer = setInterval(rebuildAndBroadcastTree, monitorIntervalMs);
  }, 2000);

  // ─── Gateway Methods ───
  api.registerGatewayMethod("prefrontal.topology", async ({ respond }) => {
    enrichTopology(); // Freshen data before responding
    const snap = topology.snapshot();
    log.info?.(
      `[prefrontal] topology requested: ${snap.nodes.length} nodes, ${snap.edges.length} edges`,
    );
    respond(true, snap);
  });

  api.registerGatewayMethod("prefrontal.status", async ({ respond }) => {
    respond(true, {
      nodeCount: topology.size,
      changesSinceLastPoll: topology.changes,
      persistPath,
      pollIntervalMs,
      stalenessThresholdMs,
    });
  });

  api.registerGatewayMethod("prefrontal.tree", async ({ respond }) => {
    const tree = monitor.getTreeState();
    respond(true, tree);
  });

  api.registerGatewayMethod("prefrontal.config", async ({ respond }) => {
    respond(true, prefrontalConfig);
  });

  log.info?.(
    `[prefrontal] Prefrontal plugin registered (poll: ${pollIntervalMs}ms, staleness: ${stalenessThresholdMs}ms, monitor: ${monitorIntervalMs}ms)`,
  );
}
