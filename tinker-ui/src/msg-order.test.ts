import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMsgOrderForTests,
  bySeq,
  findByUid,
  isClientOnlyBubble,
  reinsertByTurnAnchor,
  renderOrder,
  stampOrder,
  turnAnchorOf,
} from "./msg-order.js";

type Msg = Record<string, unknown>;

const user = (text: string): Msg => ({ role: "user", content: text });
const assistant = (text: string): Msg => ({ role: "assistant", content: text });
const seqOf = (m: unknown): unknown => (m as Msg)._seq;
const uidOf = (m: unknown): unknown => (m as Msg)._uid;
const arrivedAtOf = (m: unknown): unknown => (m as Msg)._arrivedAt;
/** Position by IDENTITY, not by deep equality — two bubbles can look alike and must not be swapped. */
const sameOrder = (actual: unknown[], expected: unknown[]): void => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((m, i) => expect(actual[i]).toBe(m));
};

beforeEach(() => {
  __resetMsgOrderForTests();
});

describe("stampOrder — idempotence IS acceptance criterion (1)", () => {
  it("stamps each message once, in current array order", () => {
    const list = [user("a"), assistant("b"), user("c")];
    stampOrder(list);
    expect(list.map(seqOf)).toEqual([1, 2, 3]);
    expect(list.map(uidOf)).toEqual(["m1", "m2", "m3"]);
  });

  it("NEVER renumbers an already-stamped message, however often it is called", () => {
    const list = [user("a"), assistant("b")];
    stampOrder(list);
    const before = list.map(seqOf);
    for (let i = 0; i < 5; i++) {
      stampOrder(list);
    }
    expect(list.map(seqOf)).toEqual(before);
    expect(list.map(uidOf)).toEqual(["m1", "m2"]);
  });

  it("THE BUG: a message spliced MID-ARRAY renders at the TAIL, not in the middle", () => {
    // app.ts: `messages.splice(lastAssistantIdx, 0, ...storedErrors)` — an insert at an old index.
    const list = [user("a"), assistant("b"), user("c"), assistant("d")];
    const [a, b, c, d] = list;
    stampOrder(list);
    const late: Msg = { role: "assistant", _isError: true };
    list.splice(1, 0, late);
    stampOrder(list);
    expect(seqOf(late)).toBe(5);
    sameOrder(renderOrder(list), [a, b, c, d, late]);
  });

  it("a wholesale array replace does not renumber the survivors", () => {
    // The tab switch in app.ts: `messages = (s.messages as unknown[]).slice()` — a NEW array holding
    // the SAME message objects. The numbers live on the objects, so they cross unchanged.
    const original = [user("a"), assistant("b")];
    stampOrder(original);
    const replaced = original.slice();
    replaced.push(user("c"));
    stampOrder(replaced);
    expect(replaced.map(seqOf)).toEqual([1, 2, 3]);
    expect(replaced[0]).toBe(original[0]);
  });
});

describe("renderOrder", () => {
  it("never mutates the input array's order", () => {
    const list = [user("a"), assistant("b")];
    stampOrder(list);
    const late = user("c");
    // Array order now DISAGREES with render order — exactly the case the sort exists for.
    list.unshift(late);
    const snapshot = [...list];
    const rendered = renderOrder(list);
    sameOrder(list, snapshot);
    expect(rendered).not.toBe(list);
    expect(rendered.at(-1)).toBe(late);
  });
});

describe("findByUid", () => {
  it("finds a message by its stable identity, across an array replace", () => {
    const list = [user("a"), assistant("b")];
    stampOrder(list);
    const uid = uidOf(list[1]) as string;
    const replaced = [user("z"), ...list];
    stampOrder(replaced);
    expect(findByUid(replaced, uid)).toBe(list[1]);
  });

  it("answers undefined for an absent, empty or null uid, and for a non-array list", () => {
    const list = [user("a")];
    stampOrder(list);
    expect(findByUid(list, "nope")).toBeUndefined();
    expect(findByUid(list, null)).toBeUndefined();
    expect(findByUid(list, "")).toBeUndefined();
    expect(findByUid(null as unknown as unknown[], "m1")).toBeUndefined();
  });
});

