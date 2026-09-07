import { describe, expect, it } from "vitest";
import { extractChangedRow, mergeChangedRow } from "./session-rows-live.js";

/** The one membership predicate app.ts passes in (canonical/short key drift). */
const matches = (a: string, b: string): boolean =>
  a === b || a.endsWith(":" + b) || b.endsWith(":" + a);

const merge = (rows: unknown[], key: string, row: Record<string, unknown>) =>
  mergeChangedRow({ rows: rows as never, key, row, matches });

describe("extractChangedRow", () => {
  // Shape captured on the wire 2026-08-24 for reason:"start".
  it("takes the nested row from a run-bearing push", () => {
    const out = extractChangedRow({
      sessionKey: "agent:main:tinker:mt6zzzz2",
      phase: "start",
      runId: "r1",
      ts: 1,
      session: {
        key: "agent:main:tinker:mt6zzzz2",
        status: "running",
        run: { live: true, count: 1 },
      },
      updatedAt: 2,
    });
    expect(out?.key).toBe("agent:main:tinker:mt6zzzz2");
    expect(out?.row.status).toBe("running");
    expect((out?.row.run as { live: boolean }).live).toBe(true);
  });

  // Shape captured on the wire for reason:"create"/"send" — no `session`, row spread on the envelope.
  it("takes the spread row when there is no nested session, dropping envelope fields", () => {
    const out = extractChangedRow({
      sessionKey: "agent:main:fractal-reflection:abc",
      reason: "create",
      ts: 5,
      updatedAt: 7,
      model: "claude-opus-5",
      modelProvider: "claude-code",
    });
    expect(out?.row).toEqual({
      updatedAt: 7,
      model: "claude-opus-5",
      modelProvider: "claude-code",
    });
    expect(out?.row.sessionKey).toBeUndefined();
    expect(out?.row.reason).toBeUndefined();
  });

  it("refuses a push it cannot attribute", () => {
    expect(extractChangedRow({ phase: "start" })).toBeNull();
    expect(extractChangedRow({ sessionKey: "   " })).toBeNull();
    expect(extractChangedRow(null)).toBeNull();
    expect(extractChangedRow(undefined)).toBeNull();
  });
});

describe("mergeChangedRow", () => {
  it("lights a session the snapshot still calls idle — the reported bug", () => {
    const rows = [{ key: "agent:main:tinker:abc", status: "done", run: { live: false, count: 0 } }];
    const out = merge(rows, "agent:main:tinker:abc", {
      status: "running",
      run: { live: true, count: 1 },
    });
    expect(out.changed).toBe(true);
    expect((out.rows[0].run as { live: boolean }).live).toBe(true);
    expect(out.rows[0].status).toBe("running");
  });

  it("clears the glow on the end push", () => {
    const rows = [
      { key: "agent:main:tinker:abc", status: "running", run: { live: true, count: 1 } },
    ];
    const out = merge(rows, "agent:main:tinker:abc", {
      status: "done",
      run: { live: false, count: 0 },
    });
    expect(out.changed).toBe(true);
    expect((out.rows[0].run as { live: boolean }).live).toBe(false);
  });

  it("matches across the canonical/short key drift and keeps the EXISTING key", () => {
    const rows = [{ key: "tinker:abc", status: "done", run: { live: false } }];
    const out = merge(rows, "agent:main:tinker:abc", { run: { live: true } });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].key).toBe("tinker:abc");
    expect((out.rows[0].run as { live: boolean }).live).toBe(true);
  });

  it("prefers an EXACT key match over a drift match", () => {
    const rows = [
      { key: "tinker:abc", status: "done" },
      { key: "agent:main:tinker:abc", status: "done" },
    ];
    const out = merge(rows, "agent:main:tinker:abc", { status: "running" });
    expect(out.rows[0].status).toBe("done");
    expect(out.rows[1].status).toBe("running");
  });

  it("appends a session the full list has never described", () => {
    const out = merge([], "agent:main:tinker:brand-new", { run: { live: true } });
    expect(out.changed).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].key).toBe("agent:main:tinker:brand-new");
  });

  it("MERGES rather than replaces, so fields a push omits survive", () => {
    const rows = [
      {
        key: "agent:main:tinker:abc",
        cookiePhrase: "NeuroCoin trademark plan",
        inputTokens: 1234,
        run: { live: false },
      },
    ];
    const out = merge(rows, "agent:main:tinker:abc", { run: { live: true } });
    expect(out.rows[0].cookiePhrase).toBe("NeuroCoin trademark plan");
    expect(out.rows[0].inputTokens).toBe(1234);
  });

  it("reports no change when nothing a surface renders moved", () => {
    const rows = [
      { key: "agent:main:tinker:abc", status: "running", run: { live: true, count: 1 } },
    ];
    // a plain message push during a long turn: same liveness, newer timestamp
    const out = merge(rows, "agent:main:tinker:abc", {
      status: "running",
      run: { live: true, count: 1 },
      updatedAt: 999,
    });
    expect(out.changed).toBe(false);
    expect(out.rows[0].updatedAt).toBe(999);
  });

  it("notices a model change even while liveness holds", () => {
    const rows = [{ key: "k", run: { live: true, count: 1 }, model: "grok-4.6" }];
    const out = merge(rows, "k", { run: { live: true, count: 1 }, model: "claude-opus-5" });
    expect(out.changed).toBe(true);
  });

  it("does not mutate the array it was given", () => {
    const rows = [{ key: "k", run: { live: false } }];
    const out = merge(rows, "k", { run: { live: true } });
    expect((rows[0].run as { live: boolean }).live).toBe(false);
    expect(out.rows).not.toBe(rows);
  });

  it("tolerates an absent or empty snapshot", () => {
    expect(mergeChangedRow({ rows: null, key: "k", row: {}, matches }).rows).toEqual([
      { key: "k" },
    ]);
    expect(mergeChangedRow({ rows: [], key: "", row: {}, matches }).changed).toBe(false);
  });
});
