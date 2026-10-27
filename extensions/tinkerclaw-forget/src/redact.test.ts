import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMatcher } from "./matcher.js";
import { fileHolds, redactFile, sniffKind } from "./redact.js";

const TOKEN = "[forgotten 2026-10-25]";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forget-redact-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("redactFile", () => {
  it("replaces the fact in a note and keeps every other byte, CRLF and a missing last newline included", async () => {
    const p = join(dir, "note.md");
    writeFileSync(
      p,
      "# Contacts\r\nDad: +34 600 11 12 22\nnothing here\nend without newline 34600111222",
    );
    const m = buildMatcher("+34 600 11 12 22");
    const out = await redactFile(p, m, TOKEN, { dryRun: false });
    expect(out).toMatchObject({ lines: 2, copies: 2, unredacted: 0, wrote: true });
    expect(readFileSync(p, "utf8")).toBe(
      `# Contacts\r\nDad: ${TOKEN}\nnothing here\nend without newline ${TOKEN}`,
    );
  });

  it("keeps each JSONL record valid and leaves untouched lines byte-identical", async () => {
    const p = join(dir, "s.jsonl");
    const untouched = '{"type":"session","id":"x",  "spaced":true}';
    const lines = [
      untouched,
      JSON.stringify({
        message: { role: "user", content: [{ type: "text", text: "my number is 600 111 222" }] },
      }),
      JSON.stringify({ phone: 600111222 }),
    ];
    writeFileSync(p, `${lines.join("\n")}\n`);
    const out = await redactFile(p, buildMatcher("600111222"), TOKEN, { dryRun: false });
    expect(out).toMatchObject({ lines: 2, unredacted: 0, wrote: true });
    const after = readFileSync(p, "utf8").split("\n");
    expect(after[0]).toBe(untouched);
    expect(JSON.parse(after[1]).message.content[0].text).toBe(`my number is ${TOKEN}`);
    expect(JSON.parse(after[2])).toEqual({ phone: TOKEN });
    expect(after[3]).toBe("");
  });

  it("a dry run counts and writes nothing; a file without the fact is never rewritten", async () => {
    const p = join(dir, "a.md");
    writeFileSync(p, "Dad: 600111222\n");
    const before = statSync(p).mtimeMs;
    const dry = await redactFile(p, buildMatcher("600111222"), TOKEN, { dryRun: true });
    expect(dry).toMatchObject({ lines: 1, copies: 1, wrote: false });
    expect(readFileSync(p, "utf8")).toBe("Dad: 600111222\n");
    const clean = join(dir, "b.md");
    writeFileSync(clean, "nothing\n");
    const none = await redactFile(clean, buildMatcher("600111222"), TOKEN, { dryRun: false });
    expect(none).toMatchObject({ lines: 0, wrote: false });
    expect(statSync(p).mtimeMs).toBe(before);
  });

  it("keeps a pretty-printed JSON file valid", async () => {
    const p = join(dir, "short-term.json");
    writeFileSync(p, JSON.stringify({ items: [{ text: "Dad +34 600 11 12 22" }] }, null, 2));
    await redactFile(p, buildMatcher("+34 600 11 12 22"), TOKEN, { dryRun: false });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ items: [{ text: `Dad ${TOKEN}` }] });
  });
});

describe("fileHolds / sniffKind", () => {
  it("finds a fact that straddles two read chunks", async () => {
    const p = join(dir, "big.txt");
    const pad = "x".repeat((1 << 20) - 5);
    writeFileSync(p, `${pad} 600111222 tail`);
    expect(await fileHolds(p, buildMatcher("600111222"))).toBe(true);
    expect(await fileHolds(p, buildMatcher("700111222"))).toBe(false);
  });

  it("tells a binary store from text by a NUL byte", async () => {
    const bin = join(dir, "x.sqlite");
    writeFileSync(bin, Buffer.from([0x53, 0x51, 0x00, 0x4c]));
    const txt = join(dir, "x.txt");
    writeFileSync(txt, "plain");
    expect(await sniffKind(bin)).toBe("binary");
    expect(await sniffKind(txt)).toBe("text");
  });
});
