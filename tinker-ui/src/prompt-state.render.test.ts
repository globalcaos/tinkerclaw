// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md step U2, the RENDER proof.
//
// prompt-state.test.ts (step U1) proves the TABLE: one state in, one §6.1 row out. This file proves
// the BUBBLE: a user row's one `_promptState` is rendered THROUGH that table (msg-order.ts
// `promptBubbleMarks` fills the two slots app.ts `renderMsg` interpolates into all four user-bubble
// render sites), and a prompt only this browser holds survives the steps loadChat composes.
//
// app.ts is a browser entry with no harness, so every step below is the PURE function app.ts calls.
// The two things app.ts does inline (append `added` on a gap-fill; write the history, then re-draw
// the outbox, on a fresh page) are spelled out here, each next to the app.ts step it mirrors.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_HISTORY_RECONCILE_DEPS, reconcileHistoryIntoPage } from "./history-reconcile.js";
import {
  PROVEN_PROMPT_FACTS,
  isBrowserOnlyPrompt,
  isClientOnlyBubble,
  notePromptFacts,
  outboxPromptFacts,
  promptBubbleMarks,
  promptFactsOf,
  promptStateOf,
} from "./msg-order.js";
import {
  OUTBOX_MAX_ATTEMPTS,
  outboxEntriesNeedingBubble,
  reconcileWithHistory,
  type HistoryUserMsg,
  type OutboxEntry,
} from "./outbox.js";
import {
  PROMPT_STATES,
  promptIndicator,
  type PromptStateInputs,
  type PromptStateName,
} from "./prompt-state.js";

type Row = Record<string, unknown>;

/**
 * THE CONTROL (prompt-queue.md §3.5 C1): the badge precedence BEFORE U2, transcribed from
 * `tinker-ui/src/app.ts` at `ac2160c717b` (the `queuedClass` / `queuedBadge` site, whose comment
 * read "the undelivered state reuses these two slots"). Kept as a passing assertion, so the fix
 * below is measured against the defect itself and not against a fixture that could share it.
 */
const badgeBeforeU2 = (msg: {
  _queued?: boolean;
  _undelivered?: boolean;
  _undeliveredAcked?: boolean;
}): string =>
  msg._queued
    ? "queued"
    : msg._undelivered
      ? msg._undeliveredAcked
        ? "accepted · not in history"
        : "not delivered · will retry"
      : "";

/** A user bubble as app.ts `send()` writes it now (the `_promptState` literal is send()'s own). */
function sentBubble(id: string, deferred: boolean): Row {
  return {
    role: "user",
    _clientMsgId: id,
    content: [{ type: "text", text: `prompt ${id}` }],
    _promptStartedAt: 1_000,
    ...(deferred ? { _queuedSession: "agent:main:tinker:A" } : {}),
    _promptState: { transport: "in-flight", deferred },
  };
}

/** A bubble as app.ts `reinjectOutboxBubbles` re-draws it from a durable outbox entry. */
function redrawnBubble(e: OutboxEntry): Row {
  return {
    role: "user",
    _clientMsgId: e.id,
    content: [{ type: "text", text: e.text }],
    _promptStartedAt: e.ts,
    timestamp: e.ts,
    _promptState: outboxPromptFacts(e),
  };
}

/** A bubble carrying exactly these facts (a fresh copy, so no test leaks a recorded fact). */
const withFacts = (facts: PromptStateInputs): Row => ({ role: "user", _promptState: { ...facts } });

const T = 1_700_000_100_000;

function outboxEntry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "lost-1",
    sessionKey: "agent:main:tinker:A",
    text: "where did this prompt go",
    ts: T,
    attempts: 0,
    lastAttemptAt: 0,
    keyedProofExpected: true,
    ...over,
  };
}

/** The user rows of a history payload as app.ts `reconcileOutboxAgainst` hands them to the outbox
 *  (key, text, time; every user row, unfiltered). */
