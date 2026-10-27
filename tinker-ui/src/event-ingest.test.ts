// FORK 2026-09-24 — tinker-ui/src/event-ingest.ts: the UI half of TINKER_UI_DESIGN_BIBLE/logging.md
// §9 step 7 (`ui.outbox.state`, `ui.prompt.state`) and the `ui.context.action` row of step 8.
//
// CONTROL: before this change there was no client, no producer and no row. `logs.ingest` appeared in
// no tinker-ui source, `outbox.ts` reported nothing (and its cap and quota sheds deleted unproven
// prompts without a trace), `prompt-state.ts` had no memory of a previous state, and a press of
// Evict or Compact left no record beyond a toast.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyIngestFailure,
  contextActionEvent,
  createEventIngest,
  EVENT_INGEST_BACKOFF_MAX_MS,
  EVENT_INGEST_FLUSH_MS,
  isUuid,
  outboxStateEvent,
  promptStateEvent,
  readIngestReply,
  sanitizeUiEvent,
  UI_EVENT_SCHEMA,
  type UiEvent,
  type UiWireEvent,
} from "./event-ingest.js";
import { promptBubbleMarks } from "./msg-order.js";
import {
  dismissOutboxEntry,
  enqueueOutbox,
  markAcked,
  markAttempted,
  OUTBOX_MAX,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETIREMENT_PROOFS,
  OUTBOX_TRANSITION_STATES,
  removeFromOutbox,
  type OutboxStore,
  type OutboxTransition,
} from "./outbox.js";
import {
  CACHE_ACT_OUTCOMES,
  CACHE_ACTS,
  cacheActOutcome,
  cacheActResultToast,
} from "./panels/context-buttons.js";
import { createPromptStateTracker, PROMPT_STATES, type PromptStateName } from "./prompt-state.js";

// ─── harness ─────────────────────────────────────────────────────────────────────────────────────

type Harness = {
  clock: number;
  connected: boolean;
  fail: boolean;
  /** What a resolved call answers; the default is the gateway's all-accepted reply. */
  reply: ((events: UiWireEvent[]) => unknown) | null;
  /** When true, `send` returns a promise the test settles through `settle`. */
  hold: boolean;
  settle: Array<(ok: boolean) => void>;
  timers: Array<{ fn: () => void; ms: number }>;
  sends: UiWireEvent[][];
};

function harness(opts: { bufferMax?: number; batchMax?: number } = {}) {
  const h: Harness = {
    clock: 1_000,
    connected: true,
    fail: false,
    reply: null,
    hold: false,
    settle: [],
    timers: [],
    sends: [],
  };
  const ingest = createEventIngest({
    send: (events) => {
      h.sends.push(events);
      if (h.hold) {
        return new Promise<unknown>((resolve, reject) =>
          h.settle.push((ok) =>
            ok ? resolve({ accepted: events.length }) : reject(new Error("timeout: logs.ingest")),
          ),
        );
      }
      if (h.fail) {
        return Promise.reject(new Error("unknown method: logs.ingest"));
      }
      return Promise.resolve(
        h.reply ? h.reply(events) : { accepted: events.length, rejected: 0, rejectedByReason: {} },
      );
    },
    isConnected: () => h.connected,
    now: () => h.clock,
    setTimer: (fn, ms) => {
      h.timers.push({ fn, ms });
    },
    bufferMax: opts.bufferMax,
    batchMax: opts.batchMax,
  });
  /** Let every pending promise chain settle (one macrotask drains all microtasks). */
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  /** Fire the timers armed so far, once each, then let the sends settle. */
  const tick = async (): Promise<void> => {
    for (const t of h.timers.splice(0)) {
      t.fn();
    }
    await settled();
  };
  return { h, ingest, tick, settled };
}

const KEY = "0b7c6f2e-4a1d-4c3b-9f7e-2d5a8c1b3e4f";

/** A valid event whose n1 tells events apart. */
const promptEv = (n: number): UiEvent =>
  promptStateEvent({ key: KEY, from: "SAVED", to: "SENDING", msInFrom: n });

/** Resolved from the run root, NOT from `import.meta.url` (jsdom), as the render tests do. */
function repoFile(...candidates: string[]): string {
  const found = candidates.map((p) => join(process.cwd(), p)).find((p) => existsSync(p));
  if (!found) {
    throw new Error(`none of ${candidates.join(", ")} found from ${process.cwd()}`);
  }
  return readFileSync(found, "utf8");
}

/** The comma list inside `<prefix> (a, b, c)`, sorted. */
function parenthetical(text: string, prefix: string): string[] {
  const at = text.indexOf(`${prefix} (`);
  expect(at, `"${prefix} (" not found`).toBeGreaterThan(-1);
  const inner = text.slice(at + prefix.length + 2, text.indexOf(")", at));
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .toSorted();
}

// ─── batching and flush ──────────────────────────────────────────────────────────────────────────

