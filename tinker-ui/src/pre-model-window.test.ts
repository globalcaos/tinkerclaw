import { describe, expect, it } from "vitest";
import {
  clearPreModelFor,
  gatewayReportIsFresh,
  gatewayReportsPreparing,
  openPreModelWindow,
  preModelReportDue,
  preModelSinceFor,
  PRE_MODEL_MAX_MS,
  PRE_MODEL_REPORT_FRESH_MS,
  PRE_MODEL_REPORT_LEAD_MS,
  PRE_MODEL_REPORT_REFRESH_MS,
  SENDING_STALE_MS,
  sendingLatchIsLive,
  sessionPending,
  terminalClosesPreModelWindow,
} from "./pre-model-window.js";

const NOW = 1_786_999_000_000;
const VIEWED = "agent:main:tinker:msok52zc";
const OTHER = "agent:main:tinker:msricppx";

// The real predicate from app.ts, inlined so these tests exercise the same matching semantics.
const matches = (candidate: string, ref: string): boolean =>
  candidate === ref || candidate.endsWith(":" + ref) || ref.endsWith(":" + candidate);

const win = () => new Map<string, number>();

describe("the pre-model window is a property of the SESSION, not of the viewed tab", () => {
  it("reports pending for a session that is not the one on screen", () => {
    // THE BUG, stated as a test: send in OTHER, then look at it from VIEWED. Before this module the
    // answer was reachable only for the active tab, so switching away blanked its glow.
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    expect(sessionPending(w, OTHER, NOW + 5_000, matches)).toBe(true);
    expect(sessionPending(w, VIEWED, NOW + 5_000, matches)).toBe(false);
  });

  it("keeps two sessions' windows independent", () => {
    const w = win();
    openPreModelWindow(w, VIEWED, NOW);
    openPreModelWindow(w, OTHER, NOW + 1_000);
    clearPreModelFor(w, VIEWED, matches);
    expect(sessionPending(w, VIEWED, NOW + 2_000, matches)).toBe(false);
    expect(sessionPending(w, OTHER, NOW + 2_000, matches)).toBe(true);
  });

  it("answers through the canonical/short key drift in both directions", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW); // stored canonical
    expect(sessionPending(w, "tinker:msricppx", NOW, matches)).toBe(true);
    const w2 = win();
    openPreModelWindow(w2, "tinker:msricppx", NOW); // stored short
    expect(sessionPending(w2, OTHER, NOW, matches)).toBe(true);
    expect(preModelSinceFor(w2, OTHER, matches)).toBe(NOW);
  });

  it("is not pending when nothing was ever opened", () => {
    expect(sessionPending(win(), OTHER, NOW, matches)).toBe(false);
    expect(sessionPending(win(), "", NOW, matches)).toBe(false);
  });
});

