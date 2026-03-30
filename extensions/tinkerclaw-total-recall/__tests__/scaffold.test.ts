import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXT_DIR = join(__dirname, "..");

describe("Total Recall scaffold", () => {
  it("has a valid plugin manifest", () => {
    const raw = readFileSync(join(EXT_DIR, "openclaw.plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.id).toBe("tinkerclaw-total-recall");
    expect(manifest.kind).toBe("memory");
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.properties.budgetTokens).toBeDefined();
    expect(manifest.configSchema.properties.pointerMode).toBeDefined();
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

  it("has all 26 source files in src/", () => {
    const expectedFiles = [
      "event-types.ts",
      "event-store.ts",
      "artifact-store.ts",
      "ingestion.ts",
      "metrics.ts",
      "search-index.ts",
      "global-fts-bridge.ts",
      "retrieval-integration.ts",
      "embedding-cache.ts",
      "embedding-worker.ts",
      "entity-extraction.ts",
      "contradiction-gate.ts",
      "daily-log-cache.ts",
      "pointer-compaction.ts",
      "time-range-marker.ts",
      "compaction-reflection.ts",
      "task-state.ts",
      "task-conditioned-scoring.ts",
      "push-pack.ts",
      "episode-detection.ts",
      "sleep-consolidation.ts",
      "consolidate-cli.ts",
      "recall-tool.ts",
      "hippocampus-rebuild.ts",
      "hippocampus-enhancement.ts",
      "test-harness.ts",
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