describe("event-ingest — batching and flush", () => {
  it("record sends nothing on the caller's stack; one timer, then ONE batch stamped at record time", async () => {
    const { h, ingest, tick } = harness();
    ingest.record(promptEv(1));
    h.clock = 1_500;
    ingest.record(promptEv(2));
    ingest.record(contextActionEvent("evict", "ok"));
    expect(h.sends).toHaveLength(0);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(EVENT_INGEST_FLUSH_MS);
    await tick();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].map((e) => e.tsMs)).toEqual([1_000, 1_500, 1_500]);
    expect(h.sends[0][0]).toEqual({
      name: "ui.prompt.state",
      tsMs: 1_000,
      label: "SENDING",
      runId: KEY,
      n1: 1,
      fields: { from: "SAVED" },
    });
    expect(ingest.stats()).toMatchObject({ buffered: 0, sent: 3, batches: 1, inFlight: false });
    expect(h.timers).toHaveLength(0);
  });

  it("caps a batch at batchMax and keeps ONE batch in flight; the rest leave on later ticks", async () => {
    const { h, ingest, tick, settled } = harness({ batchMax: 2 });
    h.hold = true;
    for (let i = 0; i < 5; i++) {
      ingest.record(promptEv(i));
    }
    await tick();
    expect(h.sends.map((b) => b.length)).toEqual([2]);
    expect(ingest.stats().inFlight).toBe(true);
    // In flight: neither a manual flush nor a timer may start a second batch.
    await ingest.flush();
    expect(h.sends).toHaveLength(1);
    expect(h.timers).toHaveLength(0);
    h.settle.shift()?.(true);
    await settled();
    expect(h.timers.map((t) => t.ms)).toEqual([EVENT_INGEST_FLUSH_MS]);
    h.hold = false;
    await tick();
    await tick();
    expect(h.sends.map((b) => b.map((e) => e.n1))).toEqual([[0, 1], [2, 3], [4]]);
    expect(ingest.stats()).toMatchObject({ buffered: 0, sent: 5, batches: 3 });
  });

  it("a failed call drops its batch, counted by cause, and never sends it twice", async () => {
    const { h, ingest, tick } = harness();
    h.fail = true;
    ingest.record(promptEv(1));
    ingest.record(promptEv(2));
    await tick();
    expect(h.sends).toHaveLength(1);
    expect(ingest.stats().dropped).toMatchObject({ refused: 2, timeout: 0, disconnected: 0 });
    expect(ingest.stats().buffered).toBe(0);
    expect(h.timers).toHaveLength(0);
  });

  it("a send that throws synchronously is a failed batch, not an exception on the timer", async () => {
    const timers: Array<() => void> = [];
    const ingest = createEventIngest({
      send: () => {
        throw new Error("boom");
      },
      isConnected: () => true,
      setTimer: (fn) => {
        timers.push(fn);
      },
    });
    ingest.record(promptEv(1));
    expect(() => timers.shift()?.()).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(ingest.stats().dropped.refused).toBe(1);
    expect(ingest.stats().inFlight).toBe(false);
  });

  it("classifies the three rejection shapes app.ts `req` produces", () => {
    expect(classifyIngestFailure("disconnected")).toBe("disconnected");
    expect(
      classifyIngestFailure(new Error("timeout: logs.ingest did not respond in 10000ms")),
    ).toBe("timeout");
    expect(classifyIngestFailure({ code: "INVALID_REQUEST", message: "unknown method" })).toBe(
      "refused",
    );
  });

  it("a timer that failed to arm is re-armed by the next record, even into a full buffer", async () => {
    const timers: Array<() => void> = [];
    let refuse = true;
    const sends: UiWireEvent[][] = [];
    const ingest = createEventIngest({
      send: (events) => {
        sends.push(events);
        return Promise.resolve({ accepted: events.length });
      },
      isConnected: () => true,
      setTimer: (fn) => {
        if (refuse) {
          throw new Error("no timers");
        }
        timers.push(fn);
      },
      bufferMax: 2,
    });
    ingest.record(promptEv(1));
    ingest.record(promptEv(2));
    expect(timers).toHaveLength(0);
    refuse = false;
    ingest.record(promptEv(3)); // full: dropped, but it arms the timer the first two never got
    expect(ingest.stats().dropped.buffer_full).toBe(1);
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sends.map((b) => b.map((e) => e.n1))).toEqual([[1, 2]]);
  });

  it("consecutive held flushes back the timer off to the ceiling; one delivery resets it", async () => {
    const { h, ingest, tick } = harness();
    h.connected = false;
    ingest.record(promptEv(1));
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      waits.push(h.timers[0].ms);
      await tick();
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(EVENT_INGEST_BACKOFF_MAX_MS).toBe(60_000);
    h.connected = true;
    await tick();
    expect(h.sends).toHaveLength(1);
    expect(ingest.stats().nextDelayMs).toBe(EVENT_INGEST_FLUSH_MS);
    ingest.record(promptEv(2));
    expect(h.timers.map((t) => t.ms)).toEqual([EVENT_INGEST_FLUSH_MS]);
  });
});

// ─── the gateway's answer ────────────────────────────────────────────────────────────────────────

