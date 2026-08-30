import { describe, it, expect } from "vitest";
import {
  OUTBOX_MAX,
  OUTBOX_STORAGE_KEY,
  dueForReplay,
  enqueueOutbox,
  historyMatchesEntry,
  markAttempted,
  outboxEntriesNeedingBubble,
  outboxForSession,
  readOutbox,
  reconcileWithHistory,
  removeFromOutbox,
  writeOutbox,
  type OutboxEntry,
  type OutboxStore,
} from "./outbox";

/** In-memory stand-in for localStorage. */
function fakeStore(initial?: string): OutboxStore & { dump(): string | null } {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_k: string, v: string) => {
      value = v;
    },
    dump: () => value,
  };
}

/** A store whose writes always throw — a full or disabled localStorage. */
const throwingStore: OutboxStore = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

// Minimal stand-in for app.ts `sessionKeyMatches` (short vs canonical form).
const matches = (a?: string, b?: string): boolean => {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(b) || b.endsWith(a);
};

const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: "id-1",
  sessionKey: "tinker:A",
  text: "hello",
  ts: 1000,
  attempts: 0,
  lastAttemptAt: 0,
  ...over,
});

describe("outbox persistence", () => {
  it("enqueues a prompt so it survives a reload", () => {
    const store = fakeStore();
    expect(enqueueOutbox(store, { id: "a", sessionKey: "tinker:A", text: "hi", ts: 5 })).toBe(true);
    const read = readOutbox(store);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ id: "a", text: "hi", attempts: 0 });
  });

  it("is idempotent on id, so a replay path can enqueue freely", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "a", sessionKey: "tinker:A", text: "hi", ts: 5 });
    enqueueOutbox(store, { id: "a", sessionKey: "tinker:A", text: "hi", ts: 9 });
    expect(readOutbox(store)).toHaveLength(1);
  });

  it("degrades to empty rather than throwing on corrupt storage", () => {
    expect(readOutbox(fakeStore("{not json"))).toEqual([]);
    expect(readOutbox(fakeStore('{"a":1}'))).toEqual([]);
    expect(readOutbox(throwingStore)).toEqual([]);
  });

  it("never throws when storage refuses the write", () => {
    expect(writeOutbox(throwingStore, [entry()])).toBe(false);
    expect(enqueueOutbox(throwingStore, { id: "a", sessionKey: "s", text: "t", ts: 1 })).toBe(
      false,
    );
  });

  it("drops malformed rows but keeps the good ones", () => {
    const store = fakeStore(
      JSON.stringify([{ id: "a", sessionKey: "s", text: "t", ts: 1 }, 42, null]),
    );
    expect(readOutbox(store)).toHaveLength(1);
  });

  it("caps the outbox so it can never exhaust the quota", () => {
    const store = fakeStore();
    const many = Array.from({ length: OUTBOX_MAX + 10 }, (_, i) => entry({ id: `id-${i}`, ts: i }));
    writeOutbox(store, many);
    const read = readOutbox(store);
    expect(read).toHaveLength(OUTBOX_MAX);
    // the OLDEST are shed, never the newest — a just-typed prompt must not be the one dropped
    expect(read[read.length - 1].id).toBe(`id-${OUTBOX_MAX + 9}`);
  });

  it("writes under the documented key", () => {
    const store = fakeStore();
    let seenKey = "";
    const spy: OutboxStore = { getItem: () => null, setItem: (k) => void (seenKey = k) };
    writeOutbox(spy, [entry()]);
    expect(seenKey).toBe(OUTBOX_STORAGE_KEY);
    expect(store.dump()).toBeNull();
  });

  it("removes only on proof of delivery", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "a", sessionKey: "s", text: "1", ts: 1 });
    enqueueOutbox(store, { id: "b", sessionKey: "s", text: "2", ts: 2 });
    removeFromOutbox(store, "a");
    expect(readOutbox(store).map((e) => e.id)).toEqual(["b"]);
  });

  it("tracks attempts across replays", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "a", sessionKey: "s", text: "1", ts: 1 });
    markAttempted(store, "a", 500);
    markAttempted(store, "a", 900);
    expect(readOutbox(store)[0]).toMatchObject({ attempts: 2, lastAttemptAt: 900 });
  });
});

