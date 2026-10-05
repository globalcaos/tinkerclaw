import { describe, it, expect } from "vitest";
import type { HistoryWindow } from "./history-window.js";
import {
  OUTBOX_CORRUPT_KEY,
  OUTBOX_MAX,
  OUTBOX_REPLAY_GRACE_MS,
  OUTBOX_STORAGE_KEY,
  dueForReplay,
  enqueueOutbox,
  historyMatchesEntry,
  markAcked,
  markAnswered,
  markAttempted,
  markCancelled,
  markProofChecked,
  outboxEntriesNeedingBubble,
  outboxForSession,
  OUTBOX_CURSOR_PROOF_LIMIT,
  OUTBOX_PROOF_LIMIT,
  outboxProofRequest,
  outboxNeedsTailProofRead,
  outboxSessionsNeedingProof,
  outboxTailProofRequest,
  PROOF_RECHECK_MS,
  readOutbox,
  reconcileWithHistory,
  removeFromOutbox,
  writeOutbox,
  appendJournal,
  dismissOutboxEntry,
  readJournal,
  JOURNAL_STORAGE_KEY,
  type HistoryUserMsg,
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

// ─── FORK 2026-09-08: identity, never text ──────────────────────────────────
//
// The keyed match never fired for three weeks: the gateway accepted `idempotencyKey` on chat.send
// but never wrote it to the transcript, so the text-prefix fallback over the last PREFIX_MATCH_TAIL
// user rows decided everything. In a cc-bridge session most user rows are tool_result-only
// (mtjwloe0: 10 of 19; the tail-8 held 4), so a real prompt fell out of the window, stayed
// "unproven", was re-armed on every reconnect (24-69 a day) and re-sent — answered twice. The
// server now serves the key back; these pin the client side of that contract.
describe("keyed proof of delivery (FORK 2026-09-08)", () => {
  /** A user row as chat.history serves it for a tool_result-only turn: no key, no text. */
  const toolRow = (): HistoryUserMsg => ({ text: "" });

  it("enqueueOutbox stamps keyedProofExpected on every new entry", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "k", sessionKey: "s", text: "hello", ts: 1 });
    expect(readOutbox(store)[0].keyedProofExpected).toBe(true);
  });

  it("a keyed served row confirms regardless of position among tool_result rows", () => {
    const e = entry({ id: "k", text: "hello", ts: 10_000_000, keyedProofExpected: true });
    // the prompt sits FIRST, then 20 tool-result-only user rows push it far outside the tail-8,
    // and its transcript timestamp is older than the entry by more than the skew allowance
    const history: HistoryUserMsg[] = [
      { idempotencyKey: "k", text: "hello\n\n---\n\ninjected suffix", ts: 1 },
      ...Array.from({ length: 20 }, toolRow),
    ];
    const r = reconcileWithHistory([e], history);
    expect(r.delivered.map((x) => x.id)).toEqual(["k"]);
    expect(r.pending).toEqual([]);
  });

  // CONTROL: the shape that produced the double answer. The SAME prompt as a legacy entry, behind
  // the same tool rows, is invisible to the text rule — it is out of the tail, so it stays pending
  // and gets re-sent. Without this control the keyed test above would pass against any fixture.
  it("CONTROL: the legacy text rule loses that same prompt behind tool_result rows", () => {
    const legacy = entry({ id: "old", text: "hello", ts: 1 });
    const history: HistoryUserMsg[] = [
      { text: "hello", ts: 2 },
      ...Array.from({ length: 20 }, toolRow),
    ];
    expect(reconcileWithHistory([legacy], history).pending.map((x) => x.id)).toEqual(["old"]);
  });

  it("an entry with keyedProofExpected is NOT confirmed by a text match", () => {
    const e = entry({ id: "k", text: "hello", ts: 10_000_000, keyedProofExpected: true });
    // an unkeyed row with the identical text, inside the tail and NEWER than the prompt —
    // everything the legacy rule would accept
    expect(historyMatchesEntry({ text: "hello", ts: 10_000_500 }, e)).toBe(false);
    const r = reconcileWithHistory([e], [{ text: "hello", ts: 10_000_500 }]);
    expect(r.delivered).toEqual([]);
    expect(r.pending.map((x) => x.id)).toEqual(["k"]);
  });

  it("...and it stays pending, not re-sent, until the key arrives", () => {
    const NOW = 10_000_000;
    const store = fakeStore();
    enqueueOutbox(store, { id: "k", sessionKey: "s", text: "hello", ts: NOW });
    markAcked(store, "k", NOW + 800); // chat.send answered ok, as on the normal path
    // history without the key: unproven — and the parked ack means no replay is due either
    const r1 = reconcileWithHistory(readOutbox(store), [{ text: "hello", ts: NOW + 500 }]);
    expect(r1.delivered).toEqual([]);
    expect(r1.pending.map((x) => x.id)).toEqual(["k"]);
    expect(dueForReplay(readOutbox(store), NOW + OUTBOX_REPLAY_GRACE_MS + 1)).toEqual([]);
    // the key arrives — identity confirms it, wherever the row sits
    const r2 = reconcileWithHistory(readOutbox(store), [
      toolRow(),
      { idempotencyKey: "k", text: "hello", ts: NOW + 500 },
      toolRow(),
    ]);
    expect(r2.delivered.map((x) => x.id)).toEqual(["k"]);
  });

  it("a legacy entry (no keyedProofExpected) still uses the text fallback as before", () => {
    const legacy = entry({ id: "old", text: "hello", ts: 10_000_000 });
    expect(legacy.keyedProofExpected).toBeUndefined();
    expect(historyMatchesEntry({ text: "hello", ts: 10_000_500 }, legacy)).toBe(true);
    const r = reconcileWithHistory([legacy], [{ text: "hello", ts: 10_000_500 }]);
    expect(r.delivered.map((x) => x.id)).toEqual(["old"]);
  });

  it("a legacy row read back from storage stays legacy", () => {
    const store = fakeStore(JSON.stringify([{ id: "old", sessionKey: "s", text: "hello", ts: 1 }]));
    expect(readOutbox(store)[0].keyedProofExpected).toBeUndefined();
  });

  it("a keyed row for SOMEONE ELSE never confirms a keyed-proof entry, whatever its text", () => {
    const e = entry({ id: "k", text: "hello", ts: 1, keyedProofExpected: true });
    const r = reconcileWithHistory([e], [{ idempotencyKey: "other", text: "hello", ts: 2 }]);
    expect(r.delivered).toEqual([]);
    expect(r.pending.map((x) => x.id)).toEqual(["k"]);
  });
});

