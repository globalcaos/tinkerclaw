import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Plan task 6 (ruling R6): `server-session-events.ts` computes the seq a push event carries from
// `readSessionMessagesWithCursor` — the SAME cached, index-backed read `chat.history` cursors use
// (Task 5) — instead of a full re-projection or a raw branch-index position. `loadSessionEntry` and
// `loadGatewaySessionRow` are session-STORE lookups, orthogonal to the transcript read this suite
// exercises, so only those two are replaced; the transcript read path stays real.
const loadSessionEntryMock = vi.fn();
const loadGatewaySessionRowMock = vi.fn();

vi.mock("./session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
    loadGatewaySessionRow: (...args: unknown[]) => loadGatewaySessionRowMock(...args),
  };
});

import { createTranscriptUpdateBroadcastHandler } from "./server-session-events.js";
import { __resetTranscriptReadCacheForTest } from "./session-utils.fs.js";
import { getTranscriptIndex, TranscriptIndex } from "./transcript-index.js";

const INTERNAL_CONTEXT_BLOCK = [
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "OpenClaw runtime context (internal):",
  "This context is runtime-generated, not user-authored. Keep internal details private.",
  "",
  "[Internal task completion event]",
  "source: subagent",
  "status: completed successfully",
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
].join("\n");

function header(id: string) {
  return { type: "session", version: CURRENT_SESSION_VERSION, id };
}

function msg(id: string, parentId: string | null, role: string, content: unknown) {
  return { type: "message", id, parentId, message: { role, content } };
}

function jsonl(entries: readonly unknown[]): string {
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

function buildChain(n: number, startAt = 1, parent: string | null = null): unknown[] {
  const entries: unknown[] = [];
  for (let i = startAt; i < startAt + n; i++) {
    const id = `m${i}`;
    entries.push(msg(id, parent, i % 2 === 0 ? "assistant" : "user", `line ${i}`));
    parent = id;
  }
  return entries;
}

const tmpDirs: string[] = [];

function writeFixture(sessionId: string, entries: readonly unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sse-test-"));
  tmpDirs.push(dir);
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, jsonl(entries), "utf-8");
  return file;
}

/** Points `loadSessionEntry` at a fixture transcript without needing a real sessions.json store. */
function useFixture(sessionId: string, file: string) {
  loadSessionEntryMock.mockReturnValue({
    cfg: {},
    storePath: undefined,
    store: {},
    entry: { sessionId, sessionFile: file },
    canonicalKey: sessionId,
    legacyKey: undefined,
  });
}

function buildHandler() {
  const broadcastToConnIds = vi.fn();
  const handler = createTranscriptUpdateBroadcastHandler({
    broadcastToConnIds,
    sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
    sessionMessageSubscribers: { get: () => new Set<string>() },
  });
  return { handler, broadcastToConnIds };
}

function findBroadcast(broadcastToConnIds: ReturnType<typeof vi.fn>, event: string) {
  return broadcastToConnIds.mock.calls.find((call) => call[0] === event)?.[1] as
    | Record<string, unknown>
    | undefined;
}

