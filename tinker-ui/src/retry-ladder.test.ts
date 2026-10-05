// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 step U5 (contradiction C8): the
// recoverable-error retry ladder goes THROUGH the durable outbox.
//
// THE DEFECT. app.ts `retryLastTurn` put a ladder fire straight on the wire: `chat.send` with a
// fresh key, the RAW text, and no outbox entry. A fire that met a closed socket existed only in the
// in-memory `retryState`, so a reload during the disconnect lost it, and no transcript row could
// ever prove it. The ladder runs exactly while the gateway is unwell, which is when reloads happen.
//
// app.ts is a browser entry with no harness, so every step below is the PURE function it calls:
// `enqueueLadderRetry` (synchronously, before retryLastTurn's first await), then what the outbox
// does after a reload (`readOutbox` → `dueForReplay` → the re-drawn bubble → `reconcileWithHistory`).
// The last block reads app.ts itself and pins the ORDER inside retryLastTurn, because the fix is an
// ordering fix, as it is in send().
//
// CONTROL (§7): `ladderFireBeforeU5` transcribes the pre-U5 fire. Its test passes and shows the
// loss, so the fix is measured against the defect and not against a fixture that could share it. On
// the pre-change tree the rest of this file is RED: `enqueueLadderRetry` does not exist there.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { outboxPromptFacts, promptBubbleMarks, promptStateOf } from "./msg-order.js";
import {
  OUTBOX_REPLAY_GRACE_MS,
  OUTBOX_STORAGE_KEY,
  dueForReplay,
  enqueueLadderRetry,
  markAcked,
  outboxEntriesNeedingBubble,
  readJournal,
  readOutbox,
  reconcileWithHistory,
  type OutboxStore,
} from "./outbox.js";
import { derivePromptState, promptIndicator } from "./prompt-state.js";

type Disk = OutboxStore & { bytes: Map<string, string> };

/**
 * localStorage, keyed. The outbox and the journal live under DIFFERENT keys, so the single-value
 * fake in outbox.test.ts would let one overwrite the other here. `bytes` is the disk.
 */
function fakeStorage(bytes: Map<string, string> = new Map()): Disk {
  return {
    bytes,
    getItem: (k) => bytes.get(k) ?? null,
    setItem: (k, v) => {
      bytes.set(k, v);
    },
  };
}

/** A reload: the page's memory is gone, and only what reached the disk comes back. */
function reload(disk: Disk): Disk {
  return fakeStorage(new Map(disk.bytes));
}

const SK = "agent:main:main";
const ORIGINAL = "prompt-typed-1";
const TEXT = "summarise the build log";
const T0 = 1_760_000_000_000;

function fireInto(store: OutboxStore, idempotencyKey: string, ts = T0) {
  return enqueueLadderRetry(store, {
    idempotencyKey,
    sessionKey: SK,
    text: TEXT,
    ts,
    retryOf: ORIGINAL,
  });
}

/**
 * THE CONTROL: the fire BEFORE U5, transcribed from app.ts `retryLastTurn` at 3e60ec36dd4:
 *   await req("chat.send", { sessionKey: sk, message: text, idempotencyKey: uuid(), …pins });
 *   catch → scheduleRetry(…)   // in page memory only
 * It never touched storage, so it takes none. `send` stands for `req`; false = the socket was closed.
 */
function ladderFireBeforeU5(send: (frame: Record<string, unknown>) => boolean): {
  sent: boolean;
  rescheduledInMemory: boolean;
} {
  const sent = send({ sessionKey: SK, message: TEXT, idempotencyKey: "fresh-key" });
  return { sent, rescheduledInMemory: !sent };
}

const socketClosed = (): boolean => false;

