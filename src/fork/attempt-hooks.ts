import { readFileSync } from "node:fs";
/**
 * FORK: All custom wiring for attempt.ts lives here.
 *
 * Instead of scattering 10+ imports and inline code blocks throughout
 * the upstream attempt.ts, this module exports hook functions that
 * attempt.ts calls at defined injection points.
 *
 * On upstream merge: accept upstream attempt.ts, re-add the single
 * import and hook calls. This file never conflicts.
 */
import { join } from "node:path";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { insertAnatomyEvent, updateAnatomyResponse } from "../agents/context-anatomy-db.js";
import { buildContextAnatomy } from "../agents/context-anatomy.js";
import {
  extractRawAssistantText,
  extractTextToolCalls,
  executeTextToolCalls,
  formatTextToolResults,
} from "../agents/embedded-agent-runner/text-tool-calls.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { createCortexRuntime, getCortexRuntime } from "../agents/pi-extensions/cortex-runtime.js";
import { getIngestionRuntime } from "../agents/pi-extensions/ingestion-runtime.js";
import { getLinkBuilderRuntime } from "../agents/pi-extensions/link-builder-runtime.js";
import {
  applyMidContextReinject,
  evaluateTurnSyncScore,
} from "../agents/pi-extensions/mid-context-reinject.js";
import { getObservationRuntime } from "../agents/pi-extensions/observation-runtime.js";
import { getRetrievalRuntime } from "../agents/pi-extensions/retrieval-runtime.js";
import type { SerializedTree } from "../agents/reasoning-tree.js";
import { captureForensicDump, finalizeForensicRun } from "../forensic/dump-writer.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { recordAlgorithmOutcome } from "../infra/algorithm-metrics.js";
import { declareInstrument, noteInstrumentFired } from "../infra/instrument-liveness.js";
import { estimateTokens } from "../memory/engram/event-store.js";
import type { MemoryEvent } from "../memory/engram/event-types.js";
import type { ContextCache, CompactionBudgets } from "../memory/engram/pointer-compaction.js";
import { pointerCompact, estimateCacheTokens } from "../memory/engram/pointer-compaction.js";
import { renderMarkers } from "../memory/engram/time-range-marker.js";
import { appendGap, detectUncertaintySpans, extractTopic, makeGap } from "./curiosity-store.js";

// FORK 2026-07-28 — LIVENESS. Two instruments on this file's traffic path declare themselves
// here, at module scope, and fire at the line where the work ACTUALLY happens (see
// infra/instrument-liveness.ts: declaring is a static property, being on the traffic path is a
// dynamic one, and only the second is worth anything).
//
// `eeg:anatomy-write` is bound to the insert inside `onTurnComplete`, deliberately NOT to
// `emitPrePromptAnatomy` further down — that function also calls `insertAnatomyEvent`, but it
// has ZERO callers (attempt.ts never wires it; the comment at the onTurnComplete insert admits
// as much). Instrumenting the orphan would declare an instrument that can only ever read NEVER,
// i.e. reproduce the exact defect this registry exists to catch.
declareInstrument({
  id: "eeg:anatomy-write",
  kind: "hook",
  description: "context-anatomy row reaching SQLite on turn completion",
});
declareInstrument({
  id: "engram:retrieval-pack-inject",
  kind: "producer",
  description: "per-turn engram retrieval pack injected into the system prompt",
});

// ---------------------------------------------------------------------------
// Cognitive feature-flag helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the given cognitive subsystem should run inline
 * (the default). Returns false when set to "extension" or "disabled",
 * meaning this code path should be skipped.
 */
function isInlineMode(subsystem: string): boolean {
  try {
    const { getRuntimeConfigSnapshot } = require("../config/config.js") as {
      getRuntimeConfigSnapshot: () => { config?: Record<string, unknown> } | undefined;
    };
    const cfg = getRuntimeConfigSnapshot()?.config as Record<string, unknown> | undefined;
    const fork = cfg?.fork as { cognitive?: Record<string, string> } | undefined;
    const mode = fork?.cognitive?.[subsystem];
    return mode !== "extension" && mode !== "disabled";
  } catch {
    return true; // safe fallback: inline
  }
}

// ---------------------------------------------------------------------------
// Hook: Persona block (before system prompt build)
// ---------------------------------------------------------------------------

/**
 * Load CortexRuntime from SOUL.md/persona-state.json and return the
 * Tier 1 persona block for system-prompt injection.
 * Called once per run, before buildEmbeddedSystemPrompt.
 *
 * FORK 2026-04-28 (bible §5.76): three-step resolution order so a
 * fresh-clone day-0 user gets the bundled JARVIS persona without any
 * workspace setup, while existing users with a workspace SOUL.md keep
 * it as the authoritative override.
 *
 *   1. Workspace `<effectiveWorkspace>/SOUL.md` (user override)
 *   2. Bundled `extensions/tinkerclaw-tinker-bridge/personas/jarvis-default.md`
 *   3. undefined (cortex disabled or both files missing)
 */
