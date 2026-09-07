/**
 * FORK 2026-08-30: ```html-render blocks must never reach WhatsApp.
 *
 * `html-render` is a TINKER-CHAT-ONLY convention — only tinker-ui parses that
 * fence (app.ts) and renders it as a card. Every other channel receives the raw
 * markup. On 2026-08-30 a woken Jarvis turn answered into WhatsApp with
 * "🤖 Here. 🤖\n\n```html-render\n<div style=\"background:#241c14…" and the reply
 * was unreadable.
 *
 * IDENTITY.md now gates the convention on the channel, but a prompt is advice,
 * not a guarantee — this is the enforcement ([[feedback_force_rules_in_code]]).
 *
 * DELIBERATE TWIN of src/web/auto-reply/strip-html-render.ts. This extension is
 * the path that actually runs for WhatsApp (dist/extensions/tinkerclaw-whatsapp/
 * on-message-*.js), and it must NOT import from src/ — see
 * `fix(boundary): route whatsapp ext off relative src/ imports` (10f6eb376f2).
 * The first fix for this bug patched the core copy only and shipped nothing:
 * `stripHtmlRenderBlocks` was absent from the whole dist tree while
 * `deliverWebReply` was present, under the extension. Keep both in step.
 *
 * The block is CONVERTED, not dropped: the closing summary usually carries the
 * gist of the answer, so throwing it away would lose information. Tags come off,
 * the text inside survives.
 */

const HTML_RENDER_FENCE = /```[ \t]*html-render[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi;

const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&amp;/gi, "&"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#0*39;|&apos;/gi, "'"],
  [/&mdash;/gi, "—"],
  [/&ndash;/gi, "–"],
];

/** Reduce an HTML fragment to readable plain text. */
export function htmlFragmentToText(html: string): string {
  let s = html;
  // Drop these wholesale — their CONTENT is not prose and must not leak.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Structural tags become line breaks so the card keeps its shape.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|h[1-6]|section|header|footer|article)\s*>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(td|th)\s*>/gi, "  ");
  // Everything else goes.
  s = s.replace(/<[^>]+>/g, "");
  for (const [re, to] of ENTITIES) {
    s = s.replace(re, to);
  }
  // Tidy: trailing spaces, runs of blank lines, outer whitespace.
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/**
 * Replace every ```html-render block with its plain-text equivalent.
 * Text with no such block is returned unchanged (same reference semantics as a
 * no-op replace), so this is safe to run on every outbound message.
 */
export function stripHtmlRenderBlocks(text: string): string {
  if (!text || !/```[ \t]*html-render/i.test(text)) {
    return text;
  }
  const out = text.replace(HTML_RENDER_FENCE, (_match, inner: string) => {
    const plain = htmlFragmentToText(String(inner ?? ""));
    return plain ? plain : "";
  });
  // Collapse the blank space a removed block can leave behind.
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
