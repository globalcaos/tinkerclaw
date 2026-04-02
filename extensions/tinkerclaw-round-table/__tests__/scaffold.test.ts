import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const EXT_DIR = join(__dirname, "..");

describe("Round Table scaffold", () => {
  it("has a valid plugin manifest", () => {
    const raw = readFileSync(join(EXT_DIR, "openclaw.plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.id).toBe("tinkerclaw-round-table");
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe("object");
  });

  it("has an index.ts entry point", () => {
    expect(existsSync(join(EXT_DIR, "index.ts"))).toBe(true);
  });

  it("imports only from plugin-sdk or relative paths (no src/** leaks)", () => {
    const indexContent = readFileSync(join(EXT_DIR, "index.ts"), "utf8");
    // Check for imports from ../../src/ or similar upstream paths
    const srcLeaks = indexContent.match(/from\s+["'][^"']*\.\.\/\.\.\/src\//g);
    expect(srcLeaks).toBeNull();
  });
});
