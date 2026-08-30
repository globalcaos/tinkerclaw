import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const EXT_DIR = join(__dirname, "..");
const REPO_ROOT = join(EXT_DIR, "..", "..");

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

  // ---------------------------------------------------------------------------
  // The three assertions that used to live here did the OPPOSITE of their intent.
  //
  //   1. "imports only from plugin-sdk or relative paths (no src/** leaks)"
  //   2. "has all 26 source files in src/"
  //   3. "no source files import from upstream paths (../../)"
  //
  // Together they FORBADE reusing src/memory/engram/ and then FROZE the private
  // copy that prohibition forced into existence. The result was a 26-file twin
  // that drifted for four months: it grew a second `vectorSearch` alongside the
  // one its own byte-identical `search-index.ts` already exported, a
  // `temporal-decay.ts` whose header claimed a wiring that did not exist, and a
  // `knowledge-compiler.ts` that never executed on any path. Meanwhile the
  // `engram:retrieval-pack-inject` instrument was attached to whichever copy was
  // dead, so the liveness registry reported the exact inverse of the truth.
  //
  // A test that asserts a duplicate still exists is not a guard. It is life
  // support — the same shape that kept 3,192 dead amygdala lines in the build on
  // four `expect(mod).toBeDefined()` calls.
  //
  // They are replaced by their inverses: the library must live ONCE, and this
  // extension must be a thin adapter over it.
  // See TINKER_UI_DESIGN_BIBLE/canonical-derivations.md.
  // ---------------------------------------------------------------------------

  it("does NOT vendor a private copy of the ENGRAM library", () => {
    // The former src/ tree held 26+ modules duplicating src/memory/engram/.
    // If it ever comes back, this fails before the copies can drift again.
    expect(existsSync(join(EXT_DIR, "src"))).toBe(false);
  });

  it("sources ENGRAM from the single canonical library via the SDK surface", () => {
    const indexContent = readFileSync(join(EXT_DIR, "index.ts"), "utf8");

    // The sanctioned crossing. NOT a relative reach into ../../src/ — extensions
    // may not import the repo src/ tree directly
    // (pnpm lint:plugins:no-extension-src-imports), and satisfying that rule by
    // vendoring a copy is what produced the twin in the first place.
    expect(
      indexContent,
      "index.ts must import ENGRAM from openclaw/plugin-sdk/memory-engram",
    ).toMatch(/from\s+["']openclaw\/plugin-sdk\/memory-engram["']/);

    // …and must reach for neither a sibling copy nor the src/ tree directly.
    expect(indexContent).not.toMatch(/from\s+["']\.\/src\//);
    expect(indexContent).not.toMatch(/from\s+["'][^"']*\.\.\/\.\.\/src\//);
  });

  it("the SDK surface exists and re-exports what this plugin imports", () => {
    // Asserts the actual dependency chain — plugin -> SDK surface -> library —
    // so it fails when a module is renamed or moved. The old version listed 26
    // filenames under the extension and therefore only ever asserted that a
    // directory had not been tidied.
    const sdkPath = join(REPO_ROOT, "src", "plugin-sdk", "memory-engram.ts");
    expect(existsSync(sdkPath), "src/plugin-sdk/memory-engram.ts is missing").toBe(true);

    const sdk = readFileSync(sdkPath, "utf8");
    for (const symbol of [
      "createEventStore",
      "createIngestionPipeline",
      "recall",
      "assembleRetrievalPack",
    ]) {
      expect(sdk, `the SDK surface must re-export ${symbol}`).toContain(symbol);
    }

    for (const file of [
      "event-store.ts",
      "ingestion.ts",
      "recall-tool.ts",
      "retrieval-integration.ts",
    ]) {
      expect(
        existsSync(join(REPO_ROOT, "src", "memory", "engram", file)),
        `src/memory/engram/${file} backs the SDK surface but is missing`,
      ).toBe(true);
    }
  });

  it("stays a thin adapter — no .ts modules beside index.ts", () => {
    // The plugin is an adapter: manifest, entry point, tests. Business logic
    // belongs in src/memory/engram/ where one owner maintains it. A new module
    // appearing here is how the twin started.
    const stray = readdirSync(EXT_DIR).filter(
      (f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".d.ts"),
    );
    expect(stray, `unexpected modules in the plugin root: ${stray.join(", ")}`).toEqual([]);
  });
});
