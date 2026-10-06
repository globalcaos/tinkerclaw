import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectUsage,
  isUsageMark,
  mergeUsageMarks,
  recipeMark,
  renderAdviceLine,
  renderUsageChip,
  renderUsageChips,
  skillMark,
  type UsageMark,
} from "./usage-chips.js";

const SKILL = {
  kind: "skill",
  name: "orca",
  path: "/home/u/.claude/skills/orca/SKILL.md",
  via: "read",
};
const RECIPE = {
  kind: "recipe",
  name: "acme-coding",
  path: "/home/u/.openclaw/recipes/acme-coding/recipe.md",
  via: "recipe-cli",
};
const PLUGIN = { kind: "plugin", name: "tinkerclaw-prefrontal", via: "plugin-tool" };

describe("isUsageMark", () => {
  it("accepts the three kinds", () => {
    for (const kind of ["skill", "recipe", "plugin"]) {
      expect(isUsageMark({ kind, name: "x", via: "read" })).toBe(true);
    }
  });

  it("rejects an unknown kind, an empty name, a non-object and a mistyped path", () => {
    expect(isUsageMark({ kind: "hook", name: "x", via: "read" })).toBe(false);
    expect(isUsageMark({ kind: "skill", name: "   ", via: "read" })).toBe(false);
    expect(isUsageMark(null)).toBe(false);
    expect(isUsageMark([SKILL])).toBe(false);
    expect(isUsageMark({ kind: "skill", name: "x", via: "read", path: 7 })).toBe(false);
  });

  // The UI never RENDERS `via`. A guard that rejected an unseen value would let one new
  // gateway-side via blank the whole chip family with no error anywhere.
  it("accepts a via it has never seen, and a mark with no via at all", () => {
    expect(isUsageMark({ kind: "skill", name: "x", via: "some-future-lane" })).toBe(true);
    expect(isUsageMark({ kind: "skill", name: "x" })).toBe(true);
  });
});

describe("collectUsage", () => {
  it("dedupes on kind+name and keeps first-seen order", () => {
    expect(collectUsage([SKILL, RECIPE], [SKILL]).map((m) => m.name)).toEqual([
      "orca",
      "acme-coding",
    ]);
  });

  it("does not merge two kinds that share a name", () => {
    expect(
      collectUsage([
        { ...SKILL, name: "x" },
        { ...PLUGIN, name: "x" },
      ]),
    ).toHaveLength(2);
  });

  it("the first mark with a path wins, and a pathless duplicate never clears it", () => {
    const pathless = { kind: "skill", name: "orca", via: "skill-tool" };
    expect(collectUsage([pathless], [SKILL])[0].path).toBe(SKILL.path);
    expect(collectUsage([SKILL], [pathless])[0].path).toBe(SKILL.path);
  });

  it("ignores non-arrays, absent sources and junk members", () => {
    expect(collectUsage(undefined, null, "nope", [null, 3, SKILL])).toHaveLength(1);
    expect(collectUsage()).toEqual([]);
  });

  it("mergeUsageMarks is the binary form of the same merge", () => {
    expect(mergeUsageMarks([SKILL as UsageMark], [SKILL as UsageMark])).toHaveLength(1);
  });
});

