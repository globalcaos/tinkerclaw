// FORK 2026-10-19 (the architect: phone app) — the adopt-or-not rule of the live tab re-sync.
import { describe, expect, it } from "vitest";
import {
  decideTabResync,
  sameSessionKey,
  tabListSignature,
  type TabResyncInput,
} from "./tab-resync";

const main = { id: "tab-main", sessionKey: "agent:main:main", title: "🏠 Main", isAttached: true };
const a = { id: "tab-a", sessionKey: "tinker:a", title: "Alpha", isAttached: true };
const b = { id: "tab-b", sessionKey: "tinker:b", title: "Bravo", isAttached: true };
const c = { id: "tab-c", sessionKey: "tinker:c", title: "Charlie", isAttached: true };

function input(over: Partial<TabResyncInput>): TabResyncInput {
  return {
    local: [main, a],
    server: [main, a],
    closed: {},
    hydrated: true,
    mirrorPending: false,
    busy: false,
    epochBefore: 3,
    epochAfter: 3,
    ...over,
  };
}

describe("decideTabResync — when the file may NOT win", () => {
  it("never before the page has read the file once", () => {
    expect(decideTabResync(input({ hydrated: false, server: [main, a, b] }))).toMatchObject({
      adopt: false,
      reason: "not-hydrated",
    });
  });

  it("never while a local write is on its way to the file", () => {
    expect(decideTabResync(input({ mirrorPending: true, server: [main, a, b] }))).toMatchObject({
      adopt: false,
      reason: "mirror-pending",
    });
  });

  it("never when a local write was scheduled while the GET was out", () => {
    expect(
      decideTabResync(input({ epochBefore: 3, epochAfter: 4, server: [main, a, b] })),
    ).toMatchObject({ adopt: false, reason: "local-changed" });
  });

  it("never while a drag, rename or clone is in flight", () => {
    expect(decideTabResync(input({ busy: true, server: [main, b] }))).toMatchObject({
      adopt: false,
      reason: "busy",
    });
  });

  it("never takes an empty list (fresh seat or damaged file)", () => {
    expect(decideTabResync(input({ server: [] }))).toMatchObject({
      adopt: false,
      reason: "server-empty",
    });
  });

  it("does nothing when the lists already agree", () => {
    expect(decideTabResync(input({}))).toMatchObject({ adopt: false, reason: "same" });
  });

  it("ignores fields outside id, session and title", () => {
    const local = [main, { ...a, titleLocked: true, cleared: { key: "x", at: 1 } }];
    expect(decideTabResync(input({ local }))).toMatchObject({ adopt: false, reason: "same" });
  });
});

describe("decideTabResync — when the file wins", () => {
  it("adopts a tab opened on the other device and names it as added", () => {
    const d = decideTabResync(input({ server: [main, a, b] }));
    expect(d.adopt).toBe(true);
    if (!d.adopt) return;
    expect(d.tabs.map((t) => t.id)).toEqual(["tab-main", "tab-a", "tab-b"]);
    expect(d.added).toEqual(["tab-b"]);
    expect(d.removed).toEqual([]);
    expect(d.pushBack).toBe(false);
  });

  it("adopts a close from the other device only through its tombstone", () => {
    const d = decideTabResync(
      input({ local: [main, a, b], server: [main, b], closed: { "tab-a": 9 } }),
    );
    expect(d.adopt).toBe(true);
    if (!d.adopt) return;
    expect(d.tabs.map((t) => t.id)).toEqual(["tab-main", "tab-b"]);
    expect(d.removed).toEqual(["tab-a"]);
  });

  it("adopts a rename and a reorder", () => {
    const renamed = decideTabResync(input({ server: [main, { ...a, title: "Alpha 2" }] }));
    expect(renamed.adopt).toBe(true);
    const reordered = decideTabResync(input({ local: [main, a, b], server: [main, b, a] }));
    expect(reordered.adopt && reordered.tabs.map((t) => t.id)).toEqual([
      "tab-main",
      "tab-b",
      "tab-a",
    ]);
  });

  it("adopts a new session key on the same tab", () => {
    const d = decideTabResync(input({ server: [main, { ...a, sessionKey: "tinker:a2" }] }));
    expect(d.adopt).toBe(true);
  });

  it("does not resurrect a tab this page closed, even if the file still lists it", () => {
    const d = decideTabResync(input({ local: [main], server: [main, a], closed: { "tab-a": 5 } }));
    expect(d).toMatchObject({ adopt: false, reason: "same" });
  });
});

