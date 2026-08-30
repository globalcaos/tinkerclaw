import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { STATIC_EXTENSION_ASSETS } from "../../../scripts/runtime-postbuild.mjs";

const EXT_DIR = join(__dirname, "..");
const EXT_REL = "extensions/tinkerclaw-fractal-reflection";

/** Shipped (non-test) sources — the files whose reads actually run in prod. */
function runtimeSourceFiles(): string[] {
  const files = [join(EXT_DIR, "index.ts")];
  for (const entry of readdirSync(join(EXT_DIR, "src"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(join(EXT_DIR, "src", entry.name));
    }
  }
  return files;
}

/**
 * Every `*.md` filename literal referenced by shipped source that really exists
 * in the extension dir — i.e. the files this plugin reads out of its own
 * directory at run time. DERIVED, not hardcoded, so a newly-read prompt is
 * covered the moment somebody reads it.
 */
function promptsReadAtRuntime(): string[] {
  const found = new Set<string>();
  for (const file of runtimeSourceFiles()) {
    for (const [, name] of readFileSync(file, "utf8").matchAll(
      /["'`]([A-Za-z0-9._-]+\.md)["'`]/g,
    )) {
      if (name && existsSync(join(EXT_DIR, name))) {
        found.add(name);
      }
    }
  }
  return [...found].toSorted();
}

/** Bare filenames this extension declares for staging into dist. */
function stagedPromptFiles(): string[] {
  return STATIC_EXTENSION_ASSETS.filter((asset) => asset.src.startsWith(`${EXT_REL}/`))
    .map((asset) => asset.src.slice(EXT_REL.length + 1))
    .toSorted();
}

describe("Fractal Reflection scaffold (v3)", () => {
  it("has a valid plugin manifest", () => {
    const raw = readFileSync(join(EXT_DIR, "openclaw.plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.id).toBe("tinkerclaw-fractal-reflection");
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.properties.enabled).toBeDefined();
    // v3 keys (§5.67b); debounceMs/minGapMs are RETIRED — must NOT reappear.
    expect(manifest.configSchema.properties.triageArm).toBeDefined();
    expect(manifest.configSchema.properties.maxFixTurnsCeiling).toBeDefined();
    expect(manifest.configSchema.properties.debounceMs).toBeUndefined();
    expect(manifest.configSchema.properties.minGapMs).toBeUndefined();
    // Go-live is one witnessed plugins.entries flag flip (Drop 1 exit criterion).
    expect(manifest.enabledByDefault).toBe(false);
  });

  it("has a package.json with openclaw.extensions", () => {
    const raw = readFileSync(join(EXT_DIR, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    expect(pkg.openclaw?.extensions).toBeDefined();
    expect(pkg.openclaw.extensions).toContain("./index.ts");
  });

  it("has an index.ts entry point", () => {
    expect(existsSync(join(EXT_DIR, "index.ts"))).toBe(true);
  });

  it("has the v3 doctrine pair bundled (triage + fix prompts)", () => {
    // The v1 fractal-prompt.md is deliberately KEPT until the dead tinker-bridge
    // loader is removed (first core-touching drop) — bible §5.67b prompt-
    // doctrine bullet. The v3 pair is what the plugin actually loads.
    expect(existsSync(join(EXT_DIR, "fractal-prompt.md"))).toBe(true);
    const triage = readFileSync(join(EXT_DIR, "triage-prompt.md"), "utf8");
    expect(triage).toContain("FRACTAL TRIAGE");
    expect(triage).toContain('"verdict"');
    const fix = readFileSync(join(EXT_DIR, "fix-prompt.md"), "utf8");
    expect(fix).toContain("FRACTAL FIX");
  });

  // REGRESSION GUARD (2026-08-04). The assertion above only ever proved the
  // prompts exist IN THE REPO. They always did. What never happened is the copy
  // into dist/: STATIC_EXTENSION_ASSETS listed only fractal-prompt.md, so the
  // gateway loaded an extension dir with no triage-prompt.md and every fractal
  // run from 2026-06-11 to 2026-08-04 failed with "triage-prompt.md missing or
  // unreadable in the extension dir" — 2,067 of 2,379 ledger rows, 245 of 245
  // in August, zero successes ever recorded. Repo-existence is not the
  // invariant; being declared for staging is. Both tests below assert that.
  it("declares every prompt it reads at runtime in STATIC_EXTENSION_ASSETS", () => {
    const read = promptsReadAtRuntime();
    // Non-vacuity guard: if the derivation ever silently returns nothing, the
    // loop below passes trivially and re-opens exactly this blind spot.
    expect(read).toContain("triage-prompt.md");
    const staged = stagedPromptFiles();
    for (const name of read) {
      expect(
        staged,
        `${name} is read from the extension dir at runtime but is not in STATIC_EXTENSION_ASSETS, so it will never reach dist/`,
      ).toContain(name);
    }
  });

  it("declares every *-prompt.md shipped in the extension dir, at the right dest", () => {
    // Disk-derived rather than source-derived: fix-prompt.md has no reader yet
    // (the fix lane is not wired), so a purely source-derived scan would let it
    // ship un-staged and reproduce the same outage the day it is wired up.
    const shipped = readdirSync(EXT_DIR)
      .filter((name) => name.endsWith("-prompt.md"))
      .toSorted();
    expect(shipped.length).toBeGreaterThanOrEqual(3);
    for (const name of shipped) {
      const entry = STATIC_EXTENSION_ASSETS.find((asset) => asset.src === `${EXT_REL}/${name}`);
      expect(entry, `${name} is missing from STATIC_EXTENSION_ASSETS`).toBeDefined();
      expect(entry?.dest).toBe(`dist/${EXT_REL}/${name}`);
    }
  });

  it("imports only from plugin-sdk or relative paths (no static src/** leaks)", () => {
    const indexContent = readFileSync(join(EXT_DIR, "index.ts"), "utf8");
    const srcLeaks = indexContent.match(/from\s+["'][^"']*\.\.\/\.\.\/src\//g);
    expect(srcLeaks).toBeNull();
  });

  it("v1 fractal-inject.ts is deleted and the v3 modules exist", () => {
    expect(existsSync(join(EXT_DIR, "src/fractal-inject.ts"))).toBe(false);
    for (const mod of ["types", "ledger", "governor", "fractal-run", "fractal-result"]) {
      expect(existsSync(join(EXT_DIR, `src/${mod}.ts`))).toBe(true);
    }
  });
});
