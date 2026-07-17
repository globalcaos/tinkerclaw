/**
 * FORK: Identity Persistence (CORTEX) extension entry point.
 *
 * Registers three plugin hooks:
 * 1. `before_prompt_build` (priority 100) -- Persona injection from SOUL.md,
 *    AMYGDALA personality nudge, and mid-context re-injection when EWMA drifts.
 * 2. `llm_output` -- SyncScore evaluation every N turns (EWMA smoothing).
 * 3. `llm_output` -- Observation extraction at 30K token threshold.
 *
 * Writes shared state to `~/.openclaw/cognitive/identity-persistence.json`
 * so other extensions (e.g. Computational Humor) can read persona data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  createCortexRuntime,
  type CortexRuntime,
  type CortexRuntimeOptions,
} from "./src/cortex-runtime.js";
import { applyMidContextReinject } from "./src/mid-context-reinject.js";
import {
  createObservationExtractor,
  type ObservationExtractor,
} from "./src/observation-runtime.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const COGNITIVE_DIR = join(OPENCLAW_DIR, "cognitive");
const CORTEX_LOG_DIR = join(OPENCLAW_DIR, "cortex");
const IDENTITY_STATE_PATH = join(COGNITIVE_DIR, "identity-persistence.json");
const NUDGE_PATH = join(COGNITIVE_DIR, "personality-nudge.json");
const TOTAL_RECALL_STATE_PATH = join(COGNITIVE_DIR, "total-recall.json");
const OBSERVATION_LOG_PATH = join(CORTEX_LOG_DIR, "observations.jsonl");
const SYNC_SCORE_LOG_PATH = join(CORTEX_LOG_DIR, "sync-score-log.jsonl");
const DEFAULT_SOUL_PATH = join(OPENCLAW_DIR, "SOUL.md");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Resolve the persona source path. Checks pluginConfig.personaPath first,
 * then falls back to ~/.openclaw/SOUL.md. If neither exists, bootstraps a
 * default SOUL.md (never overwrites existing files).
 */
