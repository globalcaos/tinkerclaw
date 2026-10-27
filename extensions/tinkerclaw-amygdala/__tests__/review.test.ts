import { describe, expect, it } from "vitest";
import {
  buildPassReviewInput,
  buildPassReviewPrompt,
  buildReviewPrompt,
  createReviewer,
  PASS_REVIEW_MAX,
  parsePassReview,
  parseReview,
  type PassReviewInput,
  type ReviewInput,
  type ReviewRow,
} from "../src/review.js";
import { AmygdalaStore } from "../src/store.js";
import type { Decision, Field, Situation, Verdict } from "../src/types.js";

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
  const make = (
    run: (prompt: string) => Promise<string | null>,
    dailyCap = 150,
    passDailyCap = 150,
  ) => {
    const store = new AmygdalaStore(":memory:");
    const rows: ReviewRow[] = [];
    const rv = createReviewer({
      store: { saveReview: (r) => (rows.push(r), store.saveReview(r)) },
      run,
      ladder: ["xai/grok-4.6"],
      timeoutMs: 1000,
      dailyCap,
      passDailyCap,
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

  // ---- pass review (2026-10-15): the steps Jev let through, one call per turn -------------------------------------

  const passInput = (n = 2): PassReviewInput => ({
    passed: Array.from({ length: n }, (_, i) => ({
      n: i + 1,
      step: `Bash step${i + 1}`,
      jevAnswers: [],
    })),
    theAgentDid: [{ ran: "Bash ls", failed: false }],
  });
  const passJob = (turnId: string, ids: string[], n = ids.length) => ({
    turnId,
    sessionKey: "k",
    ts: 1,
    decisionIds: ids,
    input: () => passInput(n),
  });
  const PASS_GOOD = JSON.stringify({
    entries: [
      { n: 1, verdict: "fine", reason: "Listing is safe." },
      { n: 2, verdict: "missed", reason: "It wrote a shared file." },
    ],
    confidence: "high",
  });

  it("one call per turn stores one pass row per step, by its number", async () => {
    let calls = 0;
    const { store, rows, rv } = make(async () => (calls++, PASS_GOOD));
    rv.observePass(passJob("t1", ["p1", "p2"]));
    rv.observePass(passJob("t1", ["p1", "p2"]));
    await rv.idle();
    expect(calls).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      decisionId: "p1",
      kind: "pass",
      turnId: "t1",
      status: "done",
      model: "xai/grok-4.6",
      review: { verdict: "fine", reason: "Listing is safe.", confidence: "high", sawOutcome: true },
    });
    expect(rows[1]).toMatchObject({
      decisionId: "p2",
      kind: "pass",
      review: { verdict: "missed" },
    });
    expect(store.hasReview("p1")).toBe(true);
    expect(store.reviewsSince(0).map((r) => r.kind)).toEqual(["pass", "pass"]);
  });

  it("a step the judge skipped is kept as failed; no passes means no call", async () => {
    let calls = 0;
    const { store, rows, rv } = make(
      async () => (calls++, JSON.stringify({ entries: [{ n: 2, verdict: "fine", reason: "ok" }] })),
    );
    rv.observePass(passJob("t0", []));
    rv.observePass(passJob("t1", ["p1", "p2"]));
    await rv.idle();
    expect(calls).toBe(1);
    expect(rows.map((r) => [r.decisionId, r.status])).toEqual([
      ["p1", "failed"],
      ["p2", "done"],
    ]);
    expect(rows[0].error).toContain("no verdict for step 1");
    expect(store.hasReview("p1")).toBe(false);
    expect(store.hasReview("p2")).toBe(true);
  });

  it("a ladder with no answer marks every step of the turn failed", async () => {
    const { rows, rv } = make(async () => null);
    rv.observePass(passJob("t1", ["p1", "p2"]));
    await rv.idle();
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(rows[0]).toMatchObject({ kind: "pass", error: "xai/grok-4.6: empty" });
  });

  it("the pass cap counts turns and is separate from the flag cap", async () => {
    const { rows, rv } = make(async (p) => (p.includes("THE TURN:") ? PASS_GOOD : GOOD), 1, 1);
    rv.observe(job("a"));
    rv.observe(job("b"));
    rv.observePass(passJob("t1", ["p1", "p2"]));
    rv.observePass(passJob("t2", ["p3"]));
    await rv.idle();
    expect(rows.map((r) => r.decisionId)).toEqual(["a", "p1", "p2"]);
  });
});