describe("U5 — a ladder fire during a disconnect survives a reload", () => {
  it("CONTROL — before U5 the fire lived only in page memory: after a reload nothing is left", () => {
    const disk = fakeStorage();
    expect(ladderFireBeforeU5(socketClosed)).toEqual({ sent: false, rescheduledInMemory: true });
    const page2 = reload(disk);
    expect(readOutbox(page2)).toEqual([]);
    expect(readJournal(page2)).toEqual([]);
    expect(dueForReplay(readOutbox(page2), T0 + 10 * OUTBOX_REPLAY_GRACE_MS)).toEqual([]);
  });

  it("the fire is on disk before anything is sent, and the tick replays it after the reload", () => {
    const disk = fakeStorage();
    expect(fireInto(disk, "retry-1")?.persisted).toBe(true);
    // The socket is closed: app.ts resendOutboxEntry returns before it counts an attempt, and
    // nothing acks the entry. Reload.
    const entries = readOutbox(reload(disk));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "retry-1",
      sessionKey: SK,
      text: TEXT,
      ts: T0,
      retryOf: ORIGINAL,
      attempts: 0,
      keyedProofExpected: true,
    });
    expect(entries[0].ackedAt).toBeUndefined();
    // The normal fast path confirms first, so there is no replay inside the grace...
    expect(dueForReplay(entries, T0 + OUTBOX_REPLAY_GRACE_MS - 1)).toEqual([]);
    // ...and after it the 20 s tick replays the fire under ITS OWN key (resendOutboxEntry sends
    // `idempotencyKey: entry.id`), never the original's, which the gateway dedupe would absorb.
    const due = dueForReplay(entries, T0 + OUTBOX_REPLAY_GRACE_MS);
    expect(due.map((e) => e.id)).toEqual(["retry-1"]);
    expect(due[0].id).not.toBe(ORIGINAL);
  });

  it("the journal keeps the fire's text and its link, whatever delivery concludes (PQ-9)", () => {
    const disk = fakeStorage();
    fireInto(disk, "retry-1");
    expect(readJournal(reload(disk))).toEqual([
      { id: "retry-1", sessionKey: SK, text: TEXT, ts: T0, retryOf: ORIGINAL },
    ]);
  });

  it("after the reload the fire is back on screen as UNSENT: not lost, and not silent", () => {
    const disk = fakeStorage();
    fireInto(disk, "retry-1");
    // What app.ts reinjectOutboxBubbles draws on a page that shows nothing yet.
    const [entry] = outboxEntriesNeedingBubble(readOutbox(reload(disk)), new Set<string>());
    const bubble = {
      role: "user",
      _clientMsgId: entry.id,
      content: [{ type: "text", text: entry.text }],
      _retryOf: entry.retryOf,
      _promptState: outboxPromptFacts(entry),
    };
    expect(promptStateOf(bubble)).toBe("UNSENT");
    expect(promptBubbleMarks(bubble).badge).toContain("not sent · retrying");
  });

  it("the fire is proven by ITS OWN keyed row, and the original's row does not prove it", () => {
    const disk = fakeStorage();
    fireInto(disk, "retry-1");
    const entries = readOutbox(reload(disk));
    const originalRow = { idempotencyKey: ORIGINAL, text: TEXT, ts: T0 - 5_000 };
    expect(reconcileWithHistory(entries, [originalRow]).delivered).toEqual([]);
    const fireRow = { idempotencyKey: "retry-1", text: TEXT, ts: T0 + 1_000 };
    const proven = reconcileWithHistory(entries, [originalRow, fireRow]).delivered;
    expect(proven.map((e) => e.id)).toEqual(["retry-1"]);
  });

  it("an acked fire is parked, not replayed: the gateway holds its key", () => {
    const disk = fakeStorage();
    fireInto(disk, "retry-1");
    markAcked(disk, "retry-1", T0 + 800);
    expect(dueForReplay(readOutbox(reload(disk)), T0 + 10 * OUTBOX_REPLAY_GRACE_MS)).toEqual([]);
  });
});

