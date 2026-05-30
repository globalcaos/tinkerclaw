/**
 * FORK 2026-05-30 — Self-evolution cron body (J8 THALAMUS, 2b + 2d).
 *
 * The deterministic orchestration core of the between-tasks meta-loop. The plan
 * (improvement_notes.md §2b/2d) notes that this fork's crons are *prompt-driven*
 * isolated-agent sessions — there is no coded scheduler handler dispatched by the
 * runtime. So this file is NOT a runtime cron handler that the gateway invokes on a
 * timer; it is the deterministic body the `self-evolution` prompt-cron calls (e.g.
 * via a tiny `node -e`/script shim, or via the fork.curiosity.* RPCs) to do the parts
 * that must be exact and testable:
 *
 *   1. read the curiosity episodic buffer (last N days),
 *   2. re-score every OPEN gap against current relevance weights,
 *   3. propose the top-K next-goals (rank by priority),
 *   4. persist accepted/proposed goals to
 *      ~/.openclaw/workspace/memory/self-evolution/goals-backlog.jsonl,
 *
 * The agentic parts (deciding the resolution channel — memorySearch vs web-search vs
 * ask-user — and actually running the active-learning) stay in the cron's recipe
 * prompt, because they require model judgment. This module is the pure substrate that
 * prompt orchestrates, so the loop is auditable and unit-testable.
 *
 * Frontier-clean: fork-only file, no upstream path patched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_WEIGHTS,
  readGaps,
  topGaps,
  type Gap,
  type RelevanceWeights,
} from "../fork/curiosity-store.js";

export interface NextGoal {
  goalId: string;
  title: string;
  reason: string;
  /** rough effort estimate the proposal surface can show */
  estimatedDuration: string;
  targetCapabilities: string[];
  /** the gap that motivated this goal */
  sourceGapId: string;
  source: Gap["source"];
  priority: number;
  proposedAt: number;
  status: "proposed";
}

export interface SelfEvolutionResult {
  proposedAt: number;
  scannedGaps: number;
  openGaps: number;
  goals: NextGoal[];
  backlogPath: string;
  skipped: boolean;
  reason?: string;
}

export interface RunOptions {
  /** how many days of buffer to scan (default 7) */
  sinceDays?: number;
  /** how many goals to propose (default 5) */
  k?: number;
  /** scoring weights (default DEFAULT_WEIGHTS) */
  weights?: RelevanceWeights;
  /** override the curiosity-gaps base dir (tests) */
  gapsBaseDir?: string;
  /** override the self-evolution dir (tests) */
  selfEvolutionDir?: string;
  /** clock injection (tests) */
  nowTs?: number;
}

/** Default on-disk dir for self-evolution artifacts (goals backlog + daily MD). */
export function selfEvolutionDir(override?: string): string {
  if (override) {
    return override;
  }
  const home = process.env.OPENCLAW_HOME ?? os.homedir();
  return path.join(home, ".openclaw", "workspace", "memory", "self-evolution");
}

function backlogPath(dir: string): string {
  return path.join(dir, "goals-backlog.jsonl");
}

// --------------------------------------------------------------------------
// Goal generation (pure)
// --------------------------------------------------------------------------

/**
 * Map a scored gap into a concrete next-goal proposal. Pure — no I/O. The wording is
 * deterministic so the proposal surface (and the tests) are stable; the prompt-cron
 * can rewrite the title for the user, this is the canonical record.
 */
export function gapToGoal(gap: Gap, priority: number, nowTs: number): NextGoal {
  const title =
    gap.source === "no-match"
      ? `Learn to use ${gap.toolName ?? gap.topic}`
      : `Fill knowledge gap: ${gap.topic}`;
  const reason =
    gap.source === "no-match"
      ? `Recipe "${gap.recipeName ?? "?"}" step "${gap.stepName ?? "?"}" failed on ${gap.toolName ?? "a tool"}${gap.reason ? ` (${gap.reason})` : ""}.`
      : `Detected an unresolved knowledge gap on "${gap.topic}" (source: ${gap.source}).`;
  return {
    goalId: `goal_${gap.id}`,
    title,
    reason,
    estimatedDuration: gap.source === "no-match" ? "~15m" : "~30m",
    targetCapabilities: gap.toolName ? [gap.toolName] : [gap.topic],
    sourceGapId: gap.id,
    source: gap.source,
    priority,
    proposedAt: nowTs,
    status: "proposed",
  };
}

/**
 * Rank gaps into goals. Pure — caller supplies the gap list (no I/O). Produces zero
 * goals when the buffer has no open gaps (no spurious proposal — plan 2d test).
 */
export function rankGoals(
  gaps: Gap[],
  opts: { k?: number; weights?: RelevanceWeights; nowTs?: number } = {},
): NextGoal[] {
  const nowTs = opts.nowTs ?? Date.now();
  const top = topGaps(gaps, { k: opts.k ?? 5, weights: opts.weights ?? DEFAULT_WEIGHTS, nowTs });
  return top.map(({ gap, priority }) => gapToGoal(gap, priority, nowTs));
}

// --------------------------------------------------------------------------
// Persistence (append-only)
// --------------------------------------------------------------------------

/** Append proposed goals to the backlog JSONL (append-only audit). Returns the path. */
export function appendGoalsToBacklog(goals: NextGoal[], dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = backlogPath(dir);
  if (goals.length > 0) {
    const lines = goals.map((g) => JSON.stringify(g)).join("\n") + "\n";
    fs.appendFileSync(file, lines, "utf8");
  }
  return file;
}

/** Read the goals backlog (skipping malformed lines). */
export function readGoalsBacklog(dir: string): NextGoal[] {
  const file = backlogPath(dir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: NextGoal[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      out.push(JSON.parse(t) as NextGoal);
    } catch {
      /* torn tail */
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Orchestration body
// --------------------------------------------------------------------------

/**
 * The deterministic self-evolution pass: read buffer → re-score open gaps → propose
 * top-K goals → persist to the backlog. Returns a structured result the prompt-cron
 * can render into self-evolution/YYYY-MM-DD.md. Skips (no write) when there are no
 * open gaps.
 */
export function runSelfEvolution(opts: RunOptions = {}): SelfEvolutionResult {
  const nowTs = opts.nowTs ?? Date.now();
  const dir = selfEvolutionDir(opts.selfEvolutionDir);
  const gaps = readGaps({ sinceDays: opts.sinceDays ?? 7, baseDir: opts.gapsBaseDir, nowTs });
  const open = topGaps(gaps, { k: Number.MAX_SAFE_INTEGER, nowTs });

  if (open.length === 0) {
    return {
      proposedAt: nowTs,
      scannedGaps: gaps.length,
      openGaps: 0,
      goals: [],
      backlogPath: backlogPath(dir),
      skipped: true,
      reason: "no open gaps in buffer",
    };
  }

  const goals = rankGoals(gaps, {
    k: opts.k ?? 5,
    weights: opts.weights ?? DEFAULT_WEIGHTS,
    nowTs,
  });
  const path = appendGoalsToBacklog(goals, dir);

  return {
    proposedAt: nowTs,
    scannedGaps: gaps.length,
    openGaps: open.length,
    goals,
    backlogPath: path,
    skipped: false,
  };
}