describe("supersededIdempotencyKeys (FORK 2026-09-23)", () => {
  const served = (over: Partial<HistoryUserMsg> = {}): HistoryUserMsg => ({
    idempotencyKey: "live",
    supersededIdempotencyKeys: ["orphan"],
    text: "[Tue 2026-09-22 13:38 GMT+2] can you check it again --- suffix",
    ts: 2,
    ...over,
  });

  it("retires an orphaned send listed on the row that followed it, text matching", () => {
    const orphan = entry({
      id: "orphan",
      text: "can you check it again",
      keyedProofExpected: true,
    });
    const live = entry({ id: "live", text: "can you check it again", keyedProofExpected: true });
    const r = reconcileWithHistory([orphan, live], [served()]);
    // both retire: the superseded match does not consume the row the live key claims
    expect(r.delivered.map((x) => x.id).toSorted()).toEqual(["live", "orphan"]);
    expect(r.pending).toEqual([]);
  });

  it("identity AND text: a listed key whose text is not in the row stays pending", () => {
    const orphan = entry({ id: "orphan", text: "something else", keyedProofExpected: true });
    expect(reconcileWithHistory([orphan], [served()]).pending.map((x) => x.id)).toEqual(["orphan"]);
  });

  it("text alone never retires: an unlisted key with matching text stays pending", () => {
    const e = entry({ id: "stranger", text: "can you check it again", keyedProofExpected: true });
    expect(reconcileWithHistory([e], [served()]).pending.map((x) => x.id)).toEqual(["stranger"]);
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

  it("never replays a prompt whose own run was STOPPED (FORK 2026-09-25)", () => {
    // UNACKED on purpose: an aborted run was accepted first, so such an entry is normally acked and
    // parked already — but the ack is what a page can miss (a socket that dropped before
    // chat.send's reply came back), and then only this rule stands between the owner's Stop and a
    // replay of the very turn they stopped, once the grace period has passed.
    const stopped = entry({ ts: 1000, cancelledAt: 5_000 });
    expect(stopped.ackedAt).toBeUndefined();
    expect(dueForReplay([stopped], 1_000_000, 15_000)).toEqual([]);
    // CONTROL: the same entry WITHOUT the stamp is due, so the stamp is what holds it back.
    expect(dueForReplay([entry({ ts: 1000 })], 1_000_000, 15_000)).toHaveLength(1);
    // readOutbox passes `cancelledAt` through unvalidated, so a stored value that is not a number
    // is NOT a stop: it must not park an unproven prompt forever (msg-order.ts `outboxPromptFacts`
    // reads it the same way).
    const junk = entry({ ts: 1000, cancelledAt: "soon" as unknown as number });
    expect(dueForReplay([junk], 1_000_000, 15_000)).toHaveLength(1);
  });

  it("a stopped entry's session is still read for proof — only the REPLAY stops", () => {
    // dueForReplay feeds outboxSessionsNeedingProof, so refusing a cancelled entry must not stop
    // its transcript being read: a stop is not proof, and only proof (or Dismiss) retires an entry
    // (PQ-9). The PROOF_RECHECK_MS branch keeps the session on the list.
    const e = entry({ id: "a", sessionKey: "s1", ts: 0, cancelledAt: 10 });
    expect(dueForReplay([e], 1_000_000, 15_000)).toEqual([]);
    expect(outboxSessionsNeedingProof([e], 1_000_000)).toEqual(["s1"]);
  });
});

// ─── FORK 2026-09-23: the outbox backstop fetches only sessions that need proof ─────────────────
//
// Measured cause of the gateway event-loop saturation: flushOutbox's 20s tick fetched
// chat.history (limit 1000) for EVERY session holding ANY outbox entry, before checking whether
// anything was due — so an acked/unprovable entry kept its session's whole transcript re-read
// every 20s forever. outboxSessionsNeedingProof narrows that to sessions actually due for replay,
// or whose proof has gone stale (PROOF_RECHECK_MS).
describe("outboxSessionsNeedingProof", () => {
  const NOW = 1_000_000;

  it("skips an acked entry whose proof was checked recently", () => {
    const e = entry({
      id: "a",
      sessionKey: "s1",
      ackedAt: NOW - 50_000,
      lastProofCheckAt: NOW - 10_000,
    });
    expect(outboxSessionsNeedingProof([e], NOW)).toEqual([]);
  });

  it("rechecks an acked entry once PROOF_RECHECK_MS has passed since its last check", () => {
    const e = entry({
      id: "a",
      sessionKey: "s1",
      ackedAt: NOW - 500_000,
      lastProofCheckAt: NOW - PROOF_RECHECK_MS - 1,
    });
    expect(outboxSessionsNeedingProof([e], NOW)).toEqual(["s1"]);
  });

  it("always includes entries due for replay, deduped per session", () => {
    const e = [
      entry({
        id: "a",
        sessionKey: "s1",
        ts: NOW - OUTBOX_REPLAY_GRACE_MS - 1,
        lastProofCheckAt: NOW,
      }),
      entry({
        id: "b",
        sessionKey: "s1",
        ts: NOW - OUTBOX_REPLAY_GRACE_MS - 1,
        lastProofCheckAt: NOW,
      }),
    ];
    expect(outboxSessionsNeedingProof(e, NOW)).toEqual(["s1"]);
  });

  it("includes an entry that has never had its proof checked (first check)", () => {
    // Not due for replay (acked, so parked) AND lastProofCheckAt was never stamped — the "unset"
    // branch must count as stale on its own, independent of the due-for-replay branch above.
    const e = entry({ id: "a", sessionKey: "s1", ackedAt: NOW - 500_000 });
    expect(e.lastProofCheckAt).toBeUndefined();
    expect(outboxSessionsNeedingProof([e], NOW)).toEqual(["s1"]);
  });
});

describe("markProofChecked", () => {
  it("stamps lastProofCheckAt on every entry of the given session, and persists it", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "a", sessionKey: "s1", text: "one", ts: 1 });
    enqueueOutbox(store, { id: "b", sessionKey: "s1", text: "two", ts: 2 });
    enqueueOutbox(store, { id: "c", sessionKey: "s2", text: "other session", ts: 3 });
    markProofChecked(store, "s1", 5_000);
    const after = readOutbox(store);
    expect(after.find((e) => e.id === "a")?.lastProofCheckAt).toBe(5_000);
    expect(after.find((e) => e.id === "b")?.lastProofCheckAt).toBe(5_000);
    expect(after.find((e) => e.id === "c")?.lastProofCheckAt).toBeUndefined();
  });

  it("round-trips lastProofCheckAt through storage like the other stamps", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "a", sessionKey: "s1", text: "one", ts: 1 });
    markProofChecked(store, "s1", 42);
    expect(readOutbox(store)[0].lastProofCheckAt).toBe(42);
  });
});