function resolveSoulPath(cfg: Record<string, unknown>, agentName: string): string {
  const configPath = cfg.personaPath as string | undefined;
  if (configPath) {
    const resolved = configPath.replace(/^~/, homedir());
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  // Bootstrap default SOUL.md if it doesn't exist
  if (!existsSync(DEFAULT_SOUL_PATH)) {
    try {
      writeFileSync(
        DEFAULT_SOUL_PATH,
        `# ${agentName}\n\nA helpful, thoughtful AI assistant.\n`,
        "utf8",
      );
    } catch {
      // Non-fatal: persona will be created from defaults
    }
  }
  return DEFAULT_SOUL_PATH;
}

/**
 * Read the AMYGDALA personality nudge if it exists. Returns the nudge text
 * or an empty string. Never crashes on missing/malformed files.
 */
function readPersonalityNudge(): string {
  try {
    if (!existsSync(NUDGE_PATH)) {
      return "";
    }
    const raw = JSON.parse(readFileSync(NUDGE_PATH, "utf8")) as Record<string, unknown>;
    if (typeof raw.nudge === "string" && raw.nudge.length > 0) {
      return raw.nudge;
    }
    if (typeof raw.text === "string" && raw.text.length > 0) {
      return raw.text;
    }
    if (Array.isArray(raw.adjustments) && raw.adjustments.length > 0) {
      return (raw.adjustments as string[]).join("\n");
    }
  } catch {
    // Malformed or unreadable -- ignore
  }
  return "";
}

/**
 * Write shared state so other extensions can discover Identity Persistence.
 */
function writeSharedState(persona: { name: string; humor: Record<string, unknown> }): void {
  ensureDir(COGNITIVE_DIR);
  writeFileSync(
    IDENTITY_STATE_PATH,
    JSON.stringify(
      {
        active: true,
        persona: {
          name: persona.name,
          humor: persona.humor,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

interface TotalRecallState {
  active: boolean;
  observationsPath?: string;
}

function readTotalRecallState(): TotalRecallState | null {
  try {
    if (existsSync(TOTAL_RECALL_STATE_PATH)) {
      return JSON.parse(readFileSync(TOTAL_RECALL_STATE_PATH, "utf8")) as TotalRecallState;
    }
  } catch {
    // Malformed or missing
  }
  return null;
}

/**
 * Append observations to either Total Recall's store or local JSONL.
 */
function persistObservations(
  observations: Array<{ type: string; content: string; confidence: number }>,
): void {
  const totalRecall = readTotalRecallState();
  const targetPath =
    totalRecall?.active && totalRecall.observationsPath
      ? totalRecall.observationsPath
      : OBSERVATION_LOG_PATH;

  ensureDir(join(targetPath, ".."));
  for (const obs of observations) {
    appendFileSync(
      targetPath,
      JSON.stringify({ ...obs, timestamp: new Date().toISOString() }) + "\n",
      "utf8",
    );
  }
}

// ---------------------------------------------------------------------------
// Plugin Entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "tinkerclaw-identity-persistence",
  name: "Identity Persistence",
  description:
    "CORTEX -- Persona injection from SOUL.md, EWMA SyncScore drift detection, " +
    "mid-context identity reinforcement, and observation extraction.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const threshold = (cfg.syncScoreThreshold as number) ?? 0.6;
    const evaluationInterval = (cfg.evaluationInterval as number) ?? 10;
    const agentName =
      ((api.config?.agents?.defaults as Record<string, unknown>)?.name as string) ?? "JarvisOne";

    // -- Initialize cortex runtime --
    const soulPath = resolveSoulPath(cfg, agentName);
    const runtimeOpts: CortexRuntimeOptions = {
      soulPath,
      name: agentName,
      syncScoreInterval: evaluationInterval,
    };
    const cortex: CortexRuntime = createCortexRuntime(runtimeOpts);

    // -- Initialize observation extractor --
    const observer: ObservationExtractor = createObservationExtractor();

    // -- Ensure log directories --
    try {
      ensureDir(CORTEX_LOG_DIR);
      ensureDir(COGNITIVE_DIR);
    } catch (err) {
      api.logger.warn(`[identity-persistence] failed to create directories: ${err}`);
    }

    // -- Write shared state for cross-extension discovery --
    try {
      writeSharedState({
        name: cortex.persona.name,
        humor: cortex.persona.humor,
      });
    } catch (err) {
      api.logger.warn(`[identity-persistence] failed to write shared state: ${err}`);
    }

    // -- Turn counter for SyncScore evaluation --
    let turnCounter = 0;

    // -----------------------------------------------------------------------
    // Hook 1: before_prompt_build (priority 100)
    // -----------------------------------------------------------------------
    api.on(
      "before_prompt_build",
      async (_payload: { prompt: string }, _context: { sessionKey: string }) => {
        // Tier 1 persona block
        const personaBlock = cortex.getPersonaBlock();

        // AMYGDALA personality nudge (optional)
        const nudge = readPersonalityNudge();
        const nudgeBlock = nudge ? `\n[Personality Nudge] ${nudge}\n` : "";

        // Mid-context re-injection when EWMA drifts below threshold
        const reinjectResult = applyMidContextReinject(cortex, "");
        const reinjectBlock = reinjectResult.reinjected
          ? `\n[Identity Reinforcement — SyncScore ${reinjectResult.ewmaScore.toFixed(3)}]\n${personaBlock}\n`
          : "";

        return {
          prependSystemContext: personaBlock + nudgeBlock,
          prependContext: reinjectBlock,
        };
      },
      { priority: 100 },
    );

    // -----------------------------------------------------------------------
    // Hook 2: llm_output — SyncScore evaluation
    // -----------------------------------------------------------------------
    api.on(
      "llm_output",
      async (payload: { text?: string; content?: string }, _context: { sessionKey: string }) => {
        turnCounter++;

        // Only evaluate every N turns
        if (turnCounter % evaluationInterval !== 0) {
          return;
        }

        const text = payload.text ?? payload.content ?? "";
        if (!text) {
          return;
        }

        const result = cortex.evaluateSyncScore([text], turnCounter);

        // Log to cortex sync-score log
        try {
          ensureDir(CORTEX_LOG_DIR);
          appendFileSync(
            SYNC_SCORE_LOG_PATH,
            JSON.stringify({
              turn: turnCounter,
              rawScore: result.rawScore,
              ewmaScore: result.ewmaScore,
              needsReinjection: result.needsReinjection,
              timestamp: result.timestamp,
            }) + "\n",
            "utf8",
          );
        } catch {
          // Non-fatal
        }

        if (result.needsReinjection) {
          api.logger.info(
            `[identity-persistence] SyncScore drift: ewma=${result.ewmaScore.toFixed(3)} < ${threshold} (turn=${turnCounter})`,
          );
        }
      },
    );

    // -----------------------------------------------------------------------
    // Hook 3: llm_output — Observation extraction
    // -----------------------------------------------------------------------
    api.on(
      "llm_output",
      async (payload: { text?: string; content?: string }, _context: { sessionKey: string }) => {
        const text = payload.text ?? payload.content ?? "";
        if (!text) {
          return;
        }

        const observations = observer.extractObservations([text]);
        if (observations.length === 0) {
          return;
        }

        // Persist observations
        try {
          persistObservations(
            observations.map((o) => ({
              type: o.type,
              content: o.content,
              confidence: o.confidence,
            })),
          );
        } catch (err) {
          api.logger.warn(`[identity-persistence] observation persistence failed: ${err}`);
        }

        api.logger.info(
          `[identity-persistence] extracted ${observations.length} observation(s) (total=${observer.totalExtracted})`,
        );
      },
    );

    api.logger.info(
      `[identity-persistence] ready (persona=${cortex.persona.name}, threshold=${threshold}, interval=${evaluationInterval})`,
    );
  },
});
