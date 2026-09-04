import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Recipe overlay resolution (2026-06-07): loadRecipeText probes the OPENCLAW_HOME
 * recipes overlay BEFORE the own-recipes dir (first-readable-wins), so an
 * installed/overridden copy wins over the bundled definition.
 * Target: recipe-runner.ts (resolveRecipeOverlayDir / loadRecipeText overlay candidates).
 * Catches: overlay candidate dropped or ordered after ownRecipesDir; broken fallback.
 */
import { describe, it, expect } from "vitest";
import { loadRecipeText, resolveRecipeOverlayDir } from "../recipe-runner.js";

const SLUG = "overlay-demo";
const KIT_REF = `owner/${SLUG}`;

// FORK 2026-09-02: the library also stores recipes as `<category>/<name>.md`, and
// `feature` composes `parallel-build`, `test-hardening`, `code-review` and
// `finish-branch` from `coding/` via `uses:`. The loader only ever probed
// `<dir>/<slug>/recipe.md`, so the matcher could select a recipe the runner then
// failed to load. Same class as the 2026-08-22 scanner blind spot, third sighting.
describe("loadRecipeText — category-folder layout", () => {
  it("finds `<own>/<category>/<slug>.md` when no `<own>/<slug>/recipe.md` exists", async () => {
    const prev = process.env.OPENCLAW_HOME;
    const overlayHome = await mkdtemp(join(tmpdir(), "recipe-locate-home-"));
    const ownRecipesDir = await mkdtemp(join(tmpdir(), "recipe-locate-own-"));
    const sandbox = await mkdtemp(join(tmpdir(), "recipe-locate-sandbox-"));
    try {
      process.env.OPENCLAW_HOME = overlayHome;
      await mkdir(join(ownRecipesDir, "coding"), { recursive: true });
      await writeFile(
        join(ownRecipesDir, "coding", "parallel-build.md"),
        "CATEGORY CONTENT",
        "utf-8",
      );
      const text = await loadRecipeText("globalcaos/parallel-build", ownRecipesDir, sandbox);
      expect(text).toBe("CATEGORY CONTENT");
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = prev;
      await rm(overlayHome, { recursive: true, force: true });
      await rm(ownRecipesDir, { recursive: true, force: true });
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("recipe overlay resolution", () => {
  it("resolveRecipeOverlayDir honours OPENCLAW_HOME", async () => {
    const prev = process.env.OPENCLAW_HOME;
    const scratch = await mkdtemp(join(tmpdir(), "recipe-overlay-resolve-"));
    try {
      process.env.OPENCLAW_HOME = scratch;
      expect(resolveRecipeOverlayDir()).toBe(join(scratch, "recipes"));
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = prev;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("prefers the overlay copy over the own-recipes copy (first-readable-wins)", async () => {
    const prev = process.env.OPENCLAW_HOME;
    const overlayHome = await mkdtemp(join(tmpdir(), "recipe-overlay-home-"));
    const ownRecipesDir = await mkdtemp(join(tmpdir(), "recipe-overlay-own-"));
    const sandbox = await mkdtemp(join(tmpdir(), "recipe-overlay-sandbox-"));
    try {
      process.env.OPENCLAW_HOME = overlayHome;
      // overlay copy: <OPENCLAW_HOME>/recipes/<slug>/recipe.md
      const overlaySlugDir = join(overlayHome, "recipes", SLUG);
      await mkdir(overlaySlugDir, { recursive: true });
      await writeFile(join(overlaySlugDir, "recipe.md"), "OVERLAY CONTENT", "utf-8");
      // own-recipes copy: <ownRecipesDir>/<slug>/recipe.md (DIFFERENT content)
      const ownSlugDir = join(ownRecipesDir, SLUG);
      await mkdir(ownSlugDir, { recursive: true });
      await writeFile(join(ownSlugDir, "recipe.md"), "OWN CONTENT", "utf-8");

      const text = await loadRecipeText(KIT_REF, ownRecipesDir, sandbox);
      expect(text).toBe("OVERLAY CONTENT");
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = prev;
      await rm(overlayHome, { recursive: true, force: true });
      await rm(ownRecipesDir, { recursive: true, force: true });
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("falls back to the own-recipes copy when no overlay file is present", async () => {
    const prev = process.env.OPENCLAW_HOME;
    // empty overlay home: <OPENCLAW_HOME>/recipes/<slug> does not exist
    const overlayHome = await mkdtemp(join(tmpdir(), "recipe-overlay-empty-"));
    const ownRecipesDir = await mkdtemp(join(tmpdir(), "recipe-overlay-own2-"));
    const sandbox = await mkdtemp(join(tmpdir(), "recipe-overlay-sandbox2-"));
    try {
      process.env.OPENCLAW_HOME = overlayHome;
      const ownSlugDir = join(ownRecipesDir, SLUG);
      await mkdir(ownSlugDir, { recursive: true });
      await writeFile(join(ownSlugDir, "recipe.md"), "OWN CONTENT", "utf-8");

      const text = await loadRecipeText(KIT_REF, ownRecipesDir, sandbox);
      expect(text).toBe("OWN CONTENT");
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = prev;
      await rm(overlayHome, { recursive: true, force: true });
      await rm(ownRecipesDir, { recursive: true, force: true });
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