describe("markCancelled — the prompt's own stop, stamped on its entry (FORK 2026-09-25)", () => {
  it("stamps only the named entry, round-trips it, and keeps the FIRST stop (PQ-6)", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "a", sessionKey: "s1", text: "one", ts: 1 });
    enqueueOutbox(store, { id: "b", sessionKey: "s1", text: "two", ts: 2 });
    markCancelled(store, "a", 100);
    markCancelled(store, "a", 900);
    const after = readOutbox(store);
    expect(after.find((e) => e.id === "a")?.cancelledAt).toBe(100);
    expect(after.find((e) => e.id === "b")?.cancelledAt).toBeUndefined();
  });

  it("is a stamp, not a retirement, and reports no transition", () => {
    const seen: string[] = [];
    const store: OutboxStore = { ...fakeStore(), onTransition: (t) => seen.push(t.to) };
    enqueueOutbox(store, { id: "a", sessionKey: "s1", text: "one", ts: 1 });
    markAcked(store, "a", 50);
    expect(seen).toEqual(["queued", "acked"]);
    markCancelled(store, "a", 100);
    expect(seen).toEqual(["queued", "acked"]);
    expect(readOutbox(store).map((e) => [e.id, e.text, e.ackedAt, e.cancelledAt])).toEqual([
      ["a", "one", 50, 100],
    ]);
  });

  it("writes nothing for an id the outbox does not hold", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "a", sessionKey: "s1", text: "one", ts: 1 });
    const before = store.dump();
    markCancelled(store, "gone", 100);
    expect(store.dump()).toBe(before);
  });
});