describe("createTranscriptUpdateBroadcastHandler", () => {
  beforeEach(() => {
    __resetTranscriptReadCacheForTest();
    loadSessionEntryMock.mockReset();
    loadGatewaySessionRowMock.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("messageSeq matches the chat.history cursor seq, skipping a runtime-context-only row — NOT the raw branch index", () => {
    const sessionId = "seq-parity";
    const file = writeFixture(sessionId, [
      header(sessionId),
      msg("u1", null, "user", "what is the plan?"),
      // Stripped entirely by the display projection before its seq bump (chat.history rehaul task
      // 2) — a raw `view.entries.findIndex(...) + 1` would still count it, landing on 3.
      msg("ctx", "u1", "user", INTERNAL_CONTEXT_BLOCK),
    ]);
    useFixture(sessionId, file);
    fs.appendFileSync(file, jsonl([msg("a1", "ctx", "assistant", "here it is")]), "utf-8");

    const { handler, broadcastToConnIds } = buildHandler();
    handler({
      sessionFile: file,
      sessionKey: "agent:main:seq-parity",
      message: { role: "assistant", content: "here it is" },
      messageId: "a1",
    });

    const messagePayload = findBroadcast(broadcastToConnIds, "session.message");
    expect(messagePayload?.messageSeq).toBe(2);
    expect(messagePayload?.epoch).toEqual(expect.any(String));

    const changedPayload = findBroadcast(broadcastToConnIds, "sessions.changed");
    expect(changedPayload?.messageSeq).toBe(2);
    expect(changedPayload?.epoch).toBe(messagePayload?.epoch);
  });

  it("a second event on the same transcript is served by a tail-parse, not a full rebuild (CONTROL: a fresh index on the same file must rebuild)", () => {
    const sessionId = "cheap-seq";
    const file = writeFixture(sessionId, [header(sessionId), ...buildChain(5000)]);
    useFixture(sessionId, file);
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

    const { handler, broadcastToConnIds } = buildHandler();

    // First event for this file in-process: nothing is indexed yet, so a full build is expected —
    // this call is not what's under test.
    fs.appendFileSync(file, jsonl([msg("m5001", "m5000", "assistant", "first appended")]), "utf-8");
    handler({
      sessionFile: file,
      sessionKey: "agent:main:cheap-seq",
      message: { role: "assistant", content: "first appended" },
      messageId: "m5001",
    });
    expect(findBroadcast(broadcastToConnIds, "session.message")?.messageSeq).toBe(5001);
    expect(getTranscriptIndex(file).stats).toMatchObject({ fullBuilds: 1, tailParses: 0 });
    broadcastToConnIds.mockClear();

    // Second event: the index already knows this file up to the previous size, so THIS append is
    // a tail-parse — only the newly appended bytes are re-read, not the transcript from byte 0.
    fs.appendFileSync(file, jsonl([msg("m5002", "m5001", "user", "second appended")]), "utf-8");
    handler({
      sessionFile: file,
      sessionKey: "agent:main:cheap-seq",
      message: { role: "user", content: "second appended" },
      messageId: "m5002",
    });
    expect(findBroadcast(broadcastToConnIds, "session.message")?.messageSeq).toBe(5002);
    expect(getTranscriptIndex(file).stats).toMatchObject({ fullBuilds: 1, tailParses: 1 });

    // The tree path never calls fs.readFileSync at all (it reads via openSync/readSync — see
    // transcript-index.ts) — across BOTH events, proving neither one fell back to the legacy
    // loader, which does call fs.readFileSync (session-utils.fs.ts, readTranscriptFileMessages).
    expect(readFileSyncSpy).not.toHaveBeenCalled();

    // CONTROL: without the index's continuity — the shape of the old, non-incremental read this
    // task replaces — reading this exact, now-5,002-line file requires a full build every time: a
    // fresh, unregistered TranscriptIndex on the identical path has no prior state to trust.
    const fresh = new TranscriptIndex(file);
    fresh.refresh();
    expect(fresh.stats).toMatchObject({ fullBuilds: 1, tailParses: 0 });
  });

  it("omits messageSeq (but still carries epoch) when the update carries no messageId", () => {
    const sessionId = "no-id";
    const file = writeFixture(sessionId, [header(sessionId), msg("u1", null, "user", "hi")]);
    useFixture(sessionId, file);
    fs.appendFileSync(file, jsonl([msg("a1", "u1", "assistant", "hello")]), "utf-8");

    const { handler, broadcastToConnIds } = buildHandler();
    handler({
      sessionFile: file,
      sessionKey: "agent:main:no-id",
      message: { role: "assistant", content: "hello" },
    });

    const payload = findBroadcast(broadcastToConnIds, "session.message");
    expect(payload).toBeDefined();
    expect(payload && "messageSeq" in payload).toBe(false);
    expect(payload?.epoch).toEqual(expect.any(String));
  });

  it("epoch is null for a flat transcript (no incremental identity)", () => {
    const sessionId = "flat-epoch";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sse-test-"));
    tmpDirs.push(dir);
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 1, id: sessionId }),
        JSON.stringify({ message: { role: "user", content: "hi" } }),
      ].join("\n"),
      "utf-8",
    );
    useFixture(sessionId, file);
    fs.appendFileSync(
      file,
      `\n${JSON.stringify({ id: "a1", message: { role: "assistant", content: "hello" } })}`,
      "utf-8",
    );

    const { handler, broadcastToConnIds } = buildHandler();
    handler({
      sessionFile: file,
      sessionKey: "agent:main:flat-epoch",
      message: { role: "assistant", content: "hello" },
      messageId: "a1",
    });

    const payload = findBroadcast(broadcastToConnIds, "session.message");
    expect(payload?.epoch).toBeNull();
    expect(payload?.messageSeq).toBe(2);
  });
});
