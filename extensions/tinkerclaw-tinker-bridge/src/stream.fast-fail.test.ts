import { describe, expect, it } from "vitest";
import { FAST_FAIL_INIT_SILENT_MS, FAST_FAIL_MAX_INIT_LINES } from "./defaults.js";
import { shouldFastFailInitStall } from "./stream.js";

// FORK 2026-06-23 (BRIDGE FIX 2/3 — fast-fail init-only stall): exercise the
// watchdog decision predicate directly. The predicate is the load-bearing gate
// the stream watchdog uses to SIGTERM an init-wedged turn early instead of
// burning the full DEFAULT_REQUEST_TIMEOUT_MS. The two scenarios the unit
// requires are modeled as predicate calls (no real claude-cli worker spawned):
//   1. a worker that emitted 2 init lines then went silent IS aborted once
//      elapsed crosses the init-silent window;
//   2. a worker that emitted MANY lines with text.len=0 (heavy tool turn) is
//      NEVER aborted — the linesSeen gate protects it.

const PAST = FAST_FAIL_INIT_SILENT_MS + 1_000; // safely past the threshold
const WITHIN = FAST_FAIL_INIT_SILENT_MS - 1_000; // still inside the window

describe("shouldFastFailInitStall (BRIDGE FIX 2/3: init-only stall fast-fail)", () => {
  it("aborts a turn that emitted a couple init lines then went silent", () => {
    // 2 init lines, no text, no thinking, well past the silent window.
    expect(
      shouldFastFailInitStall({ elapsedMs: PAST, textLen: 0, thinkingLen: 0, linesSeen: 2 }),
    ).toBe(true);
  });

  it("does NOT abort a heavy tool turn that streams MANY lines with text.len=0", () => {
    // The critical non-regression: lots of stream lines (tool work) but no
    // visible text/thinking yet — must NOT be fast-failed.
    expect(
      shouldFastFailInitStall({
        elapsedMs: PAST,
        textLen: 0,
        thinkingLen: 0,
        linesSeen: FAST_FAIL_MAX_INIT_LINES + 50,
      }),
    ).toBe(false);
  });

  it("does NOT abort before the init-silent window elapses", () => {
    expect(
      shouldFastFailInitStall({ elapsedMs: WITHIN, textLen: 0, thinkingLen: 0, linesSeen: 2 }),
    ).toBe(false);
  });

  it("does NOT abort once any visible text has been produced", () => {
    expect(
      shouldFastFailInitStall({ elapsedMs: PAST, textLen: 12, thinkingLen: 0, linesSeen: 2 }),
    ).toBe(false);
  });

  it("does NOT abort once any thinking has been produced", () => {
    expect(
      shouldFastFailInitStall({ elapsedMs: PAST, textLen: 0, thinkingLen: 34, linesSeen: 2 }),
    ).toBe(false);
  });

  it("fires exactly at the line budget boundary and never above it", () => {
    expect(
      shouldFastFailInitStall({
        elapsedMs: PAST,
        textLen: 0,
        thinkingLen: 0,
        linesSeen: FAST_FAIL_MAX_INIT_LINES,
      }),
    ).toBe(true);
    expect(
      shouldFastFailInitStall({
        elapsedMs: PAST,
        textLen: 0,
        thinkingLen: 0,
        linesSeen: FAST_FAIL_MAX_INIT_LINES + 1,
      }),
    ).toBe(false);
  });

  it("honors caller-supplied overrides for window and line budget", () => {
    expect(
      shouldFastFailInitStall({
        elapsedMs: 5_000,
        textLen: 0,
        thinkingLen: 0,
        linesSeen: 1,
        initSilentMs: 4_000,
        maxInitLines: 2,
      }),
    ).toBe(true);
  });
});