describe("event-ingest — reading the gateway's answer", () => {
  it("counts what the gateway accepted and what it rejected, per record", async () => {
    const { h, ingest, tick } = harness();
    h.reply = (events) => ({
      accepted: events.length - 1,
      rejected: 1,
      rejectedByReason: { undeclared_field: 1 },
    });
    ingest.record(promptEv(1));
    ingest.record(promptEv(2));
    await tick();
    expect(ingest.stats()).toMatchObject({ sent: 1, gatewayRejected: 1, batches: 1 });
    expect(ingest.stats().nextDelayMs).toBe(EVENT_INGEST_FLUSH_MS);
  });

  it("a whole batch refused for the RATE cap goes back to the head, backs off, and is sent again", async () => {
    const { h, ingest, tick } = harness();
    h.reply = (events) => ({
      accepted: 0,
      rejected: events.length,
      rejectedByReason: { rate_limited: events.length },
    });
    ingest.record(promptEv(1));
    ingest.record(promptEv(2));
    await tick();
    expect(ingest.stats()).toMatchObject({ sent: 0, gatewayRejected: 0, requeued: 2, buffered: 2 });
    expect(h.timers.map((t) => t.ms)).toEqual([2 * EVENT_INGEST_FLUSH_MS]);
    h.reply = null;
    await tick();
    // The same two records, still stamped when they happened, in their order.
    expect(h.sends.map((b) => b.map((e) => [e.n1, e.tsMs]))).toEqual([
      [
        [1, 1_000],
        [2, 1_000],
      ],
      [
        [1, 1_000],
        [2, 1_000],
      ],
    ]);
    expect(ingest.stats()).toMatchObject({ sent: 2, buffered: 0 });
  });

  it("an OVERSIZE refusal is dropped (the same batch would be refused again) and backs off", async () => {
    const { h, ingest, tick } = harness();
    h.reply = (events) => ({
      accepted: 0,
      rejected: events.length,
      rejectedByReason: { oversize: events.length },
    });
    ingest.record(promptEv(1));
    await tick();
    expect(ingest.stats()).toMatchObject({ sent: 0, gatewayRejected: 1, requeued: 0, buffered: 0 });
    expect(ingest.stats().nextDelayMs).toBe(2 * EVENT_INGEST_FLUSH_MS);
  });

  it("a requeued batch keeps the bound: the newest records past it are dropped and counted", async () => {
    const held: { answer?: (reply: unknown) => void } = {};
    const timers: Array<() => void> = [];
    const ingest = createEventIngest({
      send: () =>
        new Promise<unknown>((resolve) => {
          held.answer = resolve;
        }),
      isConnected: () => true,
      setTimer: (fn) => {
        timers.push(fn);
      },
      bufferMax: 3,
      batchMax: 2,
    });
    ingest.record(promptEv(1));
    ingest.record(promptEv(2));
    timers.shift()?.(); // [1, 2] leave, and the call is held
    ingest.record(promptEv(3));
    ingest.record(promptEv(4));
    ingest.record(promptEv(5)); // the buffer is [3, 4, 5]: full
    held.answer?.({ accepted: 0, rejected: 2, rejectedByReason: { rate_limited: 2 } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // [1, 2] go back to the head; the bound keeps three, so the two NEWEST (4, 5) are dropped.
    expect(ingest.stats()).toMatchObject({ buffered: 3, requeued: 2 });
    expect(ingest.stats().dropped.buffer_full).toBe(2);
  });

  it("reads the gateway's counts, clamped to the batch, and knows which refusals to retry", () => {
    expect(readIngestReply({ ok: true }, 3)).toEqual({
      accepted: 3,
      rejected: 0,
      throttled: false,
      retry: false,
    });
    expect(readIngestReply(null, 2)).toEqual({
      accepted: 2,
      rejected: 0,
      throttled: false,
      retry: false,
    });
    expect(readIngestReply({ accepted: 99, rejected: 99 }, 2)).toEqual({
      accepted: 0,
      rejected: 2,
      throttled: false,
      retry: false,
    });
    expect(readIngestReply({ rejected: 1, rejectedByReason: { oversize: 1 } }, 1)).toEqual({
      accepted: 0,
      rejected: 1,
      throttled: true,
      retry: false,
    });
    expect(
      readIngestReply({ accepted: 0, rejected: 2, rejectedByReason: { rate_limited: 2 } }, 2),
    ).toEqual({ accepted: 0, rejected: 2, throttled: true, retry: true });
    // Part of the batch was written: never re-send any of it.
    expect(
      readIngestReply({ accepted: 1, rejected: 1, rejectedByReason: { rate_limited: 1 } }, 2),
    ).toEqual({ accepted: 1, rejected: 1, throttled: true, retry: false });
  });
});

// ─── the bound ───────────────────────────────────────────────────────────────────────────────────

describe("event-ingest — bounded buffer", () => {
  it("holds at most bufferMax; past it the NEWEST is dropped and counted", async () => {
    const { h, ingest, tick } = harness({ bufferMax: 3 });
    for (let i = 0; i < 5; i++) {
      ingest.record(promptEv(i));
    }
    expect(ingest.stats().buffered).toBe(3);
    expect(ingest.stats().dropped.buffer_full).toBe(2);
    await tick();
    expect(h.sends[0].map((e) => e.n1)).toEqual([0, 1, 2]);
  });

  it("a socket that is down KEEPS the buffer (counted), still bounded, and delivers on reconnect", async () => {
    const { h, ingest, tick } = harness({ bufferMax: 2 });
    h.connected = false;
    ingest.record(promptEv(1));
    ingest.record(promptEv(2));
    ingest.record(promptEv(3));
    await tick();
    expect(h.sends).toHaveLength(0);
    expect(ingest.stats()).toMatchObject({ buffered: 2, heldForSocket: 1 });
    expect(ingest.stats().dropped.buffer_full).toBe(1);
    expect(h.timers).toHaveLength(1);
    h.clock = 90_000;
    h.connected = true;
    await tick();
    // Delivered late, stamped when they happened.
    expect(h.sends).toEqual([
      [
        expect.objectContaining({ n1: 1, tsMs: 1_000 }),
        expect.objectContaining({ n1: 2, tsMs: 1_000 }),
      ],
    ]);
  });

  it("an isConnected that throws reads as down, never as an exception", () => {
    const timers: Array<() => void> = [];
    const ingest = createEventIngest({
      send: () => Promise.resolve(),
      isConnected: () => {
        throw new Error("no socket yet");
      },
      setTimer: (fn) => {
        timers.push(fn);
      },
    });
    ingest.record(promptEv(1));
    expect(() => timers.shift()?.()).not.toThrow();
    expect(ingest.stats()).toMatchObject({ buffered: 1, heldForSocket: 1 });
  });
});

// ─── L4: no free text, no session key ────────────────────────────────────────────────────────────

// Fictional placeholders only (the 555-01xx block is reserved for fiction): this is a public repo.
const PROMPT_TEXT = "call me at +1 555 0100 about the invoice";
const SESSION_KEY = "agent:main:whatsapp:direct:+15550100";

describe("event-ingest — nothing outside the closed sets is ever sent (L4)", () => {
  const refused: Array<[string, unknown]> = [
    ["a gateway-only name", { name: "gw.boot", label: "abc" }],
    ["an undeclared name", { name: "ui.free.text", label: "x" }],
    ["a label outside its set", { name: "ui.context.action", label: "purge" }],
    ["free text as a label", { name: "ui.prompt.state", label: PROMPT_TEXT }],
    [
      "free text as a field value",
      { name: "ui.context.action", label: "evict", fields: { result: PROMPT_TEXT } },
    ],
    [
      "a session key as a field value",
      { name: "ui.outbox.state", label: "queued", fields: { from: SESSION_KEY } },
    ],
    [
      "an undeclared field key",
      { name: "ui.context.action", label: "evict", fields: { result: "ok", text: "x" } },
    ],
    ["an extra top-level `text`", { name: "ui.context.action", label: "evict", text: PROMPT_TEXT }],
    [
      "an extra top-level `sessionKey`",
      { name: "ui.context.action", label: "evict", sessionKey: SESSION_KEY },
    ],
    ["a caller-supplied time", { name: "ui.context.action", label: "evict", tsMs: 5 }],
    ["an undeclared slot", { name: "ui.prompt.state", label: "SENDING", n3: 1 }],
    ["a non-finite slot", { name: "ui.prompt.state", label: "SENDING", n1: Number.NaN }],
    ["a numeric string slot", { name: "ui.prompt.state", label: "SENDING", n1: "12" }],
    ["fields as an array", { name: "ui.context.action", label: "evict", fields: ["ok"] }],
    ["a prototype key as a name", { name: "__proto__", label: "evict" }],
    ["not an object", PROMPT_TEXT],
  ];

  for (const [what, event] of refused) {
    it(`refuses ${what}`, () => {
      expect(sanitizeUiEvent(event, 1)).toBeNull();
    });
  }

  it("a refused event is dropped whole and counted, and the wire never carries the text or the key", async () => {
    const { h, ingest, tick } = harness();
    for (const [, event] of refused) {
      ingest.record(event as UiEvent);
    }
    ingest.record(contextActionEvent("compact", "noop"));
    await tick();
    expect(ingest.stats().dropped.invalid).toBe(refused.length);
    expect(h.sends).toEqual([[expect.objectContaining({ name: "ui.context.action" })]]);
    const wire = JSON.stringify(h.sends);
    expect(wire).not.toContain("555");
    expect(wire).not.toContain("invoice");
    expect(wire).not.toContain("whatsapp");
  });

  it("a run id is a UUID or nothing: the wall refuses it, the client strips it and counts it", async () => {
    // The measured reason for the UUID rule: the gateway's id shape admits a raw session key.
    expect(SESSION_KEY).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/);
    expect(isUuid(KEY)).toBe(true);
    expect(isUuid(SESSION_KEY)).toBe(false);
    expect(isUuid("k-1")).toBe(false);
    expect(sanitizeUiEvent({ name: "ui.outbox.state", label: "queued", runId: KEY }, 7)).toEqual({
      name: "ui.outbox.state",
      tsMs: 7,
      label: "queued",
      runId: KEY,
    });
    for (const runId of [SESSION_KEY, PROMPT_TEXT, "k-1"]) {
      expect(sanitizeUiEvent({ name: "ui.outbox.state", label: "queued", runId }, 7)).toBeNull();
    }
    const { h, ingest, tick } = harness();
    for (const runId of [SESSION_KEY, PROMPT_TEXT]) {
      ingest.record({ name: "ui.outbox.state", label: "queued", runId });
    }
    await tick();
    expect(h.sends.flat()).toEqual([
      { name: "ui.outbox.state", tsMs: 1_000, label: "queued" },
      { name: "ui.outbox.state", tsMs: 1_000, label: "queued" },
    ]);
    expect(ingest.stats()).toMatchObject({ runIdOmitted: 2 });
    expect(ingest.stats().dropped.invalid).toBe(0);
    const wire = JSON.stringify(h.sends);
    expect(wire).not.toContain("555");
    expect(wire).not.toContain("invoice");
  });

  it("the schema has no free-text slot: every allowed string is a short identifier", () => {
    const ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/;
    for (const [name, spec] of Object.entries(UI_EVENT_SCHEMA)) {
      expect(spec.labels.length, name).toBeGreaterThan(0);
      for (const v of spec.labels) {
        expect(v, `${name} label`).toMatch(ID);
      }
      for (const [key, values] of Object.entries(spec.fields)) {
        expect(values.length, `${name}.${key}`).toBeGreaterThan(0);
        for (const v of values) {
          expect(v, `${name}.${key}`).toMatch(ID);
        }
      }
    }
  });

  it("the schema is exactly the catalog's UI-ingestable rows, their declared slots, keys and label sets", () => {
    const catalog = repoFile("src/infra/events/catalog.ts", "../src/infra/events/catalog.ts");
    const ingestable = [
      ...catalog.matchAll(/name: "([a-z0-9_.]+)",[\s\S]*?uiIngestable: (true|false)/g),
    ]
      .filter((m) => m[2] === "true")
      .map((m) => m[1])
      .toSorted();
    expect(Object.keys(UI_EVENT_SCHEMA).toSorted()).toEqual(ingestable);
    const blockOf = (name: string) => {
      const start = catalog.indexOf(`name: "${name}",`);
      return catalog.slice(start, catalog.indexOf("uiIngestable:", start));
    };
    for (const [name, spec] of Object.entries(UI_EVENT_SCHEMA)) {
      const block = blockOf(name);
      for (const slot of spec.slots) {
        expect(block, `${name} ${slot}`).not.toMatch(new RegExp(`\\b${slot}: null`));
      }
      for (const key of Object.keys(spec.fields)) {
        expect(block, `${name}.${key}`).toMatch(new RegExp(`\\b${key}: "enum"`));
      }
    }
    // The label sets the catalog spells out are the ones the code owns: one list each, no copy.
    expect(parenthetical(blockOf("ui.outbox.state"), "to_state")).toEqual(
      [...OUTBOX_TRANSITION_STATES].toSorted(),
    );
    expect(parenthetical(blockOf("ui.context.action"), "action")).toEqual(
      [...CACHE_ACTS].toSorted(),
    );
  });

  it("`ui.context.action`'s result set is the one logging.md §4.7 declares", () => {
    const doc = repoFile(
      "TINKER_UI_DESIGN_BIBLE/logging.md",
      "../TINKER_UI_DESIGN_BIBLE/logging.md",
    );
    const row = doc.split("\n").find((l) => l.startsWith("| `ui.context.action`"));
    expect(row).toBeDefined();
    expect(parenthetical(row ?? "", "result")).toEqual([...CACHE_ACT_OUTCOMES].toSorted());
  });
});

// ─── ui.outbox.state from outbox.ts ──────────────────────────────────────────────────────────────

type ObservedStore = OutboxStore & {
  seen: OutboxTransition[];
  raw: Map<string, string>;
  /** The next setItem throws, as a full localStorage does. */
  failNextWrite: boolean;
};

function observedStore(): ObservedStore {
  const raw = new Map<string, string>();
  const store: ObservedStore = {
    seen: [],
    raw,
    failNextWrite: false,
    getItem: (k: string) => raw.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (store.failNextWrite) {
        store.failNextWrite = false;
        throw new Error("QuotaExceededError");
      }
      raw.set(k, v);
    },
    onTransition: (t: OutboxTransition) => {
      store.seen.push(t);
    },
  };
  return store;
}