// ─── FORK 2026-10-01: an answered prompt costs no bubble and no proof read ──────────────────────
//
// bug-log.md [chat-divergence], cause 1, client half. The answer lived only on the live bubble, so
// once a fresh history merge dropped it, an entry nothing proves (a session's first prompt is never
// keyed in the transcript) was re-drawn LOST beside its served row on every load, and its session
// was read every PROOF_RECHECK_MS. `answeredAt` puts the answer on the entry itself.
describe("markAnswered — the prompt's own answer, stamped on its entry (FORK 2026-10-01)", () => {
  const NOW = 1_000_000;

  it("an answered entry needs no bubble, even with nothing on screen yet", () => {
    const answered = entry({ id: "a", answeredAt: NOW });
    const open = entry({ id: "b" });
    for (const onScreen of [undefined, null, new Set<string>(), ["zzz"]]) {
      expect(outboxEntriesNeedingBubble([answered, open], onScreen).map((e) => e.id)).toEqual([
        "b",
      ]);
    }
    // CONTROL: the same entry without the stamp is re-drawn, so the stamp is what holds it back.
    expect(outboxEntriesNeedingBubble([entry({ id: "a" })], undefined).map((e) => e.id)).toEqual([
      "a",
    ]);
  });

  it("an answered entry is not due for a proof read", () => {
    // Acked and never proven: the stuck entry the bug log measured, read every PROOF_RECHECK_MS.
    const stuck = entry({ id: "a", sessionKey: "s1", ackedAt: NOW - 500_000 });
    expect(outboxSessionsNeedingProof([stuck], NOW)).toEqual(["s1"]); // CONTROL
    expect(outboxSessionsNeedingProof([{ ...stuck, answeredAt: NOW - 400_000 }], NOW)).toEqual([]);
  });

  it("nor for a replay, when the ack was missed and the final was not", () => {
    const unacked = entry({ id: "a", sessionKey: "s1", ts: NOW - OUTBOX_REPLAY_GRACE_MS - 1 });
    expect(dueForReplay([unacked], NOW)).toHaveLength(1); // CONTROL
    const answered = { ...unacked, answeredAt: NOW - 1, lastProofCheckAt: NOW };
    expect(dueForReplay([answered], NOW)).toEqual([]);
    expect(outboxSessionsNeedingProof([answered], NOW)).toEqual([]);
  });

  it("an unanswered neighbour still gets its session read, and keyed proof retires both", () => {
    const answered = entry({ id: "a", sessionKey: "s1", answeredAt: NOW - 1 });
    const open = entry({ id: "b", sessionKey: "s1", ackedAt: NOW - 500_000 });
    expect(outboxSessionsNeedingProof([answered, open], NOW)).toEqual(["s1"]);
    const r = reconcileWithHistory(
      [answered, open],
      [
        { idempotencyKey: "a", text: "hello" },
        { idempotencyKey: "b", text: "hello" },
      ],
    );
    expect(r.delivered.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("stamps only the named entry, keeps the first answer, round-trips through the store", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "a", sessionKey: "s1", text: "one", ts: 1 });
    enqueueOutbox(store, { id: "b", sessionKey: "s1", text: "two", ts: 2 });
    markAnswered(store, "a", 100);
    markAnswered(store, "a", 900);
    expect(readOutbox(store).map((e) => [e.id, e.answeredAt])).toEqual([
      ["a", 100],
      ["b", undefined],
    ]);
    expect(writeOutbox(store, readOutbox(store))).toBe(true);
    expect(readOutbox(store).map((e) => [e.id, e.answeredAt])).toEqual([
      ["a", 100],
      ["b", undefined],
    ]);
  });

  it("only a number reads back as an answer: junk in storage never hides a prompt", () => {
    const junk = fakeStore(
      JSON.stringify([{ id: "j", sessionKey: "s1", text: "x", ts: 1, answeredAt: "yes" }]),
    );
    const [e] = readOutbox(junk);
    expect(e.answeredAt).toBeUndefined();
    expect(outboxEntriesNeedingBubble([e], undefined).map((x) => x.id)).toEqual(["j"]);
  });

  it("the first outcome stands: a stopped entry is never stamped answered, and the reverse", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "stopped", sessionKey: "s1", text: "one", ts: 1 });
    enqueueOutbox(store, { id: "answered", sessionKey: "s1", text: "two", ts: 2 });
    markCancelled(store, "stopped", 100);
    markAnswered(store, "stopped", 200);
    markAnswered(store, "answered", 100);
    markCancelled(store, "answered", 200);
    expect(readOutbox(store).map((e) => [e.id, e.cancelledAt, e.answeredAt])).toEqual([
      ["stopped", 100, undefined],
      ["answered", undefined, 100],
    ]);
  });

  it("is a stamp, not a retirement: the entry stays and no transition is reported", () => {
    const seen: string[] = [];
    const store: OutboxStore = { ...fakeStore(), onTransition: (t) => seen.push(t.to) };
    enqueueOutbox(store, { id: "a", sessionKey: "s1", text: "one", ts: 1 });
    markAcked(store, "a", 50);
    markAnswered(store, "a", 100);
    expect(seen).toEqual(["queued", "acked"]);
    expect(readOutbox(store).map((e) => [e.id, e.text, e.ackedAt, e.answeredAt])).toEqual([
      ["a", "one", 50, 100],
    ]);
  });

  it("writes nothing for an id the outbox does not hold", () => {
    const store = fakeStore();
    enqueueOutbox(store, { id: "a", sessionKey: "s1", text: "one", ts: 1 });
    const before = store.dump();
    markAnswered(store, "gone", 100);
    expect(store.dump()).toBe(before);
  });
});