function historyUsers(incoming: readonly Row[]): HistoryUserMsg[] {
  return incoming
    .filter((m) => String(m.role ?? "").toLowerCase() === "user")
    .map((m) => ({
      idempotencyKey: typeof m.idempotencyKey === "string" ? m.idempotencyKey : undefined,
      text: Array.isArray(m.content)
        ? (m.content as Row[]).map((b) => (typeof b.text === "string" ? b.text : "")).join("")
        : "",
      ts: typeof m.timestamp === "number" ? m.timestamp : undefined,
    }));
}

/** One set of facts per §2 state: every state a bubble can be derived into. */
const FACTS_BY_STATE: Array<[PromptStateName, PromptStateInputs]> = [
  ["SAVED", { transport: "not-issued" }],
  ["SENDING", { transport: "in-flight" }],
  ["UNSENT", { transport: "rejected" }],
  ["ACCEPTED", { transport: "acked" }],
  ["BEHIND", { transport: "acked", disposition: "backlogged" }],
  ["STEERED", { transport: "acked", disposition: "steered" }],
  ["PREPARING", { transport: "acked", pending: "preparing" }],
  ["RUNNING", { transport: "acked", pending: "running" }],
  ["RETRYING", { transport: "acked", retrying: true }],
  ["ANSWERED", { transport: "acked", answered: true }],
  ["FAILED", { transport: "acked", failed: true }],
  ["CANCELLED", { transport: "acked", cancelled: true }],
  ["LOST", { transport: "acked", noGatewayHolder: true }],
];

const NO_MARKS = { state: null, cls: "", badge: "" };

describe("U2 C1 — a deferred prompt that never reached the gateway reads UNSENT, not `queued`", () => {
  it("CONTROL — before U2 this prompt's flags rendered `queued`; its facts now derive UNSENT", () => {
    // A deferred send whose chat.send was rejected: before U2, app.ts stamped BOTH flags on it.
    expect(badgeBeforeU2({ _queued: true, _undelivered: true })).toBe("queued");
    // The facts U2 records for the very same prompt.
    const b = sentBubble("p1", true);
    expect(notePromptFacts(b, { transport: "rejected" })).toBe(true);
    expect(promptStateOf(b)).toBe("UNSENT");
  });

  it("renders the UNSENT row: amber, dashed, `not sent · retrying`", () => {
    const b = sentBubble("p1", true);
    notePromptFacts(b, { transport: "rejected" });
    const marks = promptBubbleMarks(b);
    expect(marks.state).toBe("UNSENT");
    expect(marks.badge).toContain(">not sent · retrying</span>");
    expect(marks.badge).toContain('data-prompt-state="UNSENT"');
    expect(marks.badge).not.toContain(">queued<");
    expect(marks.cls).toContain("prompt-tone-amber");
    expect(marks.cls).toContain("prompt-dashed");
    // Deferral is a PLACEMENT fact (PQ-8): it neither dims nor re-words the bubble.
    expect(marks.cls).not.toContain("prompt-dimmed");
  });
});