describe("outboxForSession", () => {
  it("returns only this tab's prompts, oldest first", () => {
    const entries = [
      entry({ id: "b", sessionKey: "tinker:A", ts: 200 }),
      entry({ id: "c", sessionKey: "tinker:B", ts: 300 }),
      entry({ id: "a", sessionKey: "agent:main:tinker:A", ts: 100 }),
    ];
    expect(outboxForSession(entries, "tinker:A", matches).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("returns nothing for an unattached tab", () => {
    expect(outboxForSession([entry()], undefined, matches)).toEqual([]);
  });
});

// FORK 2026-08-28 — the deferred prompt was painted TWICE: once dimmed grey from
// `pendingQueuedSends`, and 5 s later a solid amber "not delivered - will retry" copy from the
// outbox backstop, because the backstop asked `messages[]` alone whether the prompt was on screen
// and a deferred prompt is deliberately NOT in `messages[]`.
describe("outboxEntriesNeedingBubble", () => {
  const a = entry({ id: "a" });
  const b = entry({ id: "b" });

  it("returns everything when nothing is on screen yet (page load / reconnect)", () => {
    expect(outboxEntriesNeedingBubble([a, b], undefined).map((e) => e.id)).toEqual(["a", "b"]);
    expect(outboxEntriesNeedingBubble([a, b], null).map((e) => e.id)).toEqual(["a", "b"]);
    expect(outboxEntriesNeedingBubble([a, b], new Set()).map((e) => e.id)).toEqual(["a", "b"]);
    expect(outboxEntriesNeedingBubble([a, b], []).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("skips an entry already committed to messages[]", () => {
    expect(outboxEntriesNeedingBubble([a, b], new Set(["a"])).map((e) => e.id)).toEqual(["b"]);
  });

  // THE BUG, as a test. "q" is deferred: held out of messages[] and living only in
  // pendingQueuedSends, with its outbox entry still legitimately unproven.
  it("skips a DEFERRED entry known only to pendingQueuedSends", () => {
    const q = entry({ id: "q" });
    expect(outboxEntriesNeedingBubble([q], new Set(["q"]))).toEqual([]);
  });

  // CONTROL for the case above: the OLD predicate — messages[] alone — really does produce the
  // duplicate. Without this, "the new one returns nothing" would pass against any fixture.
  it("CONTROL: the old messages[]-only predicate DID emit a bubble for that entry", () => {
    const q = entry({ id: "q" });
    const messagesOnly = new Set<string>(); // deferred prompts are absent from messages[] by design
    expect(outboxEntriesNeedingBubble([q], messagesOnly).map((e) => e.id)).toEqual(["q"]);
  });

  it("returns an entry absent from BOTH stores — the real lost prompt", () => {
    const lost = entry({ id: "lost" });
    expect(outboxEntriesNeedingBubble([a, lost], new Set(["a"])).map((e) => e.id)).toEqual([
      "lost",
    ]);
  });

  it("reads messages[] and pendingQueuedSends as ONE id set", () => {
    // "m" is committed in messages[]; "q" is DEFERRED and lives only in pendingQueuedSends; "lost"
    // is in neither store — the single case that has earned an undelivered bubble.
    const fromMessages = ["m"];
    const fromQueued = ["q"];
    const onScreen = new Set([...fromMessages, ...fromQueued]);
    const mine = [entry({ id: "m" }), entry({ id: "q" }), entry({ id: "lost" })];
    expect(outboxEntriesNeedingBubble(mine, onScreen).map((e) => e.id)).toEqual(["lost"]);
  });

  it("returns the entries BY REFERENCE, preserving order", () => {
    const out = outboxEntriesNeedingBubble([a, b], new Set(["zzz"]));
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it("does not mutate the input entries array", () => {
    const entries = [a, b];
    const out = outboxEntriesNeedingBubble(entries, undefined);
    expect(out).not.toBe(entries);
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  // ACK IS NOT DURABILITY (2026-08-24). Suppressing the bubble must leave the STORED entry alone —
  // only `reconcileWithHistory` may retire it. Two gateway restarts destroyed prompts through the
  // "it's on screen, so it must be safe to drop" shortcut, so this is the gate on that shortcut
  // rather than one more paragraph asking the next reader not to take it.
  it("suppresses the BUBBLE without retiring the outbox ENTRY", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "q", sessionKey: "s", text: "deferred prompt", ts: 1 });
    const stored = readOutbox(store);
    expect(outboxEntriesNeedingBubble(stored, new Set(["q"]))).toEqual([]);
    expect(readOutbox(store).map((e) => e.id)).toEqual(["q"]);
  });
});

describe("historyMatchesEntry", () => {
  it("matches exactly on the idempotency key when the gateway stamps one", () => {
    expect(historyMatchesEntry({ idempotencyKey: "id-1", text: "anything" }, entry())).toBe(true);
    expect(historyMatchesEntry({ idempotencyKey: "other", text: "hello" }, entry())).toBe(false);
  });

  it("falls back to a text prefix, because the server stores the INJECTED prompt", () => {
    const injected = "hello\n\n---\n\n**After your reply, append a FRACTAL reflection**";
    expect(historyMatchesEntry({ text: injected }, entry())).toBe(true);
  });

  it("ignores whitespace reflow between client and transcript", () => {
    expect(historyMatchesEntry({ text: "  hello   there " }, entry({ text: "hello there" }))).toBe(
      true,
    );
  });

  it("does not match a different prompt", () => {
    expect(historyMatchesEntry({ text: "goodbye" }, entry())).toBe(false);
  });

  it("never matches on empty text", () => {
    expect(historyMatchesEntry({ text: "" }, entry({ text: "   " }))).toBe(false);
  });
});

describe("reconcileWithHistory", () => {
  it("confirms a prompt the transcript proves the gateway received", () => {
    const e = entry();
    const r = reconcileWithHistory([e], [{ text: "hello" }]);
    expect(r.delivered.map((x) => x.id)).toEqual(["id-1"]);
    expect(r.pending).toEqual([]);
  });

  it("keeps a prompt the transcript does NOT contain — the whole point", () => {
    const e = entry({ text: "the prompt that got forgotten" });
    const r = reconcileWithHistory([e], [{ text: "some other turn" }]);
    expect(r.delivered).toEqual([]);
    expect(r.pending.map((x) => x.id)).toEqual(["id-1"]);
  });

  it("matches one-to-one, so the same text sent twice is not half-confirmed", () => {
    const a = entry({ id: "a", ts: 1 });
    const b = entry({ id: "b", ts: 2 });
    const r = reconcileWithHistory([a, b], [{ text: "hello" }]);
    expect(r.delivered.map((x) => x.id)).toEqual(["a"]);
    expect(r.pending.map((x) => x.id)).toEqual(["b"]);
  });

  it("confirms both copies when the transcript has both", () => {
    const a = entry({ id: "a", ts: 1 });
    const b = entry({ id: "b", ts: 2 });
    const r = reconcileWithHistory([a, b], [{ text: "hello" }, { text: "hello" }]);
    expect(r.pending).toEqual([]);
  });

  it("prefers the keyed match over a text collision", () => {
    const a = entry({ id: "a", text: "hello" });
    const r = reconcileWithHistory(
      [a],
      [
        { idempotencyKey: "someone-else", text: "hello" },
        { idempotencyKey: "a", text: "hello" },
      ],
    );
    expect(r.delivered.map((x) => x.id)).toEqual(["a"]);
  });

  // REGRESSION 2026-08-16 (the architect: "I am still missing prompts"). Confirmation by text prefix used
  // to search the WHOLE transcript with no notion of time, so re-sending a prompt you had sent
  // before was instantly "confirmed" by the OLD copy: dropped from the outbox, un-flagged, and
  // then deleted from the transcript by the next loadChat. the architect demonstrably resends identical
  // text (the same "executive summary" prompt went in at 23:56 and again at 00:11), so this was
  // not a corner case — the safety net was deleting the very prompts it existed to protect.
  it("does NOT let an OLD identical turn confirm a freshly typed prompt", () => {
    const fresh = entry({ id: "new", text: "Great, do the summary", ts: 10_000_000 });
    const r = reconcileWithHistory(
      [fresh],
      [{ text: "Great, do the summary", ts: 9_000_000 }], // sent an hour earlier
    );
    expect(r.delivered).toEqual([]);
    expect(r.pending.map((x) => x.id)).toEqual(["new"]);
  });

  it("confirms when the matching turn is NEWER than the prompt", () => {
    const fresh = entry({ id: "new", text: "Great, do the summary", ts: 10_000_000 });
    const r = reconcileWithHistory([fresh], [{ text: "Great, do the summary", ts: 10_000_500 }]);
    expect(r.delivered.map((x) => x.id)).toEqual(["new"]);
  });

  it("tolerates small clock skew between the browser and the transcript", () => {
    const fresh = entry({ id: "new", text: "hello", ts: 10_000_000 });
    const r = reconcileWithHistory([fresh], [{ text: "hello", ts: 10_000_000 - 30_000 }]);
    expect(r.delivered.map((x) => x.id)).toEqual(["new"]);
  });

  it("still confirms on the exact key regardless of age — a key cannot collide", () => {
    const fresh = entry({ id: "new", text: "x", ts: 10_000_000 });
    const r = reconcileWithHistory(
      [fresh],
      [{ idempotencyKey: "new", text: "totally different", ts: 1 }],
    );
    expect(r.delivered.map((x) => x.id)).toEqual(["new"]);
  });

  it("without timestamps, only the TAIL of history may confirm by text", () => {
    const fresh = entry({ id: "new", text: "continue", ts: 10_000_000 });
    const ancient = Array.from({ length: 40 }, (_, i) => ({ text: `old turn ${i}` }));
    // the identical text sits deep in history, far from the tail
    const history = [{ text: "continue" }, ...ancient];
    const r = reconcileWithHistory([fresh], history);
    expect(r.delivered).toEqual([]);
  });

  it("treats an empty transcript as 'nothing delivered'", () => {
    const r = reconcileWithHistory([entry()], []);
    expect(r.pending).toHaveLength(1);
  });
});

describe("dueForReplay", () => {
  it("does not replay inside the grace window — the normal path confirms first", () => {
    expect(dueForReplay([entry({ ts: 1000 })], 1200, 15_000)).toEqual([]);
  });

  it("replays once the grace period has passed", () => {
    expect(dueForReplay([entry({ ts: 1000 })], 20_000, 15_000)).toHaveLength(1);
  });

  it("measures the wait from the LAST attempt, not from when it was typed", () => {
    const e = entry({ ts: 1000, attempts: 1, lastAttemptAt: 19_000 });
    expect(dueForReplay([e], 20_000, 15_000)).toEqual([]);
    expect(dueForReplay([e], 40_000, 15_000)).toHaveLength(1);
  });

  it("stops automatic replay after the attempt ceiling, without dropping the prompt", () => {
    const e = entry({ ts: 0, attempts: 8 });
    expect(dueForReplay([e], 1_000_000, 15_000, 8)).toEqual([]);
  });
});
