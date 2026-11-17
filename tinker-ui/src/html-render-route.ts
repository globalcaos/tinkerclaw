// Which path a ```html-render block takes in the chat. Inline = DOMPurify-sanitized HTML
// (no reload flicker); frame = sandboxed iframe. DOMPurify keeps no <script> and drops a
// <style> block, so a block carrying either must render in the frame or it arrives
// unstyled (2026-10-12: the owner saw such a block still unstyled, hover effects missing).
export function htmlRenderNeedsFrame(raw: string): boolean {
  return /<(script|style)[\s>]/i.test(raw);
}

// What the page really drew, for the snapshot sidecar: a card can sit in the DOM with no height (a closed
// fold, a clipped parent), or stay as source when its fence was cut. The text alone proves neither.
export function htmlCardCensus(root: Pick<ParentNode, "querySelectorAll">): {
  cards: number;
  zeroHeight: number;
  rawFences: number;
} {
  const cards = [...root.querySelectorAll(".chat-html-inline, iframe.chat-html-frame")];
  return {
    cards: cards.length,
    zeroHeight: cards.filter((c) => c.getBoundingClientRect().height < 1).length,
    rawFences: root.querySelectorAll("code.language-html-render").length,
  };
}
