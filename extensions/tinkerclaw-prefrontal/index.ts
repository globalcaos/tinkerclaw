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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped plugin API boundary
let _sessionStoreLoader: ((cfg: any) => any) | null = null;
let _sessionStoreChecked = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped plugin API boundary
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
import { type ActiveRecipeState } from "./orchestrator.js";
import { createPermissionHooks } from "./permission-hooks.js";
import { saveState, loadState } from "./persistence.js";
import { createPrefrontalHttpHandler } from "./prefrontal-http.js";
import { createPrefrontalMonitor } from "./prefrontal-monitor.js";
import type { SubagentRunInfo } from "./prefrontal-monitor.js";
import { loadPrefrontalPromptWithAddendum } from "./prefrontal-prompt-loader.js";
import { readRecoveryState, clearRecoveryState } from "./prefrontal-recovery.js";
import { DEFAULT_PREFRONTAL_CONFIG } from "./prefrontal-types.js";
import { formatProgressEvent, type ProgressReport } from "./progress-reporter.js";
import { formatRecipePrompt, BUILT_IN_RECIPES, isToolAllowedByCurrentStep, detectRecipeActivation } from "./recipe-engine.js";
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

// ─── Recipe Engine State (v3.0) ───
// Keyed by sessionKey. Persists across turns within a session but NOT across sessions.
const activeRecipes = new Map<string, ActiveRecipeState>();
const recipeStartTimes = new Map<string, number>();

