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
 * And one gateway method, `limbic.reaction.set` -- his tap on a purple line's chips in Tinker (laughed / neutral /
 * not now) becomes the outcome of that line's attempt row (J7 §8.6, plan Phase 1.4). Each new row is also judged
 * joke or plain (`src/joke-judge.ts`).
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
import { isSlashCommandPrompt, ownerWords } from "openclaw/plugin-sdk/fork-prompt-envelope";
import { createHumorTrigger, type HumorTrigger } from "./src/humor-trigger.js";
import { createJokeJudge } from "./src/joke-judge.js";
import {
  createLimbicRuntime,
  type LimbicRuntime,
  type HumorCalibration,
} from "./src/limbic-runtime.js";
import {
  applyTap,
  buildHumorBlock,
  extractSpokenLine,
  jokesOff,
  lastTurnReplyText,
  reactionTo,
  TAP_REACTIONS,
  type SpokenLineAttempt,
  type TapReaction,
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
    case "max":
      return 0.9;
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
 * Thalamus owns the Jev settings: where Jev lives, and whether real text may be sent to it at all
 * (`jev.sendRealSituations`). The judge reads them from the live gateway config, never from its own copy.
 */
function thalamusJev(api: OpenClawPluginApi): Record<string, unknown> {
  let cfg: unknown;
  try {
    cfg = api.runtime.config.current();
  } catch {
    cfg = api.config;
  }
  type Cfg = { plugins?: { entries?: Record<string, { config?: { jev?: unknown } }> } };
  const jev = (cfg as Cfg | undefined)?.plugins?.entries?.["tinkerclaw-thalamus"]?.config?.jev;
  return jev && typeof jev === "object" ? (jev as Record<string, unknown>) : {};
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

    const jevCfg = thalamusJev(api);
    const judge = createJokeJudge({
      allowed: () => {
        const j = thalamusJev(api);
        return j.enabled !== false && j.sendRealSituations === true;
      },
      baseUrl: typeof jevCfg.baseUrl === "string" ? jevCfg.baseUrl : "https://api.typesafe.ai",
      model: typeof jevCfg.model === "string" ? jevCfg.model : "jev-latest",
    });
    /** Joke or plain, asked once per new row; a tap that lands first ("laughed", "not now") keeps its answer. */
    const judgeLine = async (sessionKey: string, line: string): Promise<void> => {
      const isJoke = await judge(line);
      if (isJoke === undefined) {
        return;
      }
      const i = recentSpokenLines.findLastIndex(
        (a) => a.sessionKey === sessionKey && a.line === line,
      );
      if (i < 0 || recentSpokenLines[i].isJoke !== undefined) {
        return;
      }
      recentSpokenLines = recentSpokenLines.with(i, { ...recentSpokenLines[i], isJoke });
      writeHumorState(runtime, trigger, turnCount, recentSpokenLines);
    };

    // -------------------------------------------------------------------
    // Hook: before_prompt_build -- record the last spoken line, say whether a joke is welcome now
    // -------------------------------------------------------------------
    api.on(
      "before_prompt_build",
      async (event: { prompt?: string; messages?: unknown[] }, ctx: { sessionKey?: string }) => {
        const sessionKey = ctx.sessionKey ?? "";
        if (!sessionKey.startsWith(TINKER_PREFIX) || isSlashCommandPrompt(event.prompt)) {
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
            {
              ts: Date.now(),
              sessionKey,
              line,
              reaction: reactionTo(event.prompt),
              reactionSource: "text" as const,
            },
          ].slice(-RECENT_KEEP);
          void judgeLine(sessionKey, line);
        }
        writeHumorState(runtime, trigger, turnCount, recentSpokenLines);

        // FORK 2026-10-10 (J-series Phase 1.5): the gate and the last lines change every turn, so they ride the turn
        // (prependContext). As system context they reached a warm Claude Code worker only when it spawned, and a
        // changed block moved the whole cached prefix.
        return {
          prependContext: buildHumorBlock({
            frequency,
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
        // Look for user message to check for reaction: only his own words count (an agent's turn is unobserved)
        const userText =
          ownerWords(
            event.userMessage ?? event.messages?.findLast((m) => m.role === "user")?.content,
          ) ?? "";

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

    // -------------------------------------------------------------------
    // Gateway method: limbic.reaction.set -- his tap on a purple line's chips
    // -------------------------------------------------------------------
    api.registerGatewayMethod(
      "limbic.reaction.set",
      async ({ params, respond }) => {
        const p = (params ?? {}) as Record<string, unknown>;
        const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : "";
        const line = typeof p.line === "string" ? p.line.trim() : "";
        const reaction = p.reaction as TapReaction;
        if (
          !sessionKey.startsWith(TINKER_PREFIX) ||
          !line ||
          line.length > 2000 ||
          !TAP_REACTIONS.includes(reaction)
        ) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: `need sessionKey (${TINKER_PREFIX}…), line, reaction (${TAP_REACTIONS.join(" | ")})`,
          });
          return;
        }
        const out = applyTap(recentSpokenLines, { sessionKey, line, reaction, now: Date.now() });
        recentSpokenLines = out.rows.slice(-RECENT_KEEP);
        writeHumorState(runtime, trigger, turnCount, recentSpokenLines);
        api.logger.info(`[computational-humor] tap ${reaction} on "${line.slice(0, 60)}"`);
        if (out.row.isJoke === undefined) {
          void judgeLine(sessionKey, line);
        }
        respond(true, { row: out.row }, undefined);
      },
      { scope: "operator.write" },
    );

    api.logger.info(
      `[computational-humor] ready (frequency=${frequency}, sensitivity=${sensitivityThreshold})`,
    );
  },
});
