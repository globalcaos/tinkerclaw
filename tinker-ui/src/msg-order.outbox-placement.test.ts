// FORK 2026-10-01 — TINKER_UI_DESIGN_BIBLE/bug-log.md `[chat-divergence]` cause 2, proposed fix (3).
// Owner, 2026-10-01: "Sometimes it shows 'not in history' messages, repeated answers or simply
// misplaced prompts (among others), and then when I refresh the page it all resets and corrected."
//
// app.ts `reinjectOutboxBubbles` redraws every still-unconfirmed prompt from the durable outbox. It
// used to place the copy with an ARRAY splice, before the first row with a later `timestamp` — but
// the page draws `renderOrder(messages)`, and `stampOrder` gives an unstamped row the NEXT `_seq`.
// So on an already-numbered page — every reload after the first paint — the copy was drawn at the
// BOTTOM, under the answers it precedes. All 13 order inversions in a census of 206 page snapshots
// were such copies, 8 to 24 places below their served twin; report
// ~/.openclaw/data/bug-reports/2026-09-28/151534-prompt-lost-ed93657b.json holds the copy at array
// index 0 with `_seq` 2538 beside its served twin's 2514. "Refreshing fixes it" because a reload
// numbers the array from scratch, which is also why the splice passed every spec written on a fresh
// list.
//
// The two page states are therefore tested as a PAIR: the NUMBERED page (the bug) and the FRESH page
// (which must not change at all). CONTROL keeps the replaced array splice executable, so the
// difference between the two placements is read off the suite rather than argued in a comment.
//
// The row-time reader is injected as a plain property read. Deliberate: what is under test is
// PLACEMENT, not timestamp parsing — and app.ts's own `toMillis` rescales any finite number below
// 1e11 as SECONDS, so the toy times 100/200/300/400 only mean what they say under a raw reader.
import { beforeEach, describe, expect, it } from "vitest";
import { __resetMsgOrderForTests, placeByTime, renderOrder, stampOrder } from "./msg-order.js";

type Msg = Record<string, unknown>;

const user = (content: string, timestamp?: number): Msg => ({ role: "user", content, timestamp });
const assistant = (content: string, timestamp?: number): Msg => ({
  role: "assistant",
  content,
  timestamp,
});
/** The bubble `reinjectOutboxBubbles` builds: the prompt's typed time on both of its stamps. */
const redrawn = (content: string, ts: number): Msg => ({
  role: "user",
  _clientMsgId: `k-${ts}`,
  content,
  _promptStartedAt: ts,
  timestamp: ts,
});
/** A reader as plain as the call site's, and as undefended: it THROWS on a non-record entry, which
 *  is how the junk-entry spec below proves `placeByTime` never hands it one. */