describe("isClientOnlyBubble", () => {
  it("is true for every client-synthesised flag", () => {
    for (const flag of [
      "_isError",
      "_isWarning",
      "_isOverloadRetry",
      "_isPrefrontal",
      "_isReasoning",
      "_stopped",
    ]) {
      expect(isClientOnlyBubble({ role: "assistant", [flag]: true })).toBe(true);
    }
    // `_subagentId` is a STRING id, not a boolean.
    expect(isClientOnlyBubble({ role: "assistant", _subagentId: "run-7" })).toBe(true);
  });

  it("is false for a plain server message and for falsy or empty flag values", () => {
    expect(isClientOnlyBubble(assistant("hello"))).toBe(false);
    expect(isClientOnlyBubble(user("hi"))).toBe(false);
    expect(isClientOnlyBubble({ _isWarning: false })).toBe(false);
    expect(isClientOnlyBubble({ _isWarning: 0 })).toBe(false);
    expect(isClientOnlyBubble({ _subagentId: "" })).toBe(false);
    expect(isClientOnlyBubble(null)).toBe(false);
    expect(isClientOnlyBubble("not a message")).toBe(false);
  });
});

describe("turnAnchorOf", () => {
  it("counts the user messages before a bubble; a user message does not count itself", () => {
    const early: Msg = { role: "assistant", _isError: true };
    const list = [early, user("u1"), assistant("a1"), user("u2")];
    expect(turnAnchorOf(list, early)).toBe(0);
    expect(turnAnchorOf(list, list[2])).toBe(1);
    expect(turnAnchorOf(list, list[3])).toBe(1);
  });

  it("anchors a message it cannot find to the newest turn", () => {
    expect(turnAnchorOf([user("u1"), user("u2")], { role: "assistant" })).toBe(2);
    expect(turnAnchorOf(null as unknown as unknown[], {})).toBe(0);
  });
});

describe("reinsertByTurnAnchor", () => {
  it("puts a turn-3 warning after user message #3, NOT before the last assistant", () => {
    const warn: Msg = { role: "assistant", _isWarning: true, content: "turn-3 warning" };
    const live = [
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
      warn,
      user("u4"),
      assistant("a4"),
    ];
    stampOrder(live);
    const turn = turnAnchorOf(live, warn);
    expect(turn).toBe(3);

    const server = [
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
      user("u4"),
      assistant("a4"),
    ];
    reinsertByTurnAnchor(server, [{ m: warn, turn }]);
    // 6 = after a3 and before u4. The old app.ts splice landed it at 7, in front of the LAST
    // assistant — i.e. at the bottom of a 40-turn transcript.
    expect(server.indexOf(warn)).toBe(6);
    expect(server).toHaveLength(9);
  });

  it("re-opens the survivor for stamping so it cannot float above the reloaded transcript", () => {
    const warn: Msg = { role: "assistant", _isWarning: true };
    const live = [user("u1"), warn];
    stampOrder(live);
    expect(seqOf(warn)).toBe(2);
    const uid = uidOf(warn);

    const server = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
    reinsertByTurnAnchor(server, [{ m: warn, turn: turnAnchorOf(live, warn) }]);
    expect(server.indexOf(warn)).toBe(2);

    const rendered = renderOrder(server);
    // Render order == array order: the survivor was renumbered INTO the reloaded chronology
    // instead of keeping a stale number that would have sorted it to the very top.
    sameOrder(rendered, server);
    expect(seqOf(warn)).toBe(5);
    // Identity survived the renumber — criteria (2) and (3) ride on `_uid`, not on `_seq`.
    expect(uidOf(warn)).toBe(uid);
  });

  it("places a turn-0 bubble at the very top and appends one whose turn never recurs", () => {
    const boot: Msg = { role: "assistant", _isError: true };
    const late: Msg = { role: "assistant", _isWarning: true };
    const server = [user("u1"), assistant("a1")];
    const u1 = server[0];
    const a1 = server[1];
    reinsertByTurnAnchor(server, [
      { m: boot, turn: 0 },
      { m: late, turn: 7 },
    ]);
    sameOrder(server, [boot, u1, a1, late]);
  });

  it("keeps the caller's order among bubbles sharing a turn", () => {
    const first: Msg = { role: "assistant", _isError: true, content: "1st" };
    const second: Msg = { role: "assistant", _isError: true, content: "2nd" };
    const server = [user("u1"), assistant("a1"), user("u2")];
    const [u1, a1, u2] = server;
    reinsertByTurnAnchor(server, [
      { m: first, turn: 1 },
      { m: second, turn: 1 },
    ]);
    sameOrder(server, [u1, a1, first, second, u2]);
  });

  it("is a no-op with nothing to reinsert, and never drops a server message", () => {
    const server = [user("u1"), assistant("a1")];
    const snapshot = [...server];
    reinsertByTurnAnchor(server, []);
    reinsertByTurnAnchor(server, [
      { m: null, turn: 0 },
      { m: 42 as unknown, turn: 1 },
    ]);
    sameOrder(server, snapshot);
  });
});