const entry = (id: string, ts = 1) => ({ id, sessionKey: SESSION_KEY, text: PROMPT_TEXT, ts });

describe("ui.outbox.state — one row per transition outbox.ts writes", () => {
  it("queued → replayed … → acked → proven, with attempts and age, and no text or session key", () => {
    const store = observedStore();
    const typedAt = 10_000;
    expect(enqueueOutbox(store, entry(KEY, typedAt))).toBe(true);
    // Idempotent on id: a second enqueue writes nothing and reports nothing.
    enqueueOutbox(store, entry(KEY, typedAt));
    for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i++) {
      markAttempted(store, KEY, typedAt + i * 1_000);
    }
    markAcked(store, KEY, 99_000);
    markAcked(store, KEY, 99_500); // already acked: no second row
    removeFromOutbox(store, KEY);
    removeFromOutbox(store, KEY); // already gone: no second row

    const replays = Array.from({ length: OUTBOX_MAX_ATTEMPTS }, () => "replayed");
    // Replays running out writes nothing: that is the prompt's UNSENT → LOST, not an outbox row.
    expect(store.seen.map((t) => t.to)).toEqual(["queued", ...replays, "acked", "proven"]);
    expect(store.seen.map((t) => t.from)).toEqual([
      "none",
      "queued",
      ...replays.slice(1),
      "replayed",
      "acked",
    ]);
    expect(store.seen.map((t) => t.attempts)).toEqual([
      0,
      ...Array.from({ length: OUTBOX_MAX_ATTEMPTS }, (_, i) => i + 1),
      OUTBOX_MAX_ATTEMPTS,
      OUTBOX_MAX_ATTEMPTS,
    ]);
    // Exactly one terminal row per entry, so `queued` and the terminals reconcile by count.
    expect(store.seen.filter((t) => t.to === "proven" || t.to === "gave_up")).toHaveLength(1);
    expect(store.seen.at(-1)?.proof).toBe("transcript");

    const events = store.seen.map((t) => outboxStateEvent(t, 130_000));
    for (const e of events) {
      expect(sanitizeUiEvent(e, 1), JSON.stringify(e)).not.toBeNull();
    }
    expect(events.at(-1)).toEqual({
      name: "ui.outbox.state",
      label: "proven",
      runId: KEY,
      n1: OUTBOX_MAX_ATTEMPTS,
      n2: 120_000,
      fields: { from: "acked", proof: "transcript" },
    });
    const wire = JSON.stringify(events);
    expect(wire).not.toContain("555");
    expect(wire).not.toContain("invoice");
  });

  it("an entry id that is not a UUID is left off the row, counted; the row itself still goes", async () => {
    const store = observedStore();
    enqueueOutbox(store, entry("legacy-7", 5));
    const ev = outboxStateEvent(store.seen[0], 5);
    // The builder carries what the producer held (L8); the client decides what may leave.
    expect(ev.runId).toBe("legacy-7");
    const { h, ingest, tick } = harness();
    ingest.record(ev);
    await tick();
    expect(h.sends.flat()).toEqual([
      {
        name: "ui.outbox.state",
        tsMs: 1_000,
        label: "queued",
        n1: 0,
        n2: 0,
        fields: { from: "none" },
      },
    ]);
    expect(ingest.stats().runIdOmitted).toBe(1);
  });

  it("the owner's Dismiss and Resend retire the entry as gave_up, saying which", () => {
    const store = observedStore();
    enqueueOutbox(store, { id: "a", sessionKey: "s", text: "one", ts: 1 });
    enqueueOutbox(store, { id: "b", sessionKey: "s", text: "two", ts: 2 });
    markAcked(store, "a", 3);
    expect(dismissOutboxEntry(store, "a", 4)).toBe(true);
    expect(dismissOutboxEntry(store, "b", 5, { resentAs: "c" })).toBe(true);
    expect(store.seen.slice(-2)).toEqual([
      { id: "a", to: "gave_up", from: "acked", attempts: 0, typedAt: 1, proof: "dismissed" },
      { id: "b", to: "gave_up", from: "queued", attempts: 0, typedAt: 2, proof: "resent" },
    ]);
  });

  it("the cap sheds the oldest entry WITH a row (it used to vanish without a trace)", () => {
    const store = observedStore();
    for (let i = 0; i <= OUTBOX_MAX; i++) {
      enqueueOutbox(store, entry(`e${i}`, i));
    }
    const shed = store.seen.filter((t) => t.to === "gave_up");
    expect(shed).toEqual([
      { id: "e0", to: "gave_up", from: "queued", attempts: 0, typedAt: 0, proof: "shed" },
    ]);
    expect(store.seen.filter((t) => t.to === "queued")).toHaveLength(OUTBOX_MAX + 1);
  });

  it("the quota path sheds the oldest half WITH rows, and a shed entry reports nothing else", () => {
    const store = observedStore();
    for (let i = 0; i < 4; i++) {
      enqueueOutbox(store, entry(`q${i}`, 100 + i));
    }
    store.seen.length = 0;
    store.failNextWrite = true;
    markAttempted(store, "q0", 500); // the write that trips the quota also sheds q0 and q1
    expect(store.seen.map((t) => [t.id, t.to, t.proof])).toEqual([
      ["q0", "gave_up", "shed"],
      ["q1", "gave_up", "shed"],
    ]);
    expect(
      JSON.parse(store.raw.get("tinker-outbox") ?? "[]").map((e: { id: string }) => e.id),
    ).toEqual(["q2", "q3"]);
  });

  it("a write that did not land reports nothing (a row is a fact, never an intention)", () => {
    const seen: OutboxTransition[] = [];
    const full: OutboxStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      onTransition: (t) => {
        seen.push(t);
      },
    };
    expect(enqueueOutbox(full, { id: "x", sessionKey: "s", text: "t", ts: 1 })).toBe(false);
    expect(seen).toEqual([]);
  });

  it("an observer that throws cannot break the send path", () => {
    const raw = new Map<string, string>();
    const store: OutboxStore = {
      getItem: (k) => raw.get(k) ?? null,
      setItem: (k, v) => {
        raw.set(k, v);
      },
      onTransition: () => {
        throw new Error("observer bug");
      },
    };
    expect(enqueueOutbox(store, { id: "x", sessionKey: "s", text: "t", ts: 1 })).toBe(true);
    expect(() => markAttempted(store, "x", 2)).not.toThrow();
    expect(() => markAcked(store, "x", 3)).not.toThrow();
    expect(() => removeFromOutbox(store, "x")).not.toThrow();
    expect(raw.get("tinker-outbox")).toBe("[]");
  });

  it("every proof outbox.ts can report is in the closed set the client accepts", () => {
    for (const proof of OUTBOX_RETIREMENT_PROOFS) {
      const t: OutboxTransition = {
        id: KEY,
        to: "gave_up",
        from: "queued",
        attempts: 0,
        typedAt: 0,
        proof,
      };
      expect(sanitizeUiEvent(outboxStateEvent(t, 1), 1)).not.toBeNull();
    }
  });
});

