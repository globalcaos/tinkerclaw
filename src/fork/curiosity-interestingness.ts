/**
 * FORK 2026-05-31 — OMNI: learned model-of-interestingness (J8 THALAMUS).
 *
 * The curiosity goal-ranker (`curiosity-store.rescore`) uses a FIXED linear weight
 * vector (`DEFAULT_WEIGHTS`). That is fast, deterministic, and a perfectly good safety
 * floor — but it can only score what its five hand-tuned axes encode. OMNI AUGMENTS
 * that fixed score with an LLM "interestingness judge" that reads each gap and rates
 * its "worth pursuing now" on three intrinsic-motivation axes the linear model can't
 * capture in isolation:
 *
 *   - **novelty**      — is this genuinely new vs. something the agent already knows?
 *   - **tractability** — learning-progress: is this fillable now with the tools at hand
 *                        (the "doctor's triage" — adjacent to known knowledge), or a dead
 *                        end?
 *   - **usefulness**   — does filling this gap actually help the user / the agent's job?
 *
 * The judge returns a single 0..100 score per gap (its own blend of those axes). We then
 * BLEND that judge score with the fixed `rescore` priority — never replace it. If the
 * judge fails, times out, or returns garbage, we fall back to the fixed score: the linear
 * weights stay the safety net, so OMNI can only ever ADD signal, never subtract
 * reliability. Nothing here throws to the caller.
 *
 * Design seams:
 *  - `blendInterestingness(fixed, judge, weight)` is PURE — the testable core.
 *  - `buildInterestingnessJudge()` returns an `InterestingnessJudge` closure that spawns a
 *    one-shot subagent (mirroring overseer-runtime / reasoning-runtime:
 *    fork.subagents.spawn → agent.wait → chat.history via callGateway) and parses a 0..100
 *    score, falling back to the fixed score on ANY failure/empty.
 *  - `scoreGapsWithInterestingness(gaps, deps)` maps each gap through judge+blend with the
 *    judge injected via `deps` (DI) so it unit-tests against a mock judge with no gateway.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  rescore as fixedRescore,
  type Gap,
  type RelevanceWeights,
  DEFAULT_WEIGHTS,
} from "./curiosity-store.js";

const log = createSubsystemLogger("fork-curiosity-omni");

/** Default blend weight: how much the LLM judge moves the final score vs. the fixed one.
 *  0 = pure fixed (judge ignored), 1 = pure judge. 0.5 = equal trust. */
export const DEFAULT_BLEND_WEIGHT = 0.5;

const RUN_TIMEOUT_S = 45;

// --------------------------------------------------------------------------
// (a) Pure blend — the testable core
// --------------------------------------------------------------------------

/**
 * Blend the fixed linear priority (0..1) with the LLM judge score (0..1) by `weight`.
 *
 *   result = (1 - weight) * fixedScore + weight * judgeScore
 *
 * Both inputs are clamped to [0,1] and the weight to [0,1]; a non-finite judge score (the
 * "judge failed" sentinel a caller may pass through) collapses the blend to the pure fixed
 * score, so the fixed weights remain the safety fallback. Pure — no I/O.
 */
export function blendInterestingness(
  fixedScore: number,
  judgeScore: number,
  weight: number = DEFAULT_BLEND_WEIGHT,
): number {
  const fixed = clamp01(fixedScore, 0);
  // A NaN/Infinity judge score means "no usable judgement" → fall back to fixed entirely.
  if (typeof judgeScore !== "number" || !Number.isFinite(judgeScore)) {
    return fixed;
  }
  const judge = clamp01(judgeScore, fixed);
  const w = clamp01(weight, DEFAULT_BLEND_WEIGHT);
  return (1 - w) * fixed + w * judge;
}

function clamp01(n: number, dflt: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return dflt;
  }
  return Math.max(0, Math.min(1, n));
}

// --------------------------------------------------------------------------
// Judge contract + score parsing
// --------------------------------------------------------------------------

/**
 * An interestingness judge: given a gap and its fixed score (0..1), return a judge score
 * in 0..1, or `undefined` to signal "no judgement → use the fixed score". MUST NOT throw;
 * a throwing judge is caught by the scorer and treated as `undefined`.
 */