describe("renderUsageChips", () => {
  it("renders nothing for no marks and for all-junk marks", () => {
    expect(renderUsageChips([])).toBe("");
    expect(renderUsageChips(undefined)).toBe("");
    expect(renderUsageChips([{ kind: "hook", name: "x", via: "read" }])).toBe("");
  });

  it("orders recipe, then skill, then plugin whatever the input order", () => {
    const h = renderUsageChips([PLUGIN, SKILL, RECIPE]);
    expect(h.indexOf("msg-recipe-notice")).toBeLessThan(h.indexOf("msg-skill-notice"));
    expect(h.indexOf("msg-skill-notice")).toBeLessThan(h.indexOf("msg-plugin-notice"));
  });

  // §5.8X reuses a chat unit by HTML equality: the same marks must always produce the same string.
  it("is order-independent, so a repaint compares equal", () => {
    expect(renderUsageChips([PLUGIN, SKILL, RECIPE])).toBe(
      renderUsageChips([RECIPE, PLUGIN, SKILL]),
    );
  });

  it("draws exactly one chip per distinct kind+name", () => {
    const h = renderUsageChips([SKILL, { ...SKILL, via: "exec" }, { ...SKILL, via: "skill-tool" }]);
    expect(h.match(/class="msg-skill-notice"/g)).toHaveLength(1);
  });

  // The legacy renderSkillNotice markup, byte for byte — an old transcript must not repaint.
  it("is byte-identical to the legacy skill chip", () => {
    expect(renderUsageChips([SKILL])).toBe(
      `<div class="msg-skill-notice">` +
        `<span class="msg-skill-notice-icon">\u{1F527}</span>` +
        `<span class="msg-skill-notice-text">Using skill <strong>orca</strong></span>` +
        `<code class="fs-link msg-skill-notice-link" data-path="${SKILL.path}" ` +
        `title="Open ${SKILL.path}">SKILL.md ↗</code>` +
        `</div>`,
    );
  });

  it("is byte-identical to the legacy recipe chip", () => {
    expect(renderUsageChips([RECIPE])).toBe(
      `<div class="msg-recipe-notice">` +
        `<span class="msg-recipe-notice-icon">\u{1F373}</span>` +
        `<span class="msg-recipe-notice-text">Using recipe <strong>acme-coding</strong></span>` +
        `<code class="fs-link msg-recipe-notice-link" data-path="${RECIPE.path}" ` +
        `title="Open ${RECIPE.path}">recipe.md ↗</code>` +
        `</div>`,
    );
  });

  it("labels a recipe link with the real basename when the file is not recipe.md", () => {
    expect(renderUsageChips([{ ...RECIPE, path: "/r/acme-article-code.md" }])).toContain(
      ">acme-article-code.md ↗</code>",
    );
  });

  it("draws a plugin chip, with NO link when the mark has no path", () => {
    const h = renderUsageChips([PLUGIN]);
    expect(h).toContain("Using plugin <strong>tinkerclaw-prefrontal</strong>");
    expect(h).toContain("msg-plugin-notice-icon");
    expect(h).not.toContain("fs-link");
    expect(h).not.toContain("data-path");
  });

  it("links a plugin chip with a bare arrow when a path IS known", () => {
    const h = renderUsageChips([{ ...PLUGIN, path: "/p/tinkerclaw-prefrontal/index.ts" }]);
    expect(h).toContain(`data-path="/p/tinkerclaw-prefrontal/index.ts"`);
    expect(h).toContain(`>↗</code>`);
    expect(h).not.toContain("index.ts ↗");
  });

  it("drops a skill chip's link rather than guessing a path", () => {
    const h = renderUsageChips([{ kind: "skill", name: "jarvis-recipe", via: "skill-tool" }]);
    expect(h).toContain("Using skill <strong>jarvis-recipe</strong>");
    expect(h).not.toContain("fs-link");
  });

  it("escapes the name and the path, in the text and in both attributes", () => {
    const h = renderUsageChips([
      { kind: "skill", name: '<img src=x onerror=1>&"', path: '/a"b/<c>/SKILL.md', via: "read" },
    ]);
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
    expect(h).toContain('data-path="/a&quot;b/&lt;c&gt;/SKILL.md"');
    expect(h).toContain('title="Open /a&quot;b/&lt;c&gt;/SKILL.md"');
  });

  it("renderUsageChip draws the same single chip the row would", () => {
    expect(renderUsageChip(SKILL as UsageMark)).toBe(renderUsageChips([SKILL]));
  });
});

describe("legacy adapters (rows served before the gateway ships usage — review focus 4)", () => {
  it("convert the old producer shapes into marks", () => {
    expect(skillMark({ name: "orca", path: "/s/orca/SKILL.md" })).toEqual({
      kind: "skill",
      name: "orca",
      via: "read",
      path: "/s/orca/SKILL.md",
    });
    expect(skillMark({ name: "orca" }, "skill-tool")).toEqual({
      kind: "skill",
      name: "orca",
      via: "skill-tool",
    });
    expect(recipeMark({ title: "acme-coding", path: "/r/recipe.md" })).toEqual({
      kind: "recipe",
      name: "acme-coding",
      via: "recipe-cli",
      path: "/r/recipe.md",
    });
  });

  it("a row with no typed usage still renders, from the adapters alone", () => {
    const html = renderUsageChips(
      collectUsage(undefined, undefined, [
        recipeMark({ title: "acme-coding", path: "/r/recipe.md" }),
        skillMark({ name: "orca", path: SKILL.path }),
      ]),
    );
    expect(html).toContain("Using recipe");
    expect(html).toContain("Using skill");
  });

  it("a gateway mark and a legacy mark for the same skill draw ONE chip", () => {
    const html = renderUsageChips(
      collectUsage([SKILL], [skillMark({ name: "orca" }, "skill-tool")]),
    );
    expect(html.match(/class="msg-skill-notice"/g)).toHaveLength(1);
    expect(html).toContain(SKILL.path);
  });
});

