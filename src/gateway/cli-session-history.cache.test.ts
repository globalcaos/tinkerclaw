import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __claudeCliTranscriptCacheTesting as cache,
  CLAUDE_CLI_TRANSCRIPT_CACHE_MAX_FILES,
  readClaudeCliSessionMessages,
} from "./cli-session-history.claude.js";

// FORK 2026-09-14 — the incremental transcript cache behind readClaudeCliSessionMessages.
// Contract under test: what the cache serves is exactly what a cold full read serves, while an
// unchanged file costs no I/O and a grown file costs only its tail. See the header comment above
// the cache in cli-session-history.claude.ts for the measured incident that motivated it.

const ORIGINAL_HOME = process.env.HOME;

let root = "";
let homeDir = "";
let projectsDir = "";

function userLine(uuid: string, text: string, ts = "2026-09-14T10:00:00.000Z"): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: ts,
    message: { role: "user", content: text },
  });
}
function assistantLine(uuid: string, text: string, ts = "2026-09-14T10:00:01.000Z"): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: ts,
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    },
  });
}
function toolCallLine(uuid: string, toolUseId: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: "2026-09-14T10:00:02.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "pwd" } }],
      stop_reason: "tool_use",
    },
  });
}
function toolResultLine(uuid: string, toolUseId: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-09-14T10:00:03.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "/tmp/demo" }],
    },
  });
}

function transcriptPath(sessionId: string): string {
  return path.join(projectsDir, `${sessionId}.jsonl`);
}
function writeTranscript(sessionId: string, lines: string[], trailingNewline = true): string {
  const p = transcriptPath(sessionId);
  fs.writeFileSync(p, lines.join("\n") + (trailingNewline ? "\n" : ""), "utf-8");
  return p;
}
function appendTranscript(sessionId: string, text: string): void {
  fs.appendFileSync(transcriptPath(sessionId), text, "utf-8");
}
/** Bump mtime so a same-size rewrite is observable; also guards against coarse mtime clocks. */
function touchLater(p: string, plusMs = 2_000): void {
  const st = fs.statSync(p);
  const later = new Date(st.mtimeMs + plusMs);
  fs.utimesSync(p, later, later);
}
function textsOf(messages: Record<string, unknown>[]): string[] {
  return messages.map((m) => {
    const role = String(m.role);
    const c = m.content;
    if (typeof c === "string") {
      return `${role}:${c}`;
    }
    if (Array.isArray(c)) {
      const blocks = c
        .map((b) => (b && typeof b === "object" ? ((b as { type?: string }).type ?? "?") : "?"))
        .join("+");
      return `${role}:${blocks}`;
    }
    return `${role}:?`;
  });
}
function coldRead(sessionId: string): Record<string, unknown>[] {
  cache.reset();
  return readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-history-cache-"));
  homeDir = path.join(root, "home");
  projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  fs.mkdirSync(projectsDir, { recursive: true });
  process.env.HOME = homeDir;
  cache.reset();
});