// ─── FORK 2026-09-23 (plan task 8): proof by seq cursor ─────────────────────
//
// Review focus 5: an entry whose proof row is older than the tail window must still be proven.
// An entry records the tab's window (lastSeq + epoch) when it is typed; the proof read asks for
// the rows after it instead of the last 200.
describe("outboxProofRequest", () => {
  const w = (over: Partial<HistoryWindow> = {}): HistoryWindow => ({
    epoch: "e1",
    firstSeq: 1,
    lastSeq: 300,
    hasMoreBefore: false,
    sessionId: "sid",
    ...over,
  });

  it("asks for the rows after the entry's send-time seq, one row early, under the window's epoch", () => {
    expect(outboxProofRequest("k", [entry({ sentAfterSeq: 40, sentEpoch: "e1" })], w())).toEqual({
      sessionKey: "k",
      afterSeq: 39,
      epoch: "e1",
      limit: OUTBOX_CURSOR_PROOF_LIMIT,
    });
    expect(OUTBOX_CURSOR_PROOF_LIMIT).toBe(1000);
  });

  it("starts from the OLDEST entry of the session, and never below seq 0", () => {
    const two = [
      entry({ id: "a", sentAfterSeq: 40, sentEpoch: "e1" }),
      entry({ id: "b", sentAfterSeq: 25, sentEpoch: "e1" }),
    ];
    expect(outboxProofRequest("k", two, w())).toEqual({
      sessionKey: "k",
      afterSeq: 24,
      epoch: "e1",
      limit: OUTBOX_CURSOR_PROOF_LIMIT,
    });
    expect(outboxProofRequest("k", [entry({ sentAfterSeq: 0, sentEpoch: "e1" })], w())).toEqual({
      sessionKey: "k",
      afterSeq: 0,
      epoch: "e1",
      limit: OUTBOX_CURSOR_PROOF_LIMIT,
    });
  });

  it("R24: a prompt sent MORE than 200 rows ago is still proven by a delta, not a reset", () => {
    // The gateway's afterSeq rule (server-methods/chat.ts + chat-history-cursor.ts planAfter, ruling
    // R10): effective limit = min(1000, limit ?? 200); a delta longer than that is answered reset
    // with the last `limit` rows — and a proof row older than those is then never seen.
    const gatewayAnswersReset = (r: Record<string, unknown>, transcriptLastSeq: number) => {
      const limit = Math.min(1000, typeof r.limit === "number" ? r.limit : 200);
      return transcriptLastSeq - (r.afterSeq as number) > limit;
    };
    const sentLongAgo = [entry({ sentAfterSeq: 40, sentEpoch: "e1" })];
    const transcriptLastSeq = 300; // 261 rows after the proof read's anchor (39)
    const now = outboxProofRequest("k", sentLongAgo, w({ lastSeq: transcriptLastSeq }));
    expect(gatewayAnswersReset(now, transcriptLastSeq)).toBe(false);
    // CONTROL: the pre-R24 shape carried no limit, so the gateway's 200 default reset this delta.
    const oldShape = { sessionKey: "k", afterSeq: 39, epoch: "e1" };
    expect(gatewayAnswersReset(oldShape, transcriptLastSeq)).toBe(true);
  });

  it("falls back to the last 200 rows when ANY entry has no send-time seq", () => {
    const mixed = [entry({ id: "a", sentAfterSeq: 40, sentEpoch: "e1" }), entry({ id: "b" })];
    expect(outboxProofRequest("k", mixed, w())).toEqual({
      sessionKey: "k",
      limit: OUTBOX_PROOF_LIMIT,
    });
    expect(OUTBOX_PROOF_LIMIT).toBe(200);
  });

  it("falls back when the tab's window has no epoch (the gateway before its restart, R7)", () => {
    expect(
      outboxProofRequest("k", [entry({ sentAfterSeq: 40, sentEpoch: "e1" })], w({ epoch: null })),
    ).toEqual({ sessionKey: "k", limit: OUTBOX_PROOF_LIMIT });
  });

  it("falls back when the seq was recorded under ANOTHER epoch — it names a different row now", () => {
    // CONTROL: without the epoch check this would ask afterSeq 39 under e1 for a number recorded
    // under e0; after a rewrite that skips the proof row, and an un-acked delivered prompt is
    // then replayed — a second real turn.
    expect(outboxProofRequest("k", [entry({ sentAfterSeq: 40, sentEpoch: "e0" })], w())).toEqual({
      sessionKey: "k",
      limit: OUTBOX_PROOF_LIMIT,
    });
    expect(outboxProofRequest("k", [entry({ sentAfterSeq: 40 })], w())).toEqual({
      sessionKey: "k",
      limit: OUTBOX_PROOF_LIMIT,
    });
  });

  // FORK 2026-09-24 (final review item 7) — a keyed entry is proven by its key at ANY position,
  // so its fallback read asks the gateway's maximum; only text proof is tail-bound.
  it("a keyed entry with no usable send cursor falls back to the last 1000 rows, not 200", () => {
    const keyed = entry({ keyedProofExpected: true });
    expect(outboxProofRequest("k", [keyed], w())).toEqual({
      sessionKey: "k",
      limit: OUTBOX_CURSOR_PROOF_LIMIT,
    });
    expect(outboxProofRequest("k", [keyed], w({ epoch: null }))).toEqual({
      sessionKey: "k",
      limit: OUTBOX_CURSOR_PROOF_LIMIT,
    });
    // One keyed entry is enough: text proof reads only the tail of the same rows.
    expect(outboxTailProofRequest("k", [entry({ id: "a" }), { ...keyed, id: "b" }])).toEqual({
      sessionKey: "k",
      limit: OUTBOX_CURSOR_PROOF_LIMIT,
    });
  });

  it("control: text-proof-only (legacy) entries keep the 200-row tail read", () => {
    expect(outboxTailProofRequest("k", [entry()])).toEqual({
      sessionKey: "k",
      limit: OUTBOX_PROOF_LIMIT,
    });
    expect(outboxTailProofRequest("k", [])).toEqual({ sessionKey: "k", limit: OUTBOX_PROOF_LIMIT });
  });

  // FORK 2026-09-24 (task 8 ledger M2) — a `reset` reply to the cursor proof read IS the last
  // 1000 rows: reconcile against it first, and read the tail again only if proof is still missing.
  describe("outboxNeedsTailProofRead", () => {
    const cursorReq = {
      sessionKey: "k",
      afterSeq: 39,
      epoch: "e1",
      limit: OUTBOX_CURSOR_PROOF_LIMIT,
    };
    const reply = (reset: boolean) => ({
      messages: [],
      cursor: { epoch: "e2", firstSeq: 1, lastSeq: 10, hasMoreBefore: false, reset },
    });

    it("a reset reply that proved every entry needs no second read", () => {
      expect(outboxNeedsTailProofRead(cursorReq, reply(true), 0)).toBe(false);
    });

    it("a reset reply that left an entry unproven is read again as the tail", () => {
      expect(outboxNeedsTailProofRead(cursorReq, reply(true), 2)).toBe(true);
    });

    it("a rejected or failed cursor read (no reply) is read again as the tail", () => {
      expect(outboxNeedsTailProofRead(cursorReq, null, 1)).toBe(true);
    });

    it("control: a delta or a legacy read never triggers a second read", () => {
      expect(outboxNeedsTailProofRead(cursorReq, reply(false), 3)).toBe(false);
      expect(outboxNeedsTailProofRead({ sessionKey: "k", limit: 200 }, null, 3)).toBe(false);
      expect(outboxNeedsTailProofRead({ sessionKey: "k", limit: 200 }, reply(true), 3)).toBe(false);
    });
  });

  it("falls back for a session with no entries", () => {
    expect(outboxProofRequest("k", [], w())).toEqual({
      sessionKey: "k",
      limit: OUTBOX_PROOF_LIMIT,
    });
  });

  it("the send-time seq is stored with the entry and round-trips; a legacy entry loads without it", () => {
    const store = fakeStore();
    enqueueOutbox(store, {
      id: "a",
      sessionKey: "s1",
      text: "one",
      ts: 1,
      sentAfterSeq: 12,
      sentEpoch: "e1",
    });
    enqueueOutbox(store, { id: "b", sessionKey: "s1", text: "two", ts: 2 });
    const [a, b] = readOutbox(store);
    expect(a.sentAfterSeq).toBe(12);
    expect(a.sentEpoch).toBe("e1");
    expect(b.sentAfterSeq).toBeUndefined();
    expect(b.sentEpoch).toBeUndefined();
    // Garbage in storage reads as "not recorded", never as a position.
    const junk = fakeStore(
      JSON.stringify([
        { id: "c", sessionKey: "s1", text: "x", ts: 3, sentAfterSeq: "12", sentEpoch: 7 },
      ]),
    );
    expect(readOutbox(junk)[0].sentAfterSeq).toBeUndefined();
    expect(readOutbox(junk)[0].sentEpoch).toBeUndefined();
  });
});