export type InterestingnessJudge = (gap: Gap, fixedScore: number) => Promise<number | undefined>;

/**
 * Parse a judge reply into a 0..1 score. Accepts a bare integer/float, a `SCORE: <n>`
 * line, or the first number found anywhere (LLMs love to add prose). The raw number is
 * interpreted on a 0..100 scale (the judge is prompted to answer 0-100); values already
 * in 0..1 are passed through. Returns `undefined` when no number is present (→ fallback).
 * Pure + testable.
 */
export function parseJudgeScore(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  // Prefer an explicit "SCORE: <n>" if present.
  const labelled = /score\s*[:=]\s*(-?\d+(?:\.\d+)?)/i.exec(raw);
  const m = labelled ?? /(-?\d+(?:\.\d+)?)/.exec(raw);
  if (!m) {
    return undefined;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  // A value in (1,100] is on the 0-100 scale; <=1 (and >=0) is treated as already-normalized.
  const normalized = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, normalized));
}

// --------------------------------------------------------------------------
// (b) buildInterestingnessJudge — spawns a one-shot subagent, never throws
// --------------------------------------------------------------------------

/** Compose the judge prompt for one gap. Exported for prompt-shape tests. */
export function buildJudgePrompt(gap: Gap): string {
  const facts: string[] = [`topic: ${gap.topic || "(unspecified)"}`, `source: ${gap.source}`];
  if (gap.toolName) facts.push(`tool: ${gap.toolName}`);
  if (gap.recipeName) facts.push(`recipe: ${gap.recipeName}`);
  if (gap.reason) facts.push(`reason: ${gap.reason}`);
  if (typeof gap.frequency === "number" && gap.frequency > 1) {
    facts.push(`seen ${gap.frequency} times`);
  }
  return `You are an INTERESTINGNESS JUDGE for an AI agent's curiosity engine. Score how worth-pursuing-NOW this knowledge gap is, intrinsically, on three axes and return ONE blended number 0-100:

  - NOVELTY: is this genuinely new knowledge, not something already mastered? (higher = newer)
  - TRACTABILITY (learning progress): can it be filled now with available tools/knowledge, i.e. is it adjacent to what is already known rather than a dead end? (higher = more learnable now)
  - USEFULNESS: does filling it actually help the user or the agent's job? (higher = more useful)

A gap that is novel AND tractable AND useful scores ~90-100. A trivial, unlearnable, or useless gap scores ~0-20.

GAP:
${facts.map((f) => `  - ${f}`).join("\n")}

Respond with ONLY a single line in EXACTLY this format, nothing else:
SCORE: <0-100>`;
}

/**
 * Build the production judge that scores a gap by spawning a one-shot subagent. Mirrors
 * the overseer/reasoning spawn→wait→history path. On ANY failure (spawn error, run
 * error/timeout, empty/unparseable reply) it logs and returns `undefined`, so the scorer
 * falls back to the fixed score. NEVER throws to the caller.
 */
