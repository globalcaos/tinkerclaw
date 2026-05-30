/**
 * FORK 2026-05-30 — tests for the self-evolution cron body (J8 THALAMUS, 2b + 2d).
 *
 * Test target: src/crons/self-evolution-cron.ts. Pure goal-ranking + the orchestration
 * body run against temp dirs (curiosity gaps + self-evolution backlog).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendGap, makeGap, type Gap } from "../fork/curiosity-store.js";
import {
  appendGoalsToBacklog,
  gapToGoal,
  rankGoals,
  readGoalsBacklog,
  runSelfEvolution,
} from "./self-evolution-cron.js";

const DAY = 24 * 60 * 60 * 1000;

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("gapToGoal (2d, pure)", () => {
  it("renders a 'learn to use' goal for a NO-MATCH gap", () => {
    const g = makeGap({
      source: "no-match",
      topic: "use d2",
      recipeName: "compile-paper",
      stepName: "figs",
      toolName: "d2",
      reason: "unknown tool",
    });
    const goal = gapToGoal(g, 0.7, 1000);
    expect(goal.title).toBe("Learn to use d2");
    expect(goal.targetCapabilities).toEqual(["d2"]);
    expect(goal.sourceGapId).toBe(g.id);
    expect(goal.priority).toBe(0.7);
    expect(goal.status).toBe("proposed");
  });
  it("renders a 'fill knowledge gap' goal for other sources", () => {
    const g = makeGap({ source: "lcm-entropy", topic: "spanish tax law" });
    const goal = gapToGoal(g, 0.5, 1000);
    expect(goal.title).toBe("Fill knowledge gap: spanish tax law");
  });
});

describe("rankGoals (2d, pure)", () => {
  it("orders by priority and caps at k", () => {
    const now = 100 * DAY;
    const gaps: Gap[] = [
      makeGap({ source: "manual", topic: "low", importance: 0.1, ts: now - DAY }),
      makeGap({ source: "manual", topic: "high", importance: 0.95, ts: now - DAY }),
      makeGap({ source: "manual", topic: "mid", importance: 0.5, ts: now - DAY }),
    ];
    const goals = rankGoals(gaps, { k: 2, nowTs: now });
    expect(goals).toHaveLength(2);
    expect(goals[0]!.title).toContain("high");
  });
  it("produces zero goals for an empty buffer (no spurious proposal)", () => {
    expect(rankGoals([], {})).toEqual([]);
  });
  it("excludes resolved gaps", () => {
    const now = 100 * DAY;
    const resolved = makeGap({ source: "manual", topic: "done", importance: 1, ts: now - DAY });
    resolved.resolvedAt = now;
    expect(rankGoals([resolved], { nowTs: now })).toEqual([]);
  });
});

describe("appendGoalsToBacklog / readGoalsBacklog", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir("self-evo-");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips goals through the backlog JSONL", () => {
    const g = makeGap({ source: "manual", topic: "x" });
    const goals = [gapToGoal(g, 0.5, 1000)];
    appendGoalsToBacklog(goals, dir);
    const read = readGoalsBacklog(dir);
    expect(read).toHaveLength(1);
    expect(read[0]!.title).toBe(goals[0]!.title);
  });

  it("appends (does not overwrite) across calls", () => {
    const g1 = makeGap({ source: "manual", topic: "a" });
    const g2 = makeGap({ source: "manual", topic: "b" });
    appendGoalsToBacklog([gapToGoal(g1, 0.5, 1)], dir);
    appendGoalsToBacklog([gapToGoal(g2, 0.5, 2)], dir);
    expect(readGoalsBacklog(dir)).toHaveLength(2);
  });

  it("writes nothing for an empty goal list", () => {
    appendGoalsToBacklog([], dir);
    expect(readGoalsBacklog(dir)).toEqual([]);
  });
});

describe("runSelfEvolution (2b+2d orchestration body)", () => {
  let gapsDir: string;
  let evoDir: string;
  beforeEach(() => {
    gapsDir = tmpDir("self-evo-gaps-");
    evoDir = tmpDir("self-evo-out-");
  });
  afterEach(() => {
    fs.rmSync(gapsDir, { recursive: true, force: true });
    fs.rmSync(evoDir, { recursive: true, force: true });
  });

  it("reads the buffer, proposes top-K goals, and persists them to the backlog", () => {
    const now = 100 * DAY;
    appendGap(
      makeGap({ source: "manual", topic: "high", importance: 0.95, ts: now - DAY }),
      gapsDir,
    );
    appendGap(
      makeGap({
        source: "no-match",
        topic: "use d2",
        toolName: "d2",
        reason: "unknown tool",
        ts: now - DAY,
      }),
      gapsDir,
    );
    appendGap(
      makeGap({ source: "manual", topic: "low", importance: 0.05, ts: now - DAY }),
      gapsDir,
    );

    const res = runSelfEvolution({
      gapsBaseDir: gapsDir,
      selfEvolutionDir: evoDir,
      k: 2,
      nowTs: now,
    });
    expect(res.skipped).toBe(false);
    expect(res.scannedGaps).toBe(3);
    expect(res.openGaps).toBe(3);
    expect(res.goals).toHaveLength(2);
    // persisted
    const backlog = readGoalsBacklog(evoDir);
    expect(backlog).toHaveLength(2);
    expect(backlog.map((g) => g.goalId).sort()).toEqual(res.goals.map((g) => g.goalId).sort());
  });

  it("skips (no write) when the buffer has no open gaps", () => {
    const now = 100 * DAY;
    const res = runSelfEvolution({ gapsBaseDir: gapsDir, selfEvolutionDir: evoDir, nowTs: now });
    expect(res.skipped).toBe(true);
    expect(res.goals).toEqual([]);
    expect(fs.existsSync(path.join(evoDir, "goals-backlog.jsonl"))).toBe(false);
  });

  it("does not re-propose a resolved gap", () => {
    const now = 100 * DAY;
    const g = makeGap({ source: "manual", topic: "vat", importance: 0.9, ts: now - DAY });
    appendGap(g, gapsDir);
    // resolution row folded in by dedupe
    appendGap(
      { ...g, ts: now, resolvedAt: now, resolvedBy: "cron", resolutionSource: "web" },
      gapsDir,
    );
    const res = runSelfEvolution({ gapsBaseDir: gapsDir, selfEvolutionDir: evoDir, nowTs: now });
    expect(res.skipped).toBe(true);
    expect(res.goals).toEqual([]);
  });
});