describe("it must never latch — every failure mode degrades to the glow STOPPING", () => {
  it("expires on its own if every closing proof is dropped", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    expect(sessionPending(w, OTHER, NOW + PRE_MODEL_MAX_MS, matches)).toBe(true);
    expect(sessionPending(w, OTHER, NOW + PRE_MODEL_MAX_MS + 1, matches)).toBe(false);
  });

  it("survives comfortably past the measured 21-36s window", () => {
    // The bound caps a LOST clear; it must not time out a merely slow gateway, or it reintroduces
    // the very blackout it exists to prevent (turn-latency.md measures 21-36s).
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    expect(sessionPending(w, OTHER, NOW + 36_000, matches)).toBe(true);
  });

  it("closes on any of the three independent proofs", () => {
    // Each proof is recorded for EVERY session above every viewed gate; any one suffices, because
    // this codebase has been observed to drop each of them at least once.
    for (const proof of ["lifecycle names a model", "chat delta", "terminal chat event"]) {
      const w = win();
      openPreModelWindow(w, OTHER, NOW);
      expect(clearPreModelFor(w, OTHER, matches), proof).toBe(true);
      expect(sessionPending(w, OTHER, NOW + 1_000, matches), proof).toBe(false);
    }
  });

  it("is idempotent and safe on junk input", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    expect(clearPreModelFor(w, OTHER, matches)).toBe(true);
    expect(clearPreModelFor(w, OTHER, matches)).toBe(false);
    expect(clearPreModelFor(w, undefined, matches)).toBe(false);
    expect(clearPreModelFor(w, "", matches)).toBe(false);
    openPreModelWindow(w, "", NOW);
    expect(w.size).toBe(0);
  });

  it("a re-send re-opens the window rather than extending the old one", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    openPreModelWindow(w, OTHER, NOW + 90_000);
    expect(preModelSinceFor(w, OTHER, matches)).toBe(NOW + 90_000);
    // The bound is measured from the LATEST send, so a second prompt gets its own full window.
    expect(sessionPending(w, OTHER, NOW + 90_000 + 60_000, matches)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FORK 2026-09-03 (the architect: "the work tab is preparing context forever").
//
// The VIEWED tab's twin of this window (`preparingSince` in app.ts) had no terminal-event
// terminator. It was cleared on disconnect, on the next send, and on send failure — never
// by the turn actually ending. A turn that ends BEFORE a model is named (an Anthropic 529
// overload is exactly that: the request never reaches a model, so neither a model-bearing
// `phase:start` nor an assistant delta ever arrives) left the pill counting forever.
//
// That is the precise latch this module's header forbids: "a dropped clear must degrade to
// 'the glow stops early', never to 'the glow never stops'." The background lane got three
// closing proofs; the viewed lane was left with two of them missing.
// ─────────────────────────────────────────────────────────────────────────────

describe("a terminal chat event closes the VIEWED pre-model window", () => {
  it("closes on error — the work-tab case: 529 before any model was named", () => {
    // THE BUG, stated as a test. Nothing else in the client would ever clear this window.
    expect(
      terminalClosesPreModelWindow({
        eventSessionKey: VIEWED,
        viewedSessionKey: VIEWED,
        state: "error",
        matches,
      }),
    ).toBe(true);
  });

  it("closes on aborted and on final too", () => {
    for (const state of ["aborted", "final"]) {
      expect(
        terminalClosesPreModelWindow({
          eventSessionKey: VIEWED,
          viewedSessionKey: VIEWED,
          state,
          matches,
        }),
        `state=${state}`,
      ).toBe(true);
    }
  });

  it("ignores a non-terminal event: a delta must not close the window from here", () => {
    // Deltas have their OWN close site (app.ts closes on first assistant text). Closing here
    // as well would be harmless but this predicate answers one question only.
    for (const state of ["delta", "start", undefined, null, 7]) {
      expect(
        terminalClosesPreModelWindow({
          eventSessionKey: VIEWED,
          viewedSessionKey: VIEWED,
          state,
          matches,
        }),
        `state=${String(state)}`,
      ).toBe(false);
    }
  });

  it("does NOT close the viewed window when ANOTHER session's turn ends", () => {
    // The regression this gate exists to prevent: a background tab finishing would otherwise
    // blank the window of a tab whose own prompt was accepted seconds ago — the 21-36s
    // pre-model window on every turn.
    expect(
      terminalClosesPreModelWindow({
        eventSessionKey: OTHER,
        viewedSessionKey: VIEWED,
        state: "error",
        matches,
      }),
    ).toBe(false);
  });

  it("matches through the canonical/short key drift, like every other reader here", () => {
    expect(
      terminalClosesPreModelWindow({
        eventSessionKey: "agent:main:tinker:msok52zc",
        viewedSessionKey: "tinker:msok52zc",
        state: "error",
        matches,
      }),
    ).toBe(true);
  });

  it("is safe on junk: no session key, no viewed key", () => {
    expect(
      terminalClosesPreModelWindow({
        eventSessionKey: undefined,
        viewedSessionKey: VIEWED,
        state: "error",
        matches,
      }),
    ).toBe(false);
    expect(
      terminalClosesPreModelWindow({
        eventSessionKey: VIEWED,
        viewedSessionKey: undefined,
        state: "error",
        matches,
      }),
    ).toBe(false);
    expect(
      terminalClosesPreModelWindow({
        eventSessionKey: "",
        viewedSessionKey: "",
        state: "error",
        matches,
      }),
    ).toBe(false);
  });
});

// ─── FORK 2026-09-04: the viewed lane's time bound ───────────────────────────
//
// The reported bug: "a few tabs like the amygdala get stuck 'preparing context' and never do
// anything." `sending` is persisted per tab and read by shouldQueue(), and it was the one lane in
// this area with no bound — so a turn that ended without a terminal event for its tab parked every
// later prompt typed into that tab for the life of the page.
describe("sendingLatchIsLive", () => {
  it("believes a latch opened just now", () => {
    expect(sendingLatchIsLive(NOW, NOW)).toBe(true);
  });

  it("believes a latch through the longest pre-model wait actually observed (~350s)", () => {
    // The bound must not cut off a turn that is genuinely still assembling its prompt; that would
    // trade this latch for a wrong answer on a real turn.
    expect(sendingLatchIsLive(NOW - 350_000, NOW)).toBe(true);
  });

  it("still believes it at the bound", () => {
    expect(sendingLatchIsLive(NOW - SENDING_STALE_MS, NOW)).toBe(true);
  });

  it("stops believing it one millisecond past the bound", () => {
    expect(sendingLatchIsLive(NOW - SENDING_STALE_MS - 1, NOW)).toBe(false);
  });

  it("is comfortably looser than the per-session window, which answers a different question", () => {
    expect(SENDING_STALE_MS).toBeGreaterThan(PRE_MODEL_MAX_MS);
  });

  it("reads a MISSING stamp as expired, which is what heals an already-stuck tab", () => {
    // A TabState saved before `sendingSince` existed carries `sending: true` and no age. Reading
    // that as live would preserve the exact latch this fix removes.
    expect(sendingLatchIsLive(null, NOW)).toBe(false);
    expect(sendingLatchIsLive(undefined, NOW)).toBe(false);
    expect(sendingLatchIsLive(Number.NaN, NOW)).toBe(false);
  });

  it("degrades to 'stops early', never to 'never stops' — a day-old latch is dead", () => {
    expect(sendingLatchIsLive(NOW - 86_400_000, NOW)).toBe(false);
  });
});

// The consequence the architect actually saw: the queue gate. Reproduced with the real predicate
// rather than asserted in prose, because "never do anything" IS shouldQueue returning true forever.
describe("the stuck-tab shape, end to end", () => {
  // Mirrors queued-sends.ts shouldQueue with the terms app.ts passes it.
  const wouldQueue = (state: {
    hasFreshActiveRunForSession: boolean;
    streamRunId: string | null;
    sending: boolean;
  }): boolean => state.hasFreshActiveRunForSession || state.streamRunId != null || state.sending;

  const strandedTab = { hasFreshActiveRunForSession: false, streamRunId: null };

  it("parked every prompt while `sending` was passed raw", () => {
    // The run aged out of activeRuns hours ago and the cursor was reset, but the flag survived.
    expect(wouldQueue({ ...strandedTab, sending: true })).toBe(true);
  });

  it("sends immediately once the latch is read through its bound", () => {
    const staleSince = NOW - SENDING_STALE_MS - 1;
    expect(wouldQueue({ ...strandedTab, sending: sendingLatchIsLive(staleSince, NOW) })).toBe(
      false,
    );
  });

  it("still queues behind a send that is genuinely in flight", () => {
    expect(wouldQueue({ ...strandedTab, sending: sendingLatchIsLive(NOW - 2_000, NOW) })).toBe(
      true,
    );
  });
});

// ─── FORK 2026-09-24: prompt-queue.md §7 step U6 — the gateway's word outranks the UI's clock ───
//
// Contradiction C9, the pill half. Pre-model waits of 21-49 min were measured live on 2026-09-23,
// and the UI stopped believing every one of them at 120 s: the tab went dark on a turn the gateway
// was still preparing. Since gateway step G5 each `sessions.list` row carries `pendingPrompts`, and
// a `preparing` entry is the gateway saying, as a fact, that the window is still open.
describe("U6: a fresh gateway `preparing` report outlives PRE_MODEL_MAX_MS", () => {
  const MINUTE_5 = NOW + 5 * 60_000;
  const row = (key: string, pendingPrompts?: unknown) =>
    pendingPrompts === undefined ? { key } : { key, pendingPrompts };
  const preparing = [{ key: "prompt-1", state: "preparing", since: NOW }];
  /** The rows as fetched `ago` ms before `at` (default 10 s: a fresh fetch). */
  const fetched = (rows: unknown[], at: number, ago = 10_000) => ({ rows, fetchedAt: at - ago });

  it("a pending turn still glows at minute 5 when the snapshot says `preparing`", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    const report = fetched([row(VIEWED), row(OTHER, preparing)], MINUTE_5);
    expect(sessionPending(w, OTHER, MINUTE_5, matches, report)).toBe(true);
  });

  it("CONTROL: with no report, or an old gateway's row, it is dark after 120 s as before U6", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    const justPast = NOW + PRE_MODEL_MAX_MS + 1;
    const oldAtJustPast = fetched([row(OTHER)], justPast);
    const oldAtMinute5 = fetched([row(OTHER)], MINUTE_5);
    expect(sessionPending(w, OTHER, justPast, matches, oldAtJustPast)).toBe(false);
    expect(sessionPending(w, OTHER, MINUTE_5, matches, oldAtMinute5)).toBe(false);
    expect(sessionPending(w, OTHER, MINUTE_5, matches)).toBe(false);
    expect(sessionPending(w, OTHER, MINUTE_5, matches, null)).toBe(false);
  });

  it("a STALE report is not believed, so a refresh that stops arriving ends the glow", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    const rows = [row(OTHER, preparing)];
    const atBound = fetched(rows, MINUTE_5, PRE_MODEL_REPORT_FRESH_MS);
    const pastBound = fetched(rows, MINUTE_5, PRE_MODEL_REPORT_FRESH_MS + 1);
    expect(sessionPending(w, OTHER, MINUTE_5, matches, atBound)).toBe(true);
    expect(sessionPending(w, OTHER, MINUTE_5, matches, pastBound)).toBe(false);
  });

  it("trusts only `preparing`: behind, steered and running do not lift the bound", () => {
    for (const state of ["behind", "steered", "running"]) {
      const w = win();
      openPreModelWindow(w, OTHER, NOW);
      const report = fetched([row(OTHER, [{ key: "prompt-1", state, since: NOW }])], MINUTE_5);
      expect(sessionPending(w, OTHER, MINUTE_5, matches, report), state).toBe(false);
    }
  });

  it("never OPENS a window: a report with no window of this page's own lights nothing", () => {
    // A rail snapshot restored from localStorage can carry a `preparing` row from another page.
    const report = fetched([row(OTHER, preparing)], MINUTE_5);
    expect(sessionPending(win(), OTHER, MINUTE_5, matches, report)).toBe(false);
  });

  it("any closing proof still closes a window the report is holding open", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    const report = fetched([row(OTHER, preparing)], MINUTE_5);
    expect(sessionPending(w, OTHER, MINUTE_5, matches, report)).toBe(true);
    clearPreModelFor(w, OTHER, matches);
    expect(sessionPending(w, OTHER, MINUTE_5, matches, report)).toBe(false);
  });

  it("reads THIS session's row only, through the canonical/short key drift", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    const elsewhere = fetched([row(VIEWED, preparing)], MINUTE_5);
    const shortKey = fetched([row("tinker:msricppx", preparing)], MINUTE_5);
    expect(sessionPending(w, OTHER, MINUTE_5, matches, elsewhere)).toBe(false);
    expect(sessionPending(w, OTHER, MINUTE_5, matches, shortKey)).toBe(true);
  });
});

