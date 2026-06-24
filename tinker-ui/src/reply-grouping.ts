// FORK 2026-06-19 (bug A — "bubbles compacted into a reasoning block; answer = only what follows the
// 💬 ANSWER mark"). Pure (DOM-free, global-free) decision extracted from app.ts so the run-grouping
// rule is unit-testable (app.ts is an un-testable browser entry).
//
// THE BUG: app.ts used to mark `assistantTextIndices.slice(0, -1)` as "thinking" — i.e. EVERY
// assistant text bubble in a run EXCEPT the last collapsed into the grey "Reasoning (N steps)" block,
// PURELY BY POSITION. The only thing that let an earlier bubble escape was the model emitting a literal
// "💬 ANSWER" marker. That marker is injected only transiently (and only when the fractal toggle is
// on), while "🌿 FRACTAL" is double-reinforced in the always-loaded system prompt — so the model
// reliably emits FRACTAL but intermittently DROPS 💬 ANSWER, and whenever it did, real answer content
// (a block-break / >5s-gap split, or text before a trailing bubble) got hidden inside "Reasoning".
//
// THE STRUCTURAL RULE (marker-free): an assistant text bubble is genuine between-tool NARRATION — and
// therefore collapses into the Reasoning group — IFF a tool call/result occurs at a LATER position in
// the same run. Text with no tool after it is part of the ANSWER and stays visible. With NO tools in
// the run, nothing collapses (real chain-of-thought already lives in the separate thinking channel).
// This matches the Anthropic/Claude-Code stream shape: the answer is the text after the last
// tool_result, narration is the text between tools.

/** Minimal per-message descriptor for one message in a run — enough to decide narration vs answer. */
export interface RunMsgKind {
  /** assistant message carrying real, user-facing answer text (NOT fractal, NOT a system/error bubble). */
  isAssistantText: boolean;
  /** message carries a tool_use or tool_result block (assistant tool call or user tool result). */
  hasTool: boolean;
}

/**
 * Run-relative indices of the assistant text bubbles that are between-tool NARRATION (collapse into
 * the Reasoning group). An assistant-text bubble is narration iff a tool occurs at a LATER index in
 * the run. Returns [] when the run has no tools (nothing collapses — the whole reply is the answer).
 */
export function narrationIndices(kinds: RunMsgKind[]): number[] {
  let lastToolIdx = -1;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i].hasTool) {
      lastToolIdx = i;
    }
  }
  if (lastToolIdx < 0) {
    return [];
  }
  const out: number[] = [];
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i].isAssistantText && i < lastToolIdx) {
      out.push(i);
    }
  }
  return out;
}
