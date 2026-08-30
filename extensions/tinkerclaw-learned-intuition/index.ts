/**
 * FORK: Learned Intuition extension entry point -- AMYGDALA safety gate.
 *
 * Neural safety gate trained on real failures. 10 ONNX networks evaluate
 * every tool call through the before_tool_call hook. Falls back to rule-based
 * heuristics when ONNX models are unavailable. Generates personality nudges
 * on llm_output for Identity Persistence to read.
 *
 * Hooks:
 *   - before_tool_call: evaluate action safety (ONNX gate or rule-based fallback)
 *   - llm_output: write personality nudge to shared cognitive file
 *
 * Cross-extension discovery: writes `~/.openclaw/cognitive/learned-intuition.json`
 * and `~/.openclaw/cognitive/personality-nudge.json`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// FORK 2026-08-04 (FOUNDATION #9 — bounded, replicable) — the observability substrate is reached
// through DECLARED plugin-SDK surfaces, never through a relative `../../src/infra/*` path. Two
// independent reasons, either fatal on its own:
//   1. this extension is `publishToNpm: true` and its `files:` list ships only its own directory,
//      so a `../../src/**` specifier cannot resolve in the published tarball at all;
//   2. it sets `openclaw.bundle.stageRuntimeDependencies: true`, so it gets its OWN rolldown graph
//      (tsdown.config.ts:288-341), in which a relative src import INLINES A SECOND COPY of the
//      module. Measured: dist/extensions/tinkerclaw-learned-intuition/index.js was ~194 KB with
//      `emitAgentEvent`/`declareInstrument` duplicated and no edge back to core's copy.
//      `openclaw/plugin-sdk/*` is externalised by isPluginSdkSelfReference(), so exactly one copy
//      stays in the shared graph.
// Be precise about what the duplication did NOT do: it did not fork the liveness registry or the
// event bus. Both resolve their state through `resolveGlobalSingleton` specifically so bundle
// splits converge on one globalThis slot (src/infra/instrument-liveness.ts:96-114,
// src/infra/agent-events.ts:130), and algorithm-metrics is stateless. Deduplicating here is about
// publishability and weight, not about repairing broken state — the false reason would be read as
// an invariant by the next person, and it is the opposite of the real one.
import { onAgentEvent, emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  recordAlgorithmOutcome,
  declareInstrument,
  noteInstrumentFired,
} from "openclaw/plugin-sdk/fork-instrumentation";
import { decodePersonalityNudge } from "./src/personality-decoder.js";
import { generateTargetVector, DEFAULT_TARGET_DIMENSIONS } from "./src/personality-seed.js";
import { writePolicySnapshot, policyPaths } from "./src/policy-snapshot.js";
import { evaluateAegisEnforced } from "./src/rule-based-gate.js";
import { AmygdalaHook, type AegisChecker } from "./src/runtime-hook.js";
import type { AmygdalaConfig, PersonalityNudge } from "./src/types.js";

// -- Constants --

const COGNITIVE_DIR = join(homedir(), ".openclaw", "cognitive");
const LEARNED_INTUITION_STATE_PATH = join(COGNITIVE_DIR, "learned-intuition.json");
const PERSONALITY_NUDGE_PATH = join(COGNITIVE_DIR, "personality-nudge.json");
const DATA_DIR = join(homedir(), ".openclaw", "data");
const AMYGDALA_DATA_DIR = join(DATA_DIR, "amygdala");
const AMYGDALA_DECISIONS_PATH = join(DATA_DIR, "amygdala-decisions.jsonl");
// v3.1: the pre-execution PreToolUse hook spools its decisions here; the gateway
// ingests them so REAL enforced denials (the strongest feedback signal) appear
// in the feed instead of being invisible.
const HOOK_DECISIONS_PATH = join(AMYGDALA_DATA_DIR, "hook-decisions.jsonl");
// FORK 2026-06-07: register() runs ~5×/gateway boot; attach the tinker-bridge prudence
// listener ONCE per process or every tool call gets evaluated (and recorded) N times.
let tinkerBridgePrudenceListenerAttached = false;

// FORK 2026-07-28 (instrument-liveness) — the WRITE half of the AMYGDALA personality thermostat.
// Its pair is `amygdala:nudge-injection` in src/agents/system-prompt.ts, and the PAIR is the whole
// point: a nudge that is written but never injected is exactly the inert-component failure the
// liveness registry exists to catch, and NEITHER instrument alone can separate "the thermostat had
// nothing to say" from "it spoke and the prompt discarded it".
//
// Declared at module scope rather than inside register() for two reasons: register() runs
// ~5x/gateway boot (see the note above), and merely LOADING this extension is what should make its
// silence visible — registration is the static property, firing is the dynamic one, and only the
// second is worth anything.
//
// Tolerance is 6h rather than the 30-minute default: the writer only fires when the decoder finds a
// dimension drifted past DRIFT_THRESHOLD, so a quiet stretch is legitimate, not a defect.
const NUDGE_WRITE_INSTRUMENT = {
  id: "amygdala:nudge-write",
  kind: "producer" as const,
  description: "AMYGDALA thermostat writing a personality nudge",
  expectFireWithinMs: 6 * 60 * 60 * 1000,
};
declareInstrument(NUDGE_WRITE_INSTRUMENT);

// -- Helpers --

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeSharedState(mode: string, onnxAvailable: boolean): void {
  ensureDir(COGNITIVE_DIR);
  writeFileSync(
    LEARNED_INTUITION_STATE_PATH,
    JSON.stringify(
      {
        active: true,
        mode,
        onnxAvailable,
        version: "1.0.0",
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writePersonalityNudge(nudge: PersonalityNudge): void {
  ensureDir(COGNITIVE_DIR);
  writeFileSync(
    PERSONALITY_NUDGE_PATH,
    JSON.stringify(
      {
        adjustments: nudge.adjustments,
        strength: nudge.strength,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function loadAmygdalaConfig(modelsDir: string): AmygdalaConfig {
  // Load config from amygdala.config.json if it exists alongside models
  const configPath = join(modelsDir, "..", "amygdala", "amygdala.config.json");
  let fileConfig: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Use defaults
  }

  // Also try the source-tree config
  const srcConfigPath = join(modelsDir, "..", "..", "src", "amygdala", "amygdala.config.json");
  try {
    if (!Object.keys(fileConfig).length && existsSync(srcConfigPath)) {
      fileConfig = JSON.parse(readFileSync(srcConfigPath, "utf-8"));
    }
  } catch {
    // Use defaults
  }

  const targetVector =
    (fileConfig.target_vector as number[]) || generateTargetVector(DEFAULT_TARGET_DIMENSIONS);

  return {
    enabled: true,
    trust: {
      // FORK 2026-05-30 ("Amygdala" task): crank the LLM personality-nudge
      // influence so we can actually SEE its effect. Both alphas were 0.0 — the
      // nudge had literally zero weight. This is the nudge (LLM tone), NOT the
      // AEGIS tool-gate (that stays observe-only via cfg.observeOnly).
      // FORK 2026-06-04: bumped personality 0.15 → 0.5 for the narration-canary
      // experiment — narration_discipline nudge is the visible tell that the
      // whole personality pipeline is live (the architect's instrument). Prudence stays
      // 0.15 (observe-only safety gate).
      alpha_prudence: 0.15,
      alpha_personality: 0.5,
      alpha_max: 0.5,
      alpha_min: 0.0,
      phase: 4,
      ramp_eta: 0.01,
      reward_threshold: 0.7,
    },
    embedding: {
      encoder_model_path: join(modelsDir, "encoder.onnx"),
      projection_model_path: join(modelsDir, "projection.onnx"),
      internal_dim: 512,
      input_dim: 384,
      window_size: 32,
    },
    prudence: {
      // FORK 2026-06-04: all 5 prudence nets retrained and exported full-weight
      // to top-level hyphenated prudence-{a..e}.onnx (dynamo=False, verified
      // matching PyTorch <1e-4). Full 5/5 ensemble — d/e no longer fall back.
      model_paths: {
        a: join(modelsDir, "prudence-a.onnx"),
        b: join(modelsDir, "prudence-b.onnx"),
        c: join(modelsDir, "prudence-c.onnx"),
        d: join(modelsDir, "prudence-d.onnx"),
        e: join(modelsDir, "prudence-e.onnx"),
      },
      meta_weights: [0.2, 0.2, 0.2, 0.2, 0.2],
      conservative_override_threshold: 0.9,
      disagreement_threshold: 0.3,
    },
    personality: {
      // FORK 2026-06-04: all 5 personality nets retrained and exported to ONNX
      // (export_onnx.py writes top-level hyphenated personality-{a..e}.onnx with
      // dynamo=False so GRU/dual-encoder match PyTorch <1e-4). Full 5/5 ensemble.
      model_paths: {
        a: join(modelsDir, "personality-a.onnx"),
        b: join(modelsDir, "personality-b.onnx"),
        c: join(modelsDir, "personality-c.onnx"),
        d: join(modelsDir, "personality-d.onnx"),
        e: join(modelsDir, "personality-e.onnx"),
      },
      meta_weights: [0.2, 0.2, 0.2, 0.2, 0.2],
      target_vector: targetVector,
      embedding_dim: 64,
    },
    conformal: {
      epsilon: 0.05,
      calibration_window_days: 30,
      calibration_db_path: join(DATA_DIR, "amygdala", "calibration.sqlite"),
    },
    git_cache: {
      enabled: true,
      watch_paths: [join(homedir(), "src")],
      ttl_seconds: 300,
    },
    training_log: {
      db_path: join(DATA_DIR, "amygdala", "training.sqlite"),
      max_entries: 100000,
      rolling_window_days: 90,
    },
    action_type_map: {},
    target_type_map: {},
    reversibility_map: {},
    blast_radius_map: {} as Record<string, never>,
  };
}

// -- Plugin definition --

export default definePluginEntry({
  id: "tinkerclaw-learned-intuition",
  name: "Learned Intuition",
  description:
    "AMYGDALA safety gate — ONNX neural networks evaluate tool calls, " +
    "rule-based fallback when models unavailable, personality nudge generation.",
  register(api: OpenClawPluginApi) {
    const cfg = api.pluginConfig as {
      phase?: number;
      alphaPrudence?: number;
      aegisEnabled?: boolean;
      observeOnly?: boolean;
      modelsDir?: string;
      legacyEnsemble?: boolean;
      hookEnforcement?: boolean;
    };
    const log = api.logger;

    // FORK 2026-05-30 ("Amygdala" task): default the nudge to its top phase so
    // its LLM influence is at maximum. observeOnly stays true by default so the
    // AEGIS tool-gate keeps only OBSERVING (no surprise tool aborts) — set
    // observeOnly:false in plugin config to also enable active blocking.
    const phase = cfg.phase ?? 4;
    const observeOnly = cfg.observeOnly ?? true;
    const modelsDir = cfg.modelsDir ?? join(homedir(), "src", "tinkerclaw", "models", "amygdala");
    // v3.1: the 5-net ONNX ensemble is retired from the decision path (default
    // off); the pre-execution AEGIS hook is on by default.
    const legacyEnsemble = cfg.legacyEnsemble === true;
    const hookEnforcement = cfg.hookEnforcement !== false;

    // Ensure data directory exists
    ensureDir(AMYGDALA_DATA_DIR);

    // Build full config
    const amygdalaConfig = loadAmygdalaConfig(modelsDir);
    amygdalaConfig.trust.alpha_prudence = cfg.alphaPrudence ?? 0.15; // FORK 2026-05-30: max by default
    amygdalaConfig.trust.phase = Math.min(4, Math.max(1, phase)) as 1 | 2 | 3 | 4;
    amygdalaConfig.legacyEnsemble = legacyEnsemble;
    amygdalaConfig.hookEnforcement = hookEnforcement;
    amygdalaConfig.novelty = {
      enabled: true,
      k: 10,
      cap: 5000,
      minRef: 100,
      recalibrateEvery: 200,
    };

    // v3.1: compile the AEGIS rule snapshot + (when enforcement is on) the
    // claude-cli settings file that wires the pre-execution PreToolUse hook into
    // every tinker-bridge spawn. Done at register() so the artifacts exist before the
    // next worker spawns. Best-effort: a write failure must not break the gate.
    try {
      const snap = writePolicySnapshot(AMYGDALA_DATA_DIR, { hookEnforcement });
      log.info(
        `[learned-intuition] policy snapshot written (hookEnforcement=${hookEnforcement}, ` +
          `settings=${snap.settingsWritten}, hook=${snap.staged ?? "none"})`,
      );
    } catch (err) {
      log.warn(`[learned-intuition] policy snapshot failed: ${(err as Error).message}`);
    }

    // FORK 2026-05-30: wire the AEGIS absolute-veto checker. It was previously
    // unwired (`new AmygdalaHook(config)` with no checker) → the paper's §4.11
    // "absolute block" tier was dead code. This deterministic checker (backed by
    // the rule-based destructive-pattern gate) runs as the AEGIS pre-check on
    // EVERY tool call AND the post-check even when the ONNX gate allows — so the
    // hard veto holds in both ONNX and rule-based-fallback modes. Disable only by
    // explicit config `aegisEnabled:false`.
    // v3.1: use the enforce-aware checker so only `enforce:true` destructive
    // rules hard-block in-process now that the native block is wired through the
    // host (credential-PATTERN rules stay observe-only — anti-cry-wolf).
    const aegisChecker: AegisChecker = {
      async check(action) {
        const argsStr = action.metadata ? JSON.stringify(action.metadata) : action.target;
        const r = evaluateAegisEnforced(action.type, argsStr);
        return {
          blocked: r.decision === "hard_block",
          rule_id: r.rule ?? undefined,
          reason: r.explanation,
        };
      },
    };
    const hook = new AmygdalaHook(
      amygdalaConfig,
      cfg.aegisEnabled === false ? undefined : aegisChecker,
    );

    // Initialize asynchronously (non-blocking)
    let initPromise: Promise<void> | null = null;
    let hookReady = false;

    function ensureInit(): Promise<void> {
      if (!initPromise) {
        initPromise = hook
          .initialize()
          .then(() => {
            hookReady = true;
            // v3.1 default mode is "novelty" (AEGIS floor + k-NN ask channel);
            // "onnx"/"rule-based" only when the legacy ensemble is re-enabled.
            const mode = legacyEnsemble
              ? hook.useRuleBasedFallback
                ? "rule-based"
                : "onnx"
              : "novelty";
            writeSharedState(mode, !hook.useRuleBasedFallback);
            // FORK 2026-07-28 (instrument-liveness) — in rule-based fallback the llm_output nudge
            // writer returns BEFORE it can write, so `amygdala:nudge-write` cannot fire and would be
            // reported BROKEN forever: that is the false alarm `conditional` exists for. Re-declare
            // here, once init has resolved and `useRuleBasedFallback` is finally known.
            // declareInstrument merges (Object.assign), so the accumulated counters survive, and
            // passing `undefined` explicitly CLEARS a previously-set reason instead of letting it go
            // stale — silence must stop being excused the moment the models do load.
            declareInstrument({
              ...NUDGE_WRITE_INSTRUMENT,
              conditional: hook.useRuleBasedFallback
                ? "ONNX personality models unavailable — the nudge writer returns before writing"
                : undefined,
            });
            const nov = hook.noveltyStatus;
            log.info(
              `[learned-intuition] ready — mode=${mode}, phase=${phase}, observeOnly=${observeOnly}, ` +
                `hookEnforcement=${hookEnforcement}, novelty=${nov.enabled ? `ref=${nov.size},thr=${nov.threshold?.toFixed(3)}` : "warming"}`,
            );
            if (hook.useRuleBasedFallback) {
              log.warn(
                `[learned-intuition] ONNX models not available at ${modelsDir}. Using rule-based fallback.`,
              );
              // FORK 2026-05-30: surface the REAL load failure via the structured
              // logger (raw console.error inside the gate is not captured).
              const diags = hook.gateLoadErrors;
              log.warn(
                `[learned-intuition] onnx load diagnostics: ${diags.length ? diags.join(" || ") : "no errors collected — model loop did not run (loadOrt returned null without a captured import error)"}`,
              );
            }
          })
          .catch((err) => {
            log.error(`[learned-intuition] initialization failed: ${err}`);
            hookReady = false;
          });
      }
      return initPromise;
    }

    // Kick off init immediately
    ensureInit();

    // FORK 2026-06-04: cache the Personality net's REAL situational embedding
    // from the most recent tool-call evaluation, so the llm_output nudge writer
    // can decode against it instead of a neutral 0.5 stub (which discarded the
    // net entirely). Null until the first tool call of the session.
    let lastPersonalityEmbedding: Float32Array | null = null;

    // FORK 2026-06-07 (Amygdala feedback loop / M−1.A): keep a ring buffer of the
    // most recent gate decisions so the Tinker UI can SHOW exactly what AMYGDALA
    // does, and broadcast each one live. The gate previously only logged them.
    interface AmygdalaDecisionRecord {
      ts: string;
      tool: string;
      target: string;
      decision: string; // allow | soft_block | hard_block
      blocked: boolean;
      enforced: boolean; // actually aborted (vs observe-only)
      reason?: string;
      mode: "onnx" | "rules" | "novelty" | "hook";
      prudence?: number;
      disagreement?: number;
      // v3.1 fields
      novelty?: number;
      disposition?: string; // proceed | ask | block
      signal?: string; // aegis | novelty | incongruity | none
    }
    const recentDecisions: AmygdalaDecisionRecord[] = [];
    const MAX_DECISIONS = 200;

    // -- Hook: before_tool_call --
    api.on(
      "before_tool_call",
      async (event: { toolName: string; args: Record<string, unknown> }) => {
        await ensureInit();
        if (!hookReady) {
          return; // Initialization failed -- allow everything
        }

        try {
          const argsStr = JSON.stringify(event.args ?? {});
          const target =
            (event.args?.path as string) ||
            (event.args?.file_path as string) ||
            (event.args?.command as string) ||
            (event.args?.target as string) ||
            event.toolName;

          const result = await hook.evaluate(
            { type: event.toolName, target, metadata: event.args },
            {
              topic: "active-session",
              emotionalState: "calm",
              effortHoursEstimate: 0.5,
              correctionCount24h: 0,
              automationDepth: 1,
              confirmationEnabled: false,
              confirmationLevel: "none",
              sessionDuration: 0,
              actionCount: 0,
              topicCentroid: null,
              recentTranscripts: [],
            },
          );

          const modeTag = result.ruleBasedFallback ? "[rules]" : "[onnx]";

          // FORK 2026-06-04: capture the net's real read of this situation so the
          // personality nudge reflects what the net actually saw, not neutral 0.5.
          const personEmb = result.evaluation?.personality?.combined_embedding;
          if (personEmb && personEmb.length > 0) {
            lastPersonalityEmbedding = personEmb;
          }

          // FORK 2026-06-07 (Amygdala feedback loop): record + broadcast this decision
          // so the Tinker UI can show exactly what the gate just did.
          const evAny = result.evaluation as unknown as {
            prudence?: { combined?: { confidence?: number }; ensemble_disagreement?: number };
          } | null;
          const enforced =
            result.blocked && (result.decision === "hard_block" || !(observeOnly || phase === 1));
          const record: AmygdalaDecisionRecord = {
            ts: new Date().toISOString(),
            tool: event.toolName,
            target: String(target).slice(0, 200),
            decision: result.decision,
            blocked: result.blocked,
            enforced,
            reason: result.response?.reason,
            mode: legacyEnsemble ? (result.ruleBasedFallback ? "rules" : "onnx") : "novelty",
            prudence:
              typeof evAny?.prudence?.combined?.confidence === "number"
                ? evAny.prudence.combined.confidence
                : undefined,
            disagreement:
              typeof evAny?.prudence?.ensemble_disagreement === "number"
                ? evAny.prudence.ensemble_disagreement
                : undefined,
            novelty: typeof result.novelty === "number" ? result.novelty : undefined,
            disposition: result.disposition,
            signal: result.signal,
          };
          recentDecisions.push(record);
          if (recentDecisions.length > MAX_DECISIONS) recentDecisions.shift();
          try {
            (api as unknown as { broadcast?: (e: string, p: unknown) => void }).broadcast?.(
              "amygdala-decision",
              record,
            );
          } catch {
            /* broadcast is best-effort */
          }

          if (result.blocked) {
            // FORK 2026-05-30: AEGIS is the ABSOLUTE deterministic veto. A
            // `hard_block` (rule-based gate OR an AEGIS pre/post-check) ALWAYS
            // aborts, independent of the AMYGDALA trust ramp — "AEGIS active, not
            // observe-only". Only the neural `soft_block`s stay observe-only while
            // the learned gate ramps (phase 1 / observeOnly).
            const isAegisHardBlock = result.decision === "hard_block";
            if (isAegisHardBlock || !(observeOnly || phase === 1)) {
              log.warn(
                `[learned-intuition] ${modeTag} ${isAegisHardBlock ? "AEGIS BLOCKED" : "BLOCKED"} ${event.toolName}(${target}): ${result.response?.reason ?? "unknown"}`,
              );
              // FORK 2026-06-11 (v3.1): the host's before_tool_call dispatcher
              // honors `{block, blockReason}` (src/plugins/hooks.ts → pi-tools.
              // before-tool-call.ts: `if (hookResult?.block)`), NOT the
              // `{abort, message}` shape this returned before — so the native gate
              // never actually blocked. Return the shape the host reads.
              return {
                block: true,
                blockReason: result.response?.reason ?? "Action blocked by safety gate.",
              };
            }
            // Neural soft-block during the trust ramp — observe-only.
            log.info(
              `[learned-intuition] ${modeTag} WOULD block ${event.toolName}(${target}): ${result.response?.reason ?? "unknown"} (observe-only, not blocking)`,
            );
          } else {
            log.debug(`[learned-intuition] ${modeTag} allowed ${event.toolName}(${target})`);
          }
        } catch (err) {
          // Safety gate failures must never block the agent
          log.error(`[learned-intuition] evaluation error (allowing action): ${err}`);
        }
      },
      { priority: 10 }, // High priority -- safety should evaluate early
    );

    // -- Hook: llm_output --
    api.on("llm_output", async (_event: { text: string }) => {
      await ensureInit();
      if (!hookReady || hook.useRuleBasedFallback) {
        return; // No personality nudge without ONNX models
      }

      try {
        // Generate personality nudge from target vector
        const targetVector = amygdalaConfig.personality.target_vector;
        if (targetVector.length > 0) {
          // FORK 2026-06-04: decode against the net's REAL combined_embedding from
          // the last tool-call evaluation (cached above). Falls back to neutral 0.5
          // only before any tool call has run this session. This is what makes the
          // Personality NET actually steer the nudge, not just the static target.
          const baselineEmbedding =
            lastPersonalityEmbedding ??
            new Float32Array(amygdalaConfig.personality.embedding_dim).fill(0.5);
          const nudge = decodePersonalityNudge(
            baselineEmbedding,
            targetVector,
            amygdalaConfig.trust.alpha_personality,
          );

          if (nudge.adjustments.length > 0) {
            writePersonalityNudge(nudge);
            // FORK 2026-07-28 — fire AFTER the file is on disk, never before. writePersonalityNudge
            // is synchronous and can throw (writeFileSync), so reaching this line is the proof that
            // the nudge is persisted at PERSONALITY_NUDGE_PATH; claiming "written" any earlier would
            // make the ledger lie in precisely the direction that hides the bug.
            noteInstrumentFired(
              "amygdala:nudge-write",
              `${nudge.adjustments.length} adjustments, strength=${nudge.strength}`,
            );
            // Parts only, never a ratio (algorithm-metrics rule 2): `adjustments` is the COUNT of
            // nudge lines actually persisted, not the strings. `embeddingSource` segments rows
            // decoded from the Personality net's REAL combined_embedding from rows decoded against
            // the neutral 0.5 stub — without it a paper cannot tell a measured nudge from a
            // placeholder one, which is the same measured-vs-estimated contamination rule 3 forbids.
            recordAlgorithmOutcome({
              algorithm: "persona-nudge",
              variant: "amygdala-thermostat",
              outcome: "written",
              metrics: {
                adjustments: nudge.adjustments.length,
                strength: nudge.strength,
              },
              provenance: {
                adjustments: "local-measured",
                strength: "local-measured",
              },
              config: {
                embeddingSource: lastPersonalityEmbedding ? "personality-net" : "neutral-stub",
              },
            });
            log.debug(
              `[learned-intuition] personality nudge written: ${nudge.adjustments.length} adjustments`,
            );
          }
        }
      } catch (err) {
        log.error(`[learned-intuition] personality nudge error: ${err}`);
      }
    });

    // -- Hook: llm_input (v3.1 incongruity gut-check, observe-only) --
    // FORK 2026-06-11 (v3.1): on every user prompt, run the validated clause-cosine
    // incongruity check (AUROC 0.896). If a request's action clause and purpose
    // clause don't cohere ("build a chess game so I can water my plants"), surface
    // an ASK signal in the Amygdala feed. Observe-only — it never blocks or alters
    // the turn; it just shows the gut-feeling that something doesn't add up. Fires
    // for tinker-bridge too (llm_input runs in attempt.ts, which wraps the provider).
    api.on("llm_input", async (event: { prompt?: string; runId?: string; sessionId?: string }) => {
      await ensureInit();
      if (!hookReady || !event.prompt) return;
      try {
        const inc = await hook.checkIncongruity(event.prompt);
        if (!inc) return;
        const record: AmygdalaDecisionRecord = {
          ts: new Date().toISOString(),
          tool: "user-prompt",
          target: `${inc.head} ⇏ ${inc.tail}`.slice(0, 200),
          decision: "soft_block",
          blocked: false,
          enforced: false,
          reason: `Incongruous request (clause coherence ${inc.similarity.toFixed(3)}): the action and its stated purpose don't add up — would ask before acting.`,
          mode: "novelty",
          disposition: "ask",
          signal: "incongruity",
        };
        recentDecisions.push(record);
        if (recentDecisions.length > MAX_DECISIONS) recentDecisions.shift();
        try {
          mkdirSync(DATA_DIR, { recursive: true });
          appendFileSync(AMYGDALA_DECISIONS_PATH, JSON.stringify(record) + "\n");
        } catch {
          /* persistence is best-effort */
        }
        try {
          (api as unknown as { broadcast?: (e: string, p: unknown) => void }).broadcast?.(
            "amygdala-decision",
            record,
          );
        } catch {
          /* broadcast is best-effort */
        }
        if (event.runId) {
          emitAgentEvent({
            runId: event.runId,
            sessionKey: event.sessionId ?? "",
            stream: "lifecycle",
            data: { phase: "amygdala-decision", ...record },
          });
        }
        log.info(
          `[learned-intuition] incongruity flagged (sim=${inc.similarity.toFixed(3)}): "${inc.head}" ⇏ "${inc.tail}" — would ask`,
        );
      } catch (err) {
        log.warn(`[learned-intuition] incongruity check failed: ${(err as Error).message}`);
      }
    });

    // FORK 2026-06-07 (Phase 1a): tinker-bridge tools bypass the native before_tool_call
    // gate (Claude Code owns its tool loop), so the prudence nets never saw them. Here
    // we subscribe to tinker-bridge tool-start events (marked `tinkerBridge`) and run the SAME
    // hook.evaluate the native gate uses — so the REAL ONNX prudence verdict appears in
    // the feed for the way Jarvis actually runs. Observe-only: the tool already executed
    // by the time we see the event, so we report (enforced:false), never abort.
    if (!tinkerBridgePrudenceListenerAttached) {
      tinkerBridgePrudenceListenerAttached = true;
      onAgentEvent((evt) => {
        const d = evt.data as Record<string, unknown> | undefined;
        if (!d || evt.stream !== "tool" || d.phase !== "start" || d.tinkerBridge !== true) {
          return;
        }
        void (async () => {
          try {
            await ensureInit();
            if (!hookReady) {
              return;
            }
            const toolName = String(d.name ?? "?");
            const args = (d.args ?? {}) as Record<string, unknown>;
            const target =
              (args.path as string) ||
              (args.file_path as string) ||
              (args.command as string) ||
              (args.target as string) ||
              toolName;
            const result = await hook.evaluate(
              { type: toolName, target, metadata: args },
              {
                topic: "active-session",
                emotionalState: "calm",
                effortHoursEstimate: 0.5,
                correctionCount24h: 0,
                automationDepth: 1,
                confirmationEnabled: false,
                confirmationLevel: "none",
                sessionDuration: 0,
                actionCount: 0,
                topicCentroid: null,
                recentTranscripts: [],
              },
            );
            const personEmb = result.evaluation?.personality?.combined_embedding;
            if (personEmb && personEmb.length > 0) {
              lastPersonalityEmbedding = personEmb;
            }
            // FORK 2026-06-11 (v3.1): fix the null-field bug — `prudence.combined`
            // is an OBJECT (read `.confidence`), and the disagreement field is
            // `ensemble_disagreement`, not `disagreement`. In the default novelty
            // path these are absent; novelty/disposition/signal carry the read.
            const evAny = result.evaluation as unknown as {
              prudence?: { combined?: { confidence?: number }; ensemble_disagreement?: number };
            } | null;
            const record: AmygdalaDecisionRecord = {
              ts: new Date().toISOString(),
              tool: toolName,
              target: String(target).slice(0, 200),
              decision: result.decision,
              blocked: result.blocked,
              enforced: false, // tinker-bridge observe path: the tool already ran (real enforcement is the PreToolUse hook)
              reason: result.response?.reason,
              mode: legacyEnsemble ? (result.ruleBasedFallback ? "rules" : "onnx") : "novelty",
              prudence:
                typeof evAny?.prudence?.combined?.confidence === "number"
                  ? evAny.prudence.combined.confidence
                  : undefined,
              disagreement:
                typeof evAny?.prudence?.ensemble_disagreement === "number"
                  ? evAny.prudence.ensemble_disagreement
                  : undefined,
              novelty: typeof result.novelty === "number" ? result.novelty : undefined,
              disposition: result.disposition,
              signal: result.signal,
            };
            recentDecisions.push(record);
            if (recentDecisions.length > MAX_DECISIONS) recentDecisions.shift();
            try {
              mkdirSync(DATA_DIR, { recursive: true });
              appendFileSync(AMYGDALA_DECISIONS_PATH, JSON.stringify(record) + "\n");
            } catch {
              /* persistence is best-effort */
            }
            emitAgentEvent({
              runId: evt.runId,
              sessionKey: evt.sessionKey,
              stream: "lifecycle",
              data: { phase: "amygdala-decision", ...record },
            });
          } catch (err) {
            log.warn(
              `[learned-intuition] tinker-bridge prudence eval failed: ${(err as Error).message}`,
            );
          }
        })();
      });
    }

    // FORK 2026-06-07 (Amygdala feedback loop / M−1.A): expose the live feed to the
    // Tinker UI — recent gate decisions (most recent first), the current personality
    // nudge, mode/alphas, and rollup counts.
    api.registerGatewayMethod("amygdala.feed", async ({ respond }) => {
      let nudge: unknown = null;
      try {
        if (existsSync(PERSONALITY_NUDGE_PATH)) {
          nudge = JSON.parse(readFileSync(PERSONALITY_NUDGE_PATH, "utf-8"));
        }
      } catch {
        /* ignore */
      }
      let state: unknown = null;
      try {
        if (existsSync(LEARNED_INTUITION_STATE_PATH)) {
          state = JSON.parse(readFileSync(LEARNED_INTUITION_STATE_PATH, "utf-8"));
        }
      } catch {
        /* ignore */
      }
      // FORK 2026-06-07: merge the durable tinker-bridge decision log (JSONL) with the
      // in-memory native ring, newest-first. tinker-bridge tools bypass the native gate,
      // so this file is the only durable source for Claude-Code runs; merging it here
      // makes the feed survive a UI refresh and a gateway restart.
      type FeedDecision = Record<string, unknown> & { ts?: number | string };
      let persisted: FeedDecision[] = [];
      try {
        if (existsSync(AMYGDALA_DECISIONS_PATH)) {
          let lines = readFileSync(AMYGDALA_DECISIONS_PATH, "utf-8").split("\n").filter(Boolean);
          if (lines.length > 1200) {
            lines = lines.slice(-400);
            try {
              writeFileSync(AMYGDALA_DECISIONS_PATH, lines.join("\n") + "\n");
            } catch {
              /* ignore trim failure */
            }
          }
          persisted = lines
            .map((l) => {
              try {
                return JSON.parse(l) as FeedDecision;
              } catch {
                return null;
              }
            })
            .filter((d): d is FeedDecision => d !== null);
        }
      } catch {
        /* ignore */
      }
      // v3.1: ingest the pre-execution hook spool (REAL enforced denials from the
      // tinker-bridge / claude-cli path). Map its rows into the feed's decision shape.
      let hookRows: FeedDecision[] = [];
      try {
        if (existsSync(HOOK_DECISIONS_PATH)) {
          let lines = readFileSync(HOOK_DECISIONS_PATH, "utf-8").split("\n").filter(Boolean);
          if (lines.length > 1200) {
            lines = lines.slice(-400);
            try {
              writeFileSync(HOOK_DECISIONS_PATH, lines.join("\n") + "\n");
            } catch {
              /* ignore trim failure */
            }
          }
          hookRows = lines
            .map((l) => {
              try {
                const h = JSON.parse(l) as Record<string, unknown>;
                const dcn = String(h.decision ?? "allow");
                const mapped =
                  dcn === "deny" ? "hard_block" : dcn === "observe" ? "soft_block" : "allow";
                return {
                  ts: h.ts,
                  tool: h.tool,
                  target: h.target,
                  decision: mapped,
                  blocked: dcn !== "allow",
                  enforced: Boolean(h.enforced),
                  mode: "hook",
                  signal: "aegis",
                  reason: h.rule ? `AEGIS [${h.rule}]` : undefined,
                } as FeedDecision;
              } catch {
                return null;
              }
            })
            .filter((d): d is FeedDecision => d !== null);
        }
      } catch {
        /* ignore */
      }
      const tms = (d: FeedDecision): number =>
        typeof d.ts === "number" ? d.ts : d.ts ? Date.parse(String(d.ts)) || 0 : 0;
      const merged = [...persisted, ...hookRows, ...(recentDecisions as unknown as FeedDecision[])]
        .sort((a, b) => tms(b) - tms(a))
        .slice(0, 300);
      respond(true, {
        ready: hookReady,
        mode: hook.useRuleBasedFallback ? "rules" : "onnx",
        onnxAvailable: !hook.useRuleBasedFallback,
        observeOnly,
        phase,
        alphas: {
          prudence: amygdalaConfig.trust.alpha_prudence,
          personality: amygdalaConfig.trust.alpha_personality,
        },
        nudge,
        state,
        decisions: merged,
        counts: {
          total: merged.length,
          flagged: merged.filter((d) => Boolean(d.blocked)).length,
          enforced: merged.filter((d) => Boolean(d.enforced)).length,
        },
      });
    });

    log.info(
      `[learned-intuition] registered — phase=${phase}, observeOnly=${observeOnly}, modelsDir=${modelsDir}`,
    );
  },
});
