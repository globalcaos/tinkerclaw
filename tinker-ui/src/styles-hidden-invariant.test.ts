/**
 * FORK 2026-08-24 (the architect: "The collapse-expand mechanism does not work") — THE SAME CSS TRAP,
 * THREE TIMES.
 *
 * A class rule that sets `display` OUTRANKS the user agent's `[hidden] { display: none }`. So any
 * container that is collapsed by toggling the `hidden` attribute, and whose own class sets
 * `display`, stays on screen no matter what the toggle does.
 *
 * The failure mode is why this is worth a test rather than a comment: the STATE MACHINE IS
 * CORRECT. The attribute goes on, the attribute comes off, the click handler runs, the ledgers
 * update — and nothing moves. It reads as a dead control, so the search starts in the JavaScript
 * and the CSS is the last place anyone looks. It cost a round trip on `.reasoning-content`
 * (2026-08-05), again on `.attach-strip`, and again on `.msg-phase-plugins` today.
 *
 * This pins the rule for every container currently on that pattern. Adding a fourth means adding
 * a line here, which is the cheapest possible moment to be reminded.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved from the run root, NOT from `import.meta.url`: this project runs under jsdom, where
// `import.meta.url` is not a `file:` URL and `fileURLToPath` throws before a single test runs.
// Both roots are accepted because the suite is launched from the repo root
// (`test:tinker-ui`) and, historically, sometimes with `--root tinker-ui`.
const CANDIDATES = ["tinker-ui/src/styles/base.css", "src/styles/base.css"];
const cssPath = CANDIDATES.map((p) => join(process.cwd(), p)).find((p) => existsSync(p));
if (!cssPath) {
  throw new Error(`base.css not found from ${process.cwd()} — tried ${CANDIDATES.join(", ")}`);
}
const CSS = readFileSync(cssPath, "utf8");

/** Containers collapsed via the `hidden` attribute whose class rule also sets `display`. */
const HIDDEN_TOGGLED_CONTAINERS = [
  ".reasoning-content",
  ".attach-strip",
  ".msg-phase-plugins",
] as const;

/** Strip comments so a selector quoted inside a warning note cannot satisfy the assertion. */
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the smart × cost card uses the viewport, not the old desktop cap", () => {
  it("covers most of the window on BOTH axes — no pixel ceiling", () => {
    const rule = CSS_NO_COMMENTS.match(/\.sc-card\s*\{([^}]*)\}/u)?.[1] ?? "";
    expect(rule).toMatch(/width\s*:\s*calc\(100vw\s*-\s*16px\)/u);
    expect(rule).toMatch(/height\s*:\s*calc\(100vh\s*-\s*16px\)/u);
    expect(rule).toMatch(/max-width\s*:\s*none/u);
    expect(rule).toMatch(/max-height\s*:\s*none/u);
    expect(rule).not.toContain("940px");
    expect(rule).not.toContain("780px");
  });
});

describe("a hidden-toggled container must defeat its own display rule", () => {
  for (const selector of HIDDEN_TOGGLED_CONTAINERS) {
    it(`${selector}[hidden] asserts display:none`, () => {
      // Asserted UNCONDITIONALLY, not only when the class rule currently sets `display`.
      // `.reasoning-content` does not set it today and would pass either way — but the moment
      // someone adds `display: flex` to it for a layout reason, the collapse silently dies, and
      // the whole point is to make that impossible rather than to describe today's stylesheet.
      const hiddenRule = new RegExp(
        `\\${selector}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`,
        "u",
      );
      expect(
        hiddenRule.test(CSS_NO_COMMENTS),
        `${selector}[hidden] { display: none } is missing. Without it the collapse toggles the ` +
          `attribute correctly and NOTHING MOVES — a dead control that looks like a JS bug.`,
      ).toBe(true);
    });
  }
});
