import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { writeSystemPromptFile } from "./worker.js";

// Regression: a system prompt over 128 KB of UTF-8 on argv killed the spawn
// with E2BIG (2026-09-22). It now travels by --append-system-prompt-file.
describe("writeSystemPromptFile", () => {
  it("round-trips a prompt far beyond the 128 KB argv cap", () => {
    const prompt = "🎛️ persona ñ ".repeat(20_000); // ~340 KB of UTF-8
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(131_072);
    const file = writeSystemPromptFile("agent:main:tinker:test", prompt);
    expect(file).not.toBeNull();
    try {
      expect(fs.readFileSync(file!, "utf8")).toBe(prompt);
      expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    } finally {
      fs.unlinkSync(file!);
    }
  });

  it("drops NUL bytes exactly like the argv route", () => {
    const file = writeSystemPromptFile("k", "a\u0000b");
    try {
      expect(fs.readFileSync(file!, "utf8")).toBe("ab");
    } finally {
      fs.unlinkSync(file!);
    }
  });
});
