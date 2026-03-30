import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXT_DIR = join(__dirname, "..");

describe("Computational Humor scaffold", () => {
  it("has a valid plugin manifest", () => {
    const raw = readFileSync(join(EXT_DIR, "openclaw.plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.id).toBe("tinkerclaw-computational-humor");
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.properties.frequency).toBeDefined();
    expect(manifest.configSchema.properties.sensitivityThreshold).toBeDefined();
    expect(manifest.configSchema.properties.embeddingProvider).toBeDefined();
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

  it("has all required source files", () => {
    const sourceFiles = [
      "vector-math.ts",
      "config.ts",
      "humor-potential.ts",
      "bridge-discovery.ts",
      "sensitivity-gate.ts",
      "humor-associations.ts",
      "pattern-taxonomy.ts",
      "limbic-runtime.ts",
      "humor-trigger.ts",
      "index.ts",
    ];
    for (const file of sourceFiles) {
      expect(existsSync(join(EXT_DIR, "src", file))).toBe(true);
    }
  });

  it("imports only from plugin-sdk or relative paths (no src/** leaks)", () => {
    const indexContent = readFileSync(join(EXT_DIR, "index.ts"), "utf8");
    const srcLeaks = indexContent.match(/from\s+["'][^"']*\.\.\/\.\.\/src\//g);
    expect(srcLeaks).toBeNull();
  });

  it("source files have no upstream imports", () => {
    const srcFiles = [
      "vector-math.ts",
      "config.ts",
      "humor-potential.ts",
      "bridge-discovery.ts",
      "sensitivity-gate.ts",
      "humor-associations.ts",
      "pattern-taxonomy.ts",
      "limbic-runtime.ts",
      "humor-trigger.ts",
    ];
    for (const file of srcFiles) {
      const content = readFileSync(join(EXT_DIR, "src", file), "utf8");
      const srcLeaks = content.match(/from\s+["'][^"']*\.\.\/\.\.\/\.\.\/src\//g);
      expect(srcLeaks).toBeNull();
    }
  });
});