describe("gatewayReportsPreparing / gatewayReportIsFresh", () => {
  const preparingRow = (key: string) => ({
    key,
    pendingPrompts: [{ key: "p", state: "preparing", since: NOW }],
  });

  it("prefers the exact-key row over a drift match", () => {
    const rows = [preparingRow("tinker:msricppx"), { key: OTHER }];
    expect(gatewayReportsPreparing(rows, OTHER, matches)).toBe(false);
    expect(gatewayReportsPreparing(rows.slice(0, 1), OTHER, matches)).toBe(true);
  });

  it("is false on junk, never a throw", () => {
    const junk: Array<readonly unknown[] | null | undefined> = [
      undefined,
      null,
      [],
      [null, 7, "x", {}],
      [{ key: OTHER, pendingPrompts: "preparing" }],
      [{ key: OTHER, pendingPrompts: [null, 7, { state: 1 }] }],
    ];
    for (const rows of junk) {
      expect(gatewayReportsPreparing(rows, OTHER, matches)).toBe(false);
    }
    expect(gatewayReportsPreparing([preparingRow(OTHER)], "", matches)).toBe(false);
  });

  it("a report is fresh from its fetch up to PRE_MODEL_REPORT_FRESH_MS, never from the future", () => {
    const rows: unknown[] = [];
    const oldest = NOW - PRE_MODEL_REPORT_FRESH_MS;
    expect(gatewayReportIsFresh({ rows, fetchedAt: NOW }, NOW)).toBe(true);
    expect(gatewayReportIsFresh({ rows, fetchedAt: oldest }, NOW)).toBe(true);
    expect(gatewayReportIsFresh({ rows, fetchedAt: oldest - 1 }, NOW)).toBe(false);
    expect(gatewayReportIsFresh({ rows, fetchedAt: NOW + 1 }, NOW)).toBe(false);
    expect(gatewayReportIsFresh({ rows, fetchedAt: Number.NaN }, NOW)).toBe(false);
    expect(gatewayReportIsFresh({ rows, fetchedAt: 0 }, NOW)).toBe(false);
    expect(gatewayReportIsFresh(null, NOW)).toBe(false);
  });
});

