import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaudeCliTranscriptSlice } from "../cli-session-history.claude.js";
import { createAskSessionHandlers } from "./ask-session.js";

// FORK 2026-10-21 — the purple ask-session card loads the bytes a woken session appended to its own
// transcript. `sessions.py ask` records the range; these tests pin what that range serves.

let homeDir = "";
let file = "";
const SID = "4e4c3737-d158-46a5-a7e8-d54e915a48d2";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const before = [
  line({ type: "user", uuid: "u0", message: { role: "user", content: "old prompt" } }),
  line({
    type: "assistant",
    uuid: "a0",
    message: { role: "assistant", content: [{ type: "text", text: "old answer" }] },
  }),
].join("");
const wake = [
  line({ type: "queue-operation", operation: "enqueue" }),
  line({ type: "user", uuid: "u1", message: { role: "user", content: "⟦ASK-SESSION⟧ why?" } }),
  // Claude Code writes one content block per transcript line.
  line({
    type: "assistant",
    uuid: "a1t",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "check the note" }] },
  }),
  line({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x/note.md" } }],
    },
  }),
  line({
    type: "user",
    uuid: "u2",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu1", content: "the note says FTS5" }],
    },
  }),
  line({
    type: "assistant",
    uuid: "a2",
    message: { role: "assistant", content: [{ type: "text", text: "Because FTS5." }] },
  }),
].join("");

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-slice-"));
  const dir = path.join(homeDir, ".claude", "projects", "-tmp-proj");
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, before + wake);
});
afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("readClaudeCliTranscriptSlice", () => {
  it("serves only the wake's bytes, parsed and coalesced like chat.history", () => {
    const from = Buffer.byteLength(before);
    const s = readClaudeCliTranscriptSlice({ cliSessionId: SID, fromByte: from, homeDir })!;
    expect(s.fromByte).toBe(from);
    expect(s.toByte).toBe(fs.statSync(file).size);
    expect(s.truncated).toBe(false);
    const texts = JSON.stringify(s.messages);
    expect(texts).not.toContain("old answer");
    expect(s.messages[0]).toMatchObject({ role: "user", content: "⟦ASK-SESSION⟧ why?" });
    // the tool call and its result are one message, as in the main feed
    const types = (i: number) =>
      (s.messages[i] as { content: Array<{ type: string }> }).content.map((b) => b.type);
    expect(types(1)).toEqual(["thinking"]);
    expect(types(2)).toEqual(["toolcall", "tool_result"]);
    expect(s.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(texts).toContain("Because FTS5.");
  });

  it("skips the rest of a line when the start falls inside one", () => {
    const from = Buffer.byteLength(before) + 5;
    const s = readClaudeCliTranscriptSlice({ cliSessionId: SID, fromByte: from, homeDir })!;
    expect(s.fromByte).toBeGreaterThan(from);
    expect(s.messages[0]).toMatchObject({ role: "user", content: "⟦ASK-SESSION⟧ why?" });
  });

  it("cuts an oversized range at the last whole line", () => {
    const from = Buffer.byteLength(before);
    const s = readClaudeCliTranscriptSlice({
      cliSessionId: SID,
      fromByte: from,
      homeDir,
      maxBytes: Buffer.byteLength(wake) - 10,
    })!;
    expect(s.truncated).toBe(true);
    expect(JSON.stringify(s.messages)).not.toContain("Because FTS5.");
  });

  it("refuses an id that is a path, and a session that is not on disk", () => {
    expect(readClaudeCliTranscriptSlice({ cliSessionId: "../x", fromByte: 0, homeDir })).toBeNull();
    expect(readClaudeCliTranscriptSlice({ cliSessionId: "nope", fromByte: 0, homeDir })).toBeNull();
  });
});

describe("askSession.slice", () => {
  async function call(params: unknown) {
    const handlers = createAskSessionHandlers({ homeDir: () => homeDir });
    let out: { ok: boolean; payload?: unknown; error?: unknown } = { ok: false };
    await handlers["askSession.slice"]({
      params,
      respond: (ok: boolean, payload?: unknown, error?: unknown) => {
        out = { ok, payload, error };
      },
    } as never);
    return out;
  }

  it("answers the slice for a recorded range", async () => {
    const from = Buffer.byteLength(before);
    const r = await call({ sessionId: SID, fromByte: from, toByte: fs.statSync(file).size });
    expect(r.ok).toBe(true);
    expect(r.payload).toMatchObject({ sessionId: SID, fromByte: from, truncated: false });
  });

  it("rejects a bad id or offset", async () => {
    expect((await call({ sessionId: "/etc/passwd", fromByte: 0 })).ok).toBe(false);
    expect((await call({ sessionId: SID, fromByte: -1 })).ok).toBe(false);
    expect((await call({ sessionId: SID })).ok).toBe(false);
  });
});
