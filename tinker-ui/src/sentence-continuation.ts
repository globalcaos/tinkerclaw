// FORK 2026-08-25 (the architect: "I interrupted one turn with another query, then the
// intermediate thinking gets deleted in the chat").
//
// `mergeSentenceContinuations` in app.ts repairs a bubble that a stream split
// mid-sentence: it appends the fragment onto its predecessor and SPLICES THE
// BUBBLE OUT. That deletion is correct for a genuine fragment and catastrophic
// for anything else, and the old test for "is this a fragment?" looked only at
// the FIRST CHARACTER OF THE FRAGMENT:
//
//     isLower || /^[\d,;:.!?)}\]"'…–—-]/.test(trimmed)
//
// A leading DIGIT is not evidence of anything. Measured on two live transcripts
// on 2026-08-25 — 12 of 103 assistant texts in one chat, 3 of 99 in another —
// every one a complete sentence that merely opened with a number:
//   "488 species researched — 260 have PFAF monographs, 468 resolved in GBIF."
//   "746 live plants, 724 in stock. Let me read the full roster…"
//   "10/10 green. Now looking at the actual render…"
// Each was glued onto the preceding bubble and erased. The rendered DOM caught
// it verbatim: "…Waiting for it to finish before merging.488 species researched…"
//
// THE REAL SIGNAL LIVES IN THE PREDECESSOR. A stream split leaves the previous
// bubble ending mid-sentence; a new narration follows a bubble that already
// ended cleanly. So: merge only when the PREVIOUS text does not end at a
// sentence boundary. "…before merging." ends clean → never a continuation,
// whatever follows. "…746 live medicinal specie" + "s at €3,50" → a real split,
// still repaired.

/** True when `text` ends at a natural sentence boundary (so nothing that follows continues it). */
export function endsAtSentenceBoundary(text: string): boolean {
  // Trailing whitespace, then optional closing quotes/brackets, then the mark.
  const t = text.replace(/[\s)\]}"'”’»]*$/, "");
  if (!t) {
    // Whitespace-only / empty: nothing to continue. Treated as a boundary so an
    // empty predecessor never swallows the next bubble.
    return true;
  }
  // A markdown block (heading, list item, table row, fence) is structurally
  // complete even without terminal punctuation — the next bubble starts fresh.
  if (/(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|\||```)[^\n]*$/.test(t)) {
    return true;
  }
  return /[.!?:…]$/.test(t);
}

/**
 * Should `next` be merged back into `prev` as the tail of a split sentence?
 *
 * Both halves must agree: the predecessor has to look UNFINISHED, and the
 * fragment has to look like a continuation rather than a new sentence. Either
 * one alone is not enough — requiring only the second is the bug this module
 * exists to kill.
 */
export function isSentenceContinuation(prev: string, next: string): boolean {
  if (!prev || !next) {
    return false;
  }
  // The decisive half: a clean-ending predecessor is never continued.
  if (endsAtSentenceBoundary(prev)) {
    return false;
  }
  const trimmed = next.trimStart();
  const first = trimmed.charAt(0);
  if (!first) {
    return false;
  }
  // A fragment never opens a markdown block.
  if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|\|)/.test(trimmed)) {
    return false;
  }
  const isLower = first === first.toLowerCase() && first !== first.toUpperCase();
  // Continuation punctuation stays in the set; a bare leading digit does NOT —
  // "488 species researched…" is a sentence, not a tail. A digit only continues
  // a predecessor that was itself cut mid-number/mid-word, which the
  // boundary test above has already established.
  return isLower || /^[\d,;:)}\]…–—-]/.test(trimmed);
}

/**
 * Two bubbles may only be merged when they belong to the SAME run.
 *
 * The caller scans the trailing block of `_temporary` messages on the
 * assumption that they all belong to the current turn. Interrupting a turn with
 * a second prompt breaks that assumption — the queued prompt is deliberately
 * held OUT of `messages[]` until the turn ends, so two runs' live bubbles sit
 * adjacent with nothing between them, and the merge happily ate one run's
 * narration into the other's. An undefined runId on either side means "unknown
 * provenance": refuse rather than guess, because the failure mode is deletion.
 */
export function sameRun(prevRunId: unknown, nextRunId: unknown): boolean {
  if (typeof prevRunId !== "string" || typeof nextRunId !== "string") {
    return false;
  }
  return prevRunId === nextRunId;
}
