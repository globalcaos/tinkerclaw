/**
 * FORK: overseer/index — Plugin entry point for the Overseer real-time agent topology tracker
 *
 * Registers the Overseer plugin with the OpenClaw plugin API, wiring up hooks
 * for subagent spawn/end, LLM input/output, tool calls, and agent completion to
 * build a live topology graph of all running agents and the main session.
 * Enriches subagent nodes by polling the gateway session store on a timer, detects
 * stale/stuck agents, and broadcasts markdown status updates to the Tinker UI via
 * `agent` lifecycle events through the ChatEmitter. Persists topology state across
 * gateway restarts. Exposes `overseer.topology` and `overseer.status` gateway
 * methods for external queries. Heartbeat sessions are filtered out at every hook.
 *
 * Wired in by: OpenClaw plugin system via `plugins.entries.overseer` in openclaw.json
 */
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
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
import { TopologyStore } from "./topology.js";

const PLUGIN_ID = "overseer";

export default function register(api: OpenClawPluginApi) {
  const config = api.config as Record<string, any>;
  const pluginConfig = (config.plugins as any)?.entries?.[PLUGIN_ID]?.config ?? {};

  const pollIntervalMs = pluginConfig.pollIntervalMs ?? 5000;
  const stalenessThresholdMs = pluginConfig.stalenessThresholdMs ?? 60000;
  const chatMinMs = pluginConfig.chatMinIntervalMs ?? 30000;
  const chatMaxMs = pluginConfig.chatMaxIntervalMs ?? 180000;

  const homeDir = process.env.HOME || "/home/<user>";
  const persistPath = pluginConfig.persistPath
    ? String(pluginConfig.persistPath).replace("~", homeDir)
    : join(homeDir, ".openclaw", "overseer-state.json");

  const log = api.logger ?? { info: console.log, warn: console.warn, error: console.error };
  const topology = new TopologyStore();

  // ─── Chat Emitter ───
  const chatEmitter = new ChatEmitter({
    minIntervalMs: chatMinMs,
    maxIntervalMs: chatMaxMs,
    emitFn: (markdown: string) => {
      // Broadcast overseer update as agent event so Tinker UI can display it
      try {
        (api as any).broadcast?.("agent", {
          stream: "lifecycle",
          data: {
            phase: "overseer-update",
            markdown,
            ts: Date.now(),
          },
        });
      } catch {
        log.warn?.("[overseer] Failed to broadcast chat update");
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
        `[overseer] Agent spawned: ${event.label || event.agentId} (${event.childSessionKey})`,
      );
    },
  );

  api.on(
    "subagent_ended",
    (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => {
      const removed = topology.removeNode(event);
      if (removed) {
        chatEmitter.onEnded(removed, event.outcome);
        log.info?.(`[overseer] Agent ended: ${removed.label} (${event.outcome || "ok"})`);
      }
    },
  );

  // ─── Main Session Tracking ───
  api.on("llm_input", (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => {
    log.info?.(
      `[overseer] HOOK llm_input sessionKey=${ctx.sessionKey} trigger=${ctx.trigger} provider=${event.provider} model=${event.model}`,
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
    log.info?.(
      `[overseer] Main activated: ${sessionKey} (${event.provider}/${event.model}) topo.size=${topology.size}`,
    );
  });

  api.on("llm_output", (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => {
    log.info?.(`[overseer] HOOK llm_output sessionKey=${ctx.sessionKey} trigger=${ctx.trigger}`);
    if (TopologyStore.isHeartbeat(ctx.sessionKey, ctx.trigger)) return;
    const sessionKey = ctx.sessionKey || "agent:main:main";
    topology.updateUsage(sessionKey, event.usage);
    topology.updatePhase(sessionKey, "responding");
  });

  api.on("before_tool_call", (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
    log.info?.(
      `[overseer] HOOK before_tool_call sessionKey=${ctx.sessionKey} tool=${event.toolName}`,
    );
    const sessionKey = ctx.sessionKey || "agent:main:main";
    if (TopologyStore.isHeartbeat(sessionKey)) return;
    topology.addToolCall(sessionKey, event.toolName);
  });

  api.on("after_tool_call", (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
    log.info?.(
      `[overseer] HOOK after_tool_call sessionKey=${ctx.sessionKey} tool=${event.toolName}`,
    );
    const sessionKey = ctx.sessionKey || "agent:main:main";
    if (TopologyStore.isHeartbeat(sessionKey)) return;
    topology.finishToolCall(sessionKey);
  });

  api.on("agent_end", (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
    log.info?.(
      `[overseer] HOOK agent_end sessionKey=${ctx.sessionKey} trigger=${ctx.trigger} success=${event.success} duration=${event.durationMs}`,
    );
    if (TopologyStore.isHeartbeat(ctx.sessionKey, ctx.trigger)) return;
    const sessionKey = ctx.sessionKey || "agent:main:main";
    topology.endSession(sessionKey, event.success, event.durationMs);
  });

  api.on("gateway_start", (_event: PluginHookGatewayStartEvent, _ctx: PluginHookGatewayContext) => {
    const snap = loadState(persistPath);
    if (snap && snap.nodes.length > 0) {
      topology.restore(snap);
      log.info?.(`[overseer] Restored ${snap.nodes.length} nodes from ${persistPath}`);
    }
  });

  api.on("gateway_stop", (_event: PluginHookGatewayStopEvent, _ctx: PluginHookGatewayContext) => {
    const snap = topology.snapshot();
    if (snap.nodes.length > 0) {
      saveState(persistPath, snap);
      log.info?.(`[overseer] Persisted ${snap.nodes.length} nodes to ${persistPath}`);
    }
    chatEmitter.destroy();
    if (pollTimer) clearInterval(pollTimer);
    if (stalenessTimer) clearInterval(stalenessTimer);
  });

  // ─── Enrichment Poll ───
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stalenessTimer: ReturnType<typeof setInterval> | null = null;

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
    } catch (e) {
      log.warn?.(`[overseer] Enrichment failed: ${e}`);
    }
  }

  function checkStaleness() {
    const stuck = topology.detectStaleness(stalenessThresholdMs);
    for (const key of stuck) {
      const node = topology.getNode(key);
      if (node) chatEmitter.onStuck(node);
    }
  }

  // Start timers after a short delay to let gateway finish booting
  setTimeout(() => {
    pollTimer = setInterval(enrichTopology, pollIntervalMs);
    stalenessTimer = setInterval(checkStaleness, stalenessThresholdMs / 6);
  }, 2000);

  // ─── Gateway Methods ───
  api.registerGatewayMethod("overseer.topology", async ({ respond }) => {
    enrichTopology(); // Freshen data before responding
    const snap = topology.snapshot();
    log.info?.(
      `[overseer] topology requested: ${snap.nodes.length} nodes, ${snap.edges.length} edges`,
    );
    respond(true, snap);
  });

  api.registerGatewayMethod("overseer.status", async ({ respond }) => {
    respond(true, {
      nodeCount: topology.size,
      changesSinceLastPoll: topology.changes,
      persistPath,
      pollIntervalMs,
      stalenessThresholdMs,
    });
  });

  log.info?.(
    `[overseer] Overseer plugin registered (poll: ${pollIntervalMs}ms, staleness: ${stalenessThresholdMs}ms)`,
  );
}
