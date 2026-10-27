// FORK 2026-07-27 (the architect: "instrument the compaction predicate and confirm the root cause")
//
// WHY THIS EXISTS. Compaction was measured firing at a median 5.53% of the 1M window while
// the nominal threshold is ~98%, and 78% of compactions hang for 9 minutes and are then
// discarded. Every attempt to root-cause it stalled on the same wall: **zero compaction
// token diagnostics reach the journal**. Greps for tokensBefore / promptBudget /
// overflowTokens / estimatedPromptTokens / preemptive all return nothing, so there is no
// way to tell WHICH of the deciders fired, or on what number, without guessing.
//
// There are FOUR independent deciders and they do NOT share an input:
//   1. run/preemptive-compaction.ts  — estimatePrePromptTokens() over the real messages
//                                       (a genuine live-context char estimate)
//   2. memory-flush.ts shouldRunPreflightCompaction — SessionEntry.totalTokens, which on
//                                       the embedded path is the TURN AGGREGATE (measured
//                                       9,380,101 with fresh:true on a 1,000,000 window)
//   3. tool-result-context-guard.ts   — a chars/token estimate ×2 that also counts
//                                       toolResult.details, which are stripped before send
//   4. pi's OWN AgentSession._checkCompaction — gate "pi-auto". THIS IS THE ONE THAT FIRES.
//      (node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js:1375-1445)
//
// FORK 2026-07-27 — why decider #4 stayed invisible. We only ever instrumented OUR three
// gates, and all three turned out to be honest: that is precisely why no
// `[compaction-diag] fires=true` line ever reached the journal. pi's own auto-compaction
// is still LIVE on this path because applyPiAutoCompactionGuard (src/agents/pi-settings.ts)
// disables it only when the context engine reports ownsCompaction:true, and
// LegacyContextEngine (src/context-engine/legacy.ts) does not. So pi decides, on ITS
// number, and we never saw the number.
//
// #4 cannot be instrumented at its own predicate without patching node_modules, so it is
// instrumented at the only place pi hands us the figures: the `compaction_end` event, which
// carries { reason: "overflow" | "threshold", result: { tokensBefore, tokensAfter } }.
// Deliberately NOT at `compaction_start` — by then pi has already popped the triggering
// assistant message off agent.state.messages (the messages.slice(0, -1) in the overflow
// branch of _checkCompaction) and our own clearStaleAssistantUsageOnSessionMessages zeroes
// assistant usage in place, so any reconstruction there prints tokens=0 and would read as
// REFUTING the very hypothesis this diagnostic exists to prove.
//
// One line per decision, per turn. Bounded by turns, not tokens.
import { recordCompactionOutcome } from "../infra/algorithm-metrics.js";
import { declareInstrument, noteInstrumentFired } from "../infra/instrument-liveness.js";
import { log } from "./embedded-agent-runner/logger.js";

// FORK 2026-07-28 — all four deciders declare themselves HERE, at the shared owner, so a gate
// that never evaluates is visible as `neverFired` rather than as silence. This file already
// documents why that matters: for weeks three gates were instrumented and honest while a
// FOURTH, uninstrumented one did all the firing. "We saw no lines" was itself the finding.
declareInstrument({
  id: "compaction-gate:preemptive",
  kind: "gate",
  description:
    "pre-prompt budget gate — char estimate over real messages + system prompt + tool schemas",
});
declareInstrument({
  id: "compaction-gate:preflight/memory-flush",
  kind: "gate",
  description: "memory-flush preflight gate on SessionEntry.totalTokens",
});
declareInstrument({
  id: "compaction-gate:tool-loop-guard",
  kind: "gate",
  description: "mid-tool-loop overflow guard — raw char estimate vs window",
});
declareInstrument({
  id: "compaction-gate:pi-auto",
  kind: "gate",
  description:
    "the agent framework's OWN decider (disabled by us when an extension owns compaction)",
  // Since 4be81d5684d we deliberately switch this off, so silence is the DESIRED state. It
  // stays declared because a line reappearing here means the guard regressed.
  conditional: "intentionally disabled while one of our extensions owns compaction",
});

export interface CompactionDecision {
  /**
   * Which decider produced this. Keep the names stable — they are grepped, by hand and by
   * monitors. "pi-auto" is pi's own AgentSession._checkCompaction, observed via compaction_end.
   */
  gate: "preemptive" | "preflight/memory-flush" | "tool-loop-guard" | "pi-auto";
  /** The number the gate compared. */
  tokens: number;
  /** What it compared against. */
  threshold: number;
  /** The model's context window, for a fill ratio. */
  contextWindow?: number;
  /** Where `tokens` came from — the field name, so a poisoned source is visible. */
  source: string;
  /** Whether this evaluation actually triggers compaction. */
  fires: boolean;
  sessionKey?: string;
  model?: string;
}

/**
 * Emit one compaction-decision line. Never throws into the serving path.
 *
 * The fill ratio is the payload: a gate firing at 5% of the window is reading the wrong
 * number, and a gate firing at 95% is working as designed. That single figure is what was
 * missing.
 */
export function logCompactionDecision(d: CompactionDecision): void {
  try {
    const win = d.contextWindow && d.contextWindow > 0 ? d.contextWindow : undefined;
    const fillPct = win ? ((d.tokens / win) * 100).toFixed(1) + "%" : "n/a";
    const overWindow = win ? d.tokens > win : false;

    // FORK 2026-07-28 — liveness + effectiveness ledger.
    noteInstrumentFired(`compaction-gate:${d.gate}`, `fires=${d.fires} fill=${fillPct}`);
    // `overWindow` is the load-bearing signal for the papers: a gate comparing a number LARGER
    // than the whole window is definitionally reading an accumulator, not a context size. We
    // record the parts (tokens + window) and the provenance, never the ratio, so an analysis
    // can recompute the fill AND check the denominator — the check whose absence produced the
    // 6,448,106-on-1,000,000 reading.
    recordCompactionOutcome({
      variant: d.gate,
      outcome: d.fires ? "fired" : "skipped",
      contextTokens: d.tokens,
      contextTokensSource: overWindow ? "turn-aggregate" : "estimated",
      windowTokens: win,
      sessionKey: d.sessionKey,
      model: d.model,
      note: `source=${d.source}${overWindow ? " OVER_WINDOW(implausible-as-context)" : ""}`,
    });
    log.info(
      `[compaction-diag] gate=${d.gate} fires=${d.fires} tokens=${d.tokens} ` +
        `threshold=${d.threshold} window=${win ?? "unknown"} fill=${fillPct} ` +
        `overWindow=${overWindow} source=${d.source}` +
        (d.sessionKey ? ` sessionKey=${d.sessionKey}` : "") +
        (d.model ? ` model=${d.model}` : ""),
    );
  } catch {
    /* diagnostics must never disturb the path they observe */
  }
}
