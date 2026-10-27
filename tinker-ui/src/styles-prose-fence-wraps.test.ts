/**
 * FORK 2026-10-02 (the architect: "When you show me an example of whatsapp message, I don't like that it
 * appears in one line with a sliding bar under it, I would rather the text wrap around").
 *
 * Second time: on 2026-08-28 the Veolia letter came in a ``` fence and he had to drag a scrollbar
 * to read every line. The fix then was a memory rule ("paste-ready prose never in a fence"); the
 * rule was archived out of the always-loaded index and the drafts went back into fences. A habit
 * rule did not hold, so the renderer now carries it.
 *
 * markdown-it renders an UNTAGGED fence as a bare `<pre><code>` and a tagged one (```bash, ```ts)
 * as `<code class="language-…">`. Untagged fences in chat are prose (drafts, letters, quoted
 * messages) far more often than code, so they wrap; tagged code keeps its exact lines and scrolls.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CANDIDATES = ["tinker-ui/src/styles/base.css", "src/styles/base.css"];
const cssPath = CANDIDATES.map((p) => join(process.cwd(), p)).find((p) => existsSync(p));
if (!cssPath) {
  throw new Error(`base.css not found from ${process.cwd()} — tried ${CANDIDATES.join(", ")}`);
}
const CSS = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const m = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS);
  return m ? m[1] : null;
}

describe("chat: untagged ``` fences wrap instead of scrolling sideways", () => {
  const selector = '.msg pre > code:not([class*="language-"])';

  it("has a rule for untagged fenced code inside chat messages", () => {
    expect(ruleBody(selector)).not.toBeNull();
  });

  it("wraps long lines while keeping the author's line breaks", () => {
    const body = ruleBody(selector) ?? "";
    expect(body).toMatch(/white-space:\s*pre-wrap/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("leaves tagged code (```bash, ```ts) on its exact lines", () => {
    expect(ruleBody(".msg pre") ?? "").not.toMatch(/white-space:\s*pre-wrap/);
  });
});
