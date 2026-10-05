// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md step U1, the table-driven proof.
//
// Two things are being pinned here, and only one of them is arithmetic:
//   1. ONE STATE → ONE INDICATOR (PQ-2). The §6.1 table is exhaustive, its rows are distinct, and
//      no state can be added without a row.
//   2. THE C1 FIX. A deferred prompt whose send was REJECTED must read UNSENT, not `queued`. That
//      one ships with an EXECUTABLE CONTROL below — today's precedence, transcribed from app.ts,
//      asserted to give the wrong answer for the very same inputs. A control written as prose is a
//      claim; written as a passing assertion it is evidence.

import { describe, it, expect } from "vitest";
import { OUTBOX_MAX_ATTEMPTS } from "./outbox.js";
import {
  PROMPT_STATES,
  derivePromptIndicator,
  derivePromptState,
  promptIndicator,
  type PromptAction,
  type PromptStateInputs,
  type PromptStateName,
} from "./prompt-state.js";

/**
 * THE CONTROL (prompt-queue.md §3.5 C1).
 *
 * Transcribed verbatim from `tinker-ui/src/app.ts:15847-15854` (HEAD 7721f5afc36) — the badge
 * precedence site, whose own comment reads "the undelivered state reuses these two slots":
 *
 *   const queuedClass = msg._queued ? " msg-queued" : msg._undelivered ? " msg-undelivered" : "";
 *   const queuedBadge = msg._queued
 *     ? `<span class="queued-badge">queued</span>`
 *     : msg._undelivered
 *       ? msg._undeliveredAcked
 *         ? `…accepted · not in history…`
 *         : `…not delivered · will retry…`
 *       : "";
 *
 * `_queued` and `_undelivered` are BOTH stamped on a deferred bubble at creation (`app.ts:13343`
 * and `:13348`), so this precedence is reached on every deferred prompt, delivered or not.
 */