// ─── ui.prompt.state — per transition, not per render ────────────────────────────────────────────

describe("ui.prompt.state — one row per TRANSITION of the one derived state, never per render", () => {
  it("repainting a bubble records nothing; each change of its derived state records one row", async () => {
    const { h, ingest, tick } = harness();
    const tracker = createPromptStateTracker();
    const facts: Record<string, unknown> = { transport: "not-issued" };
    const bubble = { role: "user", _clientMsgId: KEY, _promptState: facts };
    // What app.ts renderMsg does on every paint: derive through promptBubbleMarks, then observe.
    const paint = () => {
      const state = promptBubbleMarks(bubble).state;
      if (state !== null) {
        const t = tracker.observe(bubble._clientMsgId, state, h.clock);
        if (t !== null) {
          ingest.record(promptStateEvent(t));
        }
      }
    };
    for (let i = 0; i < 5; i++) {
      paint(); // SAVED: the first sighting is a baseline, not a transition
    }
    h.clock = 1_040;
    facts.transport = "in-flight";
    for (let i = 0; i < 5; i++) {
      paint(); // SENDING
    }
    h.clock = 1_840;
    facts.transport = "acked";
    for (let i = 0; i < 5; i++) {
      paint(); // ACCEPTED
    }
    await tick();
    expect(h.sends.flat()).toEqual([
      {
        name: "ui.prompt.state",
        tsMs: 1_040,
        label: "SENDING",
        runId: KEY,
        n1: 40,
        fields: { from: "SAVED" },
      },
      {
        name: "ui.prompt.state",
        tsMs: 1_840,
        label: "ACCEPTED",
        runId: KEY,
        n1: 800,
        fields: { from: "SENDING" },
      },
    ]);
  });

  it("keys are independent, and memory is bounded (a forgotten key starts a new baseline)", () => {
    const tracker = createPromptStateTracker(2);
    expect(tracker.observe("a", "SAVED", 0)).toBeNull();
    expect(tracker.observe("b", "SAVED", 0)).toBeNull();
    expect(tracker.observe("a", "SENDING", 5)).toEqual({
      key: "a",
      from: "SAVED",
      to: "SENDING",
      msInFrom: 5,
    });
    expect(tracker.observe("c", "SAVED", 6)).toBeNull(); // evicts b, the least recently changed
    expect(tracker.size()).toBe(2);
    expect(tracker.last("b")).toBeUndefined();
    expect(tracker.last("a")).toBe("SENDING");
    expect(tracker.observe("c", "SENDING", 8)).toEqual({
      key: "c",
      from: "SAVED",
      to: "SENDING",
      msInFrom: 2,
    });
    expect(tracker.observe("a", "ACCEPTED", 9)).toEqual({
      key: "a",
      from: "SENDING",
      to: "ACCEPTED",
      msInFrom: 4,
    });
    expect(tracker.observe("b", "SENDING", 10)).toBeNull(); // forgotten: a new baseline
  });

  it("refuses an empty key, a non-finite clock and a state outside the vocabulary", () => {
    const tracker = createPromptStateTracker();
    expect(tracker.observe("", "SAVED", 0)).toBeNull();
    expect(tracker.observe("a", "SAVED", Number.NaN)).toBeNull();
    expect(tracker.observe("a", "QUEUED" as PromptStateName, 0)).toBeNull();
    expect(tracker.size()).toBe(0);
  });

  it("every state the tracker can report is a label the schema accepts", () => {
    for (const from of PROMPT_STATES) {
      for (const to of PROMPT_STATES) {
        if (from !== to) {
          expect(
            sanitizeUiEvent(promptStateEvent({ key: KEY, from, to, msInFrom: 1 }), 1),
          ).not.toBeNull();
        }
      }
    }
  });
});