export function buildInterestingnessJudge(
  opts: { runTimeoutSeconds?: number; parentSessionKey?: string } = {},
): InterestingnessJudge {
  const runTimeoutSeconds = opts.runTimeoutSeconds ?? RUN_TIMEOUT_S;
  const parentSessionKey = opts.parentSessionKey ?? "agent:main:main";

  return async (gap: Gap): Promise<number | undefined> => {
    try {
      const { callGateway } = await import("../gateway/call.js");
      const task = buildJudgePrompt(gap);
      const spawn = await callGateway<{
        ok?: boolean;
        childSessionKey?: string;
        runId?: string;
        note?: string;
      }>({
        method: "fork.subagents.spawn",
        params: {
          task,
          label: "curiosity:interestingness",
          parentSessionKey,
          runTimeoutSeconds,
          expectsCompletionMessage: false,
        },
        timeoutMs: (runTimeoutSeconds + 10) * 1000,
      });
      if (!spawn?.ok || !spawn.childSessionKey || !spawn.runId) {
        log.warn(`[omni] judge spawn failed: ${spawn?.note ?? "no childSessionKey/runId"}`);
        return undefined;
      }
      const { childSessionKey, runId } = spawn;

      const wait = await callGateway<{ status?: "ok" | "timeout" | "error"; error?: string }>({
        method: "agent.wait",
        params: { runId, timeoutMs: runTimeoutSeconds * 1000 },
        timeoutMs: runTimeoutSeconds * 1000 + 5_000,
      });
      if (wait?.status === "error") {
        log.warn(`[omni] judge run errored: ${wait.error ?? "?"}`);
        return undefined;
      }
      if (wait?.status === "timeout") {
        return undefined; // stalled judge → fixed fallback
      }

      // Read the final assistant text, with a short retry for sessionFile flush.
      const deadline = Date.now() + 10_000;
      do {
        const hist = await callGateway<{
          messages?: Array<{ role?: string; content?: unknown }>;
        }>({
          method: "chat.history",
          params: { sessionKey: childSessionKey, limit: 30 },
          timeoutMs: 10_000,
        });
        const messages = Array.isArray(hist?.messages) ? hist.messages : [];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role !== "assistant") continue;
          const text = messageText(messages[i]?.content);
          if (text.trim()) {
            return parseJudgeScore(text);
          }
          break;
        }
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 150));
      } while (true);
      return undefined; // no text → fallback
    } catch (err) {
      // The judge must never break ranking. Log for devtools, return fallback sentinel.
      log.warn(
        `[omni] judge threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  };
}

/** Flatten an assistant message's content (string or content-block array) to plain text. */
function messageText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "",
      )
      .join("");
  }
  return "";
}

// --------------------------------------------------------------------------
// (c) scoreGapsWithInterestingness — DI scoring path
// --------------------------------------------------------------------------

export interface InterestingnessDeps {
  /** The LLM judge. Inject a mock in tests; defaults to `buildInterestingnessJudge()`. */
  judge?: InterestingnessJudge;
  /** Fixed linear weights for the safety-floor `rescore`. */
  weights?: RelevanceWeights;
  /** Blend weight (0=pure fixed, 1=pure judge). */
  blendWeight?: number;
  /** Clock for deterministic recency in `rescore`. */
  nowTs?: number;
}

export interface ScoredGap {
  gap: Gap;
  /** The fixed linear `rescore` priority, 0..1. Always present (the safety floor). */
  fixedScore: number;
  /** The judge's 0..1 score, or `undefined` if the judge gave no usable answer. */
  judgeScore?: number;
  /** The blended final priority used for ranking, 0..1. */
  score: number;
}

/**
 * Score every gap through the LLM interestingness judge and blend with the fixed linear
 * priority, returning the list sorted descending by blended score. The judge is run per
 * gap (DI — a mock in tests; the spawning judge in prod). A judge that returns
 * `undefined`/throws collapses that gap's score to the fixed one (safety fallback), so the
 * ranking degrades gracefully to the linear model when the LLM is unavailable. Never throws.
 */
export async function scoreGapsWithInterestingness(
  gaps: Gap[],
  deps: InterestingnessDeps = {},
): Promise<ScoredGap[]> {
  const judge = deps.judge ?? buildInterestingnessJudge();
  const weights = deps.weights ?? DEFAULT_WEIGHTS;
  const blendWeight = deps.blendWeight ?? DEFAULT_BLEND_WEIGHT;
  const nowTs = deps.nowTs ?? Date.now();

  const out: ScoredGap[] = [];
  for (const gap of gaps) {
    const fixedScore = fixedRescore(gap, weights, nowTs);
    let judgeScore: number | undefined;
    try {
      judgeScore = await judge(gap, fixedScore);
    } catch (err) {
      // A mock/judge that throws despite the contract → treat as no judgement (fallback).
      log.warn(
        `[omni] judge invocation threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      judgeScore = undefined;
    }
    const score =
      judgeScore === undefined
        ? fixedScore
        : blendInterestingness(fixedScore, judgeScore, blendWeight);
    const scored: ScoredGap = { gap, fixedScore, score };
    if (judgeScore !== undefined) {
      scored.judgeScore = judgeScore;
    }
    out.push(scored);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