// ─── FORK 2026-09-04: the prompt-eating sequence, reproduced ────────────────
//
// The architect lost four long prompts in one morning. Each was accepted by the gateway, never
// persisted to the transcript, and then DELETED from the outbox by the replay path calling
// removeFromOutbox on the gateway's dedupe-cache echo. These tests pin the shape so it cannot
// come back.
describe("an ack must never destroy the last copy", () => {
  const NOW = 1_788_500_000_000;
  const seed = (): Pick<OutboxEntry, "id" | "sessionKey" | "text" | "ts"> => ({
    id: "id-1",
    sessionKey: "agent:main:tinker:abc",
    text: "a long, carefully written prompt",
    ts: NOW,
  });

  it("parks an acked entry instead of retiring it — the text survives", () => {
    const store = fakeStore();
    enqueueOutbox(store, seed());
    markAcked(store, "id-1", NOW);
    const kept = readOutbox(store);
    expect(kept).toHaveLength(1);
    expect(kept[0].text).toBe("a long, carefully written prompt");
    expect(kept[0].ackedAt).toBe(NOW);
  });

  it("does not replay a parked entry — this is the replay that used to end in a delete", () => {
    const store = fakeStore();
    enqueueOutbox(store, seed());
    markAcked(store, "id-1", NOW);
    const due = dueForReplay(readOutbox(store), NOW + OUTBOX_REPLAY_GRACE_MS + 1);
    expect(due).toHaveLength(0);
  });

  it("WOULD have replayed it without the park (the pre-fix behaviour)", () => {
    const store = fakeStore();
    enqueueOutbox(store, seed());
    const due = dueForReplay(readOutbox(store), NOW + OUTBOX_REPLAY_GRACE_MS + 1);
    expect(due).toHaveLength(1);
  });

  it("keeps an acknowledged entry parked indefinitely, including across reconnect time", () => {
    const store = fakeStore();
    enqueueOutbox(store, seed());
    markAcked(store, "id-1", NOW);
    expect(readOutbox(store)[0].ackedAt).toBe(NOW);
    const muchLater = NOW + 30 * 24 * 60 * 60 * 1000;
    expect(dueForReplay(readOutbox(store), muchLater)).toEqual([]);
  });

  it("only the transcript may retire an entry", () => {
    const store = fakeStore();
    enqueueOutbox(store, seed());
    markAcked(store, "id-1", NOW);
    expect(readOutbox(store)).toHaveLength(1);
    removeFromOutbox(store, "id-1");
    expect(readOutbox(store)).toHaveLength(0);
  });
});