describe("decideTabResync — a tab only this page has is never dropped on absence", () => {
  it("keeps it in place and asks for a push back when the rest agrees", () => {
    const d = decideTabResync(input({ local: [main, c, a], server: [main, a] }));
    expect(d).toMatchObject({ adopt: false, reason: "same", pushBack: true });
  });

  it("keeps it after the file's order when the file also changed", () => {
    const d = decideTabResync(input({ local: [main, c, a], server: [main, a, b] }));
    expect(d.adopt).toBe(true);
    if (!d.adopt) return;
    expect(d.tabs.map((t) => t.id)).toEqual(["tab-main", "tab-a", "tab-b", "tab-c"]);
    expect(d.removed).toEqual([]);
    expect(d.pushBack).toBe(true);
  });

  it("puts Main first when the file has none", () => {
    const d = decideTabResync(input({ local: [main, a], server: [a, b] }));
    expect(d.adopt && d.tabs.map((t) => t.id)).toEqual(["tab-main", "tab-a", "tab-b"]);
  });

  it("drops junk and duplicate ids from the file", () => {
    const d = decideTabResync(input({ server: [main, a, { title: "no id" }, { ...a }, b] }));
    expect(d.adopt && d.tabs.map((t) => t.id)).toEqual(["tab-main", "tab-a", "tab-b"]);
  });
});

describe("tabListSignature", () => {
  it("is order-sensitive", () => {
    expect(tabListSignature([a, b])).not.toBe(tabListSignature([b, a]));
  });
});

// Review fix: a field this page changed since it last read the file is ITS news; any other field
// is the file's. Without that, a page that held a change back while hidden lost it, and with the
// old "file wins" a stale page's post was indistinguishable from a real edit elsewhere.
describe("decideTabResync — three-way, against the file as this page last knew it", () => {
  it("takes the file's new session key for a tab this page did not touch", () => {
    const server = [main, { ...a, sessionKey: "agent:main:tinker:a2" }];
    const d = decideTabResync(input({ base: [main, a], local: [main, a], server }));
    expect(d.adopt && d.tabs[1].sessionKey).toBe("agent:main:tinker:a2");
    expect(d.adopt && d.pushBack).toBe(false);
  });

  it("keeps this page's own rename and still takes the file's key, then pushes the merge", () => {
    const local = [main, { ...a, title: "Mine" }];
    const server = [main, { ...a, sessionKey: "agent:main:tinker:a2" }];
    const d = decideTabResync(input({ base: [main, a], local, server }));
    expect(d.adopt).toBe(true);
    if (!d.adopt) return;
    expect(d.tabs[1]).toMatchObject({ title: "Mine", sessionKey: "agent:main:tinker:a2" });
    expect(d.pushBack).toBe(true);
  });

  it("an edit only this page made, the file otherwise unchanged: nothing to take, push it", () => {
    const local = [main, { ...a, title: "Mine" }];
    const d = decideTabResync(input({ base: [main, a], local, server: [main, a] }));
    expect(d).toMatchObject({ adopt: false, reason: "same", pushBack: true });
  });

  it("keeps this page's reorder over the file's order", () => {
    const d = decideTabResync(
      input({ base: [main, a, b], local: [main, b, a], server: [main, a, b, c] }),
    );
    expect(d.adopt && d.tabs.map((t) => t.id)).toEqual(["tab-main", "tab-b", "tab-a", "tab-c"]);
  });

  it("without a base the file wins every common field, as before", () => {
    const local = [main, { ...a, title: "Mine" }];
    const d = decideTabResync(input({ local, server: [main, a] }));
    expect(d.adopt && d.tabs[1].title).toBe("Alpha");
  });
});

describe("decideTabResync — one session, two spellings", () => {
  it("short and canonical keys are no change at all", () => {
    const server = [main, { ...a, sessionKey: "agent:main:tinker:a" }];
    expect(decideTabResync(input({ server }))).toMatchObject({
      adopt: false,
      reason: "same",
      pushBack: false,
    });
  });

  it("when adopting for another reason, the merge keeps the canonical key", () => {
    const server = [main, { ...a, sessionKey: "agent:main:tinker:a" }, b];
    const d = decideTabResync(input({ base: [main, a], local: [main, a], server }));
    expect(d.adopt && d.tabs[1].sessionKey).toBe("agent:main:tinker:a");
  });

  it("sameSessionKey follows the app's suffix rule", () => {
    expect(sameSessionKey("tinker:a", "agent:main:tinker:a")).toBe(true);
    expect(sameSessionKey("tinker:a", "tinker:b")).toBe(false);
    expect(sameSessionKey(null, null)).toBe(true);
    expect(sameSessionKey("tinker:a", null)).toBe(false);
  });
});
