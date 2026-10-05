/**
 * FORK: Identity Persistence (CORTEX) extension entry point.
 *
 * OPT-IN. Nothing here runs until BOTH hold: `config.enabled === true`, and a
 * persona markdown file already exists (explicit `personaPath`, else the
 * default `~/.openclaw/workspace/SOUL.md`). Otherwise register() returns having
 * hooked nothing. The plugin never creates a persona file.
 *
 * Once opted in, registers three plugin hooks:
 * 1. `before_prompt_build` (priority 100) -- Persona injection into the system
 *    context of EVERY prompt, AMYGDALA personality nudge, and mid-context
 *    re-injection when EWMA drifts.
 * 2. `llm_output` -- SyncScore evaluation every N turns (EWMA smoothing).
 * 3. `llm_output` -- Observation extraction, appended to disk.
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

// $HOME first, homedir() as the fallback: os.homedir() resolves the passwd
// entry and ignores a redirected HOME, so a test could not keep this plugin's
// writes (shared state, observation log) out of the developer's real
// ~/.openclaw. Same value in production.
const OPENCLAW_DIR = join(process.env.HOME ?? homedir(), ".openclaw");
const COGNITIVE_DIR = join(OPENCLAW_DIR, "cognitive");
const CORTEX_LOG_DIR = join(OPENCLAW_DIR, "cortex");
const IDENTITY_STATE_PATH = join(COGNITIVE_DIR, "identity-persistence.json");
const NUDGE_PATH = join(COGNITIVE_DIR, "personality-nudge.json");
const TOTAL_RECALL_STATE_PATH = join(COGNITIVE_DIR, "total-recall.json");
const OBSERVATION_LOG_PATH = join(CORTEX_LOG_DIR, "observations.jsonl");
const SYNC_SCORE_LOG_PATH = join(CORTEX_LOG_DIR, "sync-score-log.jsonl");
const DEFAULT_SOUL_PATH = join(OPENCLAW_DIR, "workspace", "SOUL.md");

/**
 * Neutral fallback name, used only when the host config names no agent. It is
 * deliberately generic: shipping a specific character here would brand every
 * install with this fork author's persona.
 */
const DEFAULT_AGENT_NAME = "Agent";

/**
 * The agent's configured name, in the order the gateway resolves it for the UI header:
 * `ui.assistant.name` -> `agents.defaults.name` -> `Name:` in the workspace IDENTITY.md ->
 * DEFAULT_AGENT_NAME. The persona header, the shared state and every voice rule say THIS name,
 * so a second deployment of the fork (Goku) answers as itself, not as the fork author's agent.
 */
function resolveAgentName(config: unknown): string {
  const c = config as
    | { ui?: { assistant?: { name?: unknown } }; agents?: { defaults?: Record<string, unknown> } }
    | undefined;
  for (const v of [c?.ui?.assistant?.name, c?.agents?.defaults?.name]) {
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  const ws = c?.agents?.defaults?.workspace;
  const workspace =
    typeof ws === "string" && ws.trim()
      ? ws.replace(/^~/, homedir())
      : join(OPENCLAW_DIR, "workspace");
  try {
    const match = readFileSync(join(workspace, "IDENTITY.md"), "utf8").match(
      /^\s*-?\s*[*_]*name[*_]*\s*:\s*[*_]*\s*(.+?)\s*$/im,
    );
    const name = match?.[1]?.replace(/[*_]+$/, "").trim();
    if (name) {
      return name;
    }
  } catch {
    // no workspace identity file: fall through to the neutral default
  }
  return DEFAULT_AGENT_NAME;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Resolve the persona source path, or null when there is nothing to inject.
 *
 * The persona must be a file the OWNER wrote. This function never creates,
 * bootstraps or overwrites one: a plugin that invents a persona for you is
 * injecting someone else's identity into every prompt.
 *
 * - `personaPath` set and present  -> that file.
 * - `personaPath` set and MISSING  -> null (no silent fallback: an explicit
 *   path that does not resolve is a configuration error, not a cue to
 *   substitute a different persona).
 * - `personaPath` unset            -> the default path if it already exists,
 *   otherwise null.
 */
function resolvePersonaPath(cfg: Record<string, unknown>): string | null {
  const configPath = cfg.personaPath as string | undefined;
  if (configPath) {
    const resolved = configPath.replace(/^~/, homedir());
    return existsSync(resolved) ? resolved : null;
  }
  return existsSync(DEFAULT_SOUL_PATH) ? DEFAULT_SOUL_PATH : null;
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
    "CORTEX -- Opt-in persona injection from a persona markdown file, EWMA " +
    "SyncScore drift detection, mid-context identity reinforcement, and " +
    "observation extraction. Registers no hooks unless enabled with a persona file.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const threshold = (cfg.syncScoreThreshold as number) ?? 0.6;
    const evaluationInterval = (cfg.evaluationInterval as number) ?? 10;
    const personalityNudge = cfg.personalityNudge === true;
    const agentName = resolveAgentName(api.config);

    // -----------------------------------------------------------------------
    // Opt-in gate. This plugin mutates the system context of EVERY prompt and
    // writes extracted observations to disk, so neither happens until the owner
    // asks for it in two explicit ways: `enabled: true`, and a persona file
    // that already exists. Registering nothing is the whole point — a hook that
    // is registered and then no-ops is still a hook on every turn.
    // -----------------------------------------------------------------------
    if (cfg.enabled !== true) {
      api.logger.info(
        "[identity-persistence] disabled — set config.enabled=true to inject the persona (no hooks registered)",
      );
      return;
    }

    const soulPath = resolvePersonaPath(cfg);
    if (!soulPath) {
      api.logger.warn(
        `[identity-persistence] no persona file — ${
          cfg.personaPath
            ? `configured personaPath '${String(cfg.personaPath)}' does not exist`
            : `default ${DEFAULT_SOUL_PATH} does not exist`
        }. Write one (or point personaPath at it); the plugin never creates a persona. No hooks registered.`,
      );
      return;
    }

    // -- Initialize cortex runtime --
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

        // AMYGDALA personality nudge — a SECOND prompt mutation, sourced from a
        // file this plugin does not own (Learned Intuition writes it). Opt-in
        // separately: enabling persona injection is not consent to inject
        // whatever another plugin last dropped on disk.
        const nudge = personalityNudge ? readPersonalityNudge() : "";
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
      `[identity-persistence] ready (persona=${cortex.persona.name}, source=${soulPath}, ` +
        `threshold=${threshold}, interval=${evaluationInterval}, personalityNudge=${personalityNudge})`,
    );
  },
});
