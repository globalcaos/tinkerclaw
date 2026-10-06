import { describe, expect, it } from "vitest";
import {
  createReviewer,
  parseReview,
  buildReviewPrompt,
  type ReviewInput,
  type ReviewRow,
} from "../src/review.js";
import { AmygdalaStore } from "../src/store.js";

const input = (): ReviewInput => ({
  previousSteps: [],
  earlierStepsOnSameFiles: [],
  jevWouldHave: "add a note",
  jevFamily: "safety",
  jevAnswers: [],
  injection: "amygdala: x.",
  delivered: false,
  thenTheAgent: [{ ran: "Bash ls", failed: false }],
});
const job = (id: string) => ({ decisionId: id, sessionKey: "k", turnId: "t", ts: 1, input });
const GOOD = JSON.stringify({
  verdict: "useful",
  reason: "It hit the very problem.",
  fix: "",
  confidence: "high",
});

describe("parseReview", () => {
  it("reads a verdict, drops an empty fix, defaults the confidence", () => {
    expect(parseReview("```json\n" + GOOD + "\n```", true)).toEqual({
      verdict: "useful",
      reason: "It hit the very problem.",
      confidence: "high",
      sawOutcome: true,
    });
    expect(
      parseReview(JSON.stringify({ verdict: "noise", reason: "r", fix: "do x" }), false),
    ).toMatchObject({
      verdict: "noise",
      fix: "do x",
      confidence: "medium",
      sawOutcome: false,
    });
  });
  it("refuses an unknown verdict, a missing reason and junk", () => {
    expect(parseReview(JSON.stringify({ verdict: "great", reason: "r" }), true)).toBeNull();
    expect(parseReview(JSON.stringify({ verdict: "noise" }), true)).toBeNull();
    expect(parseReview("no", true)).toBeNull();
    expect(parseReview(null, true)).toBeNull();
  });
  it("the prompt carries what happened next", () => {
    expect(buildReviewPrompt(input())).toContain('"thenTheAgent"');
  });
});

describe("createReviewer", () => {
  const make = (run: () => Promise<string | null>, dailyCap = 150) => {
    const store = new AmygdalaStore(":memory:");
    const rows: ReviewRow[] = [];
    const rv = createReviewer({
      store: { saveReview: (r) => (rows.push(r), store.saveReview(r)) },
      run,
      ladder: ["xai/grok-4.6"],
      timeoutMs: 1000,
      dailyCap,
      now: () => 1_700_000_000_000,
      logger: { warn: () => {} },
    });
    return { store, rows, rv };
  };

  it("stores a done review, runs one at a time, and a decision is queued once", async () => {
    let live = 0;
    let peak = 0;
    const { store, rows, rv } = make(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return GOOD;
    });
    rv.observe(job("a"));
    rv.observe(job("a"));
    rv.observe(job("b"));
    await rv.idle();
    expect(rows.map((r) => r.decisionId)).toEqual(["a", "b"]);
    expect(peak).toBe(1);
    expect(store.hasReview("a")).toBe(true);
    expect(store.reviewsSince(0)[0]).toMatchObject({
      status: "done",
      review: { verdict: "useful" },
    });
  });

  it("a failed review is kept as failed and does not count as reviewed", async () => {
    const { store, rows, rv } = make(async () => null);
    rv.observe(job("a"));
    await rv.idle();
    expect(rows[0]).toMatchObject({ status: "failed", error: "xai/grok-4.6: empty" });
    expect(store.hasReview("a")).toBe(false);
  });

  it("stops at the daily cap", async () => {
    const { rows, rv } = make(async () => GOOD, 2);
    for (const id of ["a", "b", "c"]) rv.observe(job(id));
    await rv.idle();
    expect(rows.map((r) => r.decisionId)).toEqual(["a", "b"]);
  });
});
