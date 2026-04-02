import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// extensions/tinkerclaw-identity-persistence/__tests__/scaffold.test.ts
import { describe, it, expect } from "vitest";

const EXT_DIR = join(__dirname, "..");

describe("Identity Persistence scaffold", () => {
  it("has a valid plugin manifest", () => {
    const raw = readFileSync(join(EXT_DIR, "openclaw.plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.id).toBe("tinkerclaw-identity-persistence");
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.properties.syncScoreThreshold).toBeDefined();
  });

  it("has a package.json with openclaw.extensions", () => {
    const raw = readFileSync(join(EXT_DIR, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    expect(pkg.openclaw?.extensions).toBeDefined();
  });

  it("has an index.ts entry point", () => {
    expect(existsSync(join(EXT_DIR, "index.ts"))).toBe(true);
  });

  it("imports only from plugin-sdk or relative paths", () => {
    const content = readFileSync(join(EXT_DIR, "index.ts"), "utf8");
    const srcLeaks = content.match(/from\s+["'][^"']*\.\.\/\.\.\/src\//g);
    expect(srcLeaks).toBeNull();
  });
});