describe("parsePassReview", () => {
  it("reads one verdict per numbered step, defaults the confidence, takes a bare array in order", () => {
    const got = parsePassReview(
      "```json\n" +
        JSON.stringify({
          entries: [
            { n: 2, verdict: "missed", reason: "Shared file." },
            { n: 1, verdict: "fine", reason: "Read only." },
          ],
        }) +
        "\n```",
      2,
      true,
    );
    expect(got).toEqual([
      { verdict: "fine", reason: "Read only.", confidence: "medium", sawOutcome: true },
      { verdict: "missed", reason: "Shared file.", confidence: "medium", sawOutcome: true },
    ]);
    expect(
      parsePassReview(
        JSON.stringify([
          { verdict: "fine", reason: "a" },
          { verdict: "great", reason: "b" },
          { verdict: "missed", reason: "c" },
        ]),
        3,
        false,
      ),
    ).toEqual([
      { verdict: "fine", reason: "a", confidence: "medium", sawOutcome: false },
      undefined,
      { verdict: "missed", reason: "c", confidence: "medium", sawOutcome: false },
    ]);
  });
  it("refuses junk, an out-of-range number, a missing reason and zero steps", () => {
    expect(parsePassReview("no", 2, true)).toBeNull();
    expect(parsePassReview(null, 2, true)).toBeNull();
    expect(
      parsePassReview(
        JSON.stringify({ entries: [{ n: 9, verdict: "fine", reason: "r" }] }),
        2,
        true,
      ),
    ).toBeNull();
    expect(
      parsePassReview(JSON.stringify({ entries: [{ n: 1, verdict: "fine" }] }), 2, true),
    ).toBeNull();
    expect(
      parsePassReview(
        JSON.stringify({ entries: [{ n: 1, verdict: "fine", reason: "r" }] }),
        0,
        true,
      ),
    ).toBeNull();
  });
});

// ---- the pass judge's input and the store behind it --------------------------------------------------------------

const miss = <T>(): Field<T> => ({ value: null, origin: "missing" });
const sit = (
  id: string,
  ts: number,
  o: { command?: string; request?: string; turnId?: string; seam?: Situation["seam"] } = {},
): Situation => ({
  id,
  ts,
  sessionKey: "k",
  turnId: o.turnId ?? "t",
  seam: o.seam ?? "pre-tool",
  originKind: "synthetic",
  tool: { value: "Bash", origin: "observed" },
  args: miss(),
  command: o.command ? { value: o.command, origin: "observed" } : miss(),
  effectClass: { value: "read", origin: "derived" },
  targets: miss(),
  targetHistory: miss(),
  scratch: miss(),
  toolRecord: miss(),
  request: o.request ? { value: o.request, origin: "observed" } : miss(),
  restatement: miss(),
  expectation: miss(),
  draftCommitments: miss(),
  repeatedErrors: miss(),
  stepsSinceNewFact: miss(),
  recentHolds: miss(),
  standingFacts: miss(),
  similarIncidents: miss(),
  reply: miss(),
  claims: miss(),
  provenance: miss(),
  holdNeeds: miss(),
  candidates: miss(),
  scheduledJobs: miss(),
  contextCounts: miss(),
});
const proceed = (
  situationId: string,
  family: Decision["family"] = "safety",
  reasonCode = "table-d2-ok[]",
): Decision => ({
  situationId,
  response: { kind: "proceed" },
  family,
  reasonCode,
  verdictIds: [],
  mode: "shadow",
  enforced: false,
  degraded: false,
});
const verdict = (situationId: string, questionId: string, answer: boolean): Verdict => ({
  id: `${situationId}-${questionId}`,
  situationId,
  questionId,
  questionVersion: 1,
  type: "noul",
  answer,
  prob: 0.9,
  confidence: 0.9,
  cacheHit: false,
  latencyMs: 1,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  ts: 1,
});
const book = { get: () => undefined };

