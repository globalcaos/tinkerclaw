// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 step U4 (LOST + actions).
//
// What this file proves. Each claim sits next to its CONTROL: the behaviour before U4, kept as a
// passing assertion, so the fix is measured against the defect and not against a fixture that could
// share it (the same method as prompt-state.render.test.ts).
//   1. A prompt the gateway's `pendingPrompts` snapshot reports BEHIND is NOT LOST across a reload.
//      That was U2's known limit (msg-order.ts `outboxPromptFacts`).
//   2. A prompt the snapshot does not hold, that the gateway acked and no transcript row proves, IS
//      LOST, and only on that evidence, never on a clock alone.
//   3. Resend never reuses an acked key. Dismiss keeps the journal row.
//   4. Only LOST draws controls, and base.css declares them once, at the one tone site.
//   5. A row that CARRIES a `pendingPrompts` report backs LOST without the stranded age bound; the
//      liveness vetoes stay (FORK 2026-09-25, after gateway G5's wiring, 7989149571e).
//   6. A stopped prompt reads CANCELLED, never LOST with Resend (FORK 2026-09-25, §6.1, PQ-6),
//      live and across a reload, from the outbox entry's own `cancelledAt` (PQ-11).
//   7. An answered prompt is never re-drawn and never reads LOST across a reload, from the outbox
//      entry's own `answeredAt` (FORK 2026-10-01, bug-log.md [chat-divergence], cause 1).
//
// app.ts is a browser entry with no harness, so every step here is the PURE function app.ts calls,
// in the order it calls them: reinjectOutboxBubbles and derivePendingPromptFacts (facts), then
// resendLostPrompt → send() and dismissLostPrompt (actions).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isBrowserOnlyPrompt,
  notePromptFacts,
  outboxPromptFacts,
  promptBubbleMarks,
  promptFactsOf,
  promptStateOf,
} from "./msg-order.js";
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_STORAGE_KEY,
  appendJournal,
  dismissOutboxEntry,
  dueForReplay,
  enqueueOutbox,
  markAcked,
  markAnswered,
  markCancelled,
  markProofChecked,
  outboxEntriesNeedingBubble,
  readJournal,
  readOutbox,
  reconcileWithHistory,
  type OutboxEntry,
  type OutboxStore,
} from "./outbox.js";
import {
  PROMPT_STATES,
  gatewayHolderFacts,
  heldPromptPhase,
  promptActionsHtml,
  type GatewayHolderEvidence,
  type PendingPromptSnapshot,
} from "./prompt-state.js";
import {
  FOLLOWUP_STARTED_FACTS,
  QUEUED_STRANDED_MS,
  ownRunTerminal,
  ownRunTerminalRecorded,
  strandedQueuedEntries,
} from "./queued-sends.js";

type Row = Record<string, unknown>;

const SESSION = "agent:main:tinker:A";
const T = 1_700_000_000_000;
/** When the gateway acked the prompt. */
const ACKED = T + 800;
/** The prompt as send() typed it: what enqueueOutbox and appendJournal receive. */
const TYPED = { id: "p-1", sessionKey: SESSION, text: "where did this prompt go", ts: T };

/** A localStorage stand-in keyed by storage key: the outbox and the journal are two keys. */
function keyedStore(): OutboxStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (k: string) => raw.get(k) ?? null,
    setItem: (k: string, v: string) => {
      raw.set(k, v);
    },
  };
}

/** The durable outbox entry of an acked, unproven prompt. */
function ackedEntry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    ...TYPED,
    attempts: 0,
    lastAttemptAt: 0,
    keyedProofExpected: true,
    ackedAt: ACKED,
    ...over,
  };
}

/** A session row read after the ack, with no run live, last written before the proof read below. */
function sessionRow(over: Partial<PendingPromptSnapshot> = {}): PendingPromptSnapshot {
  return { at: T + 200_000, runLive: false, updatedAt: T + 100_000, ...over };
}

/** Everything app.ts gathers about the prompt, every item pointing at LOST. */
function lostEvidence(over: Partial<GatewayHolderEvidence> = {}): GatewayHolderEvidence {
  return {
    key: "p-1",
    outbox: { ackedAt: ACKED, lastProofCheckAt: T + 150_000 },
    snapshot: sessionRow(),
    stranded: true,
    clientIdle: true,
    ...over,
  };
}

/** A row whose snapshot names the prompt BEHIND the running turn. */
const BEHIND_ROW = sessionRow({
  runLive: true,
  pendingPrompts: [{ key: "p-1", state: "behind", since: ACKED }],
});

