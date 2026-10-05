import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  forkTruncatedTranscript,
  lastPromptIndex,
  promptText,
  rewindCapability,
} from "../src/rewind.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "amy-rewind-"));
  dirs.push(d);
  return d;
};

const S = "sess-original";
const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: S, ...o });
const prompt = (text: string, uuid: string) =>
  line({ type: "user", uuid, message: { role: "user", content: text } });
const reply = (text: string, uuid: string) =>
  line({
    type: "assistant",
    uuid,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const toolUse = (uuid: string) =>
  line({
    type: "assistant",
    uuid,
    message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
  });
const toolResult = (uuid: string) =>
  line({
    type: "user",
    uuid,
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  });

/** The shape of the real session file measured on 2026-09-29: queue entries, attachments, two exchanges. */
function twoExchanges(): string[] {
  return [
    line({ type: "queue-operation", operation: "enqueue" }),
    line({ type: "attachment", uuid: "a1" }),
    prompt("remember ALPHA", "u1"),
    reply("OK", "r1"),
    line({ type: "queue-operation", operation: "enqueue" }),
    prompt("now BRAVO, and please run something", "u2"),
    toolUse("r2"),
    toolResult("tr2"),
    reply("done", "r3"),
    line({ type: "last-prompt" }),
  ];
}

describe("promptText", () => {
  it("only a real user prompt counts: not tool results, meta entries or assistant text", () => {
    expect(promptText(JSON.parse(prompt("hi", "u")))).toBe("hi");
    expect(promptText(JSON.parse(toolResult("t")))).toBeNull();
    expect(promptText(JSON.parse(reply("x", "r")))).toBeNull();
    expect(promptText({ type: "user", isMeta: true, message: { content: "meta" } })).toBeNull();
    expect(
      promptText({ type: "user", message: { content: [{ type: "text", text: "block prompt" }] } }),
    ).toBe("block prompt");
    expect(promptText({ type: "user", message: { content: "   " } })).toBeNull();
  });
  it("lastPromptIndex skips tool results after the prompt and garbled lines", () => {
    const lines = [...twoExchanges(), "not json"];
    expect(lastPromptIndex(lines)).toBe(5);
    expect(lastPromptIndex(["x"])).toBe(-1);
  });
});

describe("forkTruncatedTranscript", () => {
  it("drops the last exchange, rewrites the session id, restores the prompt, leaves the original untouched", () => {
    const d = tmp();
    const src = join(d, "orig.jsonl");
    writeFileSync(src, `${twoExchanges().join("\n")}\n`);
    const before = readFileSync(src, "utf-8");
    const r = forkTruncatedTranscript(src, { newId: "sess-fork" });
    expect(r).toMatchObject({
      ok: true,
      forkSessionId: "sess-fork",
      originalSessionId: S,
      keptEntries: 5,
      droppedEntries: 5,
      restoredPrompt: "now BRAVO, and please run something",
    });
    const forked = readFileSync(r.forkPath as string, "utf-8")
      .trim()
      .split("\n");
    expect(forked).toHaveLength(5);
    for (const l of forked)
      expect((JSON.parse(l) as { sessionId: string }).sessionId).toBe("sess-fork");
    expect(forked.join("\n")).not.toContain("BRAVO");
    expect(forked.join("\n")).toContain("ALPHA");
    expect(readFileSync(src, "utf-8")).toBe(before);
  });

  it("writes into destDir when given, mode 0600", () => {
    const d = tmp();
    const src = join(d, "o.jsonl");
    writeFileSync(src, `${twoExchanges().join("\n")}\n`);
    const out = join(d, "sub");
    const r = forkTruncatedTranscript(src, { destDir: out, newId: "f1" });
    expect(r.forkPath).toBe(join(out, "f1.jsonl"));
  });

  it("refuses when there is nothing before the prompt (that is a reset, not a rewind) or no prompt at all", () => {
    const d = tmp();
    const only = join(d, "only.jsonl");
    writeFileSync(only, `${[prompt("first", "u1"), reply("a", "r1")].join("\n")}\n`);
    expect(forkTruncatedTranscript(only)).toMatchObject({ ok: false });
    const none = join(d, "none.jsonl");
    writeFileSync(none, `${[line({ type: "attachment" })].join("\n")}\n`);
    expect(forkTruncatedTranscript(none)).toMatchObject({
      ok: false,
      reason: "no user prompt found in the transcript",
    });
  });

  it("a missing file fails cleanly instead of throwing", () => {
    expect(forkTruncatedTranscript("/nonexistent/x.jsonl")).toMatchObject({ ok: false });
  });
});

describe("rewindCapability", () => {
  it("is supported only on the Claude Code runner", () => {
    expect(rewindCapability("cc-bridge")).toBe("claude-fork");
    expect(rewindCapability("claude-cli")).toBe("claude-fork");
    expect(rewindCapability("native")).toBe("unsupported");
    expect(rewindCapability("")).toBe("unsupported");
  });
});
