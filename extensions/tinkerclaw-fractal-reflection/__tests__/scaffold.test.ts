import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const EXT_DIR = join(__dirname, "..");

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
