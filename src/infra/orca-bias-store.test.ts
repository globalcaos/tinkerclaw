import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearOrcaBiasCache, orcaBiasFilePath, readOrcaBias } from "./orca-bias-store.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-bias-"));
  dirs.push(dir);
  return dir;
}

function tempFile(): string {
  return join(tempDir(), "orca-bias.json");
}

afterEach(() => {
  clearOrcaBiasCache();
  delete process.env.OPENCLAW_ORCA_BIAS_FILE;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readOrcaBias", () => {
  it("reads back exactly what the prefrontal dial writes", () => {
    const file = tempFile();
    // Byte-for-byte the payload `prefrontal.orcaBias` produces.
    writeFileSync(file, `${JSON.stringify({ biasIdx: 5, ts: Date.now() })}\n`);
    expect(readOrcaBias({ file })).toBe(5);
  });

  it("rounds and clamps a position outside the dial's range", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ biasIdx: 99 }));
    expect(readOrcaBias({ file })).toBe(6);
    clearOrcaBiasCache();
    writeFileSync(file, JSON.stringify({ biasIdx: -4 }));
    expect(readOrcaBias({ file })).toBe(0);
    clearOrcaBiasCache();
    writeFileSync(file, JSON.stringify({ biasIdx: 2.6 }));
    expect(readOrcaBias({ file })).toBe(3);
  });

  it("returns undefined for a corrupt file instead of throwing", () => {
    const file = tempFile();
    writeFileSync(file, "{not json");
    expect(() => readOrcaBias({ file })).not.toThrow();
    expect(readOrcaBias({ file })).toBeUndefined();
  });

  it("treats a null / absent / non-numeric biasIdx as no preference, never as stop 0", () => {
    // `Number(null)` is 0, which would silently read as the FAST end of the dial —
    // the exact coercion this guard exists to refuse. The read side of
    // `prefrontal.orcaBias` answers `{biasIdx: null}` when nothing was ever set.
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ biasIdx: null }));
    expect(readOrcaBias({ file })).toBeUndefined();
    clearOrcaBiasCache();
    writeFileSync(file, JSON.stringify({ ts: 1 }));
    expect(readOrcaBias({ file })).toBeUndefined();
    clearOrcaBiasCache();
    writeFileSync(file, JSON.stringify({ biasIdx: "smart" }));
    expect(readOrcaBias({ file })).toBeUndefined();
  });

  it("returns undefined when the file does not exist", () => {
    expect(readOrcaBias({ file: join(tempDir(), "missing.json") })).toBeUndefined();
  });

  it("honours OPENCLAW_ORCA_BIAS_FILE so a test never touches the real dial", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ biasIdx: 1 }));
    process.env.OPENCLAW_ORCA_BIAS_FILE = file;
    expect(orcaBiasFilePath()).toBe(file);
    expect(readOrcaBias()).toBe(1);
    // An explicit path still wins over the env var.
    const other = tempFile();
    writeFileSync(other, JSON.stringify({ biasIdx: 4 }));
    expect(readOrcaBias({ file: other })).toBe(4);
  });

  it("serves the cache until the file changes, then re-reads it", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ biasIdx: 0 }));
    expect(readOrcaBias({ file })).toBe(0);
    expect(readOrcaBias({ file })).toBe(0);
    // A LONGER payload, so the (mtimeMs, size) key changes even if the filesystem
    // clock has not ticked between the two writes.
    writeFileSync(file, `${JSON.stringify({ biasIdx: 6, ts: Date.now() })}\n`);
    expect(readOrcaBias({ file })).toBe(6);
  });

  it("stops serving a cached value once the file is deleted", () => {
    const dir = tempDir();
    const file = join(dir, "orca-bias.json");
    writeFileSync(file, JSON.stringify({ biasIdx: 6 }));
    expect(readOrcaBias({ file })).toBe(6);
    rmSync(file);
    expect(readOrcaBias({ file })).toBeUndefined();
  });
});
