import { describe, expect, it } from "vitest";
import { createEarned, DEFAULT_EARNED, earnedSet, type EarnedRow } from "../src/earned.js";
import { AmygdalaStore } from "../src/store.js";

const row = (o: Partial<EarnedRow>): EarnedRow => ({
  family: "double-check",
  kind: "send-back",
  reasonCode: "claim-unsupported[claim-record]",
  n: 40,
  useful: 24,
  harmful: 2,
  ...o,
});

describe("earnedSet: the bar a rule must clear to act on its own", () => {
  it("acts with enough reviews, half useful or more, a tenth harmful or less", () => {
    expect([...earnedSet([row({})], DEFAULT_EARNED)]).toEqual([
      "double-check|send-back|claim-unsupported[claim-record]",
    ]);
  });
  it("too few reviews, too little useful, or too much harmful: stays in shadow", () => {
    for (const r of [
      row({ n: 19, useful: 19, harmful: 0 }),
      row({ useful: 19 }),
      row({ harmful: 5 }),
    ])
      expect(earnedSet([r], DEFAULT_EARNED).size).toBe(0);
  });
  it("holds, proof checks and questions never earn it, whatever their numbers", () => {
    for (const kind of ["hold", "proof", "ask", "refusal"])
      expect(earnedSet([row({ kind, useful: 40, harmful: 0 })], DEFAULT_EARNED).size).toBe(0);
  });
  it("switched off, nothing acts", () => {
    expect(earnedSet([row({})], { ...DEFAULT_EARNED, enabled: false }).size).toBe(0);
  });
});

describe("createEarned: counts only the judge's reviews from the store", () => {
  it("Sonnet's reviews earn the rule; Grok's do not count", () => {
    const store = new AmygdalaStore(":memory:");
    const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } })
      .db;
    const add = (i: number, model: string, verdict: string) => {
      db.prepare(
        `INSERT INTO situations(id, ts, session, turn_id, seam, tool, effect_class, origin_kind, hash, record_json, redacted_json)
         VALUES(?, 1000, 's', 't', 'stop', '', '', '', '', '{}', '{}')`,
      ).run(`s${i}`);
      db.prepare(
        `INSERT INTO decisions(id, situation_id, seam, family, kind, reason_code, verdict_ids, mode, enforced, degraded, response_json, ts)
         VALUES(?, ?, 'stop', 'double-check', 'send-back', 'claim-unsupported[claim-record]', '[]', 'shadow', 0, 0, '{}', 1000)`,
      ).run(`d${i}`, `s${i}`);
      db.prepare(
        `INSERT INTO reviews(decision_id, session, turn_id, ts, status, model, verdict, kind) VALUES(?, 's', 't', 1000, 'done', ?, ?, 'flag')`,
      ).run(`d${i}`, model, verdict);
    };
    for (let i = 0; i < 30; i++) add(i, "xai/grok-4.6", "useful");
    const now = () => 2000;
    expect(
      createEarned(store, DEFAULT_EARNED, now).has(
        "double-check",
        "send-back",
        "claim-unsupported[claim-record]",
      ),
    ).toBe(false);
    for (let i = 30; i < 55; i++)
      add(i, "claude-code/claude-sonnet-5-5", i < 45 ? "useful" : "noise");
    const e = createEarned(store, DEFAULT_EARNED, now);
    expect(e.has("double-check", "send-back", "claim-unsupported[claim-record]")).toBe(true);
    expect(e.report()[0]).toMatchObject({ n: 25, useful: 15, acts: true });
  });
});
