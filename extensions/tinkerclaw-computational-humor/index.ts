/**
 * FORK: Computational Humor (LIMBIC) extension entry point.
 *
 * Registers two plugin hooks:
 * 1. `before_prompt_build` -- on Tinker chats, record the previous purple spoken line with the principal's
 *    reaction to it, and hand the turn a short block: is a joke welcome now, and how did the last lines land
 *    (J7 v4.9 §9: humor lives only in the spoken line, Data's deadpan register).
 * 2. `llm_output` -- capture user reaction to previous humor attempt by scanning
 *    for positive signals (laughter, emoji, affirmation).
 *
 * Reads persona humor settings from Identity Persistence shared state at
 * `~/.openclaw/cognitive/identity-persistence.json`. Falls back to config
 * defaults when that file is absent.
 *
 * Writes its own shared state to `~/.openclaw/cognitive/computational-humor.json`
 * for cross-extension discovery.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createHumorTrigger, type HumorTrigger } from "./src/humor-trigger.js";
import {
  createLimbicRuntime,
  type LimbicRuntime,
  type HumorCalibration,
} from "./src/limbic-runtime.js";
import {
  buildHumorBlock,
  extractSpokenLine,
  jokesOff,
  lastTurnReplyText,
  reactionTo,
  type SpokenLineAttempt,
} from "./src/spoken-line.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const COGNITIVE_DIR = join(OPENCLAW_DIR, "cognitive");
const IDENTITY_STATE_PATH = join(COGNITIVE_DIR, "identity-persistence.json");
const HUMOR_STATE_PATH = join(COGNITIVE_DIR, "computational-humor.json");
/** The purple spoken line exists only on the Tinker web chat (VOICE.md). */
const TINKER_PREFIX = "agent:main:tinker:";
const RECENT_KEEP = 20;
const RECENT_SHOW = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Frequency enum to numeric mapping. */
function frequencyToNumber(freq: string): number {
  switch (freq) {
    case "off":
      return 0;
    case "low":
      return 0.1;
    case "medium":
      return 0.25;
    case "high":
      return 0.5;
    default:
      return 0.1;
  }
}

/**
 * Read humor calibration from Identity Persistence shared state.
 * Falls back to config defaults when file is absent or malformed.
 */
function readIdentityHumorCalibration(
  configFrequency: string,
  configSensitivity: number,
): HumorCalibration {
  const defaults: HumorCalibration = {
    humorFrequency: frequencyToNumber(configFrequency),
    preferredPatterns: [1, 4, 7],
    sensitivityThreshold: configSensitivity,
    audienceModel: {},
  };

  try {
    if (!existsSync(IDENTITY_STATE_PATH)) {
      return defaults;
    }
    const raw = JSON.parse(readFileSync(IDENTITY_STATE_PATH, "utf8"));
    const humor = raw?.persona?.humor;
    if (!humor) {
      return defaults;
    }
    return {
      humorFrequency:
        typeof humor.humorFrequency === "number" ? humor.humorFrequency : defaults.humorFrequency,
      preferredPatterns: Array.isArray(humor.preferredPatterns)
        ? humor.preferredPatterns
        : defaults.preferredPatterns,
      sensitivityThreshold:
        typeof humor.sensitivityThreshold === "number"
          ? humor.sensitivityThreshold
          : defaults.sensitivityThreshold,
      audienceModel: humor.audienceModel ?? defaults.audienceModel,
    };
  } catch {
    return defaults;
  }
}

/** Spoken lines recorded by earlier runs, so the reactions survive a restart. */
function readRecentSpokenLines(): SpokenLineAttempt[] {
  try {
    const raw = JSON.parse(readFileSync(HUMOR_STATE_PATH, "utf8"));
    return Array.isArray(raw?.recentSpokenLines) ? raw.recentSpokenLines : [];
  } catch {
    return [];
  }
}

/**
 * Write shared state for cross-extension discovery.
 */