/** A bubble as reinjectOutboxBubbles drew it after a reload BEFORE U4 (U2's facts only). */
function redrawnBeforeU4(e: OutboxEntry): Row {
  return {
    role: "user",
    _clientMsgId: e.id,
    content: [{ type: "text", text: e.text }],
    _promptState: outboxPromptFacts(e),
  };
}

/** The same bubble as U4 draws it: U2's facts, then the gateway's evidence (app.ts's order). */
function redrawn(e: OutboxEntry, ev: GatewayHolderEvidence): Row {
  return {
    ...redrawnBeforeU4(e),
    _promptState: { ...outboxPromptFacts(e), ...gatewayHolderFacts(ev) },
  };
}

/** base.css with its comments removed, so a selector quoted inside a note cannot count. */
function stripCssComments(css: string): string {
  const parts: string[] = [];
  let i = 0;
  let open = css.indexOf("/*", i);
  while (open >= 0) {
    parts.push(css.slice(i, open));
    const close = css.indexOf("*/", open + 2);
    if (close < 0) {
      return parts.join("");
    }
    i = close + 2;
    open = css.indexOf("/*", i);
  }
  parts.push(css.slice(i));
  return parts.join("");
}

/** Does this selector name `.cls` exactly (not `.cls-more`)? */
function selectorHasClass(sel: string, cls: string): boolean {
  const needle = `.${cls}`;
  for (let at = sel.indexOf(needle); at >= 0; at = sel.indexOf(needle, at + 1)) {
    if (!/[A-Za-z0-9_-]/.test(sel.charAt(at + needle.length))) {
      return true;
    }
  }
  return false;
}

describe("U4 — a prompt the snapshot reports BEHIND is NOT LOST across a reload", () => {
  const e = ackedEntry();

  it("CONTROL — U2 re-drew this acked, unproven prompt LOST (its known limit)", () => {
    expect(promptStateOf(redrawnBeforeU4(e))).toBe("LOST");
  });

  it("is re-drawn BEHIND: grey `waiting for the current turn`, dimmed, and no control", () => {
    const b = redrawn(e, lostEvidence({ snapshot: BEHIND_ROW }));
    expect(promptStateOf(b)).toBe("BEHIND");
    const marks = promptBubbleMarks(b);
    expect(marks.badge).toContain(">waiting for the current turn</span>");
    expect(marks.cls).toContain("prompt-tone-grey");
    expect(marks.cls).toContain("prompt-dimmed");
    expect(promptActionsHtml(marks.state, "p-1")).toBe("");
    // The gateway holds it, so it is no longer a prompt only this browser has.
    expect(isBrowserOnlyPrompt(b)).toBe(false);
  });

  it("a holder the snapshot names outranks every other LOST condition", () => {
    const named = sessionRow({ pendingPrompts: [{ key: "p-1", state: "behind", since: ACKED }] });
    expect(gatewayHolderFacts(lostEvidence({ snapshot: named }))).toStrictEqual({
      pending: "behind",
      noGatewayHolder: false,
    });
  });

  it("the clock follows the snapshot: LOST → BEHIND, and the phase clears once it is gone", () => {
    const b = redrawnBeforeU4(e);
    notePromptFacts(b, gatewayHolderFacts(lostEvidence({ snapshot: BEHIND_ROW })));
    expect(promptStateOf(b)).toBe("BEHIND");
    // A later row no longer names it and gives no verdict (a run is live): ACCEPTED, not BEHIND.
    notePromptFacts(
      b,
      gatewayHolderFacts(lostEvidence({ snapshot: sessionRow({ runLive: true }) })),
    );
    expect(promptStateOf(b)).toBe("ACCEPTED");
  });

  it("reads only a well-formed snapshot entry for this key", () => {
    expect(heldPromptPhase(undefined, "p-1")).toBeUndefined();
    expect(heldPromptPhase("junk", "p-1")).toBeUndefined();
    expect(heldPromptPhase([{ key: "p-1", state: "bogus" }], "p-1")).toBeUndefined();
    expect(
      heldPromptPhase(
        [null, { key: "p-2", state: "behind" }, { key: "p-1", state: "running" }],
        "p-1",
      ),
    ).toBe("running");
  });
});