export function getPersonaBlock(effectiveWorkspace: string): string | undefined {
  if (!isInlineMode("cortex")) {
    return undefined;
  }
  // Step 1: workspace override.
  try {
    const soulPath = join(effectiveWorkspace, "SOUL.md");
    const rt = createCortexRuntime({ soulPath });
    const block = rt.getPersonaBlock();
    if (block) {
      return block;
    }
  } catch {
    /* fall through to bundled default */
  }
  // Step 2: bundled jarvis-default.md. We don't go through CortexRuntime here
  // because the bundled file is plain markdown, not a CORTEX state file —
  // CortexRuntime expects state-tracking semantics that the bundled default
  // doesn't carry. Read raw and return.
  try {
    const candidates = resolveBundledPersonaCandidates();
    for (const p of candidates) {
      try {
        const txt = readFileSync(p, "utf8");
        if (txt.trim().length > 0) {
          return txt;
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* both missing; return undefined */
  }
  return undefined;
}

function resolveBundledPersonaCandidates(): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.TINKERCLAW_PERSONA_DEFAULT;
  if (fromEnv) {
    candidates.push(fromEnv);
  }
  const bundleRoot = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  if (bundleRoot) {
    candidates.push(join(bundleRoot, "tinkerclaw-tinker-bridge", "personas", "jarvis-default.md"));
  }
  candidates.push(
    join(
      process.env.HOME ?? "/tmp",
      "src",
      "tinkerclaw",
      "extensions",
      "tinkerclaw-tinker-bridge",
      "personas",
      "jarvis-default.md",
    ),
  );
  return candidates;
}

// ---------------------------------------------------------------------------
// Hook: AMYGDALA Personality Nudge (before system prompt build)
// ---------------------------------------------------------------------------

/**
 * Load the latest personality nudge from the AMYGDALA nudge file.
 *
 * The nightly training writes personality drift analysis to a nudge file.
 * This hook reads it and returns adjustments for system prompt injection.
 * Falls back to static nudges from the target vector if no runtime data exists.
 *
 * Called once per run, alongside getPersonaBlock.
 */
/** Candidate paths for the AMYGDALA nudge file */
const AMYGDALA_NUDGE_PATHS = [
  join(process.env.HOME ?? "/tmp", ".openclaw/cognitive/personality-nudge.json"),
  join(process.cwd(), "data/amygdala/personality-nudge.json"),
  join(process.env.HOME ?? "/tmp", ".openclaw/workspace/data/amygdala/personality-nudge.json"),
];

export function getAmygdalaNudge(): string[] | undefined {
  if (!isInlineMode("amygdala")) {
    return undefined;
  }
  try {
    for (const nudgePath of AMYGDALA_NUDGE_PATHS) {
      try {
        const raw = readFileSync(nudgePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.adjustments) && data.adjustments.length > 0) {
          console.log(`[AMYGDALA] loaded ${data.adjustments.length} nudges from ${nudgePath}`);
          return data.adjustments;
        }
      } catch {
        // try next candidate
      }
    }
    console.log("[AMYGDALA] no nudge file found");
    return undefined;
  } catch (err) {
    console.log(`[AMYGDALA] error: ${String(err)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Hook: Mid-context re-injection (before prompt)
// ---------------------------------------------------------------------------

/**
 * ENGRAM Phase 1.2: Inject a retrieval pack of relevant past events
 * into the system prompt. Uses FTS search + recency boost + MMR dedup.
 */
/**
 * FORK 2026-05-12 — synchronous session-status transition on surface_error
 * (failures.md M10's open follow-up).
 *
 * The upstream embedded runner throws on `surface_error` without
 * persisting `session.status = "failed"` to disk. The recovery path
 * (`markRunningMainSessionsAsInterrupted` at gateway boot) catches it
 * eventually, but the on-disk state stays stale until the next reboot.
 * This hook is called from `run.ts` at the surface_error throw site
 * (one-line touch — the merge guardian wiring check enforces the call
 * survives upstream merges).
 *
 * FORK 2026-07-30 (the architect: "Grok is firing without stop") — the run.ts call site
 * only covers `stage:"prompt"`. A `stage:"assistant"` surface_error (an xAI
 * stream that dies mid-turn) throws from `handleAssistantFailover` and never
 * passed through here, so `status:"running"` survived on disk and the Tinker UI
 * re-lit the thinking indicator from every `sessions.list` poll — un-stoppable
 * until the next gateway boot. The reply runner now calls this at its terminal
 * "failed before reply" funnel, which covers EVERY pre-reply failure path
 * (prompt stage, assistant stage, and fallback exhaustion) rather than one
 * branch. See failures.md M10.
 *
 * Behaviour:
 *   - With `storePath`: marks that store only.
 *   - Otherwise scans every agent's `sessions.json` store under `<state>/agents/`.
 *   - Whichever store contains `sessionKey`, transition its entry from
 *     `status:"running"` → `status:"failed"` with `abortedLastRun:true`,
 *     `endedAt:Date.now()`.
 *   - Best-effort: a failure here never throws back — we DO NOT want to
 *     mask the original surface_error with a session-store I/O error.
 *
 * Round-trip-tested with `debug.simulate` (future: a `markFailed` mode).
 */
export async function markFailedOnSurfaceError(params: {
  sessionKey: string | undefined;
  reason: string;
  /**
   * FORK 2026-07-30 — when the caller already knows which store owns the
   * session (the reply runner does: `params.storePath`), mark it directly and
   * skip the scan. Omit it and we fall back to scanning every agent store.
   */
  storePath?: string;
  /**
   * FORK 2026-07-30 — pass `false` when recording a provider FAILURE rather than
   * a user abort, so the next turn is not prefixed with the "aborted by the
   * user" hint. See `markSessionFailed`.
   */
  abortedLastRun?: boolean;
}): Promise<void> {
  if (!params.sessionKey) return;
  try {
    const { markSessionFailed } = await import("../agents/main-session-restart-recovery.js");
    if (params.storePath) {
      await markSessionFailed({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        reason: params.reason,
        ...(params.abortedLastRun === undefined ? {} : { abortedLastRun: params.abortedLastRun }),
      }).catch(() => {
        // best-effort: never mask the caller's original failure
      });
      return;
    }
    const [{ resolveStateDir }, { resolveAgentSessionDirs }] = await Promise.all([
      import("../config/paths.js"),
      import("../agents/session-dirs.js"),
    ]);
    const stateDir = resolveStateDir();
    const sessionDirs = await resolveAgentSessionDirs(stateDir);
    const { default: pathMod } = await import("node:path");
    // Try each agent's store path; mark in the first one that contains
    // the sessionKey. markSessionFailed's internal guard (`status !== "running"`)
    // safely no-ops on stores that don't have the entry as running.
    for (const sessionsDir of sessionDirs) {
      const storePath = pathMod.join(sessionsDir, "sessions.json");
      await markSessionFailed({
        storePath,
        sessionKey: params.sessionKey,
        reason: params.reason,
        ...(params.abortedLastRun === undefined ? {} : { abortedLastRun: params.abortedLastRun }),
      }).catch(() => {
        // ignore per-store errors; we tried.
      });
    }
  } catch {
    // best-effort only — never block on the side effect
  }
}

export async function injectRetrievalPack(
  sessionManager: SessionManager,
  systemPromptText: string,
  query: string,
  log: { info: (msg: string) => void },
): Promise<string> {
  if (!isInlineMode("engram")) {
    return systemPromptText;
  }
  const rt = getRetrievalRuntime(sessionManager);
  console.log(
    `[ENGRAM] retrieval runtime lookup: ${rt ? "FOUND" : "NULL"}, assemble: ${!!rt?.assemble}`,
  );
  if (!rt?.assemble) {
    return systemPromptText;
  }
  try {
    const pack = await rt.assemble(query, RETRIEVAL_PACK_MAX_TOKENS);
    if (!pack) {
      return systemPromptText;
    }
    log.info(`engram: injected retrieval pack (${pack.length} chars)`);
    // FORK 2026-07-28 — fire HERE: `assemble()` returned a non-null pack and the very next
    // line concatenates it onto the system prompt. Firing at the `isInlineMode` guard above
    // would only prove this function was entered, not that anything reached the model — the
    // "registered means running" conflation instrument-liveness.ts exists to catch.
    noteInstrumentFired("engram:retrieval-pack-inject", `${pack.length} chars`);
    recordAlgorithmOutcome({
      algorithm: "retrieval",
      variant: "engram-fts+vector-mmr",
      outcome: "injected",
      // A real char count over content we hold — genuinely local-measured.
      metrics: { packChars: pack.length },
      provenance: { packChars: "local-measured" },
    });
    return systemPromptText + "\n\n" + pack;
  } catch (err) {
    log.info(`engram: retrieval pack failed: ${String(err)}`);
    return systemPromptText;
  }
}

/**
 * When the session-bound CortexRuntime's EWMA SyncScore drops below 0.6,
 * prepend the Tier 1A persona block to reinforce persona identity.
 * Returns the (possibly modified) system prompt text and whether it was applied.
 */
export function applyMidContextReinjectHook(
  sessionManager: SessionManager,
  systemPromptText: string,
  log: { info: (msg: string) => void },
): { systemPromptText: string; reinjected: boolean } {
  if (!isInlineMode("cortex")) {
    return { systemPromptText, reinjected: false };
  }
  const cortexRuntime = getCortexRuntime(sessionManager);
  const reinjectResult = applyMidContextReinject(cortexRuntime, systemPromptText);
  if (reinjectResult.reinjected) {
    log.info(
      `cortex: mid-context re-injection applied (ewma=${reinjectResult.ewmaScore.toFixed(3)} < 0.6)`,
    );
  }
  return {
    systemPromptText: reinjectResult.reinjected ? reinjectResult.systemPrompt : systemPromptText,
    reinjected: reinjectResult.reinjected,
  };
}

// ---------------------------------------------------------------------------
// Hook: Text-tool-call interception (after prompt, local providers only)
// ---------------------------------------------------------------------------

const TEXT_TOOL_CALL_MAX_RETRIES = 3;
const RETRIEVAL_PACK_MAX_TOKENS = 4096;
// How many recent messages to scan for observations — balances recall vs. processing cost
const RECENT_MESSAGES_WINDOW = 20;
// Every N turns, force observation extraction regardless of threshold
const OBSERVATION_FORCE_INTERVAL = 10;

// ---------------------------------------------------------------------------
// Per-run tool execution accumulator
// ---------------------------------------------------------------------------

/** Accumulates tool-exec-complete events per runId until round completion. */
const pendingToolExecs = new Map<
  string,
  Array<{
    name: string;
    toolCallId: string;
    inputChars?: number;
    outputChars?: number;
    durationMs?: number;
    isError?: boolean;
  }>
>();

// ---------------------------------------------------------------------------
// U10 — per-run reasoning-trace stash
// ---------------------------------------------------------------------------
//
// The pre-prompt thought search (maybeRunThoughtSearch, wired into attempt.ts)
// produces a SerializedTree, but the augmentation hook only returns the prompt
// string. To persist the trace in onTurnComplete we stash it by runId between
// the two seams — the same per-run-map pattern as pendingToolExecs above.
//
// HANDOFF: reasoning-runtime.ts owns maybeRunThoughtSearch and currently
// swallows the trace (it returns only the augmented prompt and takes no runId).
// Until that producer calls stashReasoningTrace(runId, trace), the consume path
// below is inert (no trace → no reasoning_tree_state event). Wiring the stash
// into the producer is a reasoning-runtime change, out of this seam's ownership.
const pendingReasoningTraces = new Map<string, SerializedTree>();

/** Stash a serialized reasoning tree for `runId` so onTurnComplete can persist it. */
export function stashReasoningTrace(runId: string, trace: SerializedTree | null): void {
  if (!runId || !trace) {
    return;
  }
  pendingReasoningTraces.set(runId, trace);
}

/** Take (and clear) the stashed reasoning tree for `runId`, or undefined if none. */
export function consumeReasoningTrace(runId: string): SerializedTree | undefined {
  const trace = pendingReasoningTraces.get(runId);
  pendingReasoningTraces.delete(runId);
  return trace;
}

/**
 * Extract the plain text of the last `user` message from a messages snapshot.
 * Handles both string content and the `{type:"text",text}` block array form.
 * Returns "" when there is no user message or no text content.
 */
export function extractLastUserText(messagesSnapshot: unknown[]): string {
  const lastUser = [...messagesSnapshot]
    .toReversed()
    .find((m) => (m as { role?: string }).role === "user") as
    | { role?: string; content?: unknown }
    | undefined;
  if (!lastUser?.content) {
    return "";
  }
  if (typeof lastUser.content === "string") {
    return lastUser.content;
  }
  if (Array.isArray(lastUser.content)) {
    return (lastUser.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// U2 (2a) — LCM uncertainty heuristic → curiosity gap
// ---------------------------------------------------------------------------

/**
 * Scan a completed turn's assistant texts for hedging / uncertainty (the
 * heuristic LCM path — no entropy model). On a hit, derive a topic from the
 * user's last message and append ONE deduped `lcm-entropy` Gap to the curiosity
 * buffer. Fire-and-forget safe: pure on the no-hit path, never throws.
 *
 * Returns the appended Gap id (for tests/observability) or null when no hedge
 * was detected.
 */
export function onCuriosityScan(
  assistantTexts: string[],
  ctx: { sessionKey?: string; runId?: string; lastUserMessage?: string; baseDir?: string },
): string | null {
  try {
    const finalText = (assistantTexts ?? []).join("\n");
    const spans = detectUncertaintySpans(finalText);
    if (spans.length === 0) {
      return null;
    }
    const topic = extractTopic(spans, ctx.lastUserMessage);
    const gap = makeGap({
      topic,
      source: "lcm-entropy",
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
      // A hedge in the model's own voice is a genuine, learnable gap the user
      // cared about (they just asked) — bias importance + user-relevance up,
      // learnability mid (we don't yet know how recoverable it is).
      importance: 0.7,
      userRelevance: 0.7,
      learnability: 0.5,
      adjacency: 0.5,
    });
    appendGap(gap, ctx.baseDir);
    return gap.id;
  } catch {
    // Curiosity scan must never break a turn.
    return null;
  }
}

/**
 * Detect and execute text-based tool calls from local providers that don't
 * use structured tool_calls. Returns true if any retries were performed.
 */
export async function interceptTextToolCalls(params: {
  provider: string;
  activeSession: {
    messages: Array<{ role: string; content?: unknown }>;
    steer: (text: string) => Promise<void>;
  };
  tools: unknown[];
  toolMetas: unknown[];
  promptError: unknown;
  aborted: boolean;
  abortSignal?: AbortSignal;
  abortable: <T>(p: Promise<T>) => Promise<T>;
  log: { info: (msg: string) => void };
}): Promise<{ promptError: unknown }> {
  const normalizedProvider = normalizeProviderId(params.provider);
  const isLocalProvider =
    normalizedProvider === "ollama" ||
    normalizedProvider === "lmstudio" ||
    normalizedProvider === "vllm";
  const madeStructuredToolCalls = (params.toolMetas as unknown[]).length > 0;

  if (
    params.promptError ||
    params.aborted ||
    (params.tools as unknown[]).length === 0 ||
    !isLocalProvider ||
    !madeStructuredToolCalls
  ) {
    return { promptError: params.promptError };
  }

  let promptError = params.promptError;
  for (let retryIndex = 0; retryIndex < TEXT_TOOL_CALL_MAX_RETRIES; retryIndex++) {
    const lastMsg = (params.activeSession.messages as Array<{ role: string; content?: unknown }>)
      .slice()
      .toReversed()
      .find((m) => m.role === "assistant");
    if (!lastMsg) {
      break;
    }

    const rawText = extractRawAssistantText(lastMsg as never);
    const textCalls = extractTextToolCalls(rawText);
    if (textCalls.length === 0) {
      break;
    }

    params.log.info(
      `text-tool-call: found ${textCalls.length} call(s) in assistant text (retry ${retryIndex + 1}/${TEXT_TOOL_CALL_MAX_RETRIES})`,
    );

    const results = await executeTextToolCalls(
      textCalls,
      params.tools as never,
      params.abortSignal,
    );
    const formatted = formatTextToolResults(results);

    try {
      await params.abortable(params.activeSession.steer(formatted));
    } catch (steerErr) {
      promptError = steerErr;
      break;
    }
  }
  return { promptError };
}

// ---------------------------------------------------------------------------
// Hook: Pre-prompt anatomy (emit anatomy event BEFORE LLM call)
// ---------------------------------------------------------------------------

/**
 * Build and write the context anatomy event before the LLM prompt fires.
 * This lets the Tinker UI show the real colorful bar immediately instead of
 * waiting for the full response. Response tokens are unknown at this point
 * and will be zero.
 */
export async function emitPrePromptAnatomy(params: {
  runId: string;
  sessionKey?: string;
  messagesSnapshot: unknown[];
  systemPromptReport?: unknown;
  provider: string;
  modelId: string;
  modelApi?: string;
  contextWindowTokens?: number;
  getCompactionCount?: () => number | null;
  systemPromptText?: string;
  tools?: unknown[];
  effectivePrompt?: string;
  authProfileId?: string;
  roundNumber?: number;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  if (!params.sessionKey) {
    return;
  }

  // 1. Anatomy event (token breakdown for timeline bar)
  //    Insert into SQLite + push over WebSocket so the UI renders the bar instantly.
  if (params.systemPromptReport) {
    try {
      const turnNumber = params.messagesSnapshot.filter(
        (m) => (m as { role?: string }).role === "user",
      ).length;
      const anatomy = buildContextAnatomy({
        turn: turnNumber,
        compactionCycle: params.getCompactionCount?.() ?? 0,
        provider: params.provider,
        model: params.modelId,
        sessionKey: params.sessionKey,
        systemPromptReport: params.systemPromptReport as never,
        messagesSnapshot: params.messagesSnapshot as never,
        contextWindowTokens: params.contextWindowTokens ?? 0,
        authProfileId: params.authProfileId,
        roundNumber: params.roundNumber,
      });
      if (anatomy) {
        anatomy.runId = params.runId;
        anatomy.sessionKey = anatomy.sessionKey ?? params.sessionKey;
        insertAnatomyEvent(anatomy);
        // Push anatomy to UI immediately via WebSocket — no polling delay
        emitAgentEvent({
          runId: params.runId,
          stream: "lifecycle",
          data: {
            phase: "context-anatomy",
            sessionKey: params.sessionKey,
            anatomy,
          },
        });
      }
    } catch (err) {
      params.log.warn(`pre-prompt anatomy failed: ${String(err)}`);
    }
  }

  // 2. Forensic dump (full text for treemap drill-down)
  //    Fire-and-forget — don't block the LLM call or anatomy delivery.
  if (params.systemPromptText != null && params.effectivePrompt != null) {
    captureForensicDump({
      runId: params.runId,
      sessionKey: params.sessionKey,
      model: params.modelId,
      provider: params.provider,
      modelApi: params.modelApi ?? params.provider,
      systemPrompt: params.systemPromptText,
      messages: params.messagesSnapshot,
      tools: params.tools ?? [],
      effectivePrompt: params.effectivePrompt,
    }).catch((err) => {
      params.log.warn(`pre-prompt forensic dump failed: ${String(err)}`);
    });
  }
}

/**
 * FORK 2026-06-04 (Stream C — forensic map permanently empty): standalone
 * pre-prompt forensic-dump capture, wired directly into attempt.ts right
 * before `activeSession.prompt(...)`. The pre-existing `emitPrePromptAnatomy`
 * export above ALSO calls `captureForensicDump`, but that whole function is
 * dead (never invoked from attempt.ts — the anatomy insert was moved into
 * `onTurnComplete`), so the forensic store (`sessionRuns` in dump-writer.ts)
 * was never populated and every `forensic.getLive*` RPC returned NO_DATA.
 *
 * This hook captures ONLY the forensic dump (NOT anatomy — onTurnComplete owns
 * that) so the L3 treemap drill-down + `forensic.summarize` have real data.
 * It receives the POST-deliberation system-prompt bytes actually sent to the
 * model so the dump reflects the exact request. Fire-and-forget; never throws.
 */
export function captureForensicDumpHook(params: {
  runId: string;
  sessionKey?: string;
  model: string;
  provider: string;
  modelApi?: string;
  systemPromptText: string;
  messages: unknown[];
  tools?: unknown[];
  effectivePrompt: string;
  log: { warn: (msg: string) => void };
}): void {
  if (!params.sessionKey) {
    return;
  }
  captureForensicDump({
    runId: params.runId,
    sessionKey: params.sessionKey,
    model: params.model,
    provider: params.provider,
    modelApi: params.modelApi ?? params.provider,
    systemPrompt: params.systemPromptText,
    messages: params.messages,
    tools: params.tools ?? [],
    effectivePrompt: params.effectivePrompt,
  }).catch((err) => {
    params.log.warn(`pre-prompt forensic dump (hook) failed: ${String(err)}`);
  });
}

// ---------------------------------------------------------------------------
// Hook: Round-level event emission (per LLM API call + tool execution)
// ---------------------------------------------------------------------------

/**
 * Emit a round-start event immediately before each LLM API call.
 * This tells the Tinker UI to show a new bar in the timeline.
 */
export function emitRoundStart(params: {
  runId: string;
  sessionKey?: string;
  roundNumber: number;
  turnNumber: number;
  model: string;
  provider: string;
  authProfileId?: string;
  inputTokensEstimate: number;
  toolsAvailable: number;
}): void {
  if (!params.sessionKey) {
    return;
  }
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: {
      phase: "round-start",
      sessionKey: params.sessionKey,
      roundNumber: params.roundNumber,
      turnNumber: params.turnNumber,
      model: params.model,
      provider: params.provider,
      authProfileId: params.authProfileId,
      inputTokensEstimate: params.inputTokensEstimate,
      toolsAvailable: params.toolsAvailable,
      timestampMs: Date.now(),
    },
  });
}

/**
 * Emit a round-complete event after an LLM API call finishes (streaming done).
 * This tells the Tinker UI to show the purple response bar.
 */
export function emitRoundComplete(params: {
  runId: string;
  sessionKey?: string;
  roundNumber: number;
  turnNumber: number;
  model: string;
  provider: string;
  outputTokens?: number;
  inputTokens?: number;
  stopReason?: string;
  durationMs: number;
  toolCallsRequested: number;
}): void {
  if (!params.sessionKey) {
    return;
  }
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: {
      phase: "round-complete",
      sessionKey: params.sessionKey,
      roundNumber: params.roundNumber,
      turnNumber: params.turnNumber,
      model: params.model,
      provider: params.provider,
      outputTokens: params.outputTokens,
      inputTokens: params.inputTokens,
      stopReason: params.stopReason,
      durationMs: params.durationMs,
      toolCallsRequested: params.toolCallsRequested,
      timestampMs: Date.now(),
    },
  });
  const toolsTriggered = pendingToolExecs.get(params.runId);
  pendingToolExecs.delete(params.runId);
  updateAnatomyResponse(params.runId, params.roundNumber, {
    responseTokens: params.outputTokens,
    durationMs: params.durationMs,
    stopReason: params.stopReason,
    toolsTriggered: toolsTriggered ?? [],
  });
}

/**
 * Emit tool execution start/complete events for timeline detail.
 */
export function emitToolExec(params: {
  runId: string;
  sessionKey?: string;
  roundNumber: number;
  phase: "tool-exec-start" | "tool-exec-complete";
  toolName: string;
  toolCallId: string;
  inputChars?: number;
  outputChars?: number;
  durationMs?: number;
  isError?: boolean;
}): void {
  if (!params.sessionKey) {
    return;
  }
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: {
      phase: params.phase,
      sessionKey: params.sessionKey,
      roundNumber: params.roundNumber,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      inputChars: params.inputChars,
      outputChars: params.outputChars,
      durationMs: params.durationMs,
      isError: params.isError,
      timestampMs: Date.now(),
    },
  });
  if (params.phase === "tool-exec-complete") {
    const list = pendingToolExecs.get(params.runId) ?? [];
    list.push({
      name: params.toolName,
      toolCallId: params.toolCallId,
      inputChars: params.inputChars,
      outputChars: params.outputChars,
      durationMs: params.durationMs,
      isError: params.isError,
    });
    pendingToolExecs.set(params.runId, list);

    // AMYGDALA shadow logging (async, fire-and-forget, never blocks)
    amygdalaShadowLog({
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      isError: params.isError,
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Hook: Post-turn side effects (after agent turn completes)
// ---------------------------------------------------------------------------

export interface PostTurnParams {
  runId: string;
  sessionManager: SessionManager;
  sessionKey?: string;
  messagesSnapshot: unknown[];
  assistantTexts: string[];
  systemPromptReport?: unknown;
  provider: string;
  modelId: string;
  contextWindowTokens?: number;
  getCompactionCount?: () => number | null;
  getUsageTotals?:
    | (() =>
        | {
            total?: number;
            output?: number;
            input?: number;
            cacheRead?: number;
            cacheWrite?: number;
          }
        | undefined)
    | null;
  authProfileId?: string;
  /**
   * Reasoning effort this turn ran at ("off" | "low" | "medium" | "high" | "xhigh" | …).
   *
   * Recorded into anatomy_events.effort. Without it the table can say WHICH model answered but not
   * HOW HARD it was asked to think, so any comparison between two turns is silently comparing two
   * different experiments — the column existed from schema v4 and was NULL on every gateway row
   * until this was plumbed through.
   */
  thinkLevel?: string;
  heartbeatReason?: string;
  /** Channel/sender info for fractal inject routing */
  lastFrom?: string;
  lastTo?: string;
  lastChannel?: string;
  lastProvider?: string;
  lastAccountId?: string;
  lastThreadId?: string;
  log: { info: (msg: string) => void; warn: (msg: string) => void; debug: (msg: string) => void };
}

/**
 * Fire-and-forget post-turn processing:
 * - Context anatomy logging
 * - ENGRAM ingestion
 * - SyncScore evaluation
 * - Observational memory extraction
 */
export async function onTurnComplete(params: PostTurnParams): Promise<void> {
  const { sessionManager, messagesSnapshot, assistantTexts, log } = params;
  const turnNumber = messagesSnapshot.filter(
    (m) => (m as { role?: string }).role === "user",
  ).length;

  // FORK 2026-04-25: drain the tinker-bridge tool-event buffer into the session
  // transcript as `customType: "tinker-bridge-tool"` entries. tinker-bridge cannot
  // put tool_use blocks in the assistant message (pi-agent-core would
  // re-execute them and trip the prefrontal exec gate — see comment in
  // `extensions/tinkerclaw-tinker-bridge/src/stream.ts:buildContent`), so the
  // buffer is the only path that lets a Tinker history reload show what
  // tools claude-cli ran. Dynamic import keeps the runner free of a
  // hard dependency on the extension's runtime.
  //
  // The `sessionManager` cast at the call site (attempt.ts) is actually an
  // `activeSession` (AgentSession) — its `appendCustomEntry` lives on the
  // wrapped `.sessionManager` field, not directly on the agent. Resolve the
  // real SessionManager-like target here so we don't depend on the cast.
  try {
    const { consumeToolEventsForRun } =
      (await import("../../extensions/tinkerclaw-tinker-bridge/src/tool-buffer.js")) as typeof import("../../extensions/tinkerclaw-tinker-bridge/src/tool-buffer.js");
    const events = consumeToolEventsForRun(params.runId);
    if (events.length > 0) {
      const sm = sessionManager as unknown as {
        appendCustomEntry?: (customType: string, data?: unknown) => string;
        sessionManager?: { appendCustomEntry?: (customType: string, data?: unknown) => string };
      };
      const target = typeof sm.appendCustomEntry === "function" ? sm : sm.sessionManager;
      if (target && typeof target.appendCustomEntry === "function") {
        for (const ev of events) {
          // appendCustomEntry → "Extension state (not in context)" — perfect
          // for tool calls: persisted on disk, rendered by Tinker on history
          // reload, but NOT replayed into the LLM message array (which would
          // force pi-agent-core to re-validate them and double-bill).
          //
          // FORK (Mechanism A): the spread carries a START event's optional
          // `textOffset` (assistant-text char count before the tool fired)
          // straight into the persisted payload, so the read path can slice
          // the coalesced assistant text back into interleaved per-segment
          // messages. Backward-compatible: old buffered events lack the field,
          // so the entry simply omits `textOffset` and the read path falls
          // back to the legacy splice-before-text reorder.
          target.appendCustomEntry("tinker-bridge-tool", { runId: params.runId, ...ev });
        }
        log.info(
          `[tinker-bridge-tool] persisted ${events.length} tool events for runId=${params.runId}`,
        );
      } else {
        log.info(
          `[tinker-bridge-tool] drain skipped — no appendCustomEntry on sessionManager (events=${events.length})`,
        );
      }
    }
  } catch (err) {
    log.info(`[tinker-bridge-tool] drain failed: ${String(err)}`);
  }

  // FRACTAL REFLECTION v4 — moved to the `tinkerclaw-fractal-reflection`
  // plugin. The inline injection path used to live here, but it double-fired
  // when the plugin was also active. `fork.cognitive.fractal="extension"`
  // should be enough on its own; the inline `if (false && …)` fallback that
  // sat here previously was dead code (oxlint flagged the constant gate).
  // If the plugin path needs to be replaced, recover the inline body from
  // git history and re-enable behind a real runtime flag.

  // Context anatomy
  if (params.systemPromptReport && params.sessionKey) {
    try {
      const usageTotals = params.getUsageTotals?.();
      const contextAnatomy = buildContextAnatomy({
        turn: turnNumber,
        compactionCycle: params.getCompactionCount?.() ?? 0,
        provider: params.provider,
        model: params.modelId,
        sessionKey: params.sessionKey,
        systemPromptReport: params.systemPromptReport as never,
        messagesSnapshot: messagesSnapshot as never,
        contextWindowTokens: params.contextWindowTokens ?? 0,
        totalTokensUsed: usageTotals?.total,
        outputTokens: usageTotals?.output,
        authProfileId: params.authProfileId,
      });
      if (contextAnatomy) {
        // Effort is decided in the runner and was never carried this far, which is why every
        // gateway row had effort=NULL while Claude Code rows had it. Stamped here beside runId,
        // the same way that field is attached after the build.
        (contextAnatomy as unknown as Record<string, unknown>).effort = params.thinkLevel;
        // FORK 2026-07-25 (anatomy-cache-fix): pin an EXPLICIT round number on the
        // anatomy object BEFORE it is inserted. `buildContextAnatomy` is called
        // above WITHOUT `roundNumber`, so the row was written with
        // `round_number = NULL`; the later `updateAnatomyResponse(runId, 0, …)`
        // matches `WHERE run_id = ? AND round_number = ?`, and in SQLite
        // `NULL = 0` evaluates to NULL (never true) — so ZERO rows were updated
        // and cache_read_tokens / cache_creation_tokens stayed NULL for every
        // row written after 2026-03-26. Persisting the same value we later match
        // on makes the UPDATE hit its own row again.
        const anatomyRound = contextAnatomy.roundNumber ?? 0;
        contextAnatomy.roundNumber = anatomyRound;
        // Cache tokens are already known here (`usageTotals` was read above for
        // buildContextAnatomy) — attach them BEFORE the emit so the live UI event
        // actually carries the fields `AnatomyEvent` declares. Previously the emit
        // fired first and the cache read happened ~45 lines later, so the pushed
        // anatomy never had them. Only assign when defined, so a provider that
        // reports no cache usage leaves the fields absent instead of undefined.
        if (usageTotals?.cacheRead !== undefined) {
          contextAnatomy.cacheReadTokens = usageTotals.cacheRead;
        }
        if (usageTotals?.cacheWrite !== undefined) {
          contextAnatomy.cacheCreationTokens = usageTotals.cacheWrite;
        }
        // Push updated anatomy (now with response tokens) to UI
        emitAgentEvent({
          runId: params.runId,
          stream: "lifecycle",
          data: {
            phase: "context-anatomy",
            sessionKey: params.sessionKey,
            anatomy: contextAnatomy,
          },
        });
        // Insert the anatomy row here in onTurnComplete (emitPrePromptAnatomy is not wired into attempt.ts).
        // If emitPrePromptAnatomy is wired in the future, add a UNIQUE(run_id, round_number) constraint
        // and switch to INSERT OR REPLACE to avoid duplicates.
        contextAnatomy.runId = params.runId;
        contextAnatomy.sessionKey = contextAnatomy.sessionKey ?? params.sessionKey;

        // Capture user message (last user message from conversation)
        const MAX_STORED_CHARS = 50_000;
        const lastUserMsg = [...messagesSnapshot]
          .toReversed()
          .find((m) => (m as { role?: string }).role === "user") as
          | { role?: string; content?: unknown }
          | undefined;
        if (lastUserMsg?.content) {
          let userText = "";
          if (typeof lastUserMsg.content === "string") {
            userText = lastUserMsg.content;
          } else if (Array.isArray(lastUserMsg.content)) {
            userText = (lastUserMsg.content as Array<{ type?: string; text?: string }>)
              .filter((c) => c.type === "text" && c.text)
              .map((c) => c.text!)
              .join("\n");
          }
          if (userText) {
            contextAnatomy.userMessage = userText.slice(0, MAX_STORED_CHARS);
          }
        }

        // Capture assistant response
        if (assistantTexts.length > 0) {
          const responseText = assistantTexts.join("\n");
          contextAnatomy.assistantResponse = responseText.slice(0, MAX_STORED_CHARS);
        }

        insertAnatomyEvent(contextAnatomy);
        // FORK 2026-07-28 — fire AFTER the row reaches SQLite, so the instrument attests to the
        // write rather than to having entered the block. This is the LIVE anatomy writer;
        // `emitPrePromptAnatomy` above is orphaned and is deliberately left uninstrumented.
        noteInstrumentFired(
          "eeg:anatomy-write",
          `turn=${turnNumber} round=${anatomyRound} session=${params.sessionKey ?? "?"}`,
        );
        // PARTS only — never a fill ratio (algorithm-metrics rule 2); `windowTokens` rides
        // along as the denominator so a later analysis can sanity-check its own ratio.
        // These token figures come from `estimateTokens(chars)` (ceil(chars/3.5), documented in
        // context-anatomy.ts as "good enough for anatomy — not billing"), so their provenance is
        // "estimated": recording a heuristic as a measurement is precisely rule 3's failure.
        recordAlgorithmOutcome({
          algorithm: "context-budget",
          variant: "anatomy-split",
          outcome: "observed",
          metrics: {
            systemPromptTokens: contextAnatomy.contextSent.systemPromptTokens,
            toolSchemaTokens: contextAnatomy.contextSent.toolSchemasTokens,
            historyTokens: contextAnatomy.contextSent.conversationHistoryTokens,
            windowTokens: contextAnatomy.contextWindow.maxTokens,
          },
          provenance: {
            systemPromptTokens: "estimated",
            toolSchemaTokens: "estimated",
            historyTokens: "estimated",
            windowTokens: "local-measured",
          },
          sessionKey: params.sessionKey,
          model: params.modelId,
          provider: params.provider,
        });
        // Update cache/response token columns on the row we just inserted.
        // Reuses the SINGLE `usageTotals` read from the top of this block (a
        // second `getUsageTotals()` call could observe different totals) and the
        // SAME `anatomyRound` that was actually persisted, so the
        // `WHERE run_id = ? AND round_number = ?` predicate matches its row.
        if (params.runId && usageTotals) {
          updateAnatomyResponse(params.runId, anatomyRound, {
            cacheReadTokens: usageTotals.cacheRead,
            cacheCreationTokens: usageTotals.cacheWrite,
          });
        }
      }
    } catch (err) {
      log.warn(`context-anatomy build failed: ${String(err)}`);
    }
  }

  // FORK 2026-06-04 (Stream C — forensic map permanently empty): finalize the
  // RESPONSE half of the forensic dump for this run. captureForensicDumpHook
  // (wired in attempt.ts before each prompt) records the REQUEST side into the
  // per-session forensic store; finalizeForensicRun walks those dumps + the
  // final messagesSnapshot to extract each call's response content blocks, so
  // the response treemap + `forensic.summarize {component:"response"}` work.
  // Fire-and-forget — never block post-turn processing. Matches the anatomy
  // wiring style above (onTurnComplete owns both response-side writes).
  if (params.sessionKey) {
    finalizeForensicRun(params.sessionKey, params.runId, messagesSnapshot).catch((err) => {
      log.warn(`forensic finalize failed: ${String(err)}`);
    });
  }

  // ENGRAM ingestion
  if (isInlineMode("engram")) {
    const ingestionRuntime = getIngestionRuntime(sessionManager);
    if (ingestionRuntime) {
      const countBefore = (() => {
        try {
          return ingestionRuntime.eventStore.count();
        } catch {
          return null;
        }
      })();
      ingestionRuntime
        .ingest(params.messagesSnapshot as never)
        .then(() => {
          // U8: reconciliation summary line, gated behind ENGRAM_RECONCILE.
          // The reconciler runs INSIDE ingestion.ts (decideSync ADD/NONE on the
          // hot path); here we just surface how many events actually landed vs.
          // were skipped by the reconciler, so the autonomy run leaves a trail.
          if (process.env.ENGRAM_RECONCILE === "true" && countBefore != null) {
            try {
              const countAfter = ingestionRuntime.eventStore.count();
              const added = countAfter - countBefore;
              log.info(
                `[engram-reconcile] turn=${turnNumber} events added=${added} (store=${countAfter})`,
              );
            } catch {
              /* count read failed — non-fatal */
            }
          }

          // U9: A-MEM Zettelkasten auto-linking. After the turn's events are
          // ingested, fire-and-forget extract + index mentions from the latest
          // assistant + user text so backlinks are available for retrieval.
          // Skipped silently when no link builder is registered for the session.
          try {
            const linkBuilder = getLinkBuilderRuntime(sessionManager);
            if (linkBuilder) {
              const linkContent = [extractLastUserText(messagesSnapshot), assistantTexts.join("\n")]
                .filter((t) => t && t.trim())
                .join("\n");
              if (linkContent.trim()) {
                // The ingestion cursor doesn't surface per-event ids here, so
                // key the link records to this run (stable, queryable source id).
                const eventId = `turn:${params.runId}:${turnNumber}`;
                Promise.resolve()
                  .then(() => linkBuilder.extractAndIndex(eventId, linkContent))
                  .catch((err) => log.warn(`[link-builder] index failed: ${String(err)}`));
              }
            }
          } catch (err) {
            log.warn(`[link-builder] dispatch failed: ${String(err)}`);
          }
        })
        .catch((err) => {
          log.warn(`ENGRAM ingestion failed: ${String(err)}`);
        });
    }
  }

  // U2 (2a): LCM uncertainty heuristic — scan the completed reply for hedging
  // and append a curiosity gap on detection. Fire-and-forget, never throws.
  if (isInlineMode("engram")) {
    const gapId = onCuriosityScan(assistantTexts, {
      sessionKey: params.sessionKey,
      runId: params.runId,
      lastUserMessage: extractLastUserText(messagesSnapshot),
    });
    if (gapId) {
      log.debug(`[curiosity] lcm-entropy gap recorded (${gapId}) at turn=${turnNumber}`);
    }
  }

  // U10: persist the pre-prompt reasoning trace (if a thought search ran this
  // turn) as a reasoning_tree_state MemoryEvent. Fire-and-forget; inert when no
  // trace was stashed (the default — ToT is opt-in). NOT a fractal trigger.
  if (params.sessionKey) {
    try {
      const trace = consumeReasoningTrace(params.runId);
      if (trace) {
        const ingestionRuntime = getIngestionRuntime(sessionManager);
        if (ingestionRuntime) {
          const content = JSON.stringify(trace);
          ingestionRuntime.eventStore.append({
            turnId: turnNumber,
            sessionKey: params.sessionKey,
            kind: "reasoning_tree_state",
            content,
            tokens: estimateTokens(content),
            // Meta trace, below agent_message (5) — useful but not hot-path.
            metadata: { importance: 4 },
          });
          log.debug(
            `[reasoning] persisted reasoning_tree_state (nodes=${trace.nodes.length}) at turn=${turnNumber}`,
          );
        }
      }
    } catch (err) {
      log.warn(`[reasoning] trace persist failed: ${String(err)}`);
    }
  }

  // SyncScore evaluation
  if (isInlineMode("cortex")) {
    const cortexRuntime = getCortexRuntime(sessionManager);
    evaluateTurnSyncScore(cortexRuntime, assistantTexts, turnNumber, (msg) => log.info(msg));
  }

  // Observational memory extraction
  if (isInlineMode("observation")) {
    const observationRuntime = getObservationRuntime(sessionManager);
    if (observationRuntime) {
      const recentTexts = messagesSnapshot.slice(-RECENT_MESSAGES_WINDOW).flatMap((rawMsg) => {
        const m = rawMsg as { role?: string; content?: unknown };
        if (!m.content) {
          return [];
        }
        if (typeof m.content === "string") {
          return m.content ? [m.content] : [];
        }
        if (Array.isArray(m.content)) {
          return (m.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .filter(Boolean);
        }
        return [];
      });

      if (recentTexts.length > 0) {
        const forceByTurn = turnNumber > 0 && turnNumber % OBSERVATION_FORCE_INTERVAL === 0;
        const threshold = forceByTurn ? 1 : undefined;

        const extracted = observationRuntime.extractObservations(recentTexts, threshold);
        if (extracted.length > 0) {
          log.debug(
            `cortex: extracted ${extracted.length} observation(s) at turn=${turnNumber} (forced=${forceByTurn})`,
          );
        }
      }
    }
  }

  // FORK 2026-05-31: THE OVERSEER — after a real Jarvis turn, run one bounded critic
  // cycle. Fire-and-forget + fully guarded: inert unless the `overseer` recipe activated
  // this session, never throws, never blocks the turn (see src/fork/overseer-runtime.ts).
  void (async () => {
    try {
      const { maybeRunOverseerFromHook } = await import("./overseer-runtime.js");
      await maybeRunOverseerFromHook(params.sessionKey, params.messagesSnapshot);
    } catch (err) {
      log.warn(`[overseer] hook dispatch failed (non-fatal): ${String(err)}`);
    }
  })();

  // FORK 2026-05-31: re-arm the idle goal-generation timer (J8 2d). Synchronous + guarded;
  // a NON-intrusive curiosity proposal fires only if the session then stays quiet past the
  // threshold (CURIOSITY_IDLE_MS, default 30m). See src/fork/idle-goals.ts.
  void (async () => {
    try {
      const { noteTurnActivity } = await import("./idle-goals.js");
      noteTurnActivity(params.sessionKey);
    } catch (err) {
      log.warn(`[idle-goals] arm failed (non-fatal): ${String(err)}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// Hook: Fractal Reflection (post-turn depth climbing)
// ---------------------------------------------------------------------------

/**
 * ⚠️ DEAD (v3) — SUPERSEDED by the `tinkerclaw-fractal-reflection` plugin (v4, gated by
 * `fork.cognitive.fractal="extension"`). This in-process injector no longer fires: the inline
 * caller was removed as dead code (see the "FRACTAL REFLECTION v4 — moved to the plugin" note
 * earlier in this file, ~line 879). Kept only for git-history reference.
 *
 * ➡️ The LIVE fractal prompt is `extensions/tinkerclaw-fractal-reflection/fractal-prompt.md` —
 *    edit THERE. `src/fork/fractal-prompt.md` is now just a MOVED-pointer stub.
 *
 * Historical v3 (2026-03-28): in-process enqueueSystemEvent() + requestHeartbeatNow(); FIFO
 * system-event queue so fractal fired before pending user messages; loop-prevention via session
 * type check. (v1: `openclaw system event` CLI raced with user messages; v2: disabled.)
 */

let _fractalPromptCache: string | null = null;

/** Candidate paths for the fractal prompt (source → workspace → fallback) */
const FRACTAL_PROMPT_PATHS = [
  // Source tree (development)
  join(process.cwd(), "src/fork/fractal-prompt.md"),
  // Workspace (production — workspace is always at this path)
  join(process.env.HOME ?? "/tmp", ".openclaw/workspace/src/fork/fractal-prompt.md"),
];

function loadFractalPrompt(): string {
  if (_fractalPromptCache) {
    return _fractalPromptCache;
  }
  for (const candidatePath of FRACTAL_PROMPT_PATHS) {
    try {
      _fractalPromptCache = readFileSync(candidatePath, "utf-8").trim();
      return _fractalPromptCache;
    } catch {
      // try next
    }
  }
  // Hard fallback — should never reach here in production
  _fractalPromptCache =
    "FRACTAL REFLECTION: Reflect on the previous turn. What pattern does it belong to? Write any insights to memory.";
  return _fractalPromptCache;
}

/** Sessions that should NOT get fractal reflection (prevents infinite loops) */
function isAutomatedSession(sessionKey: string): boolean {
  return (
    sessionKey.includes("subagent:") ||
    sessionKey.includes("isolated:") ||
    sessionKey.includes("cron:") ||
    sessionKey.includes("heartbeat")
  );
}

export function maybeTriggerFractalReflection(
  assistantTexts: string[],
  sessionKey: string | undefined,
  log: { info: (msg: string) => void },
  heartbeatReason?: string,
): void {
  if (!isInlineMode("fractal")) {
    return;
  }
  if (!sessionKey) {
    return;
  }

  // Skip automated sessions (cron, sub-agents, heartbeats) to prevent loops
  if (isAutomatedSession(sessionKey)) {
    log.info("[fractal] skipped — automated session");
    return;
  }

  const fullResponse = assistantTexts.join("\n").trim();

  // Skip if this turn was itself triggered by a fractal reflection.
  // Check both the explicit reason (if wired) and the response content.
  if (heartbeatReason?.includes("fractal")) {
    log.info("[fractal] skipped — heartbeat reason is fractal");
    return;
  }
  // Fallback detection: if the assistant's response contains fractal reflection
  // markers, this IS a fractal pass — don't re-trigger.
  if (fullResponse.includes("🌿") && fullResponse.includes("Level 2")) {
    log.info("[fractal] skipped — response contains fractal markers (self-detection)");
    return;
  }
  if (fullResponse === "NO_REPLY" || fullResponse === "HEARTBEAT_OK") {
    log.info("[fractal] skipped — silent reply");
    return;
  }

  const prompt = loadFractalPrompt();

  // FORK 2026-08-05 — was: write the prompt to /tmp/openclaw-fractal-prompt.txt, then run
  //   exec(`openclaw system event --text "$(cat ${tmpPath})" --mode now`, {shell: "/bin/bash"})
  // Three problems, none of which needed to exist:
  //
  // 1. THE STATED REASON WAS FALSE. The comment said the prompt was "too large for CLI --text".
  //    It is 811 bytes (src/fork/fractal-prompt.md) — the extension's copy is 7,120 — against a
  //    per-argument limit of 131,072. An assumption nobody re-measured, which then justified a
  //    shell and a temp file for years.
  // 2. A PREDICTABLE PATH IN A WORLD-WRITABLE DIRECTORY. Any local process could rewrite
  //    /tmp/openclaw-fractal-prompt.txt between the write and the `cat`, substituting its own
  //    text into a prompt this agent then acts on. Prompt injection through the filesystem, no
  //    privileges required.
  // 3. A SHELL ON THE PATH FOR NO GAIN. `$(cat …)` output is not re-scanned by bash, so this was
  //    not itself exploitable — but it kept a /bin/bash on a hot path where one edit to tmpPath
  //    would have made it so, which is exactly how git-cache.ts launched /usr/bin/orca on this
  //    host on 2026-08-05. Flagged by scripts/check-shell-interpolation.mjs on its first run.
  //
  // argv array, no shell, no temp file: all three disappear at once.
  const MAX_ARG_BYTES = 100_000; // headroom under Linux MAX_ARG_STRLEN (131_072)
  if (Buffer.byteLength(prompt, "utf-8") > MAX_ARG_BYTES) {
    log.info(
      `[fractal] prompt too large to pass as an argument (${prompt.length} chars) — skipped`,
    );
    return;
  }

  const { execFile } = require("node:child_process");
  execFile(
    "openclaw",
    ["system", "event", "--text", prompt, "--mode", "now"],
    { timeout: 10_000 },
    (err: Error | null) => {
      if (err) {
        log.info(`[fractal] system event injection failed: ${err.message}`);
      }
    },
  );

  log.info("[fractal] reflection injected via system event (argv, no shell)");
}

// ---------------------------------------------------------------------------
// Hook: Pointer-based compaction (ENGRAM Phase 1B)
// ---------------------------------------------------------------------------

/**
 * Feature flag: set ENGRAM_POINTER_COMPACTION=1 to enable.
 */
function isPointerCompactionEnabled(): boolean {
  // Default to enabled in tinkerclaw fork; set ENGRAM_POINTER_COMPACTION=0 to disable.
  return process.env["ENGRAM_POINTER_COMPACTION"] !== "0";
}

/**
 * Convert SDK messages to MemoryEvents for pointer compaction.
 * Uses already-ingested events when available, falls back to mapping messages directly.
 */
function messagesToMemoryEvents(
  messages: Array<{ role: string; content?: unknown }>,
  sessionKey: string,
): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  let turnId = 0;

  for (const msg of messages) {
    if (msg.role === "user") {
      turnId++;
    }

    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as Array<{ type?: string; text?: string }>)
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text as string)
              .join("")
          : "";

    if (!text) {
      continue;
    }

    const kind =
      msg.role === "user"
        ? "user_message"
        : msg.role === "assistant"
          ? "agent_message"
          : msg.role === "toolResult"
            ? "tool_result"
            : "system_event";

    events.push({
      id: `ptr-${events.length}`,
      timestamp: new Date().toISOString(),
      turnId,
      sessionKey,
      kind: kind as MemoryEvent["kind"],
      content: text,
      tokens: estimateTokens(text),
      metadata: { importance: 5 },
    });
  }

  return events;
}

export interface PointerCompactionResult {
  /** Whether compaction was performed. */
  compacted: boolean;
  /** New messages array with markers injected, or null if not compacted. */
  messages: Array<{ role: string; content: unknown }> | null;
  /** Number of events evicted. */
  eventsEvicted: number;
  /** Tokens freed. */
  tokensFreed: number;
}

/**
 * Attempt pointer-based compaction on the session messages.
 * Returns the compacted message list with time-range markers,
 * or { compacted: false } if not enabled or nothing to evict.
 *
 * Called from run.ts BEFORE narrative compaction.
 */
export function tryPointerCompaction(
  sessionManager: SessionManager,
  messages: Array<{ role: string; content?: unknown }>,
  contextWindowTokens: number,
  sessionKey: string,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): PointerCompactionResult {
  if (!isPointerCompactionEnabled()) {
    return { compacted: false, messages: null, eventsEvicted: 0, tokensFreed: 0 };
  }

  const ingestionRuntime = getIngestionRuntime(sessionManager);
  const eventStore = ingestionRuntime?.eventStore ?? null;

  // Build context cache from messages
  const events = messagesToMemoryEvents(messages, sessionKey);
  if (events.length === 0) {
    return { compacted: false, messages: null, eventsEvicted: 0, tokensFreed: 0 };
  }

  const cache: ContextCache = { events: [...events], markers: [] };
  const tokensBefore = estimateCacheTokens(cache);

  const budgets: CompactionBudgets = {
    ctx: contextWindowTokens,
    headroom: Math.floor(contextWindowTokens * 0.2), // 20% headroom
    hotTailTurns: 3,
    markerSoftCap: 15,
  };

  try {
    const cycles = pointerCompact(cache, budgets, eventStore ?? undefined);
    if (cycles === 0) {
      return { compacted: false, messages: null, eventsEvicted: 0, tokensFreed: 0 };
    }

    const tokensAfter = estimateCacheTokens(cache);
    const tokensFreed = tokensBefore - tokensAfter;
    const eventsEvicted = events.length - cache.events.length;

    log.info(
      `engram: pointer compaction completed — ${cycles} cycles, ${eventsEvicted} events evicted, ~${tokensFreed} tokens freed`,
    );

    // Rebuild messages: surviving events as messages + markers as system message
    const newMessages: Array<{ role: string; content: unknown }> = [];

    // Prepend markers as a system message
    const markersText = renderMarkers(cache.markers);
    if (markersText) {
      newMessages.push({
        role: "system",
        content: markersText,
      });
    }

    // Add surviving events back as messages
    for (const event of cache.events) {
      const role =
        event.kind === "user_message"
          ? "user"
          : event.kind === "agent_message"
            ? "assistant"
            : event.kind === "tool_result" || event.kind === "artifact_reference"
              ? "toolResult"
              : "system";
      newMessages.push({ role, content: event.content });
    }

    return {
      compacted: true,
      messages: newMessages,
      eventsEvicted,
      tokensFreed,
    };
  } catch (err) {
    log.warn(`engram: pointer compaction failed: ${String(err)}`);
    return { compacted: false, messages: null, eventsEvicted: 0, tokensFreed: 0 };
  }
}

// ---------------------------------------------------------------------------
// Hook: AMYGDALA shadow logging (Phase 1)
// Evaluates every tool execution through AMYGDALA and logs predictions.
// Does NOT block actions — shadow mode only (alpha = 0).
// ---------------------------------------------------------------------------
let amygdalaInitialized = false;
let amygdalaEnabled = false;

async function maybeInitAmygdala(): Promise<void> {
  if (amygdalaInitialized) {
    return;
  }
  amygdalaInitialized = true;
  try {
    const configPath = join(__dirname, "../amygdala/amygdala.config.json");
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    amygdalaEnabled = config.enabled === true;
    if (amygdalaEnabled) {
      console.log("[amygdala] Shadow mode active — logging predictions");
    }
  } catch {
    // Config not found or invalid — AMYGDALA stays disabled
    amygdalaEnabled = false;
  }
}

export async function amygdalaShadowLog(params: {
  toolName: string;
  toolCallId: string;
  inputSummary?: string;
  isError?: boolean;
}): Promise<void> {
  await maybeInitAmygdala();
  if (!amygdalaEnabled) {
    return;
  }

  try {
    // For now, log the tool execution as a situation template stub.
    // Full embedding + network evaluation will be wired once onnxruntime-node is verified.
    const { appendFile } = await import("node:fs/promises");
    const logLine =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        tool: params.toolName,
        toolCallId: params.toolCallId,
        inputChars: params.inputSummary?.length ?? 0,
        isError: params.isError ?? false,
        phase: "shadow",
        note: "AMYGDALA shadow log — prediction eval pending ONNX runtime setup",
      }) + "\n";
    await appendFile(join(__dirname, "../../data/amygdala/shadow-log.jsonl"), logLine);
  } catch {
    // Shadow logging should never crash the agent
  }
}
