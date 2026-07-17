import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeProjectDir,
  isTranscriptOversized,
  resolveTranscriptPath,
} from "./transcript-path.js";

describe("encodeProjectDir", () => {
  it("replaces every non-alphanumeric char with '-' (matches claude-cli layout)", () => {
    // Verified against the live host layout:
    // /home/user/.openclaw -> -home-user--openclaw
    expect(encodeProjectDir("/home/user/.openclaw")).toBe("-home-user--openclaw");
  });

  it("collapses nothing — each separator/dot is its own dash", () => {
    expect(encodeProjectDir("/a.b/c")).toBe("-a-b-c");
  });
});

describe("resolveTranscriptPath", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tp-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("builds ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl", () => {
    const p = resolveTranscriptPath("/work/dir", "abc-123");
    expect(p).toBe(path.join(tmpHome, ".claude", "projects", "-work-dir", "abc-123.jsonl"));
  });

  it("resolves a relative cwd to absolute before encoding", () => {
    const expectedEncoded = encodeProjectDir(path.resolve("rel/sub"));
    const p = resolveTranscriptPath("rel/sub", "s1");
    expect(p).toBe(path.join(tmpHome, ".claude", "projects", expectedEncoded, "s1.jsonl"));
  });
});

describe("isTranscriptOversized", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-size-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when file size strictly exceeds maxBytes", () => {
    const f = path.join(tmpDir, "big.jsonl");
    fs.writeFileSync(f, Buffer.alloc(1024));
    expect(isTranscriptOversized(f, 1023)).toBe(true);
  });

  it("returns false when file size equals maxBytes (strict >)", () => {
    const f = path.join(tmpDir, "exact.jsonl");
    fs.writeFileSync(f, Buffer.alloc(1000));
    expect(isTranscriptOversized(f, 1000)).toBe(false);
  });

  it("returns false (fail-open) for a missing file", () => {
    expect(isTranscriptOversized(path.join(tmpDir, "nope.jsonl"), 1)).toBe(false);
  });
});
