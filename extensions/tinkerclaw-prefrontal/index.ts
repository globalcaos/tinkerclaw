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
 * Wired in by: OpenClaw plugin system via `plugins.entries.tinkerclaw-prefrontal` in openclaw.json
 */
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
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
} from "./hook-types.js";

// Try to load session utils from fork source (available in tinkerclaw fork).
// Falls back gracefully on vanilla OpenClaw — topology enrichment is skipped.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
let _sessionStoreLoader: ((cfg: any) => any) | null = null;
let _sessionStoreChecked = false;

// oxlint-disable-next-line typescript-eslint/no-explicit-any
function getSessionStoreLoader(): ((cfg: any) => any) | null {
  if (_sessionStoreChecked) {
    return _sessionStoreLoader;
  }
  _sessionStoreChecked = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../src/gateway/session-utils.js");
    _sessionStoreLoader = mod.loadCombinedSessionStoreForGateway ?? null;
  } catch {
    _sessionStoreLoader = null;
  }
  return _sessionStoreLoader;
}
import {
  loadAntiGoldplatingPrompt,
  shouldInjectAntiGoldplating,
  DEFAULT_ANTI_GOLDPLATING_CONFIG,
} from "./anti-goldplating.js";
import { ChatEmitter } from "./chat-emitter.js";
import { DEFAULT_CORF_CONFIG } from "./corf-trigger.js";
import { createDenialTracker } from "./denial-tracking.js";
import {
  validateModelAssignment,
  DEFAULT_EFFORT_ROUTING_CONFIG,
  buildEffortGuidance,
} from "./effort-router.js";
import { createExplorationGate, DEFAULT_EXPLORATION_GATE_CONFIG } from "./exploration-gate.js";
import { createFaarTracker, classifyTask } from "./faar-tracker.js";
import { resolveFeatureFlags, isEnabled } from "./feature-flags.js";
import { getForcingQuestionsPrompt } from "./forcing-questions.js";
import { seedPlanFromPrompt } from "./kit-matcher.js";
import { createKitRpcs } from "./kit-rpcs.js";
import { resolveOwnKitsDir } from "./kit-runner.js";
import { KitStore } from "./kit-store.js";
import { createPermissionHooks } from "./permission-hooks.js";
import { saveState, loadState } from "./persistence.js";
import { createPlanRpcs } from "./plan-rpcs.js";
import { PlanStore } from "./plan-store.js";
import { createPrefrontalHttpHandler } from "./prefrontal-http.js";
import { createPrefrontalMonitor } from "./prefrontal-monitor.js";
import type { SubagentRunInfo } from "./prefrontal-monitor.js";
import { readRecoveryState, clearRecoveryState } from "./prefrontal-recovery.js";
import { DEFAULT_PREFRONTAL_CONFIG } from "./prefrontal-types.js";
import { TopologyStore } from "./topology.js";

const PLUGIN_ID = "tinkerclaw-prefrontal";

// Module-level singletons — shared across all register() calls.
// The gateway loads this plugin multiple times (gateway + per-agent),
// but hooks and gateway methods must operate on the SAME state.
let sharedMonitor: ReturnType<typeof createPrefrontalMonitor> | null = null;
let sharedFaarTracker: ReturnType<typeof createFaarTracker> | null = null;
const sharedSubagentRuns = new Map<string, SubagentRunInfo>();
const sharedLastEventTimestamps = new Map<string, number>();
let sharedPrefrontalSessionKey: string | null = null;