afterEach(() => {
  cache.reset();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("claude-cli transcript cache", () => {
  it("an unchanged transcript is served from memory: one full read, then hits", () => {
    const sid = "11111111-1111-4111-8111-111111111111";
    writeTranscript(sid, [userLine("u1", "hi"), assistantLine("a1", "hello")]);

    const first = readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    const second = readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    const third = readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });

    expect(textsOf(first)).toEqual(["user:hi", "assistant:text"]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(cache.stats()).toMatchObject({ fullReads: 1, hits: 2, tailReads: 0, resets: 0 });
  });

  it("serves a fresh copy each time: mutating a served message never reaches the cache", () => {
    const sid = "22222222-2222-4222-8222-222222222222";
    writeTranscript(sid, [userLine("u1", "hi"), assistantLine("a1", "hello")]);

    const served = readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    served[0].content = "TAMPERED";
    (served[1].content as Record<string, unknown>[])[0].text = "TAMPERED";
    (served[1] as Record<string, unknown>).injected = true;

    const again = readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    expect(again[0].content).toBe("hi");
    expect((again[1].content as Record<string, unknown>[])[0].text).toBe("hello");
    expect("injected" in again[1]).toBe(false);
    expect(cache.stats().hits).toBe(1);
  });

  it("a grown transcript costs only a tail read and serves what a cold read serves", () => {
    const sid = "33333333-3333-4333-8333-333333333333";
    const p = writeTranscript(sid, [userLine("u1", "hi"), assistantLine("a1", "hello")]);
    readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });

    appendTranscript(sid, `${userLine("u2", "and then?")}\n${assistantLine("a2", "more")}\n`);
    touchLater(p);
    const warm = readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    expect(textsOf(warm)).toEqual([
      "user:hi",
      "assistant:text",
      "user:and then?",
      "assistant:text",
    ]);
    expect(cache.stats()).toMatchObject({ fullReads: 1, tailReads: 1, resets: 0 });

    expect(warm).toEqual(coldRead(sid));
  });

  it("a tool call/result pair split across two appends coalesces like a single full read", () => {
    const sid = "44444444-4444-4444-8444-444444444444";
    const p = writeTranscript(sid, [userLine("u1", "run pwd"), toolCallLine("a1", "toolu_1")]);
    const before = readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    expect(before).toHaveLength(2);
    expect(before[1].role).toBe("assistant");
    expect(before[1].content).toHaveLength(1);

    appendTranscript(sid, `${toolResultLine("u2", "toolu_1")}\n${assistantLine("a2", "done")}\n`);
    touchLater(p);
    const warm = readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    // The call and its result are merged into ONE assistant row (two blocks), exactly as a full
    // parse does — the user tool_result row does not survive as a separate row.
    expect(warm.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(warm[1].content).toHaveLength(2);
    expect(cache.stats().tailReads).toBe(1);
    expect(warm).toEqual(coldRead(sid));
  });

  it("a half-written trailing line is served but not committed, then re-read whole", () => {
    const sid = "55555555-5555-4555-8555-555555555555";
    const p = writeTranscript(sid, [userLine("u1", "hi"), assistantLine("a1", "hello")]);
    readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });

    // Writer got pre-empted mid-line: a complete JSON object but no newline yet.
    const partial = userLine("u2", "partial-but-complete-json");
    appendTranscript(sid, partial);
    touchLater(p);
    const midWrite = readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    expect(textsOf(midWrite)).toEqual([
      "user:hi",
      "assistant:text",
      "user:partial-but-complete-json",
    ]);
    expect(cache.stats().tailReads).toBe(1);

    // The newline lands (plus another row). The pending line must appear exactly ONCE.
    appendTranscript(sid, `\n${assistantLine("a2", "ok")}\n`);
    touchLater(p, 4_000);
    const settled = readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    expect(textsOf(settled)).toEqual([
      "user:hi",
      "assistant:text",
      "user:partial-but-complete-json",
      "assistant:text",
    ]);
    expect(cache.stats()).toMatchObject({ fullReads: 1, tailReads: 2, resets: 0 });
    expect(settled).toEqual(coldRead(sid));
  });

  it("a truly torn line (invalid JSON so far) is ignored until it completes", () => {
    const sid = "66666666-6666-4666-8666-666666666666";
    const p = writeTranscript(sid, [userLine("u1", "hi")]);
    readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });

    const full = assistantLine("a1", "hello");
    appendTranscript(sid, full.slice(0, 40));
    touchLater(p);
    expect(textsOf(readClaudeCliSessionMessages({ cliSessionId: sid, homeDir }))).toEqual([
      "user:hi",
    ]);

    appendTranscript(sid, `${full.slice(40)}\n`);
    touchLater(p, 4_000);
    expect(textsOf(readClaudeCliSessionMessages({ cliSessionId: sid, homeDir }))).toEqual([
      "user:hi",
      "assistant:text",
    ]);
  });

  it("a shrunk or rewritten transcript falls back to a full re-read", () => {
    const sid = "77777777-7777-4777-8777-777777777777";
    writeTranscript(sid, [
      userLine("u1", "one"),
      assistantLine("a1", "1"),
      userLine("u2", "two"),
      assistantLine("a2", "2"),
    ]);
    readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });

    // Shrunk (e.g. a reset): fewer bytes than the committed offset.
    const p = writeTranscript(sid, [userLine("u9", "fresh")]);
    touchLater(p);
    expect(textsOf(readClaudeCliSessionMessages({ cliSessionId: sid, homeDir }))).toEqual([
      "user:fresh",
    ]);
    expect(cache.stats()).toMatchObject({ fullReads: 2, resets: 1 });

    // Rewritten in place to a LONGER file whose old prefix is gone: the byte before the old
    // offset is no longer a newline, so the tail path is refused and the file is re-read whole.
    const longer = writeTranscript(sid, [
      userLine("u1", "a totally different first line that is long"),
      assistantLine("a1", "x"),
    ]);
    touchLater(longer, 4_000);
    expect(textsOf(readClaudeCliSessionMessages({ cliSessionId: sid, homeDir }))).toEqual([
      "user:a totally different first line that is long",
      "assistant:text",
    ]);
    expect(readClaudeCliSessionMessages({ cliSessionId: sid, homeDir })).toEqual(coldRead(sid));
  });

  it("the periodic re-verify forces a full read even when size and mtime look unchanged", () => {
    const sid = "88888888-8888-4888-8888-888888888888";
    const p = writeTranscript(sid, [userLine("u1", "hi"), assistantLine("a1", "hello")]);
    readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    expect(cache.expireVerification(p)).toBe(true);
    readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    expect(cache.stats()).toMatchObject({ fullReads: 2, resets: 1 });
  });

  it("evicts the least recently used transcript beyond the cap", () => {
    const ids: string[] = [];
    for (let i = 0; i <= CLAUDE_CLI_TRANSCRIPT_CACHE_MAX_FILES; i += 1) {
      const sid = `9999${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`;
      ids.push(sid);
      writeTranscript(sid, [userLine(`u${i}`, `hi ${i}`)]);
    }
    for (const sid of ids) {
      readClaudeCliSessionMessages({ cliSessionId: sid, homeDir });
    }
    expect(cache.size()).toBe(CLAUDE_CLI_TRANSCRIPT_CACHE_MAX_FILES);
    // The first one read is the one evicted: reading it again is a full read, not a hit.
    const before = cache.stats().fullReads;
    readClaudeCliSessionMessages({ cliSessionId: ids[0], homeDir });
    expect(cache.stats().fullReads).toBe(before + 1);
  });

  it("a missing transcript still yields [] and caches nothing", () => {
    expect(
      readClaudeCliSessionMessages({
        cliSessionId: "00000000-0000-4000-8000-00000000dead",
        homeDir,
      }),
    ).toEqual([]);
    expect(cache.size()).toBe(0);
  });
});
