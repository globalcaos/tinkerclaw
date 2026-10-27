// Which path a ```html-render block takes in the chat. Inline = DOMPurify-sanitized HTML
// (no reload flicker); frame = sandboxed iframe. DOMPurify keeps no <script> and drops a
// <style> block, so a block carrying either must render in the frame or it arrives
// unstyled (2026-10-12, owner: "still not html-pretty with mouseover").
export function htmlRenderNeedsFrame(raw: string): boolean {
  return /<(script|style)[\s>]/i.test(raw);
}
