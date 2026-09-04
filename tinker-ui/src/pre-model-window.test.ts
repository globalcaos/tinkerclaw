import { describe, expect, it } from "vitest";
import {
  clearPreModelFor,
  openPreModelWindow,
  preModelSinceFor,
  PRE_MODEL_MAX_MS,
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
// FORK 2026-09-03 (the architect: "the serraclaw tab is preparing context forever").
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
  it("closes on error — the SerraClaw case: 529 before any model was named", () => {
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