describe("U2 — the send path records facts, and the state is derived from them", () => {
  it("a prompt being sent draws nothing and is browser-only (SENDING)", () => {
    const b = sentBubble("p2", false);
    expect(promptBubbleMarks(b)).toEqual({ ...NO_MARKS, state: "SENDING" });
    expect(isBrowserOnlyPrompt(b)).toBe(true);
    expect(isClientOnlyBubble(b)).toBe(true);
  });

  it("the ack derives ACCEPTED: nothing drawn, and the bubble stops being client-only", () => {
    const b = sentBubble("p2", false);
    notePromptFacts(b, { transport: "acked" });
    expect(promptBubbleMarks(b)).toEqual({ ...NO_MARKS, state: "ACCEPTED" });
    expect(isClientOnlyBubble(b)).toBe(false);
  });

  it("OLD GATEWAY (no disposition read): a deferred, acked prompt is ACCEPTED, not `queued`", () => {
    // Before U2 the same bubble (`_queued` kept, `_undelivered` cleared by the ack) said `queued`.
    expect(badgeBeforeU2({ _queued: true })).toBe("queued");
    const b = sentBubble("p3", true);
    notePromptFacts(b, { transport: "acked" });
    // PQ-8: the UI must not guess BEHIND or STEERED, so it claims nothing at all.
    expect(promptBubbleMarks(b)).toEqual({ ...NO_MARKS, state: "ACCEPTED" });
  });

  it("replays count to the outbox cap: UNSENT while they remain, LOST (never 'retry') after", () => {
    const b = sentBubble("p4", false);
    notePromptFacts(b, { transport: "rejected", attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    expect(promptStateOf(b)).toBe("UNSENT");
    notePromptFacts(b, { attempts: OUTBOX_MAX_ATTEMPTS });
    const marks = promptBubbleMarks(b);
    expect(marks.state).toBe("LOST");
    expect(marks.badge).toContain(">not in history</span>");
    expect(marks.badge).not.toMatch(/retry/i);
  });

  it("a replay's ack clears the warning at once: UNSENT → ACCEPTED", () => {
    const b = sentBubble("p5", false);
    notePromptFacts(b, { transport: "rejected", attempts: 2 });
    expect(promptStateOf(b)).toBe("UNSENT");
    notePromptFacts(b, { transport: "acked" });
    expect(promptBubbleMarks(b)).toEqual({ ...NO_MARKS, state: "ACCEPTED" });
  });
});

describe("U2 — every state renders exactly its §6.1 row (one state, one indicator)", () => {
  it("covers every lifecycle state", () => {
    expect(FACTS_BY_STATE.map(([s]) => s)).toEqual([...PROMPT_STATES]);
  });

  it.each(FACTS_BY_STATE)("%s", (state, facts) => {
    const marks = promptBubbleMarks(withFacts(facts));
    const row = promptIndicator(state);
    expect(marks.state).toBe(state);
    // The badge text is the table's, verbatim: copy lives in prompt-state.ts and nowhere else.
    if (row.badge === null) {
      expect(marks.badge).toBe("");
    } else {
      expect(marks.badge).toContain(`>${row.badge}</span>`);
      expect(marks.badge).toContain(`class="prompt-badge prompt-tone-${row.tone}"`);
    }
    const toned = row.tone === "grey" || row.tone === "amber";
    expect(marks.cls.includes(`prompt-tone-${row.tone}`)).toBe(toned);
    expect(marks.cls.includes("prompt-dimmed")).toBe(row.dimmed);
    expect(marks.cls.includes("prompt-dashed")).toBe(row.dashed);
    // The badge slot never carries a control, in any state. Since step U4 the LOST row's Resend and
    // Dismiss exist, in their own slot (prompt-state.ts promptActionsHtml, pinned in
    // prompt-state.lost.test.ts), so this assertion keeps the two slots apart.
    expect(marks.badge).not.toMatch(/<button|resend|dismiss/i);
  });

  it("a row with no facts, or with malformed facts, draws nothing and is not client-only", () => {
    const rows: unknown[] = [
      { role: "user", content: [{ type: "text", text: "a history row" }] },
      { role: "user", _promptState: true },
      { role: "user", _promptState: { transport: "bogus" } },
      null,
      "not a row",
    ];
    for (const m of rows) {
      expect(promptFactsOf(m)).toBeNull();
      expect(promptBubbleMarks(m)).toEqual(NO_MARKS);
      expect(isClientOnlyBubble(m)).toBe(false);
    }
  });

  it("never invents facts for a row that has none", () => {
    const history: Row = { role: "user", content: [] };
    expect(notePromptFacts(history, { transport: "acked" })).toBe(false);
    expect("_promptState" in history).toBe(false);
  });
});

describe("U2 — isBrowserOnlyPrompt answers what the retired `_undelivered` flag answered", () => {
  // live-continuation.ts `runTurnStart` (through app.ts `isPromptRow`) and msg-order.ts
  // `isClientOnlyBubble` both read that flag. Each row: a moment in a prompt's life, what
  // `_undelivered` was at that moment, and the facts U2 records for it.
  const acked = outboxPromptFacts(outboxEntry({ ackedAt: T + 500 }));
  const MOMENTS: Array<[string, boolean, PromptStateInputs]> = [
    ["created by send()", true, { transport: "in-flight" }],
    ["chat.send acked", false, { transport: "acked" }],
    ["chat.send rejected", true, { transport: "rejected" }],
    ["re-drawn from the outbox, unacked", true, outboxPromptFacts(outboxEntry())],
    ["re-drawn from the outbox, acked and unproven", true, acked],
    ["proven by a keyed transcript row", false, { ...acked, ...PROVEN_PROMPT_FACTS }],
  ];
  it.each(MOMENTS)("%s → %s", (_moment, undelivered, facts) => {
    const b = withFacts(facts);
    expect(isBrowserOnlyPrompt(b)).toBe(undelivered);
    expect(isClientOnlyBubble(b)).toBe(undelivered);
  });
});

describe("U2 — a re-injected LOST bubble survives loadChat", () => {
  const olderPrompt: Row = {
    role: "user",
    __openclaw: { id: "u1" },
    idempotencyKey: "older-1",
    content: [{ type: "text", text: "an older prompt" }],
    timestamp: T - 120_000,
  };
  const olderAnswer: Row = {
    role: "assistant",
    __openclaw: { id: "a1" },
    content: [{ type: "text", text: "an older answer" }],
    timestamp: T - 110_000,
  };
  const laterAnswer: Row = {
    role: "assistant",
    __openclaw: { id: "a2" },
    content: [{ type: "text", text: "a later answer" }],
    timestamp: T + 300_000,
  };
  // Acked by the gateway, never proven by a transcript row.
  const lostEntry = outboxEntry({ ackedAt: T + 500 });

  it("is re-drawn LOST from its outbox entry: amber, solid, `not in history`, client-only", () => {
    const b = redrawnBubble(lostEntry);
    const marks = promptBubbleMarks(b);
    expect(marks.state).toBe("LOST");
    expect(marks.badge).toContain(">not in history</span>");
    expect(marks.cls).toContain("prompt-tone-amber");
    expect(marks.cls).not.toContain("prompt-dashed");
    expect(isClientOnlyBubble(b)).toBe(true);
  });

  it("a GAP-FILL merge keeps it on the page, still LOST", () => {
    const b = redrawnBubble(lostEntry);
    const page: Row[] = [olderPrompt, olderAnswer, b];
    const incoming: Row[] = [olderPrompt, olderAnswer, laterAnswer];
    // loadChat step 1, reconcileOutboxAgainst: the transcript does not prove it, so no proof fact.
    expect(reconcileWithHistory([lostEntry], historyUsers(incoming)).delivered).toEqual([]);
    // loadChat step 2, reconcileHistoryIntoPage; on a gap-fill app.ts pushes `added`, nothing else.
    const res = reconcileHistoryIntoPage(page, incoming, DEFAULT_HISTORY_RECONCILE_DEPS);
    expect(res.mode).toBe("gapfill");
    const after = [...page, ...res.added];
    expect(after).toContain(b);
    expect(after).toContain(laterAnswer);
    expect(promptStateOf(b)).toBe("LOST");
    expect(promptBubbleMarks(b).badge).toContain(">not in history</span>");
  });

  it("a FRESH page (a reload) writes the history, and the outbox re-draws it LOST again", () => {
    const incoming: Row[] = [olderPrompt, olderAnswer, laterAnswer];
    const res = reconcileHistoryIntoPage([], incoming, DEFAULT_HISTORY_RECONCILE_DEPS);
    expect(res.mode).toBe("fresh");
    // loadChat: `messages = incoming`, then reinjectOutboxBubbles asks which entries are off screen.
    const page: Row[] = [...incoming];
    const onScreen = new Set(
      page.map((m) => m._clientMsgId).filter((id): id is string => typeof id === "string"),
    );
    const needing = outboxEntriesNeedingBubble([lostEntry], onScreen);
    expect(needing.map((e) => e.id)).toEqual(["lost-1"]);
    const b = redrawnBubble(needing[0]);
    page.push(b);
    expect(promptStateOf(b)).toBe("LOST");
    // Once it IS on screen it is not drawn a second time.
    expect(outboxEntriesNeedingBubble([lostEntry], new Set(["lost-1"]))).toEqual([]);
  });

  it("an unacked entry is re-drawn UNSENT while replays remain, LOST once they are exhausted", () => {
    expect(promptStateOf(redrawnBubble(outboxEntry({ attempts: 3 })))).toBe("UNSENT");
    expect(promptStateOf(redrawnBubble(outboxEntry({ attempts: OUTBOX_MAX_ATTEMPTS })))).toBe(
      "LOST",
    );
  });

  it("a keyed transcript row retires the indicator: the proof is recorded, nothing is drawn", () => {
    const b = redrawnBubble(lostEntry);
    const proof: Row = {
      role: "user",
      __openclaw: { id: "u9" },
      idempotencyKey: "lost-1",
      content: [{ type: "text", text: "where did this prompt go" }],
      timestamp: T + 1_000,
    };
    const { delivered } = reconcileWithHistory([lostEntry], historyUsers([olderPrompt, proof]));
    expect(delivered.map((e) => e.id)).toEqual(["lost-1"]);
    // What app.ts markPromptDelivered and the loadChat reconcile loop record.
    expect(notePromptFacts(b, PROVEN_PROMPT_FACTS)).toBe(true);
    expect(promptBubbleMarks(b)).toEqual({ ...NO_MARKS, state: "ACCEPTED" });
    expect(isClientOnlyBubble(b)).toBe(false);
  });
});

describe("U2 — base.css keys the indicator by TONE, at ONE declaration site", () => {
  // Resolved from the run root, NOT from `import.meta.url` (jsdom), same as the styles-* tests.
  const srcRoot = ["tinker-ui/src", "src"]
    .map((p) => join(process.cwd(), p))
    .find((p) => existsSync(join(p, "styles/base.css")));
  if (!srcRoot) {
    throw new Error(`tinker-ui/src not found from ${process.cwd()}`);
  }
  const css = readFileSync(join(srcRoot, "styles/base.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const selectors = [...css.matchAll(/([^{};]+)\{[^{}]*\}/g)].flatMap((m) =>
    m[1].split(",").map((s) => s.trim()),
  );

  it("declares every class the render can emit", () => {
    const emitted = new Set<string>();
    for (const [, facts] of FACTS_BY_STATE) {
      const marks = promptBubbleMarks(withFacts(facts));
      for (const c of marks.cls.split(/\s+/)) {
        if (c) {
          emitted.add(c);
        }
      }
      for (const m of marks.badge.matchAll(/class="([^"]+)"/g)) {
        for (const c of m[1].split(/\s+/)) {
          emitted.add(c);
        }
      }
    }
    expect([...emitted].toSorted()).toEqual([
      "msg-prompt",
      "prompt-badge",
      "prompt-dashed",
      "prompt-dimmed",
      "prompt-tone-amber",
      "prompt-tone-grey",
    ]);
    for (const c of emitted) {
      expect(
        selectors.some((s) => new RegExp(`\\.${c}(?![\\w-])`).test(s)),
        c,
      ).toBe(true);
    }
  });

  it("retires the selectors of the two stacked lanes", () => {
    for (const gone of [".msg-queued", ".queued-badge", ".msg-undelivered", ".undelivered-badge"]) {
      expect(css.includes(gone), gone).toBe(false);
    }
  });

  it("declares each indicator rule once, with the dashed override after the tone border", () => {
    for (const sel of [
      ".msg.msg-prompt",
      ".msg.prompt-tone-amber",
      ".msg.prompt-dashed",
      ".msg.prompt-dimmed",
      ".prompt-badge",
      ".prompt-badge.prompt-tone-grey",
      ".prompt-badge.prompt-tone-amber",
    ]) {
      expect(selectors.filter((s) => s === sel).length, sel).toBe(1);
    }
    // `.msg.prompt-tone-amber` sets the `border` shorthand, which resets the style, so the dashed
    // override must come after it or UNSENT would draw solid.
    expect(selectors.indexOf(".msg.prompt-tone-amber")).toBeLessThan(
      selectors.indexOf(".msg.prompt-dashed"),
    );
  });
});