// ─── ui.context.action — the button row ──────────────────────────────────────────────────────────

describe("ui.context.action — one row per fired Evict or Compact press", () => {
  it("the reply's result class is the SAME one the toast reads", () => {
    const replies: unknown[] = [
      { ok: true, compacted: true, tokensBefore: 10, tokensAfter: 4 },
      { ok: true, compacted: false, reason: "too few messages to evict" },
      { ok: false, reason: "the lane owns its context" },
      null,
    ];
    expect(replies.map((r) => cacheActOutcome(r))).toEqual(["ok", "noop", "error", "noop"]);
    for (const r of replies) {
      const toast = cacheActResultToast("evict", r);
      const outcome = cacheActOutcome(r);
      expect(toast.isError).toBe(outcome === "error");
      expect(toast.nothingToDo !== undefined).toBe(outcome === "noop");
    }
  });

  it("builds the declared row and nothing else", async () => {
    const { h, ingest, tick } = harness();
    ingest.record(contextActionEvent("evict", cacheActOutcome({ ok: true, compacted: true })));
    ingest.record(contextActionEvent("compact", "error"));
    await tick();
    expect(h.sends.flat()).toEqual([
      { name: "ui.context.action", tsMs: 1_000, label: "evict", fields: { result: "ok" } },
      { name: "ui.context.action", tsMs: 1_000, label: "compact", fields: { result: "error" } },
    ]);
  });
});