describe("preModelReportDue — when app.ts re-asks sessions.list (U6)", () => {
  const never = () => false;
  const always = () => true;
  const LONG_AGO = NOW - 10 * PRE_MODEL_REPORT_REFRESH_MS;

  it("never asks during a normal 21-36 s window, or with no window at all", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    expect(preModelReportDue(w, NOW + 36_000, LONG_AGO, always)).toBe(false);
    expect(preModelReportDue(win(), NOW, LONG_AGO, always)).toBe(false);
  });

  it("asks just before the bound, so a report is in hand when it passes", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    const leadIn = NOW + PRE_MODEL_MAX_MS - PRE_MODEL_REPORT_LEAD_MS;
    expect(preModelReportDue(w, leadIn - 1, LONG_AGO, never)).toBe(false);
    expect(preModelReportDue(w, leadIn, LONG_AGO, never)).toBe(true);
  });

  it("asks at most once per PRE_MODEL_REPORT_REFRESH_MS", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    const at = NOW + 5 * 60_000;
    expect(preModelReportDue(w, at, at - PRE_MODEL_REPORT_REFRESH_MS + 1, always)).toBe(false);
    expect(preModelReportDue(w, at, at - PRE_MODEL_REPORT_REFRESH_MS, always)).toBe(true);
  });

  it("past the bound it asks only while the window is still believed, so it cannot poll forever", () => {
    const w = win();
    openPreModelWindow(w, OTHER, NOW);
    const at = NOW + 5 * 60_000;
    expect(preModelReportDue(w, at, LONG_AGO, always)).toBe(true);
    expect(preModelReportDue(w, at, LONG_AGO, never)).toBe(false);
  });

  it("two refresh periods fit inside the fresh bound, and the lead sits inside the time bound", () => {
    expect(PRE_MODEL_REPORT_FRESH_MS).toBeGreaterThan(2 * PRE_MODEL_REPORT_REFRESH_MS);
    expect(PRE_MODEL_REPORT_LEAD_MS).toBeLessThan(PRE_MODEL_MAX_MS);
  });
});
