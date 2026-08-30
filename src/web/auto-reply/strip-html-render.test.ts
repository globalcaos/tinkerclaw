import { describe, expect, it } from "vitest";
import { htmlFragmentToText, stripHtmlRenderBlocks } from "./strip-html-render.js";

describe("stripHtmlRenderBlocks", () => {
  // Shaped after the real 2026-08-30 WhatsApp reply that started
  // "🤖 Here. 🤖\n\n```html-render\n<div style=\"background:#241c14;…"
  const realShape = [
    "🤖 Here. 🤖",
    "",
    "```html-render",
    '<div style="background:#241c14;border-radius:12px;padding:14px">',
    "  <style>.x{color:#eee}</style>",
    "  <h3>🌿 Woke up</h3>",
    "  <p>Channel is live again.</p>",
    "  <ul><li>WhatsApp relinked</li><li>Monitor restarted</li></ul>",
    "</div>",
    "```",
  ].join("\n");

  it("removes the fence and every tag, keeping the words", () => {
    const out = stripHtmlRenderBlocks(realShape);
    expect(out).not.toContain("html-render");
    expect(out).not.toContain("<div");
    expect(out).not.toContain("<h3>");
    expect(out).not.toMatch(/<[a-z/][^>]*>/i);
    expect(out).toContain("🤖 Here. 🤖");
    expect(out).toContain("Woke up");
    expect(out).toContain("Channel is live again.");
    expect(out).toContain("WhatsApp relinked");
  });

  it("never leaks style or script CONTENT", () => {
    const out = stripHtmlRenderBlocks(realShape);
    expect(out).not.toContain("color:#eee");
    expect(out).not.toContain("background:#241c14");
    expect(stripHtmlRenderBlocks("```html-render\n<script>alert(1)</script>\n```")).not.toContain(
      "alert(1)",
    );
  });

  it("leaves ordinary text and normal code fences untouched", () => {
    const plain = "Just a sentence.";
    expect(stripHtmlRenderBlocks(plain)).toBe(plain);
    const code = "See this:\n\n```ts\nconst a = 1;\n```";
    expect(stripHtmlRenderBlocks(code)).toBe(code);
    // An <html> mention in prose is not a fence and must survive.
    const prose = "The <div> tag is block-level.";
    expect(stripHtmlRenderBlocks(prose)).toBe(prose);
  });

  it("handles several blocks and odd fence spacing", () => {
    const two = "a\n\n``` html-render \n<p>one</p>\n```\n\nb\n\n```HTML-RENDER\n<p>two</p>\n```";
    const out = stripHtmlRenderBlocks(two);
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).not.toContain("html-render");
    expect(out.toLowerCase()).not.toContain("<p>");
  });

  it("turns list items and breaks into readable lines", () => {
    const t = htmlFragmentToText("<ul><li>alpha</li><li>beta</li></ul><p>x<br>y</p>");
    expect(t).toContain("- alpha");
    expect(t).toContain("- beta");
    expect(t).toMatch(/x\ny/);
  });

  it("decodes the entities a card actually uses", () => {
    expect(htmlFragmentToText("<p>a &amp; b &lt;c&gt; &quot;d&quot; &nbsp;e</p>")).toBe(
      'a & b <c> "d"  e',
    );
  });

  it("drops a block that is pure markup without collapsing the message", () => {
    const out = stripHtmlRenderBlocks("Done.\n\n```html-render\n<div></div>\n```");
    expect(out).toBe("Done.");
  });
});
