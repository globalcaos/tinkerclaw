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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { decodePersonalityNudge } from "./src/personality-decoder.js";
import { generateTargetVector, DEFAULT_TARGET_DIMENSIONS } from "./src/personality-seed.js";
import { evaluateRuleBased } from "./src/rule-based-gate.js";
import { AmygdalaHook } from "./src/runtime-hook.js";
import type { AmygdalaConfig, PersonalityNudge } from "./src/types.js";

// -- Constants --

const COGNITIVE_DIR = join(homedir(), ".openclaw", "cognitive");
const LEARNED_INTUITION_STATE_PATH = join(COGNITIVE_DIR, "learned-intuition.json");
const PERSONALITY_NUDGE_PATH = join(COGNITIVE_DIR, "personality-nudge.json");
const DATA_DIR = join(homedir(), ".openclaw", "data");

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
      // influence to the ceiling (alpha_max) so we can actually SEE its effect.
      // Both alphas were 0.0 — the nudge had literally zero weight, which is
      // why it "didn't seem to do anything". This is the nudge (LLM tone), NOT
      // the AEGIS tool-gate (that stays observe-only via cfg.observeOnly).
      alpha_prudence: 0.15,
      alpha_personality: 0.15,
      alpha_max: 0.15,
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
      model_paths: {
        a: join(modelsDir, "onnx", "prudence_a_gru_mlp.onnx"),
        b: join(modelsDir, "onnx", "prudence_b_tcn.onnx"),
        c: join(modelsDir, "onnx", "prudence_c_transformer.onnx"),
        d: join(modelsDir, "onnx", "prudence_d_dual_encoder.onnx"),
        e: join(modelsDir, "onnx", "prudence_e_ensemble_mlp.onnx"),
      },
      meta_weights: [0.2, 0.2, 0.2, 0.2, 0.2],
      conservative_override_threshold: 0.9,
      disagreement_threshold: 0.3,
    },
    personality: {
      model_paths: {
        a: join(modelsDir, "onnx", "personality_a_gru_mlp.onnx"),
        b: join(modelsDir, "onnx", "personality_b_tcn.onnx"),
        c: join(modelsDir, "onnx", "personality_c_transformer.onnx"),
        d: join(modelsDir, "onnx", "personality_d_dual_encoder.onnx"),
        e: join(modelsDir, "onnx", "personality_e_ensemble_mlp.onnx"),
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
    };
    const log = api.logger;

    // FORK 2026-05-30 ("Amygdala" task): default the nudge to its top phase so
    // its LLM influence is at maximum. observeOnly stays true by default so the
    // AEGIS tool-gate keeps only OBSERVING (no surprise tool aborts) — set
    // observeOnly:false in plugin config to also enable active blocking.
    const phase = cfg.phase ?? 4;
    const observeOnly = cfg.observeOnly ?? true;
    const modelsDir = cfg.modelsDir ?? join(homedir(), "src", "tinkerclaw", "models", "amygdala");

    // Ensure data directory exists
    ensureDir(join(DATA_DIR, "amygdala"));

    // Build full config
    const amygdalaConfig = loadAmygdalaConfig(modelsDir);
    amygdalaConfig.trust.alpha_prudence = cfg.alphaPrudence ?? 0.15; // FORK 2026-05-30: max by default
    amygdalaConfig.trust.phase = Math.min(4, Math.max(1, phase)) as 1 | 2 | 3 | 4;

    // Create hook instance
    const hook = new AmygdalaHook(amygdalaConfig);

    // Initialize asynchronously (non-blocking)
    let initPromise: Promise<void> | null = null;
    let hookReady = false;

    function ensureInit(): Promise<void> {
      if (!initPromise) {
        initPromise = hook
          .initialize()
          .then(() => {
            hookReady = true;
            const mode = hook.useRuleBasedFallback ? "rule-based" : "onnx";
            writeSharedState(mode, !hook.useRuleBasedFallback);
            log.info(
              `[learned-intuition] ready — mode=${mode}, phase=${phase}, observeOnly=${observeOnly}`,
            );
            if (hook.useRuleBasedFallback) {
              log.warn(
                `[learned-intuition] ONNX models not available at ${modelsDir}. Using rule-based fallback.`,
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

          if (result.blocked) {
            if (observeOnly || phase === 1) {
              // Phase 1: observe-only -- log but never block
              log.info(
                `[learned-intuition] ${modeTag} WOULD block ${event.toolName}(${target}): ${result.response?.reason ?? "unknown"} (observe-only, not blocking)`,
              );
            } else {
              // Phase 2+: active blocking
              log.warn(
                `[learned-intuition] ${modeTag} BLOCKED ${event.toolName}(${target}): ${result.response?.reason ?? "unknown"}`,
              );
              return {
                abort: true,
                message: result.response?.reason ?? "Action blocked by safety gate.",
              };
            }
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
          // Use a neutral combined embedding as baseline (actual model output
          // would come from the last evaluation, but we generate a fresh nudge
          // based on the target vector drift from neutral)
          const neutralEmbedding = new Float32Array(amygdalaConfig.personality.embedding_dim).fill(
            0.5,
          );
          const nudge = decodePersonalityNudge(
            neutralEmbedding,
            targetVector,
            amygdalaConfig.trust.alpha_personality,
          );

          if (nudge.adjustments.length > 0) {
            writePersonalityNudge(nudge);
            log.debug(
              `[learned-intuition] personality nudge written: ${nudge.adjustments.length} adjustments`,
            );
          }
        }
      } catch (err) {
        log.error(`[learned-intuition] personality nudge error: ${err}`);
      }
    });

    log.info(
      `[learned-intuition] registered — phase=${phase}, observeOnly=${observeOnly}, modelsDir=${modelsDir}`,
    );
  },
});
