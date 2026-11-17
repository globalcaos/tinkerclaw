// FORK 2026-11-04 — a ```html-render card cut across two bubbles.
//
// Every writer that splits a run's text into bubbles splits at a character offset: the live text
// stream when a thought, a tool or a stop check closes the open segment, the thinking stream the
// same way, and a final when it reslices. None of them reads markdown, so the cut can fall inside an
// open card. `md()` needs both fences in one string, so the first half then renders as escaped
// source and the second half's closing fence opens a NEW code block that swallows whatever follows
// (seen live: the second answer after a stop-check send-back drawn as code under `</div></div>`).
//
// The rule every writer applies: a bubble never ends inside an open card. The text up to and
// including the closing fence belongs to the bubble that opened the card; only what follows the
// fence may start a new bubble. Text moves up, never down, and nothing is lost.

const CARD_OPEN = "```html-render";

/** True when `text` opens a ```html-render card that it does not close. */
export function endsInsideCard(text: string): boolean {
  const open = text.lastIndexOf(CARD_OPEN);
  return open >= 0 && text.indexOf("```", open + 3) < 0;
}

/**
 * How many leading characters of `next` belong to the card `prev` left open: up to and including
 * its closing fence, or all of `next` while the fence has not arrived yet. 0 when `prev` ends
 * outside a card.
 */
export function cardCarryLength(prev: string, next: string): number {
  if (!endsInsideCard(prev)) {
    return 0;
  }
  const close = next.indexOf("```");
  return close < 0 ? next.length : close + 3;
}