describe("a corrupt outbox is quarantined, not overwritten", () => {
  /** fakeStore ignores the key; quarantine writes to a DIFFERENT key, so this one is keyed. */
  const keyedStore = (): OutboxStore & { raw: Map<string, string> } => {
    const raw = new Map<string, string>();
    return {
      raw,
      getItem: (k: string) => raw.get(k) ?? null,
      setItem: (k: string, v: string) => {
        raw.set(k, v);
      },
    };
  };

  it("keeps the unparseable bytes so the prompts stay recoverable", () => {
    const store = fakeStore();
    store.setItem(OUTBOX_STORAGE_KEY, '[{"id":"a","text":"my prompt"'); // truncated write
    expect(readOutbox(store)).toEqual([]);
    expect(store.getItem(OUTBOX_CORRUPT_KEY)).toBe('[{"id":"a","text":"my prompt"');
  });

  it("does not quarantine a healthy store", () => {
    const store = keyedStore();
    enqueueOutbox(store, {
      id: "x",
      sessionKey: "s",
      text: "t",
      ts: 1,
      attempts: 0,
      lastAttemptAt: 0,
    });
    readOutbox(store);
    expect(store.getItem(OUTBOX_CORRUPT_KEY)).toBeNull();
  });
});

describe("U4 — dismissOutboxEntry, the owner's journaled retirement (PQ-9)", () => {
  /** fakeStore ignores the key; the outbox and the journal are two keys, so this one is keyed. */
  const keyed = (): OutboxStore & { raw: Map<string, string> } => {
    const raw = new Map<string, string>();
    return {
      raw,
      getItem: (k: string) => raw.get(k) ?? null,
      setItem: (k: string, v: string) => {
        raw.set(k, v);
      },
    };
  };
  const lost = {
    id: "lost-1",
    sessionKey: "agent:main:tinker:A",
    text: "where did it go",
    ts: 1_000,
  };

  it("retires the entry and KEEPS its journal row, stamped with the dismissal", () => {
    const store = keyed();
    enqueueOutbox(store, lost);
    appendJournal(store, lost);
    markAcked(store, lost.id, 2_000);
    expect(dismissOutboxEntry(store, lost.id, 3_000)).toBe(true);
    expect(readOutbox(store)).toEqual([]);
    expect(readJournal(store)).toEqual([{ ...lost, dismissedAt: 3_000 }]);
  });

  it("CONTROL — the proof retirement records nothing: only a Dismiss is journaled", () => {
    const store = keyed();
    enqueueOutbox(store, lost);
    appendJournal(store, lost);
    removeFromOutbox(store, lost.id);
    expect(readOutbox(store)).toEqual([]);
    expect(readJournal(store)).toEqual([lost]);
  });

  it("re-appends the text first when the journal no longer holds the row", () => {
    const store = keyed();
    enqueueOutbox(store, lost);
    expect(readJournal(store)).toEqual([]);
    expect(dismissOutboxEntry(store, lost.id, 3_000)).toBe(true);
    expect(readJournal(store)).toEqual([{ ...lost, dismissedAt: 3_000 }]);
  });

  it("retires NOTHING when the journal cannot record it, and leaves that journal untouched", () => {
    const store = keyed();
    enqueueOutbox(store, lost);
    store.raw.set(JOURNAL_STORAGE_KEY, "{not json");
    expect(dismissOutboxEntry(store, lost.id, 3_000)).toBe(false);
    expect(readOutbox(store).map((e) => e.id)).toEqual([lost.id]);
    expect(store.raw.get(JOURNAL_STORAGE_KEY)).toBe("{not json");
  });

  it("refuses an unknown id, and a Resend that names the entry's own key", () => {
    const store = keyed();
    enqueueOutbox(store, lost);
    expect(dismissOutboxEntry(store, "nope", 3_000)).toBe(false);
    expect(dismissOutboxEntry(store, lost.id, 3_000, { resentAs: lost.id })).toBe(false);
    expect(readOutbox(store).map((e) => e.id)).toEqual([lost.id]);
  });

  it("round-trips a Resend link; enqueueOutbox refuses an entry that re-sends its own key", () => {
    const store = keyed();
    expect(enqueueOutbox(store, { ...lost, id: "new-1", retryOf: lost.id })).toBe(true);
    expect(readOutbox(store)[0].retryOf).toBe(lost.id);
    expect(enqueueOutbox(store, { ...lost, retryOf: lost.id })).toBe(false);
    expect(readOutbox(store).map((e) => e.id)).toEqual(["new-1"]);
  });
});