export default function register(api: OpenClawPluginApi) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped plugin config
  const config = api.config as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped plugin config
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped HTTP handler from plugin SDK
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- broadcast not in plugin SDK types
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- model not in hook event type
        model: (event as any).model,
        createdAt: Date.now(),
        startedAt: Date.now(),
      };
      subagentRuns.set(event.runId, run);
      lastEventTimestamps.set(event.runId, Date.now());

      // WS3: Validate model assignment against task complexity
      if (isEnabled(featureFlags, "effortRouting") && event.label) {
        const routing = validateModelAssignment(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- model not in hook event type
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

    // v3.0: Demand-driven recipe activation — detect when model mentions a recipe
    if (isEnabled(featureFlags, "recipeEngine")) {
      const outputText =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event shape varies
        (event as any).text ?? (event as any).content ?? "";
      if (typeof outputText === "string" && outputText.length > 0) {
        const existingRecipe = activeRecipes.get(sessionKey);
        if (!existingRecipe) {
          const activatedId = detectRecipeActivation(outputText);
          if (activatedId) {
            activeRecipes.set(sessionKey, {
              recipeId: activatedId,
              completedSteps: [],
            });
            recipeStartTimes.set(sessionKey, Date.now());
            log.info?.(
              `[prefrontal] Demand-driven recipe activated: ${activatedId} (session=${sessionKey})`,
            );
          }
        }
      }
    }

    // v3.0: Recipe step completion detection + progress broadcast
    if (isEnabled(featureFlags, "recipeEngine")) {
      const recipeState = activeRecipes.get(sessionKey);
      if (recipeState) {
        const recipe = BUILT_IN_RECIPES.find((r) => r.id === recipeState.recipeId);
        if (recipe) {
          const currentStep = recipe.steps.find((s) => !recipeState.completedSteps.includes(s.id));
          // Heuristic: if the LLM output contains the success criteria text,
          // mark the step as completed and advance
          if (currentStep?.successCriteria) {
            const outputText =
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event shape varies
              (event as any).text ?? (event as any).content ?? "";
            if (
              typeof outputText === "string" &&
              outputText.toLowerCase().includes(currentStep.successCriteria.toLowerCase())
            ) {
              recipeState.completedSteps.push(currentStep.id);
              log.info?.(
                `[prefrontal] Recipe step completed: ${currentStep.name} (${recipeState.completedSteps.length}/${recipe.steps.length})`,
              );
            }
          }

          // Broadcast progress event
          const startTime = recipeStartTimes.get(sessionKey) ?? Date.now();
          const report: ProgressReport = {
            recipeId: recipe.id,
            recipeName: recipe.name,
            currentStep: currentStep?.id ?? recipeState.completedSteps.at(-1) ?? "",
            completedSteps: [...recipeState.completedSteps],
            totalSteps: recipe.steps.length,
            activeWorkers: subagentRuns.size,
            stalledWorkers: 0,
            elapsedMs: Date.now() - startTime,
          };
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- broadcast not in plugin SDK types
            (api as any).broadcast?.("agent", {
              stream: "lifecycle",
              data: {
                ...formatProgressEvent(report),
                ts: Date.now(),
              },
            });
          } catch {
            // broadcast not available — non-fatal
          }
        }
      }
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
      // Bypass: if a recipe is active and the current step explicitly allows this tool,
      // skip the gate (earlier recipe steps already did exploration).
      if (isEnabled(featureFlags, "explorationGate")) {
        let bypassGate = false;
        if (isEnabled(featureFlags, "recipeEngine")) {
          const sessionKey = ctx.sessionKey || "agent:main:main";
          const recipeState = activeRecipes.get(sessionKey);
          if (recipeState) {
            const recipe = BUILT_IN_RECIPES.find((r) => r.id === recipeState.recipeId);
            if (recipe) {
              const currentStep = recipe.steps.find(
                (s) => !recipeState.completedSteps.includes(s.id),
              );
              if (currentStep && isToolAllowedByCurrentStep(recipe, currentStep.id, event.toolName)) {
                bypassGate = true;
              }
            }
          }
        }

        if (!bypassGate) {
          const gateResult = explorationGate.checkTool(event.toolName, {
            trigger: ctx.trigger,
            isSubagent: ctx.sessionKey?.includes(":subagent:"),
          });
          if (gateResult.blocked) {
            return { block: true, blockReason: gateResult.message };
          }
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

      // v3.0: Recipe step awareness — gentle reminder if agent is using tools
      // that don't match the current step (don't block, just guide)
      if (isEnabled(featureFlags, "recipeEngine")) {
        const recipeState = activeRecipes.get(sessionKey);
        if (recipeState) {
          const recipe = BUILT_IN_RECIPES.find((r) => r.id === recipeState.recipeId);
          if (recipe) {
            const currentStep = recipe.steps.find(
              (s) => !recipeState.completedSteps.includes(s.id),
            );
            if (currentStep?.requiredTools && currentStep.requiredTools.length > 0) {
              const toolAllowed = currentStep.requiredTools.includes(event.toolName);
              if (!toolAllowed) {
                log.info?.(
                  `[prefrontal] Recipe hint: tool ${event.toolName} not in step "${currentStep.name}" tools [${currentStep.requiredTools.join(",")}] — proceeding anyway`,
                );
              }
            }
          }
        }
      }

      // Update last event timestamp for any matching subagent
      for (const [runId, run] of subagentRuns) {
        if (run.childSessionKey === sessionKey) {
          lastEventTimestamps.set(runId, Date.now());
          break;
        }
      }
    },
  );

  // P0: Anti-gold-plating + P3: Forcing questions + v3.0: Recipe engine —
  // inject discipline rules, thinking prompts, and recipe workflows
  api.on(
    "before_prompt_build",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped hook event/ctx
    async (event: any, ctx: any) => {
      const parts: string[] = [];

      // v3.0: Prefrontal system prompt (Iron Laws, debugging protocol, orchestration)
      // Includes recipe system description + planning instruction for demand-driven activation
      if (
        isEnabled(featureFlags, "recipeEngine") &&
        ctx?.trigger !== "heartbeat" &&
        ctx?.trigger !== "cron"
      ) {
        const prefrontalPrompt = loadPrefrontalPromptWithAddendum();
        if (prefrontalPrompt) {
          parts.push(prefrontalPrompt);
        }
      }

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
        parts.push(getForcingQuestionsPrompt());
      }

      // v3.0: Recipe engine — inject active recipe steps (demand-driven, NOT auto-selected)
      // Recipes are activated by the model mentioning them in its output (llm_output hook).
      // Here we only inject the recipe prompt for ALREADY-ACTIVE recipes.
      if (
        isEnabled(featureFlags, "recipeEngine") &&
        ctx?.trigger !== "heartbeat" &&
        ctx?.trigger !== "cron"
      ) {
        const sessionKey = ctx?.sessionKey ?? "agent:main:main";
        const existingRecipe = activeRecipes.get(sessionKey) ?? null;

        if (existingRecipe) {
          const recipe = BUILT_IN_RECIPES.find((r) => r.id === existingRecipe.recipeId);
          if (recipe) {
            // Find next incomplete step
            const nextStep = recipe.steps.find(
              (s) => !existingRecipe.completedSteps.includes(s.id),
            );
            parts.push(formatRecipePrompt(recipe, nextStep?.id ?? undefined));
            log.info?.(
              `[prefrontal] Recipe prompt injected: ${recipe.name} step=${nextStep?.id ?? "done"} (session=${sessionKey})`,
            );

            // Emit recipe status event to Tinker UI
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- broadcast not in plugin SDK types
              (api as any).broadcast?.("agent", {
                stream: "lifecycle",
                data: {
                  phase: "prefrontal-recipe-status",
                  recipeId: existingRecipe.recipeId,
                  recipeName: recipe.name,
                  currentStep: nextStep?.id ?? "done",
                  currentStepName: nextStep?.name ?? "complete",
                  completedSteps: [...existingRecipe.completedSteps],
                  totalSteps: recipe.steps.length,
                  category: (recipe as any).category ?? "coding",
                  startedAt: recipeStartTimes.get(sessionKey) ?? Date.now(),
                  ts: Date.now(),
                },
              });
            } catch {
              // broadcast not available — non-fatal
            }
          }
        }
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

    // v3.0: Recipe completion — emit final progress event and record FAAR metric
    if (isEnabled(featureFlags, "recipeEngine")) {
      const recipeState = activeRecipes.get(sessionKey);
      if (recipeState) {
        const recipe = BUILT_IN_RECIPES.find((r) => r.id === recipeState.recipeId);
        if (recipe) {
          const startTime = recipeStartTimes.get(sessionKey) ?? Date.now();
          const allComplete = recipeState.completedSteps.length >= recipe.steps.length;
          const report: ProgressReport = {
            recipeId: recipe.id,
            recipeName: recipe.name,
            currentStep: allComplete
              ? (recipe.steps.at(-1)?.id ?? "")
              : (recipe.steps.find((s) => !recipeState.completedSteps.includes(s.id))?.id ?? ""),
            completedSteps: [...recipeState.completedSteps],
            totalSteps: recipe.steps.length,
            activeWorkers: 0,
            stalledWorkers: 0,
            elapsedMs: Date.now() - startTime,
          };
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- broadcast not in plugin SDK types
            (api as any).broadcast?.("agent", {
              stream: "lifecycle",
              data: {
                ...formatProgressEvent(report),
                ts: Date.now(),
              },
            });
          } catch {
            // broadcast not available — non-fatal
          }
          log.info?.(
            `[prefrontal] Recipe ${allComplete ? "completed" : "ended"}: ${recipe.name} (${recipeState.completedSteps.length}/${recipe.steps.length} steps)`,
          );
        }
        // Clean up recipe state
        activeRecipes.delete(sessionKey);
        recipeStartTimes.delete(sessionKey);
      }
    }

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped session store loader
      const { store } = loader(config as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped session store entry
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- broadcast not in plugin SDK types
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

  log.info?.(
    `[prefrontal] Prefrontal plugin registered (poll: ${pollIntervalMs}ms, staleness: ${stalenessThresholdMs}ms, monitor: ${monitorIntervalMs}ms)`,
  );
}