describe("U4 — a started follow-up run (U3) outranks an older snapshot", () => {
  // The two steps were drafted apart: U3 records PREPARING when gateway G3's `followup` start links
  // a run to the key, and U4's clock re-derives the phase from the last `sessions.list` row on every
  // tick. G5's follow-up item outlives its run's start (drain.ts), so that row still says `behind`.
  const started = { transport: "acked" as const, disposition: "backlogged" as const };

  it("CONTROL — without the start fact the tick pulls a started prompt back to BEHIND", () => {
    const b: Row = { role: "user", _clientMsgId: "p-1", _promptState: { ...started } };
    notePromptFacts(b, FOLLOWUP_STARTED_FACTS);
    expect(promptStateOf(b)).toBe("PREPARING");
    notePromptFacts(b, gatewayHolderFacts(lostEvidence({ snapshot: BEHIND_ROW })));
    expect(promptStateOf(b)).toBe("BEHIND");
  });

  it("with it, the prompt stays PREPARING, with a holder, whatever the row or outbox says", () => {
    const b: Row = { role: "user", _clientMsgId: "p-1", _promptState: { ...started } };
    notePromptFacts(b, FOLLOWUP_STARTED_FACTS);
    for (const over of [
      { snapshot: BEHIND_ROW },
      { snapshot: null },
      { outbox: null },
      {},
    ] as Array<Partial<GatewayHolderEvidence>>) {
      const facts = gatewayHolderFacts(lostEvidence({ ...over, followupStarted: true }));
      expect(facts).toStrictEqual({ pending: "preparing", noGatewayHolder: false });
      notePromptFacts(b, facts);
      expect(promptStateOf(b)).toBe("PREPARING");
    }
  });

  it("a snapshot that already says `running` is still read", () => {
    const running = sessionRow({
      pendingPrompts: [{ key: "p-1", state: "running", since: ACKED }],
    });
    expect(
      gatewayHolderFacts(lostEvidence({ snapshot: running, followupStarted: true })),
    ).toStrictEqual({ pending: "running", noGatewayHolder: false });
  });
});

describe("U4 — absent from the snapshot + acked + not in history is LOST", () => {
  it("not in history: no transcript row proves it", () => {
    const history = [{ idempotencyKey: "older-1", text: "an older prompt", ts: T - 60_000 }];
    expect(reconcileWithHistory([ackedEntry()], history).pending.map((x) => x.id)).toEqual(["p-1"]);
  });

  it("LOST when a G5 snapshot holds only OTHER keys", () => {
    const others = sessionRow({
      pendingPrompts: [{ key: "other", state: "behind", since: ACKED }],
    });
    expect(gatewayHolderFacts(lostEvidence({ snapshot: others }))).toStrictEqual({
      pending: undefined,
      noGatewayHolder: true,
    });
  });

  it("LOST with no `pendingPrompts` field at all (an old gateway, or nothing pending)", () => {
    expect(gatewayHolderFacts(lostEvidence())).toStrictEqual({
      pending: undefined,
      noGatewayHolder: true,
    });
  });

  it("a bubble the page watched being acked turns LOST, with Resend and Dismiss", () => {
    const b: Row = { role: "user", _clientMsgId: "p-1", _promptState: { transport: "acked" } };
    // CONTROL — before U4 nothing ever moved an acked bubble on the page: ACCEPTED for good.
    expect(promptStateOf(b)).toBe("ACCEPTED");
    notePromptFacts(b, gatewayHolderFacts(lostEvidence()));
    const marks = promptBubbleMarks(b);
    expect(marks.state).toBe("LOST");
    expect(marks.badge).toContain(">not in history</span>");
    const html = promptActionsHtml(marks.state, "p-1");
    expect(html).toContain('data-prompt-action="resend"');
    expect(html).toContain('data-prompt-action="dismiss"');
    // 2026-09-26 — and the 🐛 that records why it reads LOST, keyed to the same prompt.
    expect(html).toContain('data-prompt-action="report-bug" data-prompt-id="p-1"');
    expect(html).toContain(">🐛</button>");
  });

  it("a prompt its own keyed `final` answered never reads LOST (PQ-6: one terminal)", () => {
    const b: Row = { role: "user", _promptState: { transport: "acked", answered: true } };
    notePromptFacts(b, gatewayHolderFacts(lostEvidence()));
    expect(promptStateOf(b)).toBe("ANSWERED");
    expect(promptBubbleMarks(b).badge).toBe("");
  });

  const NO_VERDICT: Array<[string, Partial<GatewayHolderEvidence>]> = [
    ["the gateway never acked it", { outbox: { lastProofCheckAt: T + 150_000 } }],
    ["the row was read before the ack", { snapshot: sessionRow({ at: ACKED }) }],
    [
      "the session's run set is live (a row with no report: the fallback)",
      { snapshot: sessionRow({ runLive: true }) },
    ],
    ["no transcript read since the ack", { outbox: { ackedAt: ACKED, lastProofCheckAt: ACKED } }],
    [
      "the last transcript read predates the session's last write",
      { snapshot: sessionRow({ updatedAt: T + 160_000 }) },
    ],
    ["it is not stranded (a row with no report: the fallback)", { stranded: false }],
    ["the session has no row", { snapshot: null }],
  ];

  it.each(NO_VERDICT)("no verdict when %s", (_why, over) => {
    expect(gatewayHolderFacts(lostEvidence(over))).toStrictEqual({ pending: undefined });
  });

  it("no outbox entry (proven, or dismissed): no verdict, and no phase either", () => {
    expect(gatewayHolderFacts(lostEvidence({ outbox: null, snapshot: BEHIND_ROW }))).toStrictEqual({
      pending: undefined,
    });
  });
});