describe("hostile input", () => {
  it("survives null, undefined and non-object entries and drops NOTHING", () => {
    const real = user("a");
    const list: unknown[] = [null, undefined, 42, "str", real, []];
    expect(() => stampOrder(list)).not.toThrow();
    expect(seqOf(real)).toBe(1);
    const rendered = renderOrder(list);
    // Criterion (2) holds even for input this module considers unrenderable: junk is relocated to
    // the tail, never removed.
    expect(rendered).toHaveLength(6);
    expect(rendered[0]).toBe(real);
    expect(rendered).toContain(null);
    expect(rendered).toContain(42);
  });

  it("leaves a frozen message unstamped, still renders it, and burns no counter value", () => {
    const frozen = Object.freeze({ role: "assistant", content: "frozen" });
    const list: unknown[] = [frozen, user("a")];
    expect(() => stampOrder(list)).not.toThrow();
    expect(seqOf(frozen)).toBeUndefined();
    // The counter was not advanced by the failed write, so the next message still gets 1.
    expect(seqOf(list[1])).toBe(1);
    const rendered = renderOrder(list);
    expect(rendered).toHaveLength(2);
    expect(rendered.at(-1)).toBe(frozen);
  });

  it("overwrites a FOREIGN _seq — a number with no _uid beside it", () => {
    const foreign: Msg = { role: "assistant", _seq: 999_999 };
    const list = [user("a"), foreign];
    stampOrder(list);
    expect(seqOf(foreign)).toBe(2);
    expect(uidOf(foreign)).toBe("m2");
    sameOrder(renderOrder(list), list);
  });

  it("keeps a _uid whose _seq was cleared, and gives it a NEW position", () => {
    const m = assistant("a");
    stampOrder([m]);
    const uid = uidOf(m);
    delete (m as Msg)._seq;
    stampOrder([user("later"), m]);
    expect(uidOf(m)).toBe(uid);
    expect(seqOf(m)).toBe(3);
  });

  it("bySeq stays a valid total order when nothing is stamped", () => {
    const a = {};
    const b = {};
    expect(bySeq(a, b)).toBe(0);
    expect(bySeq(null, undefined)).toBe(0);
    stampOrder([a]);
    expect(bySeq(a, b)).toBe(-1);
    expect(bySeq(b, a)).toBe(1);
  });

  it("tolerates a non-array list everywhere", () => {
    const notAList = null as unknown as unknown[];
    expect(() => stampOrder(notAList)).not.toThrow();
    expect(renderOrder(notAList)).toEqual([]);
    expect(() => reinsertByTurnAnchor(notAList, [{ m: {}, turn: 0 }])).not.toThrow();
  });
});