export default function register(api: OpenClawPluginApi) {
  // oxlint-disable-next-line typescript-eslint/no-explicit-any
  const config = api.config as Record<string, any>;
  // oxlint-disable-next-line typescript-eslint/no-explicit-any
  const pluginConfig = (config.plugins as any)?.entries?.[PLUGIN_ID]?.config ?? {};

  // ─── Config: merge plugin config with defaults ───
  const prefrontalConfig = {
    ...DEFAULT_PREFRONTAL_CONFIG,
    ...pluginConfig.prefrontal,
  };

  // ─── WS5: Feature Flags ───
  const featureFlags = resolveFeatureFlags(pluginConfig.featureFlags ?? {});

  // ─── P0: Exploration Gate ───
  const explorationGateConfig = {
    ...DEFAULT_EXPLORATION_GATE_CONFIG,
    ...pluginConfig.explorationGate,
  };
  explorationGateConfig.enabled = isEnabled(featureFlags, "explorationGate");
  const explorationGate = createExplorationGate(explorationGateConfig);

  // ─── P0: Anti-Gold-Plating ───
  const antiGoldplatingConfig = {
    ...DEFAULT_ANTI_GOLDPLATING_CONFIG,
    ...pluginConfig.antiGoldplating,
  };
  antiGoldplatingConfig.enabled = isEnabled(featureFlags, "antiGoldplating");

  // ─── WS3: Effort Routing ───
  const effortRoutingConfig = {
    ...DEFAULT_EFFORT_ROUTING_CONFIG,
    enabled: isEnabled(featureFlags, "effortRouting"),
    ...pluginConfig.effortRouting,
  };

  // ─── WS4: CORF Trigger ───
  const _corfConfig = {
    ...DEFAULT_CORF_CONFIG,
    enabled: isEnabled(featureFlags, "corfTrigger"),
    ...pluginConfig.corf,
  };

  // ─── WS6: FAAR Tracker ───
  if (!sharedFaarTracker) {
    sharedFaarTracker = createFaarTracker();
  }
  const faarTracker = sharedFaarTracker;

  // ─── P3: Forcing Questions ───
  const forcingQuestionsEnabled = pluginConfig.forcingQuestions?.enabled !== false;

  // ─── P3: Permission Hooks + Denial Tracking ───
  const hookDefs = pluginConfig.hooks?.before_tool ?? [];
  const permissionHooks = createPermissionHooks(hookDefs);
  const denialTracker = createDenialTracker({ limit: pluginConfig.hooks?.denialLimit ?? 3 });

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
      // oxlint-disable-next-line typescript-eslint/no-explicit-any
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
        // oxlint-disable-next-line typescript-eslint/no-explicit-any
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
      if (node) {
        chatEmitter.onSpawned(node);
      }
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
        // oxlint-disable-next-line typescript-eslint/no-explicit-any
        model: (event as any).model,
        createdAt: Date.now(),
        startedAt: Date.now(),
      };
      subagentRuns.set(event.runId, run);
      lastEventTimestamps.set(event.runId, Date.now());

      // WS3: Validate model assignment against task complexity
      if (isEnabled(featureFlags, "effortRouting") && event.label) {
        const routing = validateModelAssignment(
          // oxlint-disable-next-line typescript-eslint/no-explicit-any
          (event as any).model ?? "",
          event.label,
          effortRoutingConfig,
        );
        if (!routing.approved) {
          log.warn?.(`[prefrontal] Effort routing: ${routing.reason}`);
        }
      }

      // If the spawning session is main, mark it as prefrontal session
      if (!getPrefrontalSessionKey() && ctx.requesterSessionKey?.includes("main")) {
        setPrefrontalSessionKey(ctx.requesterSessionKey);
      }
      // FORK 2026-04-20: push tree to UI immediately so the new subagent row
      // shows up in the Prefrontal panel without waiting for the 120s
      // monitor tick. Subagent lifespans (170-260s) frequently overlap with
      // the interval window, so without this UIs rarely see live branches.
      rebuildAndBroadcastTree();
    },
  );

  api.on(
    "subagent_ended",
    (event: PluginHookSubagentEndedEvent, _ctx: PluginHookSubagentContext) => {
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
      // FORK 2026-04-20: flush the end-of-life state to the UI now; without
      // this the completed child keeps shimmering as "running" until the
      // slow monitor tick catches up.
      rebuildAndBroadcastTree();
    },
  );

  // ─── Main Session Tracking ───
  api.on("llm_input", (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => {
    // P0: Reset exploration gate for each new LLM turn
    explorationGate.resetTurn();
    log.info?.(
      `[prefrontal] HOOK llm_input sessionKey=${ctx.sessionKey} trigger=${ctx.trigger} provider=${event.provider} model=${event.model}`,
    );
    if (TopologyStore.isHeartbeat(ctx.sessionKey, ctx.trigger)) {
      return;
    }
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
    if (TopologyStore.isHeartbeat(ctx.sessionKey, ctx.trigger)) {
      return;
    }
    const sessionKey = ctx.sessionKey || "agent:main:main";
    topology.updateUsage(sessionKey, event.usage);
    topology.updatePhase(sessionKey, "responding");
    // Update monitor phase to "responding" — keep existing provider/model from llm_input
    const current = monitor.getTreeState();
    if (current.root) {
      monitor.setActiveMain({
        sessionKey,
        provider: current.root.provider,
        model: current.root.model,
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

  api.on(
    "before_tool_call",
    async (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
      log.info?.(
        `[prefrontal] HOOK before_tool_call sessionKey=${ctx.sessionKey} tool=${event.toolName}`,
      );

      // P0: Exploration gate — block mutating tools before read-only exploration
      if (isEnabled(featureFlags, "explorationGate")) {
        const gateResult = explorationGate.checkTool(event.toolName, {
          trigger: ctx.trigger,
          isSubagent: ctx.sessionKey?.includes(":subagent:"),
        });
        if (gateResult.blocked) {
          return { block: true, blockReason: gateResult.message };
        }
        // Record the tool call for gate tracking
        explorationGate.recordToolCall(event.toolName);
      }

      // P3: Permission hooks — user-defined shell scripts gate tool calls
      if (isEnabled(featureFlags, "permissionHooks") && hookDefs.length > 0) {
        const hookResult = await permissionHooks.check(event.toolName, {
          args: event.params,
          sessionKey: ctx.sessionKey,
        });
        if (hookResult.decision === "deny") {
          denialTracker.recordDenial(event.toolName);
          if (denialTracker.shouldEscalate(event.toolName)) {
            return { block: true, blockReason: denialTracker.getEscalationMessage(event.toolName) };
          }
          return { block: true, blockReason: hookResult.feedback ?? "Denied by permission hook" };
        }
        denialTracker.recordApproval(event.toolName);
      }

      const sessionKey = ctx.sessionKey || "agent:main:main";
      if (TopologyStore.isHeartbeat(sessionKey)) {
        return;
      }
      topology.addToolCall(sessionKey, event.toolName);

      // Update last event timestamp for any matching subagent
      for (const [runId, run] of subagentRuns) {
        if (run.childSessionKey === sessionKey) {
          lastEventTimestamps.set(runId, Date.now());
          break;
        }
      }
    },
  );

  // P0: Anti-gold-plating + P3: Forcing questions — inject discipline rules and
  // structured pre-task thinking prompts into every agent prompt
  api.on(
    "before_prompt_build",
    // oxlint-disable-next-line typescript-eslint/no-explicit-any
    async (_event: any, ctx: any) => {
      const parts: string[] = [];

      // P0: Anti-gold-plating rules
      if (
        isEnabled(featureFlags, "antiGoldplating") &&
        shouldInjectAntiGoldplating(antiGoldplatingConfig, ctx?.trigger)
      ) {
        parts.push(loadAntiGoldplatingPrompt());
      }

      // P3: Forcing questions for complex tasks
      if (
        isEnabled(featureFlags, "forcingQuestions") &&
        forcingQuestionsEnabled &&
        ctx?.trigger !== "heartbeat" &&
        ctx?.trigger !== "cron"
      ) {
        // We can't access the user message here, so inject forcing questions
        // unconditionally when enabled — the questions are lightweight guidance
        // and won't hurt simple tasks
        parts.push(getForcingQuestionsPrompt());
      }

      if (parts.length > 0) {
        return { prependSystemContext: parts.join("\n\n") };
      }
      return {};
    },
    { priority: 40 },
  );

  api.on("after_tool_call", (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
    log.info?.(
      `[prefrontal] HOOK after_tool_call sessionKey=${ctx.sessionKey} tool=${event.toolName}`,
    );
    const sessionKey = ctx.sessionKey || "agent:main:main";
    if (TopologyStore.isHeartbeat(sessionKey)) {
      return;
    }
    topology.finishToolCall(sessionKey);
  });

  api.on("agent_end", (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
    log.info?.(
      `[prefrontal] HOOK agent_end sessionKey=${ctx.sessionKey} trigger=${ctx.trigger} success=${event.success} duration=${event.durationMs}`,
    );
    if (TopologyStore.isHeartbeat(ctx.sessionKey, ctx.trigger)) {
      return;
    }
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
    // FORK 2026-05-30: clear the active-main marker BEFORE the UI's 6s ext-tree
    // cache (PREFRONTAL_EXT_TREE_TTL_MS) expires. The old 10s delay left a 4s
    // window where the UI fell back to a still-"active" tree built from a
    // completed run — the panel showed a frozen "thinking" while every other
    // indicator was idle (the "Prefrontal rethink" stuck bug).
    setTimeout(() => {
      monitor.setActiveMain(null);
      rebuildAndBroadcastTree();
    }, 4_000);

    // WS6: Track task outcome for FAAR metrics
    if (isEnabled(featureFlags, "faarTracking")) {
      const category = classifyTask(topology.getNode(sessionKey)?.label ?? "unknown");
      faarTracker.record({
        timestamp: Date.now(),
        sessionKey,
        category,
        firstAttemptSuccess: event.success,
        model: topology.getNode(sessionKey)?.model ?? "unknown",
        provider: topology.getNode(sessionKey)?.provider ?? "unknown",
        tokensUsed: event.usage?.totalTokens ?? 0,
        durationMs: event.durationMs ?? 0,
        retryCount: 0,
      });
    }
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
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    if (stalenessTimer) {
      clearInterval(stalenessTimer);
    }
    if (monitorTimer) {
      clearInterval(monitorTimer);
    }
  });

  // ─── Enrichment Poll ───
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stalenessTimer: ReturnType<typeof setInterval> | null = null;
  let monitorTimer: ReturnType<typeof setInterval> | null = null;

  function enrichTopology() {
    // Only enrich non-main nodes (main node gets data from hooks directly)
    if (topology.allNodes().filter((n) => !n.isMain).length === 0) {
      return;
    }
    const loader = getSessionStoreLoader();
    if (!loader) {
      return;
    }
    try {
      // oxlint-disable-next-line typescript-eslint/no-explicit-any
      const { store } = loader(config as any);
      // oxlint-disable-next-line typescript-eslint/no-explicit-any
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
      for (const [_runId, run] of subagentRuns) {
        if (!run.endedAt) {
          const session = sessions.find((s) => s.key === run.childSessionKey);
          if (session?.model) {
            run.model = session.model;
          }
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
      if (node) {
        chatEmitter.onStuck(node);
      }
    }
  }

  // FORK 2026-05-29: join topology vitals (tokens / toolCalls / phase /
  // currentToolArg) onto the tree the monitor builds — runToNode itself never
  // reads topology, so without this the per-subagent vitals never reach the UI.
  function enrichTreeWithTopology(tree: ReturnType<typeof monitor.buildTree>) {
    try {
      const snap = topology.snapshot();
      const byRun = new Map<string, (typeof snap.nodes)[number]>();
      for (const n of snap.nodes) if (n.runId) byRun.set(n.runId, n);
      const walk = (node: {
        runId: string;
        tokens?: number;
        toolCalls?: number;
        phase?: string;
        currentToolArg?: string;
        children: unknown[];
      }) => {
        const t = byRun.get(node.runId);
        if (t) {
          node.tokens = t.tokens;
          node.toolCalls = t.toolCalls;
          if (t.phase) node.phase = t.phase;
          if (t.currentToolArg) node.currentToolArg = t.currentToolArg;
        }
        for (const c of node.children) walk(c as Parameters<typeof walk>[0]);
      };
      if (tree.root) walk(tree.root as unknown as Parameters<typeof walk>[0]);
    } catch {
      // enrichment is best-effort — never break the broadcast
    }
  }

  function rebuildAndBroadcastTree() {
    try {
      const runs = Array.from(subagentRuns.values());
      const tree = monitor.buildTree(runs, getPrefrontalSessionKey());
      enrichTreeWithTopology(tree);
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
        // oxlint-disable-next-line typescript-eslint/no-explicit-any
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

  // Start timers after a short delay to let gateway finish booting.
  // Skip during build-time CLI metadata scans — timers keep the process alive forever.
  if (api.registrationMode === "full") {
    setTimeout(() => {
      pollTimer = setInterval(enrichTopology, pollIntervalMs);
      stalenessTimer = setInterval(checkStaleness, stalenessThresholdMs / 6);
      monitorTimer = setInterval(rebuildAndBroadcastTree, monitorIntervalMs);
    }, 2000);
  }

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

  api.registerGatewayMethod("prefrontal.metrics", async ({ respond }) => {
    respond(true, faarTracker.getMetrics());
  });

  api.registerGatewayMethod("prefrontal.flags", async ({ respond }) => {
    respond(true, featureFlags);
  });

  // ── Kit dir constants (used by both plan-rpcs and kit-rpcs) ──
  const kitInstallSandbox = join(os.homedir(), ".openclaw", "workspace", "kits");
  // Resolve ownKitsDir relative to this file's location so it works regardless of
  // the gateway's working directory AND of the bundle depth (source lives at
  // extensions/tinkerclaw-prefrontal/, the bundle at dist/ root — different `..`
  // counts). resolveOwnKitsDir walks up to the first existing kits dir.
  const ownKitsDir = resolveOwnKitsDir(dirname(fileURLToPath(import.meta.url)));

  // ── Plan store + RPCs (FORK 2026-05-13) ──
  const planRootDir = join(os.homedir(), ".openclaw", "workspace", "state", "prefrontal", "plans");
  const planStore = new PlanStore({
    rootDir: planRootDir,
    onMutation: (sessionKey, plan) => {
      try {
        (api as any).broadcast?.("prefrontal-plan-state", { sessionKey, plan });
      } catch (err) {
        log.warn?.(`[prefrontal] broadcast prefrontal-plan-state failed: ${String(err)}`);
      }
    },
  });
  const planRpcs = createPlanRpcs({ store: planStore, ownKitsDir, kitInstallSandbox });
  for (const [name, handler] of Object.entries(planRpcs)) {
    api.registerGatewayMethod(name, async ({ respond, params }) => {
      try {
        const result = await handler(params);
        respond(true, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        respond(false, undefined, { code: "INVALID_REQUEST", message });
      }
    });
  }
  log.info?.(`[prefrontal] plan RPCs registered at planRootDir=${planRootDir}`);

  // ── Kit-matcher: auto-seed a plan at turn start (FORK 2026-05-16) ──
  // The "smart router" matching half. Fires on every real user turn to the
  // main session, scores the prompt against the local kit catalog, and
  // (when matched) seeds a merged plan so the prefrontal panel shows real
  // steps and an interrupted turn can re-read it on resume. No match → WARN recipe-gap signal
  // + the implicit 2-step panel takes over. Registered as a second
  // before_prompt_build hook (separate concern from the anti-goldplating
  // one at priority 40) — runs at lower priority so prompt-context plugins
  // settle first; it mutates plan-store, not the prompt.
  api.on(
    "before_prompt_build",
    // oxlint-disable-next-line typescript-eslint/no-explicit-any
    async (event: any, ctx: any) => {
      const parts: string[] = [];
      try {
        const sessionKey: string = ctx?.sessionKey ?? "";
        const trigger: string = ctx?.trigger ?? "";
        // Only the user's primary chat turn. Skip subagents, heartbeats,
        // cron, and any non-main session — those must not seed the main
        // plan (and kit-runner's own subagents would recurse).
        if (
          !sessionKey ||
          sessionKey.includes(":subagent:") ||
          !sessionKey.endsWith(":main") ||
          trigger === "heartbeat" ||
          trigger === "cron"
        ) {
          return {};
        }
        const prompt: string = typeof event?.prompt === "string" ? event.prompt : "";
        if (!prompt.trim()) return {};

        // Provenance trail emitter → the RECIPES panel sees searched/matched/
        // merged/composed/authored as the recipe lifecycle unfolds. Same shape
        // as fork.prefrontal.trailEvent's broadcast (UI maps unknown kinds → note).
        const emitTrail = (kind: string, message: string, label?: string) => {
          try {
            // oxlint-disable-next-line typescript-eslint/no-explicit-any
            (api as any).broadcast?.("agent", {
              stream: "lifecycle",
              data: {
                phase: "prefrontal-trail-event",
                kind,
                message,
                label,
                ts: Date.now(),
                sessionKey,
              },
              sessionKey,
            });
          } catch {}
        };

        // 1) Dynamic effort adaptation — scale reasoning/orchestration to the task.
        const effortGuidance = buildEffortGuidance(prompt);
        if (effortGuidance) parts.push(effortGuidance);

        // 2) Recipe matching + provenance.
        const outcome = await seedPlanFromPrompt({
          prompt,
          sessionKey,
          runId: ctx?.runId ?? "",
          ownKitsDir,
          planStore,
          log,
        });

        if (outcome.catalogSize > 0) {
          emitTrail("searched", `scored ${outcome.catalogSize} recipes`, "match");
        }
        if (outcome.seeded) {
          const kits = outcome.kitRefs ?? [];
          if (kits.length > 1 || (outcome.composedFrom?.length ?? 0) > 0) {
            emitTrail("merged", `${outcome.intent} — ${outcome.stepCount} steps`, kits.join("+"));
          } else {
            emitTrail("matched", `${outcome.intent} (conf ${outcome.confidence})`, kits[0]);
          }
          if ((outcome.composedFrom?.length ?? 0) > 0) {
            emitTrail("composed", `pulled in ${outcome.composedFrom!.join(", ")}`, "composes");
          }
          parts.push(
            `<active_recipe kits="${kits.join(",")}" steps="${outcome.stepCount}">A plan was auto-seeded from the matched recipe(s). Follow its steps and keep the RECIPES panel honest via the recipe-state CLI: one \`--recipe <id> --step N\` call per transition, and \`--trail dispatch\`/\`--trail complete\` around each subagent.</active_recipe>`,
          );
          // FORK 2026-05-31: auto-engage the Overseer on a HIGH-confidence overseer
          // match so the supervisory loop starts deterministically (the recipe also
          // instructs Jarvis to activate — this just guarantees it). Fire-and-forget,
          // gated on HIGH confidence so it never fires on simple tasks.
          if (
            outcome.confidence === "high" &&
            kits.some((k) => k === "overseer" || k.endsWith("/overseer"))
          ) {
            void (async () => {
              try {
                const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
                await callGatewayFromCli(
                  "fork.overseer.activate",
                  { timeout: "8000" },
                  { sessionKey, task: prompt },
                  { progress: false },
                );
                emitTrail("note", "Overseer engaged (high-confidence match)", "overseer");
              } catch (err) {
                log.warn?.(`[overseer] auto-activate failed: ${String(err)}`);
              }
            })();
          }
        } else if (outcome.noMatch) {
          emitTrail(
            "warn",
            `no recipe fit (catalog ${outcome.catalogSize}) — authoring offered`,
            "gap",
          );
          // Auto on-the-fly authoring directive — only for non-trivial work.
          // effortGuidance is non-null iff classifyComplexity != "trivial", so
          // reuse it instead of re-classifying (review finding 2026-05-29).
          if (effortGuidance !== null) {
            parts.push(
              `<recipe_gap>No existing recipe matched (catalog=${outcome.catalogSize}). If this is repeatable work, COMPOSE one now: call \`prefrontal.kit.author\` with {slug,title,summary,tags,category,steps:[{title,tools,doneWhen,body}],parallelismGroups}. It becomes matchable next turn. To build a recipe FROM other recipes, add a \`uses: <slug>\` line to a step (runtime sub-kit) or a frontmatter \`composes: [slug,...]\` list (merged steps).</recipe_gap>`,
            );
          }
        }
      } catch (err) {
        log.warn?.(`[kit-matcher] before_prompt_build failed: ${String(err)}`);
      }
      if (parts.length > 0) return { prependSystemContext: parts.join("\n\n") };
      return {};
    },
    { priority: 20 },
  );

  // ── Kit store + RPCs (FORK 2026-05-13, Phase 6) ──
  const kitStore = new KitStore({ rootDir: kitInstallSandbox });
  // oxlint-disable-next-line typescript-eslint/no-explicit-any
  const journeyCfg = (config as any)?.integrations?.journey ?? {};
  const kitRpcs = createKitRpcs({
    store: kitStore,
    baseUrl:
      typeof journeyCfg.baseUrl === "string" && journeyCfg.baseUrl.length > 0
        ? journeyCfg.baseUrl
        : "https://www.journeykits.ai",
    apiKey:
      typeof journeyCfg.apiKey === "string" && journeyCfg.apiKey.length > 0
        ? journeyCfg.apiKey
        : null,
    kitInstallSandbox,
    ownKitsDir,
    // FORK 2026-05-14: pass the plan store so prefrontal.kit.run can seed/update plan rows
    planStore,
  });
  for (const [name, handler] of Object.entries(kitRpcs)) {
    const wrapped = async ({
      respond,
      params,
    }: {
      respond: (ok: boolean, result?: unknown, err?: unknown) => void;
      params: unknown;
    }) => {
      try {
        const result = await handler(params);
        respond(true, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        respond(false, undefined, { code: "INVALID_REQUEST", message });
      }
    };
    // FORK 2026-05-30: "recipe" is the canonical term. Register under
    // prefrontal.recipe.* (primary) AND keep prefrontal.kit.* as a deprecated
    // back-compat alias so any in-flight client/CLI keeps working through the
    // rename. (The kit/1.0 wire format itself stays — it's the external Journey
    // standard.)
    // oxlint-disable-next-line typescript-eslint/no-explicit-any
    api.registerGatewayMethod(name, wrapped as any);
    const alias = name.replace(".recipe.", ".kit.");
    if (alias !== name) {
      // oxlint-disable-next-line typescript-eslint/no-explicit-any
      api.registerGatewayMethod(alias, wrapped as any);
    }
  }
  log.info?.(
    `[prefrontal] kit RPCs registered (baseUrl=${typeof journeyCfg.baseUrl === "string" ? journeyCfg.baseUrl : "default"}, apiKey=${journeyCfg.apiKey ? "set" : "absent"})`,
  );

  // ── Restart resume: single source of truth (FORK 2026-05-30) ──
  // The plan-based `restart-continue` auto-fire was REMOVED. It resumed any
  // in_progress plan on boot regardless of whether a turn was actually
  // interrupted, so a parked/incomplete plan triggered a phantom resume on
  // every restart (and could double-resume alongside the interruption path).
  // Restart recovery now has ONE trigger, owned by
  // `src/agents/main-session-restart-recovery.ts`: a session that was
  // `status:"running"` at boot is — by definition — interrupted mid-turn, and
  // only those are resumed. The plan is still seeded for the Prefrontal panel
  // and for the resumed model to read via `prefrontal.plan.get`; it is no
  // longer itself a resume trigger.

  log.info?.(
    `[prefrontal] Prefrontal plugin registered (poll: ${pollIntervalMs}ms, staleness: ${stalenessThresholdMs}ms, monitor: ${monitorIntervalMs}ms)`,
  );
}