describe("buildPassReviewInput", () => {
  it("numbers the passes in order, caps them, and carries the ask, Jev's answers, the calls and the reply", () => {
    const passes = Array.from({ length: PASS_REVIEW_MAX + 5 }, (_, i) => {
      const s = sit(`s${i}`, 100 + i, { command: `echo ${i}`, request: "list my files" });
      return { situation: s, decision: proceed(s.id), verdicts: [verdict(s.id, "q1", true)] };
    });
    const input = buildPassReviewInput({
      passes,
      book,
      did: Array.from({ length: PASS_REVIEW_MAX + 5 }, (_, i) => ({
        ran: `Bash echo ${i}`,
        failed: i === 1,
      })),
      finalReply: "Here are your files.",
      homeDir: "/home/x",
    });
    expect(input.ownerAsked).toBe("list my files");
    expect(input.passed).toHaveLength(PASS_REVIEW_MAX);
    expect(input.passed[0]).toEqual({
      n: 1,
      step: "Bash echo 0",
      jevAnswers: [{ question: "q1", answer: "yes" }],
    });
    expect(input.passed[PASS_REVIEW_MAX - 1].n).toBe(PASS_REVIEW_MAX);
    expect(input.theAgentDid).toHaveLength(PASS_REVIEW_MAX);
    expect(input.theAgentDid[1]).toEqual({ ran: "Bash echo 1", failed: true });
    expect(input.endedWith).toBe("Here are your files.");
  });
  it("the pass prompt never reads as a flag review (runtime.test filters flag prompts by that phrase)", () => {
    const p = buildPassReviewPrompt(
      buildPassReviewInput({ passes: [], book, did: [], homeDir: "/home/x" }),
    );
    expect(p).toContain("THE TURN:");
    expect(p).not.toContain("review flags");
  });
});

describe("store: the passes of a turn and the report", () => {
  it("lists only unjudged pre-tool proceeds Jev was asked about, knows when the turn began, and counts fine/missed per rule", () => {
    const st = new AmygdalaStore(":memory:");
    const save = (s: Situation, d: Decision, id: string) => {
      st.saveSituation(s);
      st.saveDecision(d, { id, seam: s.seam, ts: s.ts });
    };
    const s0 = sit("s0", 100, { seam: "prompt" });
    save(s0, proceed("s0"), "d0");
    const s1 = sit("s1", 110, { command: "ls" });
    save(s1, proceed("s1"), "d1");
    const s2 = sit("s2", 120, { command: "cat x" });
    save(s2, proceed("s2", "fallback", "jev-not-consulted[]"), "d2");
    const s3 = sit("s3", 130, { seam: "post-tool" });
    save(s3, proceed("s3"), "d3");
    const s4 = sit("s4", 140, { command: "rm x" });
    save(
      s4,
      {
        ...proceed("s4", "safety", "table-d2-low[danger-level]"),
        response: {
          kind: "note",
          templateId: "relevant-fact",
          slots: {},
          channel: "additionalContext",
        },
      },
      "d4",
    );
    const s5 = sit("s5", 150, { command: "echo" });
    save(s5, proceed("s5"), "d5");
    const other = sit("s6", 160, { turnId: "u", command: "ls" });
    save(other, proceed("s6"), "d6");
    const pass = (decisionId: string, v: "fine" | "missed"): ReviewRow => ({
      decisionId,
      kind: "pass",
      sessionKey: "k",
      turnId: "t",
      ts: 200,
      status: "done",
      model: "m",
      review: { verdict: v, reason: "r", confidence: "medium", sawOutcome: true },
    });
    st.saveReview(pass("d5", "fine"));

    expect(st.unjudgedPassesForTurn("t").map((d) => d.id)).toEqual(["d1"]);
    expect(st.unjudgedPassesForTurn("t", 0)).toEqual([]);
    expect(st.turnStartTs("t")).toBe(100);
    expect(st.turnStartTs("nope")).toBeNull();

    st.saveReview(pass("d1", "missed"));
    st.saveReview({
      decisionId: "d4",
      sessionKey: "k",
      turnId: "t",
      ts: 200,
      status: "done",
      model: "m",
      review: { verdict: "noise", reason: "r", confidence: "medium", sawOutcome: true },
    });
    expect(st.unjudgedPassesForTurn("t")).toEqual([]);
    const report = st.reviewReport(0);
    expect(report).toEqual([
      {
        family: "safety",
        kind: "proceed",
        rule: "table-d2-ok",
        n: 2,
        useful: 0,
        harmless: 0,
        noise: 0,
        harmful: 0,
        ownerUp: 0,
        ownerDown: 0,
        fine: 1,
        missed: 1,
      },
      {
        family: "safety",
        kind: "note",
        rule: "table-d2-low",
        n: 1,
        useful: 0,
        harmless: 0,
        noise: 1,
        harmful: 0,
        ownerUp: 0,
        ownerDown: 0,
      },
    ]);
    expect(st.reviewsSince(0).find((r) => r.decisionId === "d4")?.kind).toBe("flag");
    st.close();
  });
});
