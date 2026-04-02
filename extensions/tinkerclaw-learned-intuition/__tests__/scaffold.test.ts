import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const EXT_DIR = join(__dirname, "..");

describe("Learned Intuition scaffold", () => {
  it("has a valid plugin manifest", () => {
    const raw = readFileSync(join(EXT_DIR, "openclaw.plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.id).toBe("tinkerclaw-learned-intuition");
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.properties.phase).toBeDefined();
    expect(manifest.configSchema.properties.observeOnly).toBeDefined();
    expect(manifest.configSchema.properties.modelsDir).toBeDefined();
  });

  it("has an index.ts entry point", () => {
    expect(existsSync(join(EXT_DIR, "index.ts"))).toBe(true);
  });

  it("has a package.json with openclaw.extensions", () => {
    const raw = readFileSync(join(EXT_DIR, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    expect(pkg.openclaw).toBeDefined();
    expect(pkg.openclaw.extensions).toContain("./index.ts");
  });

  it("imports only from plugin-sdk or relative paths (no src/** leaks)", () => {
    const indexContent = readFileSync(join(EXT_DIR, "index.ts"), "utf8");
    const srcLeaks = indexContent.match(/from\s+["'][^"']*\.\.\/\.\.\/src\//g);
    expect(srcLeaks).toBeNull();
  });

  it("has all 10 source files in src/", () => {
    const expectedFiles = [
      "types.ts",
      "gate.ts",
      "situation-template.ts",
      "training-log.ts",
      "personality-decoder.ts",
      "personality-seed.ts",
      "runtime-hook.ts",
      "embedding.ts",
      "distribution-shift.ts",
      "git-cache.ts",
      "rule-based-gate.ts",
    ];
    for (const file of expectedFiles) {
      expect(existsSync(join(EXT_DIR, "src", file))).toBe(true);
    }
  });

  it("no source files import from upstream paths (../../)", () => {
    const srcDir = join(EXT_DIR, "src");
    const { readdirSync } = require("node:fs");
    const files = readdirSync(srcDir).filter((f: string) => f.endsWith(".ts"));
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8");
      const leaks = content.match(/from\s+["'][^"']*\.\.\/\.\.\//g);
      expect(leaks, `${file} has upstream import leaks: ${leaks}`).toBeNull();
    }
  });
});
