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

  // REMOVED 2026-08-03 (architect's call). This forbade `from "../../src/"` and had been red
  // for weeks, because index.ts imports exactly three things from core — agent-events,
  // algorithm-metrics and instrument-liveness — i.e. the observability substrate we WANT every
  // extension to share. A boundary that forbids the one thing that must not be duplicated was
  // pushing extensions toward their own copies, which is how the 26-file engram twin and the
  // 10-file amygdala twin were born. Sharing core infrastructure beats re-implementing it.
  //
  // If a real boundary is wanted later, the shape is a curated plugin-sdk re-export, not a
  // grep — and it should be enforced where the import graph is known, not by pattern-matching
  // one file's text.
  it("declares its own source files (the scaffold contract)", () => {
    const indexContent = readFileSync(join(EXT_DIR, "index.ts"), "utf8");
    expect(indexContent).toMatch(/from\s+["']\.\/src\//);
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