const rawTime = (m: unknown): number | null => {
  const v = (m as Msg).timestamp;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
/** What the page DRAWS, and what the array HOLDS. The pair is the whole subject of this file. */
const drawn = (list: unknown[]): unknown[] => renderOrder(list).map((m) => (m as Msg)?.content);
const held = (list: unknown[]): unknown[] => list.map((m) => (m as Msg)?.content);

/** A page already on screen: a previous paint numbered every row. */
const numberedPage = () => {
  const u1 = user("U1", 100);
  const a1 = assistant("A1", 200);
  const u2 = user("U2", 300);
  const a2 = assistant("A2", 400);
  const list: unknown[] = [u1, a1, u2, a2];
  stampOrder(list);
  return { u1, a1, u2, a2, list };
};
const freshPage = (): unknown[] => [
  user("U1", 100),
  assistant("A1", 200),
  user("U2", 300),
  assistant("A2", 400),
];

beforeEach(() => {
  __resetMsgOrderForTests();
});

describe("placeByTime — a redrawn outbox prompt sits at its own time on a NUMBERED page", () => {
  it("THE BUG: a copy typed at 150 renders SECOND", () => {
    const { list } = numberedPage();
    const copy = redrawn("COPY", 150);

    placeByTime(list, copy, 150, rawTime);

    expect(drawn(list)).toEqual(["U1", "COPY", "A1", "U2", "A2"]);
    expect(renderOrder(list)[1]).toBe(copy);
    // The ARRAY agrees with the screen, so code that scans it (turn starts, anchors) and the
    // raw-array debug view (`__tinkerRenderSorted = false`) read the same page.
    expect(held(list)).toEqual(["U1", "COPY", "A1", "U2", "A2"]);
  });

  it("CONTROL: the array splice it replaces renders that same copy LAST", () => {
    const { list } = numberedPage();
    const copy = redrawn("COPY", 150);

    // Verbatim the replaced app.ts: findIndex over the ARRAY, then splice at that index.
    const at = list.findIndex((m) => (rawTime(m) ?? 0) > 150);
    expect(at).toBe(1); // the array index is right — it is the NUMBER that is wrong
    list.splice(at, 0, copy);
    stampOrder(list);

    expect(drawn(list)).toEqual(["U1", "A1", "U2", "A2", "COPY"]);
    expect(copy._seq).toBe(5); // the NEXT number: the whole defect, in one value
  });

  it("ANCHORS IN RENDER ORDER, NOT ARRAY ORDER", () => {
    // A legacy mid-array splice has already put X at array index 1 while it renders LAST. An
    // array-order search would anchor the copy on X and draw it under A1@200; the render-order
    // search anchors on A1 and draws it above both. This spec fails for a half-fix that keeps the
    // array scan and only changes how the row is inserted.
    const u1 = user("U1", 100);
    const a1 = assistant("A1", 200);
    const list: unknown[] = [u1, a1];
    stampOrder(list);
    const x = assistant("X", 150);
    list.splice(1, 0, x);
    stampOrder(list);
    expect(drawn(list)).toEqual(["U1", "A1", "X"]);

    placeByTime(list, redrawn("COPY", 120), 120, rawTime);

    expect(drawn(list)).toEqual(["U1", "COPY", "A1", "X"]);
  });

  it("a copy older than every row renders FIRST", () => {
    const { list } = numberedPage();
    placeByTime(list, redrawn("COPY", 50), 50, rawTime);
    expect(drawn(list)).toEqual(["COPY", "U1", "A1", "U2", "A2"]);
  });

  it("a copy newer than every row renders LAST", () => {
    const { list } = numberedPage();
    placeByTime(list, redrawn("COPY", 500), 500, rawTime);
    expect(drawn(list)).toEqual(["U1", "A1", "U2", "A2", "COPY"]);
  });

  it("two copies typed minutes apart keep their own order between the same two rows", () => {
    const list: unknown[] = [user("U1", 100), assistant("A1", 400)];
    stampOrder(list);

    placeByTime(list, redrawn("FIRST", 150), 150, rawTime);
    placeByTime(list, redrawn("SECOND", 250), 250, rawTime);

    expect(drawn(list)).toEqual(["U1", "FIRST", "SECOND", "A1"]);
  });

  it("a row with no readable time is never the anchor", () => {
    // Why the call site keeps a `timestamp`-only reader instead of history-reconcile.ts
    // `historyRowTime`: that one falls back to `_arrivedAt`, which `stampOrder` writes as
    // `Date.now()` on every row it numbers — so this NOTE would read as page-load time, outrank a
    // prompt typed at 150 and pull the copy above U1@100. Measured, then rejected.
    const list: unknown[] = [assistant("NOTE"), user("U1", 100), assistant("A1", 200)];
    stampOrder(list);

    placeByTime(list, redrawn("COPY", 150), 150, rawTime);

    expect(drawn(list)).toEqual(["NOTE", "U1", "COPY", "A1"]);
  });

  it("never hands a junk entry to the caller's reader, and never drops one", () => {
    // `messages` holds entries this module relocates but never drops (see `renderOrder`), and
    // `rawTime` above would throw a TypeError on one. The guard lives inside `placeByTime`, where
    // every caller gets it, rather than in each caller's reader.
    const list: unknown[] = [null, user("U1", 100), assistant("A1", 200)];
    stampOrder(list);
    const copy = redrawn("COPY", 150);

    expect(() => placeByTime(list, copy, 150, rawTime)).not.toThrow();

    expect(drawn(list)).toEqual(["U1", "COPY", "A1", undefined]);
    expect(list).toHaveLength(4);
  });

  it("is a no-op for a row already on the list", () => {
    const { a1, list } = numberedPage();
    placeByTime(list, a1, 150, rawTime);
    expect(drawn(list)).toEqual(["U1", "A1", "U2", "A2"]);
  });
});

describe("placeByTime — a FRESH page draws exactly what the array splice drew", () => {
  it("renders what today's splice renders, row for row", () => {
    const mine = freshPage();
    placeByTime(mine, redrawn("COPY", 150), 150, rawTime);

    const theirs = freshPage();
    const at = theirs.findIndex((m) => (rawTime(m) ?? 0) > 150);
    theirs.splice(at, 0, redrawn("COPY", 150));
    stampOrder(theirs);

    expect(drawn(mine)).toEqual(drawn(theirs));
    expect(drawn(mine)).toEqual(["U1", "COPY", "A1", "U2", "A2"]);
  });

  it("render order equals array order on a page nothing has numbered yet", () => {
    const list = freshPage();
    placeByTime(list, redrawn("COPY", 150), 150, rawTime);
    expect(drawn(list)).toEqual(held(list));
  });
});
