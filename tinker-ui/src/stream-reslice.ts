// FORK 2026-08-05 (monotone stream reconciliation — the grok/qwen killer) — a PURE, DOM-free
// module in the style of sectioned-reply.ts / run-state.ts, so the law below is unit-testable in
// isolation and app.ts can stop hand-rolling it at the chat.final site.
//
// THE BUG THIS EXISTS TO KILL (app.ts, chat.final): every promoted streaming bubble had its text
// REPLACED in place with `finalText.slice(cur.segStart, segEnd)`. `segStart` was measured against
// the CUMULATIVE delta stream; `finalText` is the server's final envelope. Whenever the two
// diverge — a final shorter than the deltas, or a differently-shaped envelope — `segStart` lands
// past `finalText.length`, `slice` returns "", and a bubble the user just finished reading is
// BLANKED IN PLACE while still occupying its slot. app.ts documents the proven instance
// (2026-07-22): run B's 321-char error envelope re-sliced run A's temps with B's short finalText
// → empty bubbles, B's message never shown. grok/qwen hit the same divergence on EVERY
// multi-message turn: their final envelope carries only the LAST assistant message, so bubble #1
// was rewritten with the wrong text and #2/#3 became "" — then were reclassified as intermediates
// and folded into a collapsed group absent from the DOM. Earlier messages rewritten, later ones
// vanished. Exactly the report.
//
// ════════════════════════════════════ THE LAW ════════════════════════════════════
// A bubble's text may only GROW — never shrink, never be replaced by different text.
//
//   next = finalText.slice(segStart, nextBubble.segStart ?? finalText.length)
//   accepted ONLY if (next.length >= cur.length && next.startsWith(cur))
//   otherwise cur is KEPT, character for character.
//
// If the kept bubbles then fail to show the TAIL of finalText — the envelope carries content
// that is nowhere on screen — the unrepresented remainder is returned as `appendTail` for the
// caller to push as a NEW bubble. Divergence becomes an APPEND, never an overwrite: "carta a
// terra va a la guerra" — a card that touched the table is played. Rendered text is the table.
// ═════════════════════════════════════════════════════════════════════════════════
//
// Two consequences worth stating because they are exactly where the old code lied:
//   • NO output text is ever "" unless its input was "" — the blank-bubble crash is
//     unrepresentable by construction.
//   • appendTail never duplicates what is on screen: it is emitted only when finalText's tail is
//     genuinely invisible, and it is trimmed past the longest kept bubble that is a prefix of
//     finalText (a partially-streamed last message appends only its missing suffix).

export type ResliceResult = {
  /** One entry per input bubble, same order. Each is the input text verbatim or a
   *  startsWith-extension of it — never shorter, never different. */
  texts: string[];
  /** Content of finalText that no kept bubble shows. Push as a NEW bubble; never overwrite.
   *  Absent when every character the final wants shown is already on screen. */
  appendTail?: string;
};

export function resliceSegments(
  bubbles: { text: string; segStart: number }[],
  finalText: string,
): ResliceResult {
  const final = typeof finalText === "string" ? finalText : "";
  // Both slice bounds are CLAMPED into [0, final.length]: a raw negative index would make `slice`
  // count from the END of the string and silently accept garbage, and a start past the end is
  // exactly the divergence this module exists to survive.
  const clampStart = (s: number | undefined): number =>
    Math.min(Math.max(0, typeof s === "number" && Number.isFinite(s) ? s : 0), final.length);

  const texts: string[] = [];
  for (let i = 0; i < bubbles.length; i++) {
    const cur = bubbles[i]?.text ?? "";
    const start = clampStart(bubbles[i]?.segStart);
    const end =
      i + 1 < bubbles.length ? Math.max(start, clampStart(bubbles[i + 1]?.segStart)) : final.length;
    const next = final.slice(start, end);
    // THE LAW. (`startsWith` already implies the length test; both are kept because the pair IS
    // the specification, verbatim.)
    texts.push(next.length >= cur.length && next.startsWith(cur) ? next : cur);
  }

  if (!final) {
    return { texts };
  }

  // Is the TAIL of finalText visible? Two geometries count, and only these two:
  //  (a) some kept bubble's text is a SUFFIX of finalText — the final's ending is on screen
  //      verbatim. This is the normal accepted geometry (the last bubble's slice runs to
  //      finalText.length, so an accepted last bubble IS a suffix), and it is also what the
  //      fully-streamed grok/qwen shape looks like: the final IS the last bubble's text, so
  //      appending it again would duplicate the message right under itself.
  //  (b) some kept bubble shows finalText's remainder-from-its-own-start AND MORE —
  //      final.slice(segStart) is a non-empty PREFIX of the kept text. This is the truncation
  //      geometry (final SHORTER than the deltas): from that bubble's start the final has
  //      nothing to say that the bubble does not already show, so nothing is missing and
  //      appending would duplicate. The remainder must be non-empty: an overflowed segStart
  //      yields "" which is a prefix of everything and proves nothing.
  for (let i = 0; i < texts.length; i++) {
    const kept = texts[i] ?? "";
    if (!kept) {
      continue;
    }
    if (final.endsWith(kept)) {
      return { texts };
    }
    const rem = final.slice(clampStart(bubbles[i]?.segStart));
    if (rem.length > 0 && kept.startsWith(rem)) {
      return { texts };
    }
  }

  // Unrepresented: finalText's tail is nowhere on screen — the 321-char envelope whose message
  // was never shown, or the content a divergent final carries beyond what streamed. Append ONLY
  // what is missing: the longest kept text that is a PREFIX of finalText is already visible, so
  // the remainder after it is the debt. When nothing overlaps, the debt is the whole finalText —
  // run B's never-shown message, finally delivered.
  let shownPrefix = 0;
  for (const kept of texts) {
    if (kept && kept.length > shownPrefix && final.startsWith(kept)) {
      shownPrefix = kept.length;
    }
  }
  const tail = final.slice(shownPrefix);
  return tail ? { texts, appendTail: tail } : { texts };
}