describe("U5 — each fire is a NEW prompt, linked by retryOf to the one the owner typed", () => {
  it("two fires of one track are two entries: two fresh keys, one link", () => {
    const disk = fakeStorage();
    fireInto(disk, "retry-1", T0);
    fireInto(disk, "retry-2", T0 + 30_000);
    const page2 = reload(disk);
    expect(readOutbox(page2).map((e) => [e.id, e.retryOf])).toEqual([
      ["retry-1", ORIGINAL],
      ["retry-2", ORIGINAL],
    ]);
    expect(readJournal(page2).map((j) => j.id)).toEqual(["retry-1", "retry-2"]);
  });

  it("refuses a fire under the ORIGINAL key (the gateway dedupe would absorb it)", () => {
    const disk = fakeStorage();
    expect(fireInto(disk, ORIGINAL)).toBeNull();
    expect(disk.bytes.size).toBe(0);
  });

  it("refuses an empty key or empty text, and writes nothing", () => {
    const disk = fakeStorage();
    expect(
      enqueueLadderRetry(disk, { idempotencyKey: "", sessionKey: SK, text: TEXT, ts: T0 }),
    ).toBeNull();
    expect(
      enqueueLadderRetry(disk, { idempotencyKey: "retry-1", sessionKey: SK, text: "  ", ts: T0 }),
    ).toBeNull();
    expect(disk.bytes.size).toBe(0);
  });

  it("a fire whose original could not be named is still protected, just unlinked", () => {
    const disk = fakeStorage();
    const fired = enqueueLadderRetry(disk, {
      idempotencyKey: "retry-1",
      sessionKey: SK,
      text: TEXT,
      ts: T0,
    });
    expect(fired?.persisted).toBe(true);
    expect(fired?.entry).not.toHaveProperty("retryOf");
    const entries = readOutbox(reload(disk));
    expect(entries[0]).not.toHaveProperty("retryOf");
    const due = dueForReplay(entries, T0 + OUTBOX_REPLAY_GRACE_MS);
    expect(due.map((e) => e.id)).toEqual(["retry-1"]);
  });

  it("readOutbox drops a retryOf that does not read back as a key", () => {
    const disk = fakeStorage();
    disk.setItem(
      OUTBOX_STORAGE_KEY,
      JSON.stringify([
        { id: "a", sessionKey: SK, text: TEXT, ts: T0, retryOf: 42 },
        { id: "b", sessionKey: SK, text: TEXT, ts: T0, retryOf: "" },
        { id: "c", sessionKey: SK, text: TEXT, ts: T0, retryOf: ORIGINAL },
      ]),
    );
    expect(readOutbox(disk).map((e) => e.retryOf)).toEqual([undefined, undefined, ORIGINAL]);
  });

  it("storage that refuses the write still hands the fire back, marked unpersisted", () => {
    const full: OutboxStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(fireInto(full, "retry-1")).toMatchObject({
      persisted: false,
      entry: { id: "retry-1", sessionKey: SK, text: TEXT, retryOf: ORIGINAL, attempts: 0 },
    });
  });
});

describe("U5 — M-C maps onto §6.1's RETRYING row", () => {
  it("RETRYING puts nothing on the prompt; its one indicator is the countdown with Stop", () => {
    const row = promptIndicator("RETRYING");
    expect(row.badge).toBeNull();
    expect(row.tone).toBe("none");
    expect(row.other).toBe("retry-countdown");
    expect(row.actions).toContain("stop-retrying");
    expect(derivePromptState({ transport: "acked", retrying: true })).toBe("RETRYING");
  });

  it("the fire's own bubble is born SENDING and draws nothing until the transport answers", () => {
    const bubble = {
      role: "user",
      _clientMsgId: "retry-1",
      content: [{ type: "text", text: TEXT }],
      _retryOf: ORIGINAL,
      _promptState: { transport: "in-flight" },
    };
    expect(promptStateOf(bubble)).toBe("SENDING");
    expect(promptBubbleMarks(bubble).badge).toBe("");
  });
});

describe("U5 — app.ts wires the seam in the right ORDER (source check)", () => {
  // Resolved from the run root, NOT from `import.meta.url` (jsdom), as the render test does.
  const srcRoot = ["tinker-ui/src", "src"]
    .map((p) => join(process.cwd(), p))
    .find((p) => existsSync(join(p, "app.ts")));
  if (!srcRoot) {
    throw new Error(`tinker-ui/src not found from ${process.cwd()}`);
  }
  const app = readFileSync(join(srcRoot, "app.ts"), "utf8");
  const start = app.indexOf("async function retryLastTurn(");
  // Line comments stripped, so a comment can neither satisfy nor break an assertion.
  const body = app.slice(start, app.indexOf("\n}\n", start)).replace(/\/\/.*$/gm, "");

  it("retryLastTurn writes the outbox before its first await, then sends via the outbox path", () => {
    expect(start).toBeGreaterThan(-1);
    const enqueueAt = body.indexOf("enqueueLadderRetry(outboxStore");
    expect(enqueueAt).toBeGreaterThan(-1);
    expect(body.indexOf("await ")).toBeGreaterThan(enqueueAt);
    expect(body).toContain("idempotencyKey: uuid(),");
    expect(body).toContain("await resendOutboxEntry(fired.entry)");
    // C8 as it was: a bare chat.send inside the ladder.
    expect(body).not.toContain('req("chat.send"');
  });

  it("both orange countdown render sites go through the RETRYING row", () => {
    expect(app).toContain('promptIndicator("RETRYING")');
    expect(app.split("h += renderRetryWarningBubble(").length - 1).toBe(2);
    expect(app.split('class="msg-overload-bubble retrying"').length - 1).toBe(1);
  });
});
