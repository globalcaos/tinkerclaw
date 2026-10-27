// FORK 2026-10-27 — unread chats and the window title (tab-attention.ts).
import { describe, expect, it } from "vitest";
import {
  composeWindowTitle,
  finalStampOf,
  isUnread,
  markSeen,
  noteOwnFinal,
  parseSeenMap,
  serializeSeenMap,
  type SeenRecord,
} from "./tab-attention.js";

const T = 1_793_100_000_000;

describe("the seen map in ui-state", () => {
  it("round-trips, keeping only the open tabs' sessions, in a stable order", () => {
    const map = {
      "tinker:b": { s: T },
      "tinker:a": { s: T - 5, f: T - 1 },
      "tinker:gone": { s: 1 },
    };
    const raw = serializeSeenMap(map, (k) => k !== "tinker:gone");
    expect(raw).toBe(
      '{"tinker:a":{"s":1793099999995,"f":1793099999999},"tinker:b":{"s":1793100000000}}',
    );
    expect(parseSeenMap(raw)).toEqual({ "tinker:a": { s: T - 5, f: T - 1 }, "tinker:b": { s: T } });
  });

  it("reads anything broken as nothing rather than throwing", () => {
    expect(parseSeenMap("")).toEqual({});
    expect(parseSeenMap("{not json")).toEqual({});
    expect(parseSeenMap("[1,2]")).toEqual({});
    expect(parseSeenMap('{"tinker:a":{"s":"x"},"tinker:b":{"s":5,"f":-1}}')).toEqual({
      "tinker:b": { s: 5 },
    });
  });
});

describe("unread", () => {
  it("is a turn that finished after the owner last saw the chat", () => {
    const rec: SeenRecord = { s: T };
    expect(isUnread(finalStampOf({ endedAt: T + 30_000 }, rec), rec)).toBe(true);
    expect(isUnread(finalStampOf({ endedAt: T - 1 }, rec), rec)).toBe(false);
    expect(isUnread(finalStampOf({ endedAt: T }, rec), rec)).toBe(false);
  });

  it("says nothing for a chat with no record or no finished turn", () => {
    expect(isUnread(T, undefined)).toBe(false);
    expect(isUnread(finalStampOf({}, { s: T }), { s: T })).toBe(false);
    expect(isUnread(finalStampOf(undefined, { s: T }), { s: T })).toBe(false);
  });

  it("takes the newer of the server's endedAt and the page's own final (the Fractal)", () => {
    expect(finalStampOf({ endedAt: T }, { s: 0, f: T + 9 })).toBe(T + 9);
    expect(finalStampOf({ endedAt: T + 9 }, { s: 0, f: T })).toBe(T + 9);
    expect(finalStampOf({ endedAt: "soon" }, { s: 0, f: T })).toBe(T);
  });
});

describe("markSeen", () => {
  it("seeds a chat seen for the first time at now: nothing older is news", () => {
    const rec = markSeen(undefined, T - 60_000, T);
    expect(rec).toEqual({ s: T });
    expect(isUnread(T - 60_000, rec ?? undefined)).toBe(false);
  });

  it("absorbs the final on screen without a write when nothing is new", () => {
    expect(markSeen({ s: T }, T - 5)).toBeNull();
    expect(markSeen({ s: T }, T + 5)).toEqual({ s: T + 5 });
  });

  it("stamps the moment of a switch, so a row that lands just after is not news", () => {
    const left = markSeen({ s: T - 100 }, T - 50, T);
    expect(left).toEqual({ s: T });
    expect(isUnread(finalStampOf({ endedAt: T - 20 }, left ?? undefined), left ?? undefined)).toBe(
      false,
    );
    expect(
      isUnread(finalStampOf({ endedAt: T + 20_000 }, left ?? undefined), left ?? undefined),
    ).toBe(true);
  });

  it("keeps the page's own final while raising the seen stamp", () => {
    expect(markSeen({ s: T, f: T + 3 }, T + 3)).toEqual({ s: T + 3, f: T + 3 });
  });
});

describe("noteOwnFinal (a Fractal answering in the chat)", () => {
  it("turns a seen chat unread", () => {
    const rec = noteOwnFinal({ s: T }, T + 10_000, T + 10_000);
    expect(isUnread(finalStampOf({ endedAt: T - 1 }, rec), rec)).toBe(true);
  });

  it("is news even for a chat with no record yet", () => {
    const rec = noteOwnFinal(undefined, T, T);
    expect(isUnread(finalStampOf(undefined, rec), rec)).toBe(true);
  });

  it("clears once the chat is seen", () => {
    const rec = noteOwnFinal({ s: T }, T + 10, T + 10);
    const seen = markSeen(rec, finalStampOf(undefined, rec), T + 20) ?? rec;
    expect(isUnread(finalStampOf(undefined, seen), seen)).toBe(false);
  });
});

describe("composeWindowTitle", () => {
  const base = "Jarvis";

  it("is the agent's name when nothing is going on", () => {
    expect(composeWindowTitle({ base, busy: null, frame: 0, unread: 0, background: false })).toBe(
      "Jarvis",
    );
  });

  it("turns a spinner while the active chat's model thinks", () => {
    expect(
      composeWindowTitle({ base, busy: { kind: "model" }, frame: 0, unread: 0, background: false }),
    ).toBe("◐ Jarvis");
    expect(
      composeWindowTitle({ base, busy: { kind: "model" }, frame: 1, unread: 0, background: false }),
    ).toBe("◓ Jarvis");
  });

  it("adds a gear and the job's label when the busy state is a job", () => {
    expect(
      composeWindowTitle({
        base,
        busy: { kind: "job", label: "Build", count: 1 },
        frame: 2,
        unread: 0,
        background: false,
      }),
    ).toBe("◑ ⚙ Build — Jarvis");
    expect(
      composeWindowTitle({
        base,
        busy: { kind: "job", label: "Build", count: 3 },
        frame: 3,
        unread: 0,
        background: false,
      }),
    ).toBe("◒ ⚙ Build +2 — Jarvis");
  });

  it("puts the unread count in front only while the window is in the background", () => {
    expect(composeWindowTitle({ base, busy: null, frame: 0, unread: 2, background: true })).toBe(
      "(2) Jarvis",
    );
    expect(composeWindowTitle({ base, busy: null, frame: 0, unread: 2, background: false })).toBe(
      "Jarvis",
    );
    expect(
      composeWindowTitle({ base, busy: { kind: "model" }, frame: 0, unread: 1, background: true }),
    ).toBe("(1) ◐ Jarvis");
  });
});
