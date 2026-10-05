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

  // FORK 2026-09-24 (final review item 9) — sessions.changed phase:"message" carries the
  // transcript's cursor epoch next to messageSeq (server-session-events.ts, plan task 6); it
  // describes the push, not the session row.
  it("drops the cursor epoch a message push carries with its messageSeq", () => {
    const out = extractChangedRow({
      sessionKey: "agent:main:tinker:mt6zzzz2",
      phase: "message",
      ts: 1,
      messageId: "m1",
      messageSeq: 42,
      epoch: "nonce:1:7:root",
      updatedAt: 9,
    });
    expect(out?.row).toEqual({ updatedAt: 9 });
    expect(out?.row.epoch).toBeUndefined();
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

// FORK 2026-09-25 — prompt-queue.md §6.3, gateway step G5. The row builder spreads `pendingPrompts`
// in only when something is pending, so a WHOLE row that leaves it out says "nothing pending". A
// spread push carries a hand-picked subset without it, so there its absence says nothing.
describe("pendingPrompts: a whole row's silence is 'nothing pending'", () => {
  const KEY = "agent:main:tinker:abc";
  const HELD = [{ key: "p-1", state: "behind", since: 1 }];
  const heldRows = (): Record<string, unknown>[] => [
    { key: KEY, status: "running", run: { live: true, count: 1 }, pendingPrompts: HELD },
  ];
  /** A push as app.ts handles it: extract, then merge with the shape the extract reported. */
  const mergePush = (rows: unknown[], payload: Record<string, unknown>) => {
    const push = extractChangedRow(payload);
    if (!push) {
      throw new Error("the push names no session");
    }
    return mergeChangedRow({
      rows: rows as never,
      key: push.key,
      row: push.row,
      whole: push.whole,
      matches,
    });
  };

  it("extractChangedRow reports which shape it read", () => {
    const nested = extractChangedRow({ sessionKey: KEY, phase: "end", session: { key: KEY } });
    expect(nested?.whole).toBe(true);
    const spread = extractChangedRow({ sessionKey: KEY, reason: "create", model: "m" });
    expect(spread?.whole).toBe(false);
  });

  it("a whole row that leaves the field out clears it: the prompt is no longer held", () => {
    // The lifecycle end push, nested the way server-chat.ts buildSessionEventSnapshot nests it.
    const out = mergePush(heldRows(), {
      sessionKey: KEY,
      phase: "end",
      session: { key: KEY, status: "done", run: { live: false, count: 0 } },
    });
    expect("pendingPrompts" in out.rows[0]).toBe(false);
  });

  it("CONTROL — merged field by field (every push before this fix), the report stood", () => {
    const out = merge(heldRows(), KEY, { status: "done", run: { live: false, count: 0 } });
    expect(out.rows[0].pendingPrompts).toEqual(HELD);
  });

  it("a spread push never clears it: it does not carry the field", () => {
    const out = mergePush(heldRows(), { sessionKey: KEY, reason: "create", updatedAt: 9 });
    expect(out.rows[0].pendingPrompts).toEqual(HELD);
    expect(out.rows[0].updatedAt).toBe(9);
  });

  it("a whole row that carries the field replaces it", () => {
    const next = [{ key: "p-2", state: "running", since: 5 }];
    const out = mergePush(heldRows(), {
      sessionKey: KEY,
      phase: "message",
      session: { key: KEY, status: "running", run: { live: true, count: 1 }, pendingPrompts: next },
    });
    expect(out.rows[0].pendingPrompts).toEqual(next);
  });

  it("every OTHER field a whole row leaves out is still kept (merge, never replace)", () => {
    const rows = [
      { ...heldRows()[0], cookiePhrase: "NeuroCoin trademark plan", derivedTitle: "t" },
    ];
    const out = mergePush(rows, {
      sessionKey: KEY,
      phase: "end",
      session: { key: KEY, run: { live: false, count: 0 } },
    });
    expect(out.rows[0].cookiePhrase).toBe("NeuroCoin trademark plan");
    expect(out.rows[0].derivedTitle).toBe("t");
  });

  it("clearing a `preparing` report is a change: the pre-model glow reads it", () => {
    const rows = [
      {
        key: KEY,
        status: "running",
        run: { live: false, count: 0 },
        pendingPrompts: [{ key: "p-1", state: "preparing", since: 1 }],
      },
    ];
    const whole = { key: KEY, status: "running", run: { live: false, count: 0 } };
    expect(mergePush(rows, { sessionKey: KEY, phase: "message", session: whole }).changed).toBe(
      true,
    );
    // CONTROL — the same push with the report unchanged is not a change.
    const same = { ...whole, pendingPrompts: rows[0].pendingPrompts };
    expect(mergePush(rows, { sessionKey: KEY, phase: "message", session: same }).changed).toBe(
      false,
    );
  });
});