function writeHumorState(
  runtime: LimbicRuntime,
  trigger: HumorTrigger,
  turnCount: number,
  recentSpokenLines: SpokenLineAttempt[],
): void {
  try {
    ensureDir(COGNITIVE_DIR);
    const state = {
      updatedAt: new Date().toISOString(),
      turnCount,
      associations: runtime.getAssociations().length,
      pendingAttempts: runtime.getPendingAttempts().size,
      recentSpokenLines,
    };
    writeFileSync(HUMOR_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort: don't crash the extension if write fails
  }
}

// ---------------------------------------------------------------------------
// Plugin Entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "tinkerclaw-computational-humor",
  name: "Computational Humor",
  description:
    "LIMBIC -- Humor from embedding geometry. " +
    "Bridge discovery, sensitivity gating, reaction capture, and calibration.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const frequency = (cfg.frequency as string) ?? "low";
    const sensitivityThreshold = (cfg.sensitivityThreshold as number) ?? 0.8;
    const _embeddingProvider = (cfg.embeddingProvider as string) ?? "ollama";

    // "off" frequency disables the extension entirely
    if (frequency === "off") {
      api.logger.info("[computational-humor] disabled via frequency=off");
      return;
    }

    // Read humor calibration from Identity Persistence (or config defaults)
    const calibration = readIdentityHumorCalibration(frequency, sensitivityThreshold);

    // Create the runtime (starts with FNV-1a fallback; ollama upgrade is async)
    const runtime = createLimbicRuntime({ calibration });
    const trigger = createHumorTrigger(runtime);

    // Track turn count across hooks
    let turnCount = 0;
    // Track the most recent humor attempt ID for reaction capture
    let lastAttemptId: string | undefined;

    // Spoken lines and how the principal reacted to each, newest last
    let recentSpokenLines = readRecentSpokenLines();

    // -------------------------------------------------------------------
    // Hook: before_prompt_build -- record the last spoken line, say whether a joke is welcome now
    // -------------------------------------------------------------------
    api.on(
      "before_prompt_build",
      async (event: { prompt?: string; messages?: unknown[] }, ctx: { sessionKey?: string }) => {
        const sessionKey = ctx.sessionKey ?? "";
        if (!sessionKey.startsWith(TINKER_PREFIX)) {
          return;
        }

        turnCount++;

        // This prompt is the principal's reaction to the spoken line that closed the previous turn
        const line = extractSpokenLine(lastTurnReplyText(event.messages));
        if (
          line &&
          !recentSpokenLines.some((a) => a.sessionKey === sessionKey && a.line === line)
        ) {
          recentSpokenLines = [
            ...recentSpokenLines,
            { ts: Date.now(), sessionKey, line, reaction: reactionTo(event.prompt) },
          ].slice(-RECENT_KEEP);
        }
        writeHumorState(runtime, trigger, turnCount, recentSpokenLines);

        return {
          prependSystemContext: buildHumorBlock({
            jokesOff: jokesOff(event.prompt),
            recent: recentSpokenLines.slice(-RECENT_SHOW),
          }),
        };
      },
    );

    // -------------------------------------------------------------------
    // Hook: llm_output -- capture user reaction to previous humor attempt
    // -------------------------------------------------------------------
    api.on(
      "llm_output",
      async (
        event: {
          text?: string;
          userMessage?: string;
          messages?: Array<{ role?: string; content?: string }>;
        },
        _ctx: { sessionKey?: string },
      ) => {
        // Look for user message to check for reaction
        const userText =
          event.userMessage ??
          event.messages?.filter((m) => m.role === "user").pop()?.content ??
          "";

        if (!userText || !lastAttemptId) {
          return;
        }

        const captured = await runtime.captureReaction(userText, lastAttemptId);
        if (captured) {
          api.logger.info(
            `[computational-humor] positive reaction captured for attempt ${lastAttemptId}`,
          );
          writeHumorState(runtime, trigger, turnCount, recentSpokenLines);
        }

        // Clear the attempt ID after checking (one-shot)
        lastAttemptId = undefined;
      },
    );

    api.logger.info(
      `[computational-humor] ready (frequency=${frequency}, sensitivity=${sensitivityThreshold})`,
    );
  },
});