// ─── app.ts wiring (source check) ────────────────────────────────────────────────────────────────

describe("app.ts wires the client and its three producers (source check)", () => {
  const srcRoot = ["tinker-ui/src", "src"]
    .map((p) => join(process.cwd(), p))
    .find((p) => existsSync(join(p, "app.ts")));
  if (!srcRoot) {
    throw new Error(`tinker-ui/src not found from ${process.cwd()}`);
  }
  // Line comments stripped, so a comment can neither satisfy nor break an assertion.
  const app = readFileSync(join(srcRoot, "app.ts"), "utf8").replace(/\/\/.*$/gm, "");

  it("exactly one site sends `logs.ingest`, and it is app.ts's client", () => {
    expect(app.split('req("logs.ingest"').length - 1).toBe(1);
    const others = [
      ...readdirSync(srcRoot).map((f) => join(srcRoot, f)),
      ...readdirSync(join(srcRoot, "panels")).map((f) => join(srcRoot, "panels", f)),
    ].filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("app.ts"));
    expect(others.length).toBeGreaterThan(10);
    for (const p of others) {
      expect(readFileSync(p, "utf8"), p).not.toContain('"logs.ingest"');
    }
  });

  it("every recorded event comes from one of the three builders, never a hand-built literal", () => {
    const BUILDERS = ["outboxStateEvent(", "promptStateEvent(", "contextActionEvent("];
    const calls = app.split("recordUiEvent(").slice(1);
    // The definition's own parameter list is the one occurrence that is not a use.
    const uses = calls.filter((c) => !c.startsWith("event: UiEvent"));
    expect(uses).toHaveLength(4);
    for (const use of uses) {
      expect(
        BUILDERS.some((b) => use.startsWith(b)),
        use.slice(0, 80),
      ).toBe(true);
    }
  });

  it("the outbox store forwards every transition, so the optional hook cannot be silently absent", () => {
    const start = app.indexOf("const outboxStore: OutboxStore = {");
    expect(start).toBeGreaterThan(-1);
    const literal = app.slice(start, app.indexOf("\n};", start));
    expect(literal).toContain(
      "onTransition: (t) => recordUiEvent(outboxStateEvent(t, Date.now()))",
    );
  });

  it("the prompt state is observed where it is derived for the paint AND where its facts are written", () => {
    const bodyOf = (fn: string): string => {
      const start = app.indexOf(`function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      return app.slice(start, app.indexOf("\n}\n", start));
    };
    const at = app.indexOf("const promptMarks = promptBubbleMarks(msg);");
    expect(at).toBeGreaterThan(-1);
    expect(app.slice(at, at + 200)).toContain("observePaintedPromptState(msg, promptMarks.state);");
    // Once per key per paint: every paint starts with an empty set.
    expect(bodyOf("updateChat")).toContain("beginPromptPaint();");
    expect(bodyOf("beginPromptPaint")).toContain("promptKeysPainted.clear();");
    expect(bodyOf("notePromptFactsById")).toContain(
      "observePromptState(observed, promptStateOf(observed));",
    );
    expect(app).toContain("promptStateTracker.observe(");
  });

  it("the Evict / Compact handler records ok, noop or error for every press that fired", () => {
    expect(app).toContain("recordUiEvent(contextActionEvent(act, cacheActOutcome(res)))");
    expect(app).toContain('recordUiEvent(contextActionEvent(act, "error"))');
  });

  it("the counters are readable and the buffer is flushed on the way out", () => {
    expect(app).toContain("__tinkerUiEvents = () => uiEventIngest.stats()");
    expect(app).toMatch(
      /addEventListener\("pagehide", \(\) => \{\s*void uiEventIngest\.flush\(\);/,
    );
  });
});
