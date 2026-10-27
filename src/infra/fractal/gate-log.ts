/**
 * FORK 2026-10-25: the Fractal gate's own log (`<stateDir>/data/fractal/gate.jsonl`).
 *
 * WHY. The gate decides whether a background reflection runs after a turn, and until now it kept no record: the ledger
 * holds the reflections that ran (705 by 2026-10-24), so a turn the gate skipped left nothing, and a missed reflection
 * could not even be counted. Every decision now writes one row: what the rules found, what Jev said or that it did not
 * answer, and the outcome. A skipped row also keeps the start of the prompt and the end of the reply, so the gate's
 * tutor (`gate-tutor.ts`) can judge later whether a reflection should have fired. A fired row keeps no text: the
 * reflection itself is the record.
 *
 * The file is local state, never sent anywhere by this module, and append-only. A failed write is logged and dropped:
 * the gate never waits on it.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { FractalGateDecision, FractalGateJevState } from "./gate-jev.js";
import { isAgentPrompt, ownerWords, type FractalTrigger } from "./gate.js";
import { resolveFractalDataDir } from "./ledger.js";

/** How much of a skipped turn's prompt and reply the row keeps. */
export const FRACTAL_GATE_LOG_TEXT = 1500;

export type FractalGateRow = {
  v: 1;
  ts: number;
  sessionKey: string;
  parentRunId: string;
  fire: boolean;
  source: "jev" | "rules";
  triggers: FractalTrigger[];
  reasons: string[];
  jev: FractalGateJevState;
  probs?: Record<string, number>;
  rules: { triggers: FractalTrigger[]; weak: FractalTrigger[]; longTurn: boolean };
  trail: { calls: number; toolCalls: number; toolErrors: number; repeated: string[] };
  /** Skipped rows only: the prompt's start (the owner's words, or an agent's prompt as written) and the reply's end. */
  prompt?: string;
  reply?: string;
};

export function resolveFractalGateLogPath(stateDir: string = resolveStateDir()): string {
  return path.join(resolveFractalDataDir(stateDir), "gate.jsonl");
}

export function resolveFractalGateReviewsPath(stateDir: string = resolveStateDir()): string {
  return path.join(resolveFractalDataDir(stateDir), "gate-reviews.jsonl");
}

export function fractalGateRow(d: FractalGateDecision, ts: number): FractalGateRow {
  const { params: p, rules, result } = d;
  const row: FractalGateRow = {
    v: 1,
    ts,
    sessionKey: p.sessionKey,
    parentRunId: p.parentRunId,
    fire: result.fire,
    source: result.source,
    triggers: [...result.triggers],
    reasons: [...result.reasons],
    jev: d.jev,
    ...(result.probs ? { probs: { ...result.probs } } : {}),
    rules: { triggers: [...rules.triggers], weak: [...rules.weak], longTurn: rules.longTurn },
    trail: {
      calls: p.trail.calls,
      toolCalls: p.trail.toolCalls,
      toolErrors: p.trail.toolErrors,
      repeated: p.trail.repeated.slice(0, 10),
    },
  };
  if (!result.fire) {
    const prompt = isAgentPrompt(p.prompt) ? p.prompt : ownerWords(p.prompt);
    row.prompt = prompt.slice(0, FRACTAL_GATE_LOG_TEXT);
    row.reply = p.reply.slice(-FRACTAL_GATE_LOG_TEXT);
  }
  return row;
}

/** One JSON line appended to `file` (its folder made if missing). Never throws: a lost row is logged, not raised. */
export async function appendFractalJsonl(file: string, row: unknown): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(row)}\n`, "utf-8");
  } catch (err) {
    console.error(`[fractal] could not append to ${file}`, err);
  }
}
