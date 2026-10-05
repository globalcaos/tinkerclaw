import { afterEach, describe, expect, it } from "vitest";
import { dayBounds, spendBetween, spendToday } from "../src/spend.js";
import { AmygdalaStore } from "../src/store.js";
import type { Field, Situation, Verdict } from "../src/types.js";

function v(id: string, ts: number, over: Partial<Verdict> = {}): Verdict {
  return {
    id,
    situationId: "s1",
    questionId: "q1",
    questionVersion: 1,
    type: "noul",
    answer: true,
    prob: 0.5,
    confidence: 0.5,
    cacheHit: false,
    latencyMs: 1,
    tokensIn: 100,
    tokensOut: 10,
    costUsd: 0.01,
    ts,
    ...over,
  };
}

const miss = <T>(): Field<T> => ({ value: null, origin: "missing" });
function situation(): Situation {
  return {
    id: "s1",
    ts: 1,
    sessionKey: "sess",
    turnId: "turn",
    seam: "pre-tool",
    originKind: "synthetic",
    tool: { value: "t", origin: "observed" },
    args: miss(),
    command: miss(),
    effectClass: { value: "read", origin: "derived" },
    targets: miss(),
    targetHistory: miss(),
    scratch: miss(),
    toolRecord: miss(),
    request: miss(),
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
  };
}

const stores: AmygdalaStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

function fresh(): AmygdalaStore {
  const st = new AmygdalaStore(":memory:");
  st.saveSituation(situation());
  stores.push(st);
  return st;
}

describe("spendBetween", () => {
  it("sums cost and tokens; skipped and cache hits are not calls", () => {
    const st = fresh();
    st.saveVerdicts([
      v("a", 100),
      v("b", 200, { costUsd: 0.03, tokensIn: 300, tokensOut: 30 }),
      v("c", 300, { cacheHit: true, costUsd: 0, tokensIn: 0, tokensOut: 0 }),
      v("d", 400, { skipped: "timeout", costUsd: 0, tokensIn: 0, tokensOut: 0 }),
      v("e", 1000), // outside: toTs is exclusive
      v("f", 50), // outside: before fromTs
    ]);
    const s = spendBetween(st, 100, 1000, 0.5);
    expect(s.usd).toBeCloseTo(0.04);
    expect(s.eur).toBeCloseTo(0.02);
    expect(s.calls).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.tokensIn).toBe(400);
    expect(s.tokensOut).toBe(40);
  });

  it("is all zeros on an empty range", () => {
    const s = spendBetween(fresh(), 0, 10, 0.92);
    expect(s).toEqual({ usd: 0, eur: 0, calls: 0, tokensIn: 0, tokensOut: 0, skipped: 0 });
  });
});

describe("dayBounds (Europe/Madrid)", () => {
  it("ordinary winter day: midnight to midnight local (UTC+1)", () => {
    // 2026-01-15 12:00 Madrid = 11:00Z
    const { start, end } = dayBounds(Date.UTC(2026, 0, 15, 11, 0));
    expect(start).toBe(Date.UTC(2026, 0, 14, 23, 0));
    expect(end).toBe(Date.UTC(2026, 0, 15, 23, 0));
  });

  it("summer day is UTC+2", () => {
    const { start, end } = dayBounds(Date.UTC(2026, 6, 1, 10, 0));
    expect(start).toBe(Date.UTC(2026, 5, 30, 22, 0));
    expect(end).toBe(Date.UTC(2026, 6, 1, 22, 0));
  });

  it("either side of local midnight lands in different days", () => {
    // 2026-01-15 23:59:59 Madrid = 22:59:59Z ; 00:00:00 on the 16th = 23:00:00Z
    const before = dayBounds(Date.UTC(2026, 0, 15, 22, 59, 59));
    const after = dayBounds(Date.UTC(2026, 0, 15, 23, 0, 0));
    expect(before.end).toBe(after.start);
    expect(after.start).toBe(Date.UTC(2026, 0, 15, 23, 0));
  });

  it("spring-forward day (2026-03-29) is 23 hours", () => {
    const { start, end } = dayBounds(Date.UTC(2026, 2, 29, 12, 0));
    expect(start).toBe(Date.UTC(2026, 2, 28, 23, 0)); // 00:00 CET
    expect(end).toBe(Date.UTC(2026, 2, 29, 22, 0)); // 00:00 CEST
    expect((end - start) / 3600000).toBe(23);
  });

  it("fall-back day (2026-10-25) is 25 hours", () => {
    const { start, end } = dayBounds(Date.UTC(2026, 9, 25, 12, 0));
    expect(start).toBe(Date.UTC(2026, 9, 24, 22, 0)); // 00:00 CEST
    expect(end).toBe(Date.UTC(2026, 9, 25, 23, 0)); // 00:00 CET
    expect((end - start) / 3600000).toBe(25);
  });

  it("honours an explicit tz", () => {
    const { start, end } = dayBounds(Date.UTC(2026, 0, 15, 12, 0), "UTC");
    expect(start).toBe(Date.UTC(2026, 0, 15));
    expect(end).toBe(Date.UTC(2026, 0, 16));
  });
});

describe("spendToday", () => {
  it("counts only verdicts inside the local day", () => {
    const st = fresh();
    const now = Date.UTC(2026, 0, 15, 11, 0);
    const { start, end } = dayBounds(now);
    st.saveVerdicts([v("in", start), v("out-late", end), v("out-early", start - 1)]);
    const s = spendToday(st, now, 1);
    expect(s.calls).toBe(1);
    expect(s.usd).toBeCloseTo(0.01);
  });
});
