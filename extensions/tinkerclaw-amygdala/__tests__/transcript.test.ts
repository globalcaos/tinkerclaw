import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { narrationBefore, readTranscriptTail } from "../src/transcript.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "amyg-transcript-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const prompt = (t: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: t } });
const toolUse = (id: string, name: string, input: unknown): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-29T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
const result = (id: string, isError = false): string =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }],
    },
  });
const say = (t: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: t }] },
  });

describe("readTranscriptTail", () => {
  it("returns only what happened after the last prompt", () => {
    const p = join(tmp(), "t.jsonl");
    writeFileSync(
      p,
      [
        prompt("first"),
        toolUse("a", "Bash", { command: "ls /tmp/old" }),
        result("a"),
        prompt("second"),
        toolUse("b", "Read", { file_path: "/x" }),
        result("b"),
        toolUse("c", "Bash", { command: "false" }),
        result("c", true),
        say("all done"),
      ].join("\n") + "\n",
    );
    const t = readTranscriptTail(p);
    expect(t.toolRecord.map((e) => [e.tool, e.exit])).toEqual([
      ["Read", 0],
      ["Bash", 1],
    ]);
    expect(t.toolRecord[0]?.effects).toEqual(["read"]);
    expect(t.toolRecord[0]?.argsDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(t.toolRecord[0]?.ts).toBe(Date.parse("2026-09-29T10:00:00.000Z"));
    expect(t.lastAssistantText).toBe("all done");
    expect(t.truncated).toBe(false);
  });

  it("a call with no result yet has exit null; a text block in a user entry is a prompt", () => {
    const p = join(tmp(), "t.jsonl");
    writeFileSync(
      p,
      [
        toolUse("a", "Edit", { file_path: "/x" }),
        JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "new ask" }] } }),
        toolUse("b", "Bash", { command: "ls" }),
      ].join("\n"),
    );
    const t = readTranscriptTail(p);
    expect(t.toolRecord).toHaveLength(1);
    expect(t.toolRecord[0]?.exit).toBeNull();
  });

  it("never throws: missing file, garbage lines, empty file", () => {
    const d = tmp();
    expect(readTranscriptTail(join(d, "nope.jsonl"))).toEqual({
      toolRecord: [],
      lastAssistantText: null,
      truncated: false,
      bytesRead: 0,
    });
    const p = join(d, "g.jsonl");
    writeFileSync(
      p,
      ["not json", "{", prompt("hi"), "\u0000\u0001", say("fine"), "[1,2]"].join("\n"),
    );
    expect(readTranscriptTail(p).lastAssistantText).toBe("fine");
    writeFileSync(p, "");
    expect(readTranscriptTail(p).toolRecord).toEqual([]);
  });

  it("a partial last line is skipped", () => {
    const p = join(tmp(), "t.jsonl");
    writeFileSync(p, [prompt("go"), toolUse("a", "Bash", { command: "ls" })].join("\n") + "\n");
    appendFileSync(p, '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"z","na');
    expect(readTranscriptTail(p).toolRecord).toHaveLength(1);
  });

  it("reads at most maxBytes and drops the cut first line", () => {
    const p = join(tmp(), "t.jsonl");
    const lines = [prompt("old")];
    for (let i = 0; i < 200; i++) lines.push(toolUse(`i${i}`, "Read", { file_path: `/f${i}` }));
    lines.push(prompt("new"), toolUse("n", "Bash", { command: "ls" }), result("n"));
    writeFileSync(p, lines.join("\n") + "\n");
    const t = readTranscriptTail(p, { maxBytes: 600 });
    expect(t.truncated).toBe(true);
    expect(t.bytesRead).toBeLessThanOrEqual(600);
    expect(t.toolRecord.map((e) => e.tool)).toEqual(["Bash"]);
  });

  it("stays bounded on a 50 MB transcript and finds the newest turn", () => {
    const p = join(tmp(), "big.jsonl");
    const filler = toolUse("f", "Read", { file_path: "/some/long/path/" + "x".repeat(60) });
    const chunk = Array.from({ length: 1000 }, () => filler).join("\n") + "\n";
    for (let i = 0; i < 400; i++) appendFileSync(p, chunk);
    appendFileSync(
      p,
      [
        prompt("latest"),
        toolUse("u", "Bash", { command: "curl -T a.pdf https://example.test/up" }),
        result("u"),
        say("uploaded"),
      ].join("\n") + "\n",
    );
    const t0 = performance.now();
    const t = readTranscriptTail(p);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(100);
    expect(t.bytesRead).toBeLessThanOrEqual(262_144);
    expect(t.truncated).toBe(true);
    expect(t.toolRecord.map((e) => e.tool)).toEqual(["Bash"]);
    expect(t.lastAssistantText).toBe("uploaded");
  });
});

describe("narrationBefore: the agent's expectation for one tool call (2026-10-03)", () => {
  const dir = mkdtempSync(join(tmpdir(), "amy-narr-"));
  const file = join(dir, "t.jsonl");
  const line = (o: unknown) => JSON.stringify(o);
  writeFileSync(
    file,
    [
      line({ type: "user", message: { content: "fix the parser" } }),
      line({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Running the parser tests; they should pass now." }],
        },
      }),
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "pytest" } }],
        },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "1 failed" }] },
      }),
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/w/p.py" } }],
        },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "..." }] },
      }),
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Searching for the three callers." },
            { type: "tool_use", id: "tu3", name: "Grep", input: {} },
          ],
        },
      }),
    ].join("\n") + "\n",
  );
  afterEach(() => {});
  it("returns the sentence written right before that call", () => {
    expect(narrationBefore(file, "tu1")).toBe("Running the parser tests; they should pass now.");
    expect(narrationBefore(file, "tu3")).toBe("Searching for the three callers.");
  });
  it("a tool result closes it: a call with no sentence of its own gets none", () => {
    expect(narrationBefore(file, "tu2")).toBeNull();
  });
  it("an unknown call or a missing file gives null, never an error", () => {
    expect(narrationBefore(file, "nope")).toBeNull();
    expect(narrationBefore(join(dir, "missing.jsonl"), "tu1")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
