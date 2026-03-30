import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXT_DIR = join(__dirname, "..");

describe("Fractal Reflection scaffold", () => {
  it("has a valid plugin manifest", () => {
    const raw = readFileSync(join(EXT_DIR, "openclaw.plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.id).toBe("tinkerclaw-fractal-reflection");
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.properties.debounceMs).toBeDefined();
    expect(manifest.configSchema.properties.enabled).toBeDefined();
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

  it("has fractal-prompt.md bundled", () => {
    expect(existsSync(join(EXT_DIR, "fractal-prompt.md"))).toBe(true);
    const content = readFileSync(join(EXT_DIR, "fractal-prompt.md"), "utf8");
    expect(content).toContain("FRACTAL REFLECTION");
    expect(content).toContain("Level 1");
    expect(content).toContain("Level 2");
    expect(content).toContain("Level 3");
    expect(content).toContain("Level 4");
  });

  it("imports only from plugin-sdk or relative paths (no src/** leaks)", () => {
    const indexContent = readFileSync(join(EXT_DIR, "index.ts"), "utf8");
    const srcLeaks = indexContent.match(/from\s+["'][^"']*\.\.\/\.\.\/src\//g);
    expect(srcLeaks).toBeNull();
  });

  it("src/fractal-inject.ts has no upstream imports", () => {
    const content = readFileSync(join(EXT_DIR, "src/fractal-inject.ts"), "utf8");
    const srcLeaks = content.match(/from\s+["'][^"']*\.\.\/\.\.\/\.\.\/src\//g);
    expect(srcLeaks).toBeNull();
  });
});
