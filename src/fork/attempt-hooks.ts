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
import { buildContextAnatomy, writeAnatomyEvent } from "../agents/context-anatomy.js";
import { captureForensicDump } from "../forensic/dump-writer.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  extractRawAssistantText,
  extractTextToolCalls,
  executeTextToolCalls,
  formatTextToolResults,
} from "../agents/pi-embedded-runner/text-tool-calls.js";
import { createCortexRuntime } from "../agents/pi-extensions/cortex-runtime.js";
import { getCortexRuntime } from "../agents/pi-extensions/cortex-runtime.js";
import { getIngestionRuntime } from "../agents/pi-extensions/ingestion-runtime.js";
import {
  applyMidContextReinject,
  evaluateTurnSyncScore,
} from "../agents/pi-extensions/mid-context-reinject.js";
import { getObservationRuntime } from "../agents/pi-extensions/observation-runtime.js";

// ---------------------------------------------------------------------------
// Hook: Persona block (before system prompt build)
// ---------------------------------------------------------------------------

/**
 * Load CortexRuntime from SOUL.md/persona-state.json and return the
 * Tier 1 persona block for system-prompt injection.
 * Called once per run, before buildEmbeddedSystemPrompt.
 */
export function getPersonaBlock(effectiveWorkspace: string): string | undefined {
  try {
    const soulPath = join(effectiveWorkspace, "SOUL.md");
    const rt = createCortexRuntime({ soulPath });
    return rt.getPersonaBlock() || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Hook: Mid-context re-injection (before prompt)
// ---------------------------------------------------------------------------

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
  for (let ttcRetry = 0; ttcRetry < TEXT_TOOL_CALL_MAX_RETRIES; ttcRetry++) {
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
      `text-tool-call: found ${textCalls.length} call(s) in assistant text (retry ${ttcRetry + 1}/${TEXT_TOOL_CALL_MAX_RETRIES})`,
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
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  if (!params.sessionKey) return;

  // 1. Anatomy event (token breakdown for timeline bar)
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
      });
      if (anatomy) {
        await writeAnatomyEvent(params.sessionKey, anatomy);
      }
    } catch (err) {
      params.log.warn(`pre-prompt anatomy failed: ${String(err)}`);
    }
  }

  // 2. Forensic dump (full text for treemap drill-down)
  if (params.systemPromptText != null && params.effectivePrompt != null) {
    try {
      await captureForensicDump({
        runId: params.runId,
        sessionKey: params.sessionKey,
        model: params.modelId,
        provider: params.provider,
        modelApi: params.modelApi ?? params.provider,
        systemPrompt: params.systemPromptText,
        messages: params.messagesSnapshot,
        tools: params.tools ?? [],
        effectivePrompt: params.effectivePrompt,
      });
    } catch (err) {
      params.log.warn(`pre-prompt forensic dump failed: ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Hook: Post-turn side effects (after agent turn completes)
// ---------------------------------------------------------------------------

export interface PostTurnParams {
  sessionManager: SessionManager;
  sessionKey?: string;
  messagesSnapshot: unknown[];
  assistantTexts: string[];
  systemPromptReport?: unknown;
  provider: string;
  modelId: string;
  contextWindowTokens?: number;
  getCompactionCount?: () => number | null;
  getUsageTotals?: (() => { total?: number; output?: number } | undefined) | null;
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
      });
      if (contextAnatomy) {
        writeAnatomyEvent(params.sessionKey, contextAnatomy).catch((err) => {
          log.warn(`context-anatomy write failed: ${String(err)}`);
        });
      }
    } catch (err) {
      log.warn(`context-anatomy build failed: ${String(err)}`);
    }
  }

  // ENGRAM ingestion
  const ingestionRuntime = getIngestionRuntime(sessionManager);
  if (ingestionRuntime) {
    ingestionRuntime.ingest(params.messagesSnapshot as never).catch((err) => {
      log.warn(`ENGRAM ingestion failed: ${String(err)}`);
    });
  }

  // SyncScore evaluation
  {
    const cortexRuntime = getCortexRuntime(sessionManager);
    evaluateTurnSyncScore(cortexRuntime, assistantTexts, turnNumber, (msg) => log.info(msg));
  }

  // Observational memory extraction
  {
    const observationRuntime = getObservationRuntime(sessionManager);
    if (observationRuntime) {
      const recentTexts = messagesSnapshot.slice(-20).flatMap((_m) => {
        const m = _m as { role?: string; content?: unknown };
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
        const forceByTurn = turnNumber > 0 && turnNumber % 10 === 0;
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
}
