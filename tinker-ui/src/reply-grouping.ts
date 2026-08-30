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

// FORK 2026-08-15 (the architect: "The turns now end up in a 'Reflection artifact verified' extra thinking
// … I have to expand the thinking to see the answer") — THE ASSUMPTION ABOVE EXPIRED.
//
// "The answer is the text after the last tool_result" held while every tool call in a run belonged
// to the main turn's work. It no longer does. The 🌿 FRACTAL section became TOOL-BACKED: the
// per-turn injection (app.ts buildInjectedPrompt) now demands "write the lesson or fix to disk NOW
// … instead of describing it", and the reflection then VERIFIES the write landed ("Reflection
// artifact verified — the note grew 5,938 → 7,417 B"). Both are real tool calls and both fire
// AFTER the answer has been written.
//
// So the answer became text BEFORE a tool, and this function dutifully demoted it. Two shapes,
// both observed live on 2026-08-15:
//   • trailing bubble exists → the answer hides inside "▸ Reasoning (N steps, M tool calls)" and
//     the reflection's own closing line is the only thing rendered as the reply;
//   • no trailing bubble → answerIndices comes out EMPTY, app.ts takes its flat branch, and the
//     whole answer renders as a bare grey "Thinking:" bubble with no group to expand at all.
//     (Measured: two identical SYNC-PROBE turns minutes apart — the one whose reflection wrote a
//     file rendered "Thinking: ACK …", the one whose reflection was clean rendered "ACK".)
//
// FIRST FIX (superseded, same day): detect the reflection by its 🌿 marker and stop counting tools
// past the last answer bubble ONLY in a run that carries one. the architect, hours later: "Some chats still
// show a short final message as the final answer and collapses the rest."
//
// It was racy by construction, and the race is in the FREEZE. app.ts stamps `_narration` at the
// first repaint where the run has no `_temporary` members left — which is main-turn end, BEFORE the
// reflection's bubble is appended. At that instant the run is the last one in the view, so there is
// no boundary message to look at, no 🌿 marker anywhere, and the answer is stamped as narration and
// FROZEN. The reflection arrives a moment later and reads an already-set stamp. Reload re-derives it
// correctly (`_narration` is not a CLIENT_ONLY_FLAG, so it does not survive `loadChat`) — which is
// why a fresh-load scan showed nothing and the tab the architect watched live showed the bug. "Some chats."
//
// So: DO NOT ASK WHETHER A REFLECTION IS THERE. Tools that fire after the last answer bubble never
// demote it, full stop. No marker, no lookahead, nothing that can be absent at freeze time.
//
// This is monotonically safe: the cutoff can only LOWER `lastToolIdx`, which can only SHRINK the
// narration set. It can reveal text, never hide it — the failure mode it removes has no inverse.
// The one behavioural delta is a run that ends on a tool with no closing text: its last text bubble
// now stays visible instead of everything collapsing and leaving the reply blank. That blank was
// never desirable; it is the same pathology, seen from the other side. Every pre-existing case is
// unchanged, guarded by test.
//
// THE KNOWN LIMIT ABOVE WAS NOT A CORNER — IT WAS THE COMMON CASE. the architect again: "Some chats still
// show a short final message as the final answer and collapses the rest."
//
// Replaying this classifier over the 45 most recently active sessions found it repeatedly. One run,
// measured end to end (`agent:main:tinker:msuxhsfq`, messages 173-176):
//
//   [173] text, 4898 chars  "Done — the SMA solar + battery is live in Home Assistant. **What you…"
//   [174] Write toolcall + result          ← the reflection writing its artifact
//   [175] Edit  toolcall + result          ← and indexing it
//   [176] text,   58 chars  "Memory written and indexed — both files confirmed on disk."
//
// There is NO 🌿 marker anywhere in that run — the model simply wrote prose. So the 58-char coda is
// the last answer text, the cutoff lands after it, the reflection's own tools count again, and 4,898
// characters of answer go into "▸ Reasoning" behind a one-line receipt.
//
// EVERY STRUCTURAL SIGNAL WAS CHECKED AGAINST THE REAL DATA AND NONE SEPARATES THEM:
//   • `stopReason` is exactly INVERTED — the 4,898-char answer is `tool_use` (the reflection's write
//     follows it) and the 58-char coda is `end_turn`. Keying on it would deepen the bug.
//   • `__openclaw` carries importedFrom/cliSessionId/externalId — identical on both; no lane, no
//     runId. `caller` is `{type:"direct"}` on every tool block.
//   • `usage.output` is per API turn, not per bubble: 173 and 174 share the same 2973.
//
// So the distinction is not encoded anywhere, and the only honest rule left is about size:
//
//   THE LARGEST TEXT BUBBLE IN A RUN IS THE ANSWER. NEVER COLLAPSE IT.
//
// It needs no marker, no metadata and no lookahead, so it cannot race the freeze and cannot drift
// when the injection's wording changes. Like the cutoff it can only ever SHRINK the narration set —
// it reveals, never hides. Where it is ambiguous (a long working-note bubble that happens to be the
// biggest thing in the run) it errs toward showing, which is the right way to be wrong: burying an
// answer is the reported harm, an extra visible paragraph is cosmetic.
//
// Ties are not protected, and a run whose lengths are all unknown behaves exactly as before.

