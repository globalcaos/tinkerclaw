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
import os from "node:os";
import { join } from "node:path";
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
import { validateModelAssignment, DEFAULT_EFFORT_ROUTING_CONFIG } from "./effort-router.js";
import { createExplorationGate, DEFAULT_EXPLORATION_GATE_CONFIG } from "./exploration-gate.js";
import { createFaarTracker, classifyTask } from "./faar-tracker.js";
import { resolveFeatureFlags, isEnabled } from "./feature-flags.js";
import { getForcingQuestionsPrompt } from "./forcing-questions.js";
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

const PLUGIN_ID = "prefrontal";

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
    setTimeout(() => {
      monitor.setActiveMain(null);
      rebuildAndBroadcastTree();
    }, 10_000);

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
  const planRpcs = createPlanRpcs({ store: planStore });
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

  // ── Restart auto-continue (Phase 3, FORK 2026-05-13) ──
  // 3s delay gives the HTTP server and cc-bridge plugin time to finish binding
  // before we fire chat.send. Uses callGateway loopback (same pattern as
  // subagent-orphan-recovery / main-session-restart-recovery).
  // operator.admin scope is required because buildContinueParams injects
  // systemInputProvenance; the loopback backend client preserves declared scopes
  // (shouldSkipLocalBackendSelfPairing = true for direct-local GATEWAY_CLIENT).
  if (api.registrationMode === "full") {
    setTimeout(() => {
      void (async () => {
        try {
          const { runRestartContinue } = await import("./restart-continue.js");
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { callGateway } = await import("../../src/gateway/call.js");
          const gatewayCall = async (
            method: string,
            params: unknown,
          ): Promise<{ runId: string }> => {
            if (method !== "chat.send") {
              throw new Error(`[prefrontal] gatewayCall: unsupported method ${method}`);
            }
            return callGateway<{ runId: string }>({
              method: "chat.send",
              params,
              scopes: ["operator.admin"],
              timeoutMs: 30_000,
            });
          };
          const result = await runRestartContinue({ store: planStore, gatewayCall });
          if (result.fired.length > 0) {
            log.info?.(
              `[prefrontal] restart-continue fired for ${result.fired.length} plan(s): ${result.fired.join(", ")}`,
            );
          } else {
            log.info?.(`[prefrontal] restart-continue: no in-progress plans to resume`);
          }
        } catch (err) {
          log.warn?.(`[prefrontal] restart-continue failed: ${String(err)}`);
        }
      })();
    }, 3000);
  }

  log.info?.(
    `[prefrontal] Prefrontal plugin registered (poll: ${pollIntervalMs}ms, staleness: ${stalenessThresholdMs}ms, monitor: ${monitorIntervalMs}ms)`,
  );
}