describe("_arrivedAt — the arrival clock, display-only", () => {
  // Fake timers live in THIS describe only: it is the one place `Date.now()` has to be a fact
  // rather than a race. Restored after every case so nothing else inherits a frozen clock.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is stamped in the same pass as `_seq`", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const list = [user("a"), assistant("b")];
    stampOrder(list);
    expect(list.map(seqOf)).toEqual([1, 2]);
    expect(list.map(arrivedAtOf)).toEqual([1_700_000_000_000, 1_700_000_000_000]);
  });

  it("collides in the same millisecond — reason (a) it could never have been the id", () => {
    vi.useFakeTimers();
    vi.setSystemTime(42);
    const toolUse = assistant("tool_use");
    const toolResult = assistant("tool_result");
    stampOrder([toolUse, toolResult]);
    expect([arrivedAtOf(toolUse), arrivedAtOf(toolResult)]).toEqual([42, 42]);
    // Identical clocks, distinct identities and a strict order: the tie costs nothing.
    expect([uidOf(toolUse), uidOf(toolResult)]).toEqual(["m1", "m2"]);
    expect(bySeq(toolUse, toolResult)).toBe(-1);
  });

  it("is stamped ONCE and never rewritten — not even when the clock jumps BACKWARDS", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const a = user("a");
    const list: unknown[] = [a];
    stampOrder(list);
    expect(arrivedAtOf(a)).toBe(10_000);

    // Reason (b): an NTP correction moves the wall clock backwards mid-session.
    vi.setSystemTime(5_000);
    const b = assistant("b");
    list.push(b);
    stampOrder(list);
    expect(arrivedAtOf(a)).toBe(10_000);
    expect(arrivedAtOf(b)).toBe(5_000);
    // `b` arrived SECOND and renders second, though its clock reading is the smaller number.
    sameOrder(renderOrder(list), [a, b]);
  });

  it("survives the re-stamp that `reinsertByTurnAnchor` forces", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const warn: Msg = { role: "assistant", _isWarning: true };
    const live = [user("u1"), warn];
    stampOrder(live);
    expect(arrivedAtOf(warn)).toBe(1_000);

    vi.setSystemTime(9_999);
    const server = [user("u1"), assistant("a1"), user("u2")];
    reinsertByTurnAnchor(server, [{ m: warn, turn: turnAnchorOf(live, warn) }]);
    stampOrder(server);
    // `_seq` was recomputed into the reloaded transcript; the moment it ARRIVED did not change.
    expect(seqOf(warn)).toBe(5);
    expect(arrivedAtOf(warn)).toBe(1_000);
  });

  it("leaves a pre-existing arrival time alone, and replaces a non-numeric squatter", () => {
    const kept: Msg = { role: "assistant", _arrivedAt: 12_345 };
    const squatter: Msg = { role: "assistant", _arrivedAt: "2026-08-05T00:00:00Z" };
    stampOrder([kept, squatter]);
    expect(kept._arrivedAt).toBe(12_345);
    // `OrderedMsg` declares a number, so the string is replaced rather than handed downstream.
    expect(squatter._arrivedAt).toEqual(expect.any(Number));
  });

  it("ORDER ignores it: arrival times in the WRONG order move nothing", () => {
    const a = user("a");
    const b = assistant("b");
    const c = user("c");
    const list = [a, b, c];
    stampOrder(list);
    // Hand-forge the clock backwards down the list. A future 'improvement' that sorted by
    // `_arrivedAt` would render c, b, a. Nothing does.
    (a as Msg)._arrivedAt = 300;
    (b as Msg)._arrivedAt = 200;
    (c as Msg)._arrivedAt = 100;
    sameOrder(renderOrder(list), [a, b, c]);
    expect(list.map(seqOf)).toEqual([1, 2, 3]);
  });

  it("a frozen message gets no arrival time either, and still burns no counter value", () => {
    const frozen = Object.freeze({ role: "assistant", content: "frozen" });
    const list: unknown[] = [frozen, user("a")];
    expect(() => stampOrder(list)).not.toThrow();
    expect(arrivedAtOf(frozen)).toBeUndefined();
    expect(seqOf(frozen)).toBeUndefined();
    expect(arrivedAtOf(list[1])).toEqual(expect.any(Number));
    expect(seqOf(list[1])).toBe(1);
  });
});
