import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_EVIDENCE_READ_BYTES, readEvidenceFile } from "../src/types.js";

describe("readEvidenceFile (bounded read of model-named paths)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fractal-evidence-"));

  it("reads a small regular file", () => {
    const f = join(dir, "ok.txt");
    writeFileSync(f, "quoted line");
    expect(readEvidenceFile(f)).toBe("quoted line");
  });

  it("refuses directories, missing paths and oversized files", () => {
    expect(readEvidenceFile(dir)).toBeNull();
    expect(readEvidenceFile(join(dir, "nope.txt"))).toBeNull();
    const big = join(dir, "big.txt");
    writeFileSync(big, Buffer.alloc(MAX_EVIDENCE_READ_BYTES + 1, 97));
    expect(readEvidenceFile(big)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without blocking", () => {
    const fifo = join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    expect(readEvidenceFile(fifo)).toBeNull();
  });
});