// ─── app.ts wiring, locked structurally ─────────────────────────────────────────────────
// app.ts is an un-testable browser entry, so the three call-site facts this unit depends on are
// read off its source (the same technique retry-lifecycle.test.ts uses for the /clear branch).
// Walk up from the vitest cwd rather than import.meta.url: under this jsdom project the module
// URL is an http:// one.
describe("app.ts usage-chip wiring", () => {
  const findAppSource = (): string => {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "tinker-ui", "src", "app.ts");
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    throw new Error(`could not locate tinker-ui/src/app.ts from ${process.cwd()}`);
  };
  const appSrc = readFileSync(findAppSource(), "utf8");

  it("REGRESSION: the recipe trail stamp only stamps the tab whose run matched", () => {
    // Without the guard a `matched` event from another tab's run stamped its recipe onto the
    // prompt on screen — the wrong chip under the wrong prompt.
    const at = appSrc.indexOf('(kind === "matched" || kind === "merged")');
    expect(at, "the matched/merged recipe stamp moved or was renamed").toBeGreaterThan(-1);
    const cond = appSrc.slice(at, appSrc.indexOf("{", at));
    expect(cond).toMatch(/sessionKeyMatches\(\s*p\.sessionKey\s*\)/);
  });

  it("the live tool START branch stamps the gateway's usage marks on the turn", () => {
    const at = appSrc.indexOf('if (d.phase === "start" && d.name && d.toolCallId) {');
    expect(at, "the tool-start branch moved or was renamed").toBeGreaterThan(-1);
    const end = appSrc.indexOf('} else if (d.phase === "result"', at);
    expect(appSrc.slice(at, end)).toMatch(/stampUsageOnCurrentTurn\(\s*d\.usage\s*\)/);
  });

  it("the `Skill` call site suppresses its row but no longer draws a second chip", () => {
    const at = appSrc.indexOf("const skillChip = skillNoticeFromTool(block.name");
    expect(at, "the Skill call-site suppression moved or was renamed").toBeGreaterThan(-1);
    const body = appSrc.slice(at, appSrc.indexOf("continue;", at));
    expect(body).not.toContain("renderSkillNotice");
    expect(body).not.toContain("renderUsageChip");
  });
});

// FORK 2026-10-06 (Broca retrieval v2, phase E)
describe("renderAdviceLine", () => {
  const LINE = "Use: acme-coding · Inspiration: review-site (§ Build the page) · source: Jev";

  it("draws one muted line with the text, and nothing that looks like a message or a button", () => {
    const html = renderAdviceLine(LINE);
    expect(html).toContain('class="msg-advice-line"');
    expect(html).toContain(LINE);
    expect(html).not.toMatch(/<(button|a|input|textarea)\b/);
    expect(html).not.toContain('class="msg ');
    expect(html.match(/<div\b/g)).toHaveLength(1);
  });

  it("escapes what it is given", () => {
    const html = renderAdviceLine('Use: <img src=x onerror=alert(1)> "a" & b');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&quot;a&quot; &amp; b");
  });

  it("draws nothing for a non-string, an empty line or an absurdly long one", () => {
    expect(renderAdviceLine(undefined)).toBe("");
    expect(renderAdviceLine(42)).toBe("");
    expect(renderAdviceLine("   ")).toBe("");
    expect(renderAdviceLine("x".repeat(601))).toBe("");
  });

  it("keeps the line on one line", () => {
    expect(renderAdviceLine("Use: a\n\nb  c")).toContain("Use: a b c");
  });
});
