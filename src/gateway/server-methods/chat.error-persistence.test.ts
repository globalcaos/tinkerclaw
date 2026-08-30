import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";

// FORK 2026-07-22 (chat-error-persist): regression guards for the "error text
// vanishes on reload" bug. When an embedded agent run died AFTER
// agentRunStarted=true (e.g. a 46-min timeout), the "⚠️ Agent failed before
// reply: …" text was only fire-and-forget WS-broadcast — never persisted to
// the session transcript — so a tab reload / WS reconnect showed NOTHING.
// These tests pin:
//  (a) the agent-started fallback IS persisted, idempotent on double-fire,
//      with the error flag on the persisted content block;
//  (b) block-kind command acks (e.g. the /model "Model set to …" ack) are
//      included in the !agentRunStarted final projection;
//  (c) the silent-reply token is still skipped.

type TranscriptLine = {
  message?: Record<string, unknown>;
};

const sessionEntryState = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "",
}));

vi.mock("../session-utils.js", async () => {
  const original =
    await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
      storePath: path.join(path.dirname(sessionEntryState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: sessionEntryState.sessionId,
        sessionFile: sessionEntryState.transcriptPath,
      },
      canonicalKey: "main",
    }),
  };
});

const { persistAgentStartedFallbackReply, projectPreRunReplyPayloads } = await import("./chat.js");

async function writeTranscriptHeader(transcriptPath: string, sessionId: string) {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date(0).toISOString(),
    cwd: "/tmp",
  };
  await fs.writeFile(transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
}

async function readTranscriptLines(transcriptPath: string): Promise<TranscriptLine[]> {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptLine;
      } catch {
        return {};
      }
    });
}

async function createTranscriptFixture(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionId = "sess-main";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  await writeTranscriptHeader(transcriptPath, sessionId);
  sessionEntryState.transcriptPath = transcriptPath;
  sessionEntryState.sessionId = sessionId;
  return { transcriptPath, sessionId };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistAgentStartedFallbackReply", () => {
  it("persists the agent-started failure text to the transcript, idempotent on double-fire", async () => {
    const { transcriptPath } = await createTranscriptFixture("openclaw-chat-error-persist-");
    const clientRunId = "run-err-1";
    const errorText =
      "⚠️ Agent failed before reply: LLM request timed out. Please try again, or use /new to start a fresh session.";

    const first = persistAgentStartedFallbackReply({
      sessionKey: "main",
      clientRunId,
      fallbackText: errorText,
      isError: true,
    });
    expect(first?.ok).toBe(true);

    // The backstop and the lifecycle path can both fire for one run — the
    // second persist must be a no-op via the idempotencyKey.
    const second = persistAgentStartedFallbackReply({
      sessionKey: "main",
      clientRunId,
      fallbackText: errorText,
      isError: true,
    });
    expect(second?.ok).toBe(true);

    const persisted = (await readTranscriptLines(transcriptPath))
      .map((line) => line.message)
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) && message?.idempotencyKey === `${clientRunId}:assistant-final`,
      );
    expect(persisted).toHaveLength(1);
    const content = persisted[0]?.content as Array<Record<string, unknown>> | undefined;
    expect(content?.[0]).toMatchObject({ type: "text", text: errorText, isError: true });
  });

  it("does not persist a successful backstop already owned by the agent runtime", async () => {
    const { transcriptPath } = await createTranscriptFixture("openclaw-chat-plain-persist-");
    const clientRunId = "run-plain-1";
    const text = "Here is the normal final answer already persisted by the agent runtime.";

    const result = persistAgentStartedFallbackReply({
      sessionKey: "main",
      clientRunId,
      fallbackText: text,
    });
    expect(result).toBeUndefined();

    const persisted = (await readTranscriptLines(transcriptPath))
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${clientRunId}:assistant-final`);
    expect(persisted).toBeUndefined();
  });

  it("still skips the silent-reply token", async () => {
    const { transcriptPath } = await createTranscriptFixture("openclaw-chat-silent-skip-");
    const result = persistAgentStartedFallbackReply({
      sessionKey: "main",
      clientRunId: "run-silent-1",
      fallbackText: SILENT_REPLY_TOKEN,
    });
    expect(result).toBeUndefined();

    const persisted = (await readTranscriptLines(transcriptPath))
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-silent-1:assistant-final");
    expect(persisted).toBeUndefined();
  });

  it("skips blank fallback text", async () => {
    await createTranscriptFixture("openclaw-chat-blank-skip-");
    const result = persistAgentStartedFallbackReply({
      sessionKey: "main",
      clientRunId: "run-blank-1",
      fallbackText: "   \n\t ",
    });
    expect(result).toBeUndefined();
  });
});

describe("projectPreRunReplyPayloads", () => {
  it("includes block-kind command acks alongside finals, in delivery order", () => {
    const ack: ReplyPayload = { text: "Model set to claude-code/claude-fable-5." };
    const final: ReplyPayload = { text: "done" };
    const out = projectPreRunReplyPayloads([
      { payload: ack, kind: "block" },
      { payload: final, kind: "final" },
    ]);
    expect(out).toEqual([ack, final]);
  });

  it("keeps a block-only turn visible (e.g. a bare /model directive)", () => {
    const ack: ReplyPayload = { text: "Model set to claude-code/claude-fable-5." };
    expect(projectPreRunReplyPayloads([{ payload: ack, kind: "block" }])).toEqual([ack]);
  });

  it("returns empty for no delivered replies", () => {
    expect(projectPreRunReplyPayloads([])).toEqual([]);
  });
});
