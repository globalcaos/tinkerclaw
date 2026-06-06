/**
 * Overlay read-precedence for prefrontal.recipe.read (Seam B).
 *
 * The RPC handler probes the OUT-OF-REPO overlay (~/.openclaw/recipes/<slug>/)
 * BEFORE the git-tracked ownRecipesDir, so a user's edited copy shadows the
 * default. We test the shared resolver `resolveRecipeOverlayDir()` (which keys
 * off OPENCLAW_HOME) plus the exact dual-read probe loop the handler runs,
 * deterministically against a tmpdir — without wiring the full RPC deps graph.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveRecipeOverlayDir } from "../recipe-runner.js";

let tmpHome: string;
let prevHome: string | undefined;

beforeAll(() => {
  prevHome = process.env.OPENCLAW_HOME;
});
afterAll(() => {
  if (prevHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = prevHome;
  }
});
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-overlay-home-"));
  process.env.OPENCLAW_HOME = tmpHome;
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Mirror of the handler's overlay-first dual-read probe so the test pins the
 * precedence behavior (recipe.md before kit.md, overlay dir resolved via the
 * shared resolver) rather than re-implementing path logic by hand.
 */
async function probeOverlay(slug: string): Promise<string | null> {
  for (const fname of ["recipe.md", "kit.md"]) {
    try {
      return await fsp.readFile(path.join(resolveRecipeOverlayDir(), slug, fname), "utf-8");
    } catch {
      // try next filename
    }
  }
  return null;
}

describe("recipe.read overlay precedence (Seam B)", () => {
  it("resolveRecipeOverlayDir() points at <OPENCLAW_HOME>/recipes", () => {
    expect(resolveRecipeOverlayDir()).toBe(path.join(tmpHome, "recipes"));
  });

  it("reads an overlay recipe.md dropped under the slug dir", async () => {
    const slug = "demo-recipe";
    const slugDir = path.join(resolveRecipeOverlayDir(), slug);
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "recipe.md"), "# overlay copy\n", "utf-8");

    const md = await probeOverlay(slug);
    expect(md).toBe("# overlay copy\n");
  });

  it("prefers recipe.md over kit.md when both exist in the overlay", async () => {
    const slug = "dual-read";
    const slugDir = path.join(resolveRecipeOverlayDir(), slug);
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "recipe.md"), "canonical\n", "utf-8");
    fs.writeFileSync(path.join(slugDir, "kit.md"), "legacy\n", "utf-8");

    expect(await probeOverlay(slug)).toBe("canonical\n");
  });

  it("falls back to kit.md when only the legacy filename exists", async () => {
    const slug = "legacy-only";
    const slugDir = path.join(resolveRecipeOverlayDir(), slug);
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "kit.md"), "legacy\n", "utf-8");

    expect(await probeOverlay(slug)).toBe("legacy\n");
  });

  it("returns null (caller falls through to ownRecipesDir) when no overlay copy exists", async () => {
    expect(await probeOverlay("absent-slug")).toBeNull();
  });
});
