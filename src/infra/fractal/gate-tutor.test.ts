import { describe, expect, it } from "vitest";
import type { FractalGateRow } from "./gate-log.js";
import {
  buildFractalGateReviewPrompt,
  createFractalGateTutor,
  parseFractalGateReview,
  runFractalGateReviewLadder,
  type FractalGateReviewRow,
} from "./gate-tutor.js";

// The gate's tutor (2026-10-25): a few skipped turns a day, judged after the fact, never on the gate's path.

const skipped = (over: Partial<FractalGateRow> = {}): FractalGateRow => ({
  v: 1,
  ts: 1000,
  sessionKey: "agent:main:tinker:a",
  parentRunId: "P",
  fire: false,
  source: "jev",
  triggers: [],
  reasons: ["Jev: worth nothing"],
  jev: "answered",
  probs: { correction: 0.1, worth: 0 },
  rules: { triggers: [], weak: [], longTurn: false },
  trail: { calls: 2, toolCalls: 1, toolErrors: 0, repeated: [] },
  prompt: "look at /home/owner/notes/plan.md",
  reply: "Done, it is in /home/owner/notes/plan.md.",
  ...over,
});

describe("parseFractalGateReview", () => {
  it("reads a verdict, keeps the trigger only on should-fire, defaults confidence to medium", () => {
    expect(
      parseFractalGateReview(
        'ok {"verdict":"should-fire","trigger":"correction","reason":"he complained","confidence":"high"}',
      ),
    ).toEqual({
      verdict: "should-fire",
      trigger: "correction",
      reason: "he complained",
      confidence: "high",
    });
    expect(
      parseFractalGateReview('{"verdict":"right-to-skip","trigger":"friction","reason":"routine"}'),
    ).toEqual({ verdict: "right-to-skip", reason: "routine", confidence: "medium" });
    expect(parseFractalGateReview('{"verdict":"maybe","reason":"x"}')).toBeNull();
    expect(parseFractalGateReview("no json")).toBeNull();
  });
});

describe("buildFractalGateReviewPrompt", () => {
  it("redacts the home folder and says when Jev did not answer", () => {
    const p = buildFractalGateReviewPrompt(
      skipped({ probs: undefined, jev: "unavailable" }),
      "/home/owner",
    );
    expect(p).not.toContain("/home/owner");
    expect(p).toContain('"jev": "did not answer"');
  });
});

describe("runFractalGateReviewLadder", () => {
  it("moves past a rung that answers nonsense or throws, and names every miss when all fail", async () => {
    const answers: Record<string, string | Error> = {
      a: "not json",
      b: new Error("down"),
      c: '{"verdict":"right-to-skip","reason":"fine"}',
    };
    const run = async (_p: string, rung: string) => {
      const x = answers[rung];
      if (x instanceof Error) {
        throw x;
      }
      return x ?? null;
    };
    expect(await runFractalGateReviewLadder("p", ["a", "b", "c"], run, 1000)).toMatchObject({
      model: "c",
      review: { verdict: "right-to-skip" },
    });
    const out = await runFractalGateReviewLadder("p", ["a", "b"], run, 1000);
    expect(out).toEqual({ error: "a: not an answer; b: Error: down" });
  });

  it("a rung past its time limit is aborted and counted as a timeout", async () => {
    let aborted = false;
    const slow = (_p: string, _r: string, signal: AbortSignal) =>
      new Promise<string | null>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(null);
        });
      });
    expect(await runFractalGateReviewLadder("p", ["s"], slow, 10)).toEqual({ error: "s: timeout" });
    expect(aborted).toBe(true);
  });
});

describe("createFractalGateTutor", () => {
  it("takes skipped rows only, at most the daily cap, sampled, one at a time; the cap resets the next day", async () => {
    const saved: FractalGateReviewRow[] = [];
    let t = Date.UTC(2026, 9, 25, 9);
    let r = 0;
    const tutor = createFractalGateTutor({
      save: (row) => {
        saved.push(row);
      },
      dailyCap: 2,
      sampleRate: 0.5,
      now: () => t,
      random: () => [0.9, 0.1, 0.2, 0.3][r++ % 4] ?? 0,
      ladder: ["m/x"],
    });
    const run = async () => '{"verdict":"should-fire","trigger":"delivery","reason":"big build"}';
    expect(tutor.observe(skipped({ fire: true }), run)).toBe(false);
    expect(tutor.observe(skipped(), run)).toBe(false); // 0.9: not sampled
    expect(tutor.observe(skipped(), run)).toBe(true);
    expect(tutor.observe(skipped(), run)).toBe(true);
    expect(tutor.observe(skipped(), run)).toBe(false); // cap
    await tutor.idle();
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({
      status: "done",
      model: "m/x",
      gateTs: 1000,
      parentRunId: "P",
      review: { verdict: "should-fire", trigger: "delivery" },
    });
    t += 86_400_000;
    r = 1;
    expect(tutor.observe(skipped(), run)).toBe(true);
    await tutor.idle();
    expect(saved).toHaveLength(3);
  });

  it("a failed ladder is saved as failed, with the misses", async () => {
    const saved: FractalGateReviewRow[] = [];
    const tutor = createFractalGateTutor({
      save: (row) => {
        saved.push(row);
      },
      sampleRate: 1,
      ladder: ["m/x"],
    });
    tutor.observe(skipped(), async () => null);
    await tutor.idle();
    expect(saved[0]).toMatchObject({ status: "failed", error: "m/x: empty" });
  });
});