describe("G5 wiring — a row that CARRIES a report backs LOST without the age bound", () => {
  // The session holds another prompt, so its row lists that one; this key is not on the list.
  const REPORTING = sessionRow({
    pendingPrompts: [{ key: "other", state: "behind", since: ACKED }],
  });

  it("CONTROL — with no report the stranded bound stands: a young prompt gets no verdict", () => {
    expect(gatewayHolderFacts(lostEvidence({ stranded: false }))).toStrictEqual({
      pending: undefined,
    });
  });

  it("a reporting row reaches LOST although nothing called the prompt stranded", () => {
    expect(
      gatewayHolderFacts(lostEvidence({ snapshot: REPORTING, stranded: false })),
    ).toStrictEqual({ pending: undefined, noGatewayHolder: true });
  });

  it("an emptied list is still a report; a malformed value is not", () => {
    const emptied = sessionRow({ pendingPrompts: [] });
    expect(gatewayHolderFacts(lostEvidence({ snapshot: emptied, stranded: false }))).toStrictEqual({
      pending: undefined,
      noGatewayHolder: true,
    });
    const junk = sessionRow({ pendingPrompts: "junk" });
    expect(gatewayHolderFacts(lostEvidence({ snapshot: junk, stranded: false }))).toStrictEqual({
      pending: undefined,
    });
  });

  // G5 names no holder between chat.send's ack and runReplyAgent, so both liveness vetoes stay, and
  // so does every fact the fallback shares.
  const STILL_NO_VERDICT: Array<[string, Partial<GatewayHolderEvidence>]> = [
    ["the session's run set is live", { snapshot: sessionRow({ ...REPORTING, runLive: true }) }],
    ["this page still watches a run or a pre-model window for it", { clientIdle: false }],
    ["this page cannot vouch for the session", { clientIdle: undefined }],
    ["the gateway never acked it", { outbox: { lastProofCheckAt: T + 150_000 } }],
    ["the row was asked for before the ack", { snapshot: sessionRow({ ...REPORTING, at: ACKED }) }],
    ["no transcript read since the ack", { outbox: { ackedAt: ACKED, lastProofCheckAt: ACKED } }],
    [
      "the last transcript read predates the session's last write",
      { snapshot: sessionRow({ ...REPORTING, updatedAt: T + 160_000 }) },
    ],
  ];

  it.each(STILL_NO_VERDICT)("no verdict on a reporting row when %s", (_why, over) => {
    expect(
      gatewayHolderFacts(lostEvidence({ snapshot: REPORTING, stranded: false, ...over })),
    ).toStrictEqual({ pending: undefined });
  });
});