const todaysBadge = (msg: {
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

const inputs = (over: Partial<PromptStateInputs> = {}): PromptStateInputs => ({
  transport: "acked",
  ...over,
});

describe("prompt-state §6.1 — one state, one indicator (PQ-2)", () => {
  // The table-driven core: state → the row §6.1 gives it.
  const TABLE: Array<{
    state: PromptStateName;
    badge: string | null;
    tone: string;
    placement: string;
    dimmed: boolean;
    dashed: boolean;
    other: string;
    actions: string[];
  }> = [
    {
      state: "SAVED",
      badge: null,
      tone: "normal",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "pill-sending",
      actions: [],
    },
    {
      state: "SENDING",
      badge: null,
      tone: "normal",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "pill-sending",
      actions: [],
    },
    {
      state: "UNSENT",
      badge: "not sent · retrying",
      tone: "amber",
      placement: "in-place",
      dimmed: false,
      dashed: true,
      other: "none",
      actions: [],
    },
    {
      state: "ACCEPTED",
      badge: null,
      tone: "normal",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "pill-preparing-context",
      actions: [],
    },
    {
      state: "BEHIND",
      badge: "waiting for the current turn",
      tone: "grey",
      placement: "trailing",
      dimmed: true,
      dashed: false,
      other: "none",
      actions: [],
    },
    {
      state: "STEERED",
      badge: "added to the current turn",
      tone: "grey",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "none",
      actions: [],
    },
    {
      state: "PREPARING",
      badge: null,
      tone: "normal",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "pill-gateway-phase",
      actions: [],
    },
    {
      state: "RUNNING",
      badge: null,
      tone: "normal",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "thinking",
      actions: [],
    },
    {
      state: "RETRYING",
      badge: null,
      tone: "none",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "retry-countdown",
      actions: ["stop-retrying"],
    },
    {
      state: "ANSWERED",
      badge: null,
      tone: "none",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "none",
      actions: [],
    },
    {
      state: "FAILED",
      badge: null,
      tone: "none",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "error-bubble",
      actions: [],
    },
    {
      state: "CANCELLED",
      badge: "stopped · not answered",
      tone: "grey",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "none",
      actions: [],
    },
    {
      state: "LOST",
      badge: "not in history",
      tone: "amber",
      placement: "in-place",
      dimmed: false,
      dashed: false,
      other: "none",
      actions: ["resend", "dismiss", "report-bug"],
    },
  ];

  it.each(TABLE)("$state renders exactly the §6.1 row", (expected) => {
    const ind = promptIndicator(expected.state);
    expect(ind).toEqual({
      state: expected.state,
      badge: expected.badge,
      tone: expected.tone,
      placement: expected.placement,
      dimmed: expected.dimmed,
      dashed: expected.dashed,
      other: expected.other,
      actions: expected.actions,
      clearedBy: expect.any(String),
    });
  });

  it("covers every lifecycle state — a new state cannot ship without a row", () => {
    expect(TABLE.map((r) => r.state)).toEqual([...PROMPT_STATES]);
    for (const state of PROMPT_STATES) {
      expect(promptIndicator(state).state).toBe(state);
    }
  });

  it("gives no two states the same badge text (PQ-2: one badge cannot mean two things)", () => {
    const badges = PROMPT_STATES.map((s) => promptIndicator(s).badge).filter(
      (b): b is string => b !== null,
    );
    expect(new Set(badges).size).toBe(badges.length);
  });

  it("keeps PQ-4's four questions distinguishable without hovering", () => {
    // grey = the gateway has it, wait.
    expect(promptIndicator("BEHIND").tone).toBe("grey");
    expect(promptIndicator("STEERED").tone).toBe("grey");
    // orange, pulsing = an automatic retry you may stop — and it is NOT on the prompt bubble.
    expect(promptIndicator("RETRYING").other).toBe("retry-countdown");
    expect(promptIndicator("RETRYING").actions).toContain("stop-retrying");
    // amber = only your browser has it, or the gateway lost it. Both amber, told apart by the
    // border and by whether they ask you for anything.
    expect(promptIndicator("UNSENT").tone).toBe("amber");
    expect(promptIndicator("LOST").tone).toBe("amber");
    expect(promptIndicator("UNSENT").dashed).toBe(true);
    expect(promptIndicator("LOST").dashed).toBe(false);
    expect(promptIndicator("UNSENT").actions).toEqual([]);
    expect(promptIndicator("LOST").actions).toEqual(["resend", "dismiss", "report-bug"]);
  });

  it("hands back a copy, so a render site cannot mutate the shared table", () => {
    const a = promptIndicator("LOST");
    a.badge = "tampered";
    (a.actions as PromptAction[]).push("resend");
    expect(promptIndicator("LOST").badge).toBe("not in history");
    expect(promptIndicator("LOST").actions).toEqual(["resend", "dismiss", "report-bug"]);
  });
});

describe("prompt-state C1 — a deferred prompt that was never delivered reads UNSENT, not queued", () => {
  // The exact shape C1 describes: the deferral predicate parked the bubble AND the send was
  // rejected, so the gateway has never seen this prompt.
  const deferredAndRejected = inputs({ transport: "rejected", deferred: true, attempts: 1 });

  it("CONTROL — today's app.ts precedence says `queued` for these same inputs", () => {
    // `_queued: true` (deferred) and `_undelivered: true` (no ack) are exactly what app.ts stamps.
    expect(todaysBadge({ _queued: true, _undelivered: true })).toBe("queued");
    // and it says it even though the honest fact is that nothing but this browser holds the text:
    expect(todaysBadge({ _undelivered: true })).toBe("not delivered · will retry");
  });

  it("derives UNSENT — the transport fact wins, deferral is placement only", () => {
    expect(derivePromptState(deferredAndRejected)).toBe("UNSENT");
    const ind = derivePromptIndicator(deferredAndRejected);
    expect(ind.badge).toBe("not sent · retrying");
    expect(ind.tone).toBe("amber");
    expect(ind.badge).not.toBe("queued");
  });

  it("keeps the deferral PLACEMENT while saying UNSENT (PQ-8, §3.1 'keep the placement')", () => {
    expect(derivePromptIndicator(deferredAndRejected).placement).toBe("trailing");
    expect(derivePromptIndicator({ ...deferredAndRejected, deferred: false }).placement).toBe(
      "in-place",
    );
  });

  it("never lets deferral change WHICH state a prompt is in", () => {
    for (const transport of ["not-issued", "in-flight", "rejected", "acked"] as const) {
      const base = inputs({ transport, attempts: 0 });
      expect(derivePromptState({ ...base, deferred: true })).toBe(
        derivePromptState({ ...base, deferred: false }),
      );
    }
  });
});

describe("prompt-state — exhausted replays give LOST, never 'will retry' (C7, PQ-12)", () => {
  it("UNSENT while attempts remain, LOST at the cap", () => {
    const at = (attempts: number) => inputs({ transport: "rejected", attempts });
    expect(derivePromptState(at(0))).toBe("UNSENT");
    expect(derivePromptState(at(OUTBOX_MAX_ATTEMPTS - 1))).toBe("UNSENT");
    expect(derivePromptState(at(OUTBOX_MAX_ATTEMPTS))).toBe("LOST");
    expect(derivePromptState(at(OUTBOX_MAX_ATTEMPTS + 3))).toBe("LOST");
  });

  it("defaults the cap to the outbox's own OUTBOX_MAX_ATTEMPTS — no second copy of the number", () => {
    expect(derivePromptState(inputs({ transport: "rejected", attempts: 8 }))).toBe("LOST");
    expect(derivePromptState(inputs({ transport: "rejected", attempts: 8, maxAttempts: 99 }))).toBe(
      "UNSENT",
    );
  });

  it("promises no retry it will not perform, and asks the owner instead", () => {
    const ind = derivePromptIndicator(
      inputs({ transport: "rejected", attempts: OUTBOX_MAX_ATTEMPTS }),
    );
    expect(ind.state).toBe("LOST");
    expect(ind.badge).toBe("not in history");
    expect(ind.badge).not.toMatch(/retry|retrying/i);
    expect(ind.actions).toEqual(["resend", "dismiss", "report-bug"]);
  });

  it("an ACKED prompt with no gateway holder is LOST too (§2 ACCEPTED/BEHIND → LOST)", () => {
    expect(derivePromptState(inputs({ transport: "acked", noGatewayHolder: true }))).toBe("LOST");
    // and a stale disposition from before a gateway restart does not override it (C11)
    expect(
      derivePromptState(
        inputs({ transport: "acked", noGatewayHolder: true, disposition: "backlogged" }),
      ),
    ).toBe("LOST");
    // an UNACKED prompt never reaches LOST this way — its route is exhaustion
    expect(
      derivePromptState(inputs({ transport: "rejected", attempts: 0, noGatewayHolder: true })),
    ).toBe("UNSENT");
  });
});

describe("prompt-state — an old gateway keeps today's behaviour (§6.3: absent field ≠ negative)", () => {
  it("no disposition and no snapshot leaves an acked prompt in ACCEPTED", () => {
    expect(derivePromptState(inputs({ transport: "acked" }))).toBe("ACCEPTED");
  });

  it("ACCEPTED claims nothing the gateway has not said, and keeps the trailing placement", () => {
    const ind = derivePromptIndicator(inputs({ transport: "acked", deferred: true }));
    expect(ind.state).toBe("ACCEPTED");
    // PQ-8 — the UI must not invent BEHIND or STEERED. No badge at all.
    expect(ind.badge).toBeNull();
    // §3.1 — the one fact the old grey bubble could honestly claim was its placement. Kept.
    expect(ind.placement).toBe("trailing");
    expect(ind.other).toBe("pill-preparing-context");
  });

  it("never guesses a disposition from the deferral predicate", () => {
    for (const deferred of [true, false]) {
      expect(derivePromptState(inputs({ transport: "acked", deferred }))).not.toBe("BEHIND");
      expect(derivePromptState(inputs({ transport: "acked", deferred }))).not.toBe("STEERED");
    }
  });
});

describe("prompt-state §2 — the gateway lane", () => {
  it("maps each reported disposition onto its own state", () => {
    expect(derivePromptState(inputs({ disposition: "steered" }))).toBe("STEERED");
    expect(derivePromptState(inputs({ disposition: "backlogged" }))).toBe("BEHIND");
    expect(derivePromptState(inputs({ disposition: "dropped" }))).toBe("CANCELLED");
  });

  it("maps each pendingPrompts phase onto its own state (PQ-11: survives a reload)", () => {
    expect(derivePromptState(inputs({ pending: "behind" }))).toBe("BEHIND");
    expect(derivePromptState(inputs({ pending: "steered" }))).toBe("STEERED");
    expect(derivePromptState(inputs({ pending: "preparing" }))).toBe("PREPARING");
    expect(derivePromptState(inputs({ pending: "running" }))).toBe("RUNNING");
  });

  it("lets the fresher snapshot move BEHIND → PREPARING when the linked follow-up starts (C3/G3)", () => {
    expect(derivePromptState(inputs({ disposition: "backlogged" }))).toBe("BEHIND");
    expect(derivePromptState(inputs({ disposition: "backlogged", pending: "preparing" }))).toBe(
      "PREPARING",
    );
    expect(derivePromptState(inputs({ disposition: "backlogged", pending: "running" }))).toBe(
      "RUNNING",
    );
  });

  it("does not dim a STEERED prompt — it IS part of the running turn now", () => {
    const ind = derivePromptIndicator(inputs({ disposition: "steered", deferred: true }));
    expect(ind.state).toBe("STEERED");
    expect(ind.dimmed).toBe(false);
    expect(ind.placement).toBe("in-place");
    expect(derivePromptIndicator(inputs({ disposition: "backlogged" })).dimmed).toBe(true);
    expect(derivePromptIndicator(inputs({ disposition: "backlogged" })).placement).toBe("trailing");
  });
});

describe("prompt-state — the browser's own lane (PQ-3)", () => {
  it("walks SAVED → SENDING → ACCEPTED as the transport does", () => {
    expect(derivePromptState(inputs({ transport: "not-issued" }))).toBe("SAVED");
    expect(derivePromptState(inputs({ transport: "in-flight" }))).toBe("SENDING");
    expect(derivePromptState(inputs({ transport: "acked" }))).toBe("ACCEPTED");
  });

  it("orders the terminals: failed > retrying > cancelled > answered", () => {
    const all: PromptStateInputs = inputs({
      failed: true,
      retrying: true,
      cancelled: true,
      answered: true,
      pending: "running",
    });
    expect(derivePromptState(all)).toBe("FAILED");
    expect(derivePromptState({ ...all, failed: false })).toBe("RETRYING");
    expect(derivePromptState({ ...all, failed: false, retrying: false })).toBe("CANCELLED");
    expect(derivePromptState({ ...all, failed: false, retrying: false, cancelled: false })).toBe(
      "ANSWERED",
    );
  });

  it("a stopped prompt that left a transcript row still says 'stopped · not answered'", () => {
    const ind = derivePromptIndicator(inputs({ cancelled: true, answered: true }));
    expect(ind.state).toBe("CANCELLED");
    expect(ind.badge).toBe("stopped · not answered");
  });

  it("a terminal outranks a transport that never got anywhere", () => {
    expect(derivePromptState(inputs({ transport: "rejected", cancelled: true }))).toBe("CANCELLED");
    expect(derivePromptState(inputs({ transport: "not-issued", failed: true }))).toBe("FAILED");
  });
});