/** Minimal per-message descriptor for one message in a run — enough to decide narration vs answer. */
export interface RunMsgKind {
  /** assistant message carrying real, user-facing answer text (NOT fractal, NOT a system/error bubble). */
  isAssistantText: boolean;
  /** message carries a tool_use or tool_result block (assistant tool call or user tool result). */
  hasTool: boolean;
  /**
   * Length of this bubble's user-facing text. Optional: when absent (or 0) for every bubble in the
   * run, the dominant-answer guard below simply does not engage and classification is unchanged.
   */
  textLen?: number;
}

/**
 * Index of the run's single largest text bubble — the one that is never narration. Returns -1 when
 * no length is known, or when the maximum is tied (nothing is unambiguously "the" answer).
 */
function dominantAnswerIdx(kinds: RunMsgKind[]): number {
  let best = -1;
  let bestLen = 0;
  let tied = false;
  for (let i = 0; i < kinds.length; i++) {
    const k = kinds[i];
    if (!k.isAssistantText) continue;
    const len = k.textLen ?? 0;
    if (len <= 0) continue;
    if (len > bestLen) {
      bestLen = len;
      best = i;
      tied = false;
    } else if (len === bestLen) {
      tied = true;
    }
  }
  return tied ? -1 : best;
}

/**
 * Run-relative indices of the assistant text bubbles that are between-tool NARRATION (collapse into
 * the Reasoning group). An assistant-text bubble is narration iff a tool occurs at a LATER index in
 * the run, counting only the tools that fire up to and including the last answer bubble. Returns []
 * when the run has no such tools (nothing collapses — the whole reply is the answer).
 */
export function narrationIndices(kinds: RunMsgKind[]): number[] {
  // Tools after the LAST answer bubble belong to whatever ran once the reply was written — today the
  // 🌿 FRACTAL reflection's own write-and-verify. They classify nothing. See the fork note above.
  let cutoff = kinds.length;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i].isAssistantText) {
      cutoff = i + 1;
    }
  }
  let lastToolIdx = -1;
  for (let i = 0; i < cutoff; i++) {
    if (kinds[i].hasTool) {
      lastToolIdx = i;
    }
  }
  if (lastToolIdx < 0) {
    return [];
  }
  const dominant = dominantAnswerIdx(kinds);
  const out: number[] = [];
  for (let i = 0; i < kinds.length; i++) {
    if (i === dominant) {
      continue; // the run's largest text bubble is the answer — never collapse it
    }
    if (kinds[i].isAssistantText && i < lastToolIdx) {
      out.push(i);
    }
  }
  return out;
}
