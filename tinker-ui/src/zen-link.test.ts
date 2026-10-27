import { describe, expect, it } from "vitest";
import { parseZenLink, zenTabHint, zenTitleHtml, ZEN_ICON_PATHS } from "./zen-link.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

describe("parseZenLink", () => {
  it("returns the linked session key", () => {
    expect(parseZenLink({ ok: true, session: "agent:main:main" })).toBe("agent:main:main");
  });

  it("reads anything malformed as no link", () => {
    for (const raw of [
      null,
      undefined,
      3,
      "agent:main:main",
      {},
      { session: 7 },
      { session: "  " },
    ]) {
      expect(parseZenLink(raw)).toBe("");
    }
  });
});

describe("zenTitleHtml", () => {
  it("draws the Zen Mail icon and keeps the escaped title for screen readers", () => {
    const html = zenTitleHtml("🏠 Main <b>", esc);
    expect(html).toContain(ZEN_ICON_PATHS);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('<span class="zen-title-text">🏠 Main &lt;b&gt;</span>');
    expect(html).not.toContain("<b>");
  });
});

describe("zenTabHint", () => {
  it("names Zen Mail before the chat's own title", () => {
    expect(zenTabHint("🏠 Main")).toBe("Zen Mail · 🏠 Main");
    expect(zenTabHint("")).toBe("Zen Mail");
  });
});