describe("Stop — an aborted prompt reads CANCELLED, never LOST (§6.1, PQ-6)", () => {
  // app.ts notePromptTerminal records what queued-sends.ts `ownRunTerminal` returns for a chat
  // terminal whose runId is the prompt's own key (chat.send runs a prompt under that key).
  const ackedBubble = (): Row => ({
    role: "user",
    _clientMsgId: "p-1",
    _promptState: { transport: "acked" },
  });

  it("CONTROL — with no terminal fact, a stopped prompt with no row is LOST + Resend", () => {
    const b = ackedBubble();
    notePromptFacts(b, gatewayHolderFacts(lostEvidence()));
    const marks = promptBubbleMarks(b);
    expect(marks.state).toBe("LOST");
    expect(promptActionsHtml(marks.state, "p-1")).toContain('data-prompt-action="resend"');
  });

  it("its own keyed `aborted` records CANCELLED, which no later LOST verdict overrides", () => {
    const b = ackedBubble();
    const own = ownRunTerminal({ state: "aborted", runId: "p-1" });
    expect(own).toStrictEqual({ key: "p-1", facts: { cancelled: true } });
    notePromptFacts(b, own?.facts ?? {});
    for (const snapshot of [sessionRow(), sessionRow({ pendingPrompts: [] })]) {
      notePromptFacts(b, gatewayHolderFacts(lostEvidence({ snapshot })));
      const marks = promptBubbleMarks(b);
      expect(marks.state).toBe("CANCELLED");
      expect(marks.badge).toContain(">stopped · not answered</span>");
      expect(promptActionsHtml(marks.state, "p-1")).toBe("");
    }
  });

  it("the first own-run terminal stands: an `aborted` after the answer is not recorded", () => {
    const b = ackedBubble();
    notePromptFacts(b, ownRunTerminal({ state: "final", runId: "p-1" })?.facts ?? {});
    expect(promptStateOf(b)).toBe("ANSWERED");
    // app.ts skips a bubble whose own run already recorded its terminal.
    expect(ownRunTerminalRecorded(promptFactsOf(b))).toBe(true);
    // CONTROL — recorded anyway, a late stop would relabel the answer "stopped · not answered".
    notePromptFacts(b, ownRunTerminal({ state: "aborted", runId: "p-1" })?.facts ?? {});
    expect(promptStateOf(b)).toBe("CANCELLED");
  });
});

