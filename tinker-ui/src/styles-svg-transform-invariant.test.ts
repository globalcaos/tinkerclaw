/**
 * FORK 2026-09-23 (the architect, on the published smartness × cost map: "there are still bubbles on the
 * top-left that are meant to be somewhere else") — THE SAME SVG TRAP, TWICE.
 *
 * A CSS `transform` declaration REPLACES an SVG element's `transform="translate(…)"` presentation
 * attribute; it does not compose with it. So a group that is POSITIONED by the attribute and ALSO
 * counter-scaled by a CSS rule loses its position and collapses to the drawing's origin, the
 * top-left corner. FORK 2026-08-06 #6 collapsed every dot that way; the fix split each marker into
 * a positioned wrapper (attribute) and an inner mark (CSS scale). `.sc-ghostpos` kept both on one
 * element, so all 374 task-mode landing rings piled up in the corner for seven weeks, invisible in
 * €/Mtok mode and obvious in €/task mode.
 *
 * The comment in base.css already said "never both on one element". A comment is not a sensor, so
 * this reads the rule from the two places that can break it: every class the panels emit with a
 * `transform="…"` attribute, and every CSS rule whose subject is one of those classes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved from the run root, NOT from `import.meta.url` (jsdom), same as styles-hidden-invariant.
const ROOTS = ["tinker-ui/src", "src"];
const srcRoot = ROOTS.map((p) => join(process.cwd(), p)).find((p) =>
  existsSync(join(p, "styles/base.css")),
);
if (!srcRoot) throw new Error(`tinker-ui/src not found from ${process.cwd()}`);

const CSS = readFileSync(join(srcRoot, "styles/base.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Classes the panels emit on an element that also carries a `transform="…"` attribute. */
function attributePositionedClasses(): Set<string> {
  const out = new Set<string>();
  const dir = join(srcRoot as string, "panels");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/<g class="([a-z0-9-]+)"[^>]*?\stransform="/g)) out.add(m[1]);
  }
  return out;
}

/** Every innermost rule as [selector, body]; @media wrappers fall away because the body has no braces. */
function rules(): Array<[string, string]> {
  return [...CSS.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
}

describe("an SVG group positioned by its transform ATTRIBUTE is never transformed by CSS", () => {
  const positioned = attributePositionedClasses();

  it("finds the positioned groups (a scan that finds nothing proves nothing)", () => {
    for (const cls of ["sc-dotpos", "sc-apipos", "sc-ghostpos", "sc-labelpos"]) {
      expect(positioned.has(cls), cls).toBe(true);
    }
  });

  it("no CSS rule whose subject is one of them sets transform", () => {
    const offenders: string[] = [];
    for (const [selectorList, body] of rules()) {
      if (!/(^|[;\s])transform\s*:/.test(body)) continue;
      for (const sel of selectorList.split(",")) {
        const subject =
          sel
            .trim()
            .split(/[\s>+~]+/)
            .pop() ?? "";
        for (const cls of positioned) {
          if (new RegExp(`\\.${cls}(?![\\w-])`).test(subject))
            offenders.push(`${sel.trim()} (${cls})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
