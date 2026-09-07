// FORK 2026-09-06 (duprep III — the live-stream duplicate) — a PURE, DOM-free module in the style
// of stream-reslice.ts, so the law below is unit-testable in isolation and app.ts only APPLIES the
// result.
//
// THE BUG THIS EXISTS TO KILL. The user: "Jarvis just handed me a duplicated answer again. If I
// refresh it goes away." That last sentence is the whole diagnosis — chat.history holds ONE copy,
// so the second copy exists only in the live DOM.
//
// The chat delta payload carries the SERVER-CUMULATIVE assistant buffer, and each streaming bubble
// slices it at its own `_segmentStart`. The gateway RE-BASES that buffer two ways
// (src/gateway/live-chat-projector.ts): a RESET, when the incoming snapshot neither extends nor is
// a stale prefix of the buffer, and a CAP, when the buffer passes MAX_LIVE_CHAT_BUFFER_CHARS and is
// silently tail-sliced. Either way every `_segmentStart` the client holds becomes an offset into a
// coordinate space that no longer exists.
//
// Since 2026-08-05 the gateway announces this: it sets `replace: true` on the delta and its comment
// states the contract — "Clients must drop the cursors and bubbles they hold for this run and
// re-render from this text instead of appending — otherwise they slice new text at stale offsets
// and the answer appears twice." The producer shipped. The consumer never did: app.ts had zero
// references to the field. Instead it fell through to its monotone guard, saw a slice that did not
// extend what was on screen, and PUSHED A SECOND BUBBLE holding the whole re-based buffer — the
// duplicate, exactly as the server predicted.
//
// ════════════════════════════════════ THE LAW ════════════════════════════════════
// RE-ANCHOR, NEVER RE-RENDER.
//
// The server's literal instruction — "re-render from this text" — is not available to us: on a CAP
// the re-based buffer has LOST ITS HEAD, so rendering from it would delete text the user has
// already read. That is the precise harm stream-reslice.ts's monotone law exists to prevent.
//
// So this module never decides to delete anything. It answers one question only:
//
//     where does each thing already on screen live in the NEW buffer?
//
// Callers rewrite `_segmentStart` from the answer and let bubbles GROW in place. Nothing on screen
// is removed. "Carta a terra va a la guerra" — a card that touched the table is played.
// ═════════════════════════════════════════════════════════════════════════════════

export type RebaseAnchors = {
  /** Per input bubble, in order: its offset in `buffer`, or null when the buffer no longer shows
   *  it (the server superseded that text, or a CAP dropped it off the head). */
  starts: (number | null)[];
  /** Per input bubble: the forward cursor at the moment that bubble was reached.
   *
   *  Park an unanchored bubble's `_segmentStart` HERE — never past the end. stream-reslice.ts:63
   *  derives bubble i's END bound from bubbles[i+1].segStart, so parking past every later start
   *  collapses the PRECEDING bubble's envelope and hands it the whole remainder to grow into. */
  parks: number[];
  /** Offset just past everything the buffer still shows. A NEW bubble must start HERE, so it can
   *  only ever carry text that nothing on screen already shows. 0 when nothing was found. */
  scan: number;
};

/**
 * Locate each on-screen bubble's text inside a re-based cumulative buffer.
 *
 * FORWARD-ONLY by construction: each search starts at the running cursor, so render order is
 * preserved and a repeated sentence can never anchor backwards into a region an earlier bubble
 * already claims. That is what stops the "answer appears twice" from re-appearing as
 * "answer appears twice, in the wrong order".
 */
export function rebaseAnchors(shown: readonly string[], buffer: string): RebaseAnchors {
  const starts: (number | null)[] = [];
  const parks: number[] = [];
  let scan = 0;
  for (const text of shown) {
    parks.push(scan);
    if (!text) {
      // An empty bubble anchors nowhere but must still park at the cursor: giving it a stale
      // offset would reorder the envelopes of its neighbours.
      starts.push(null);
      continue;
    }
    const at = buffer.indexOf(text, scan);
    if (at < 0) {
      starts.push(null);
      continue;
    }
    starts.push(at);
    scan = at + text.length;
  }
  return { starts, parks, scan };
}

/**
 * Did this re-base drop text off the HEAD rather than replace the body?
 *
 * A CAP tail-slices the buffer, so the new buffer is a strict SUFFIX of the previous one. A RESET
 * is not. The distinction matters because a caller may safely absorb a leading span into the first
 * anchored bubble on a RESET (it is genuinely new content the buffer carries above what is shown),
 * but on a CAP that leading span is dropped HISTORY — absorbing it would re-show text the bubble
 * above already displays.
 *
 * Requires the previous buffer verbatim, which is why app.ts keeps `lastDeltaText` and not merely
 * `lastDeltaLen`.
 */
export function isCapRebase(prevBuffer: string, buffer: string): boolean {
  return prevBuffer.length > buffer.length && prevBuffer.endsWith(buffer);
}