describe("Stop across a reload — the outbox's cancel stamp re-draws CANCELLED (PQ-11)", () => {
  // The reload is real: the entry is written to the keyed store and read back from its JSON, then
  // re-drawn as app.ts reinjectOutboxBubbles does (`redrawn`: the outbox's facts, then the
  // gateway's evidence spread over them).
  const stoppedStore = (stamp: boolean): OutboxStore & { raw: Map<string, string> } => {
    const store = keyedStore();
    enqueueOutbox(store, TYPED);
    markAcked(store, TYPED.id, ACKED);
    if (stamp) {
      // app.ts notePromptTerminal, on the prompt's own `aborted` (ownRunTerminal → cancelled).
      markCancelled(store, TYPED.id, ACKED + 400);
    }
    return store;
  };

  it("CONTROL — with no stamp, the stopped prompt is re-drawn LOST with a Resend", () => {
    const [e] = readOutbox(stoppedStore(false));
    const marks = promptBubbleMarks(redrawn(e, lostEvidence()));
    expect(marks.state).toBe("LOST");
    expect(promptActionsHtml(marks.state, "p-1")).toContain('data-prompt-action="resend"');
  });

  it("stamped, it is re-drawn CANCELLED with no action, whatever the gateway's verdict", () => {
    const [e] = readOutbox(stoppedStore(true));
    expect(e.cancelledAt).toBe(ACKED + 400);
    for (const ev of [
      lostEvidence(),
      lostEvidence({ snapshot: sessionRow({ pendingPrompts: [] }) }),
      lostEvidence({ snapshot: BEHIND_ROW }),
    ]) {
      const marks = promptBubbleMarks(redrawn(e, ev));
      expect(marks.state).toBe("CANCELLED");
      expect(marks.badge).toContain(">stopped · not answered</span>");
      expect(promptActionsHtml(marks.state, "p-1")).toBe("");
    }
  });

  it("an unacked entry whose replays ran out reads CANCELLED too, once stamped", () => {
    const spent = ackedEntry({ ackedAt: undefined, attempts: OUTBOX_MAX_ATTEMPTS });
    // CONTROL — unstamped, replays exhausted: LOST (§2 UNSENT → LOST).
    expect(promptStateOf(redrawnBeforeU4(spent))).toBe("LOST");
    expect(promptStateOf(redrawnBeforeU4({ ...spent, cancelledAt: T + 900 }))).toBe("CANCELLED");
  });

  it("only a number is a stop: a stored value of any other type reads as none", () => {
    const junk = { ...ackedEntry(), cancelledAt: "soon" as unknown as number };
    expect(promptStateOf(redrawnBeforeU4(junk))).toBe("LOST");
  });

  it("the stamp retires nothing: the entry and its text stay until proof or Dismiss (PQ-9)", () => {
    const store = stoppedStore(true);
    expect(readOutbox(store).map((x) => [x.id, x.text])).toEqual([[TYPED.id, TYPED.text]]);
    // …and the acked entry is still parked: nothing replays a stopped prompt's key.
    expect(dueForReplay(readOutbox(store), T + 3_600_000)).toEqual([]);
  });

  it("app.ts stamps the entry where it records the stop, behind the answer check", () => {
    // Resolved from the run root, NOT from `import.meta.url` (jsdom), same as the styles-* tests.
    const srcRoot = ["tinker-ui/src", "src"]
      .map((p) => join(process.cwd(), p))
      .find((p) => existsSync(join(p, "app.ts")));
    if (!srcRoot) {
      throw new Error(`tinker-ui/src not found from ${process.cwd()}`);
    }
    const app = readFileSync(join(srcRoot, "app.ts"), "utf8");
    const from = app.indexOf("function notePromptTerminal(");
    expect(from).toBeGreaterThan(0);
    const fn = app.slice(from, app.indexOf("\n}\n", from));
    // CONTROL: fails on the parent commit, whose notePromptTerminal wrote nothing to the outbox.
    expect(fn).toContain("markCancelled(outboxStore, own.key, Date.now())");
    // PQ-6 on disk: no stamp once a bubble of the prompt recorded its run's `final`.
    expect(fn).toContain("promptFactsOf(m)?.answered === true");
    // The one writer of the stamp.
    expect(app.match(/markCancelled\(/g) ?? []).toHaveLength(1);
  });
});

describe("An answered prompt across a reload — never re-drawn, never LOST", () => {
  // bug-log.md [chat-divergence], cause 1, client half (FORK 2026-10-01). A session's FIRST prompt
  // is never keyed in the transcript, so its entry is never proven. The answer was a fact on the
  // live bubble alone; a fresh history merge dropped that bubble, and app.ts reinjectOutboxBubbles
  // re-drew the entry LOST beside its served row, with a Resend that would re-run the answered
  // prompt. The reload is real: the entry goes through the keyed store's JSON and back, and the
  // evidence carries the entry itself as `outbox`, the way app.ts promptHolderFacts hands it over.
  const answeredStore = (stamp: boolean): OutboxStore & { raw: Map<string, string> } => {
    const store = keyedStore();
    enqueueOutbox(store, TYPED);
    markAcked(store, TYPED.id, ACKED);
    // The proof read after the ack found no keyed row: a first prompt never has one.
    markProofChecked(store, SESSION, T + 150_000);
    if (stamp) {
      // app.ts notePromptTerminal, on the prompt's own successful `final` (ownRunTerminal).
      markAnswered(store, TYPED.id, ACKED + 30_000);
    }
    return store;
  };

  it("CONTROL — unstamped, the answered prompt is re-drawn LOST, with a Resend", () => {
    const [e] = readOutbox(answeredStore(false));
    expect(outboxEntriesNeedingBubble([e], new Set()).map((x) => x.id)).toEqual(["p-1"]);
    const marks = promptBubbleMarks(redrawn(e, lostEvidence({ outbox: e })));
    expect(marks.state).toBe("LOST");
    expect(promptActionsHtml(marks.state, "p-1")).toContain('data-prompt-action="resend"');
  });

  it("stamped, reinjectOutboxBubbles has nothing to re-draw", () => {
    const [e] = readOutbox(answeredStore(true));
    expect(e.answeredAt).toBe(ACKED + 30_000);
    expect(outboxEntriesNeedingBubble([e], new Set())).toEqual([]);
    expect(outboxEntriesNeedingBubble([e], undefined)).toEqual([]);
  });

  it("a re-drawn copy of it is never LOST, whatever the gateway's evidence", () => {
    const [e] = readOutbox(answeredStore(true));
    for (const over of [
      {},
      { snapshot: sessionRow({ pendingPrompts: [] }) },
      { snapshot: BEHIND_ROW },
      { followupStarted: true },
      { snapshot: null },
    ] as Array<Partial<GatewayHolderEvidence>>) {
      const b = redrawn(e, lostEvidence({ outbox: e, ...over }));
      const marks = promptBubbleMarks(b);
      expect(marks.state).toBe("ANSWERED");
      expect(marks.badge).toBe("");
      expect(promptActionsHtml(marks.state, "p-1")).toBe("");
      expect(isBrowserOnlyPrompt(b)).toBe(false);
    }
    // The unacked shape too: the ack was missed, the final was not, and the replays ran out.
    const spent = { ...e, ackedAt: undefined, attempts: OUTBOX_MAX_ATTEMPTS };
    expect(promptStateOf(redrawn(spent, lostEvidence({ outbox: spent })))).toBe("ANSWERED");
  });

  it("the clock moves a copy that never saw the final from LOST to ANSWERED", () => {
    // Another tab answered it (the outbox is one per browser) while this page drew it from disk.
    const [e] = readOutbox(answeredStore(true));
    const b = redrawnBeforeU4(e);
    expect(promptStateOf(b)).toBe("LOST"); // CONTROL: the outbox's starting facts alone
    notePromptFacts(b, gatewayHolderFacts(lostEvidence({ outbox: e })));
    expect(promptStateOf(b)).toBe("ANSWERED");
  });

  it("the stamp retires nothing: the entry stays until proof or Dismiss, and never replays", () => {
    const store = answeredStore(true);
    expect(readOutbox(store).map((x) => [x.id, x.text])).toEqual([[TYPED.id, TYPED.text]]);
    expect(dueForReplay(readOutbox(store), T + 3_600_000)).toEqual([]);
    expect(dismissOutboxEntry(store, TYPED.id, T + 3_600_000)).toBe(true);
    expect(readOutbox(store)).toEqual([]);
  });

  it("app.ts stamps the entry where it records its own run's answer, never for a failure", () => {
    // Resolved from the run root, NOT from `import.meta.url` (jsdom), same as the styles-* tests.
    const srcRoot = ["tinker-ui/src", "src"]
      .map((p) => join(process.cwd(), p))
      .find((p) => existsSync(join(p, "app.ts")));
    if (!srcRoot) {
      throw new Error(`tinker-ui/src not found from ${process.cwd()}`);
    }
    const app = readFileSync(join(srcRoot, "app.ts"), "utf8");
    const from = app.indexOf("function notePromptTerminal(");
    expect(from).toBeGreaterThan(0);
    const fn = app.slice(from, app.indexOf("\n}\n", from));
    // CONTROL: fails on the parent commit, whose notePromptTerminal stamped only the stop.
    expect(fn).toContain("markAnswered(outboxStore, own.key, Date.now())");
    // Only the prompt's own answer, and only a final that carries no failure outcome.
    expect(fn).toContain("own.facts.answered === true");
    expect(fn).toContain("outcomeOf((p as { message?: unknown }).message) === null");
    // The one writer of the stamp.
    expect(app.match(/markAnswered\(/g) ?? []).toHaveLength(1);
  });
});

describe("U4 — the stranded fallback reads an outbox entry as the queue entry it would have been", () => {
  // app.ts strandedPromptIds hands each entry over in exactly this shape.
  const asQueued = (e: OutboxEntry) => ({
    _clientMsgId: e.id,
    _queuedSession: e.sessionKey,
    ts: e.ts,
  });
  const matches = (a?: string, b?: string): boolean =>
    !!a && !!b && (a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`));

  it("stranded once QUEUED_STRANDED_MS has passed with no fresh run, never while one runs", () => {
    const q = asQueued(ackedEntry());
    const later = T + QUEUED_STRANDED_MS + 1;
    expect(strandedQueuedEntries([q], "tinker:A", matches, later, false)).toEqual([q]);
    expect(strandedQueuedEntries([q], "tinker:A", matches, later, true)).toEqual([]);
    expect(strandedQueuedEntries([q], "tinker:A", matches, T + QUEUED_STRANDED_MS, false)).toEqual(
      [],
    );
  });
});

describe("U4 — Resend never reuses an acked key", () => {
  it("the text goes out under a NEW key, and the acked key can never be replayed", () => {
    const store = keyedStore();
    enqueueOutbox(store, TYPED);
    appendJournal(store, TYPED);
    markAcked(store, TYPED.id, ACKED);
    const later = T + 3_600_000;
    // CONTROL — the acked entry is parked: the automatic replay never sends its key again.
    expect(dueForReplay(readOutbox(store), later)).toEqual([]);
    // app.ts resendLostPrompt → send(text, undefined, "p-1"): a fresh key, linked, protected first…
    const fresh = { ...TYPED, id: "p-2", ts: T + 300_000, retryOf: TYPED.id };
    expect(enqueueOutbox(store, fresh)).toBe(true);
    appendJournal(store, fresh);
    // …and only then the LOST entry's journaled retirement.
    expect(dismissOutboxEntry(store, TYPED.id, fresh.ts, { resentAs: fresh.id })).toBe(true);
    const after = readOutbox(store);
    expect(after.map((x) => x.id)).toEqual(["p-2"]);
    expect(after[0]).toMatchObject({ retryOf: "p-1", attempts: 0 });
    expect(after[0].ackedAt).toBeUndefined();
    // Only the new key can ever go out again.
    expect(dueForReplay(after, later).map((x) => x.id)).toEqual(["p-2"]);
    // The journal keeps BOTH texts: the original, stamped, and the resend, linked.
    const journal = readJournal(store);
    expect(journal.find((r) => r.id === "p-1")).toMatchObject({
      text: TYPED.text,
      dismissedAt: fresh.ts,
      resentAs: "p-2",
    });
    expect(journal.find((r) => r.id === "p-2")).toMatchObject({ retryOf: "p-1" });
  });

  it("refuses a Resend under the key it replaces, at both steps, and writes nothing", () => {
    const store = keyedStore();
    enqueueOutbox(store, TYPED);
    markAcked(store, TYPED.id, ACKED);
    const before = store.raw.get(OUTBOX_STORAGE_KEY);
    expect(enqueueOutbox(store, { ...TYPED, retryOf: TYPED.id })).toBe(false);
    expect(dismissOutboxEntry(store, TYPED.id, T, { resentAs: TYPED.id })).toBe(false);
    expect(store.raw.get(OUTBOX_STORAGE_KEY)).toBe(before);
  });
});

describe("U4 — Dismiss keeps the journal row", () => {
  it("retires the outbox entry; the journal still holds the text, stamped", () => {
    const store = keyedStore();
    enqueueOutbox(store, TYPED);
    appendJournal(store, TYPED);
    markAcked(store, TYPED.id, ACKED);
    // CONTROL — without a Dismiss the parked, acked entry stays in the outbox for good.
    expect(readOutbox(store).map((x) => x.id)).toEqual(["p-1"]);
    expect(dismissOutboxEntry(store, TYPED.id, T + 400_000)).toBe(true);
    expect(readOutbox(store)).toEqual([]);
    expect(readJournal(store)).toEqual([{ ...TYPED, dismissedAt: T + 400_000 }]);
  });
});

describe("U4 — only LOST draws controls (PQ-12), declared once at base.css's tone site", () => {
  it.each(PROMPT_STATES.filter((s) => s !== "LOST"))("%s draws no control", (state) => {
    expect(promptActionsHtml(state, "p-1")).toBe("");
  });

  it("LOST draws Resend, Dismiss, then the 🐛, amber, each keyed by the prompt's id", () => {
    const html = promptActionsHtml("LOST", "p-1");
    expect(html.startsWith('<span class="prompt-actions prompt-tone-amber">')).toBe(true);
    expect([...html.matchAll(/data-prompt-action="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "resend",
      "dismiss",
      "report-bug",
    ]);
    expect(html.match(/data-prompt-id="p-1"/g)).toHaveLength(3);
    expect(html).toContain(">Resend</button>");
    expect(html).toContain(">Dismiss</button>");
  });

  it("escapes the id, and draws nothing without an id or a state", () => {
    expect(promptActionsHtml("LOST", 'a"<b')).toContain('data-prompt-id="a&quot;&lt;b"');
    expect(promptActionsHtml("LOST", undefined)).toBe("");
    expect(promptActionsHtml("LOST", "")).toBe("");
    expect(promptActionsHtml(null, "p-1")).toBe("");
  });

  it("base.css declares every class the controls emit, and each control rule once", () => {
    // Resolved from the run root, NOT from `import.meta.url` (jsdom), same as the styles-* tests.
    const srcRoot = ["tinker-ui/src", "src"]
      .map((p) => join(process.cwd(), p))
      .find((p) => existsSync(join(p, "styles/base.css")));
    if (!srcRoot) {
      throw new Error(`tinker-ui/src not found from ${process.cwd()}`);
    }
    const css = stripCssComments(readFileSync(join(srcRoot, "styles/base.css"), "utf8"));
    const selectors = [...css.matchAll(/([^{};]+)[{][^{}]*[}]/g)].flatMap((m) =>
      m[1].split(",").map((s) => s.trim()),
    );
    const emitted = new Set<string>();
    for (const m of promptActionsHtml("LOST", "p-1").matchAll(/class="([^"]+)"/g)) {
      for (const c of m[1].split(" ")) {
        if (c) {
          emitted.add(c);
        }
      }
    }
    expect([...emitted].toSorted()).toEqual([
      "prompt-action",
      "prompt-actions",
      "prompt-tone-amber",
    ]);
    for (const c of emitted) {
      expect(
        selectors.some((s) => selectorHasClass(s, c)),
        c,
      ).toBe(true);
    }
    for (const sel of [
      ".prompt-actions",
      ".prompt-action",
      ".prompt-actions.prompt-tone-amber .prompt-action",
    ]) {
      expect(selectors.filter((s) => s === sel).length, sel).toBe(1);
    }
  });
});
