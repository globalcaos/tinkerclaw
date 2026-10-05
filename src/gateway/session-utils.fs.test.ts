import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import {
  archiveSessionTranscripts,
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readLatestSessionUsageFromTranscript,
  readSessionMessages,
  readSessionTitleFieldsFromTranscript,
  readSessionPreviewItemsFromTranscript,
  resolveSessionTranscriptCandidates,
  USAGE_TAIL_MAX_BYTES,
} from "./session-utils.fs.js";

function registerTempSessionStore(
  prefix: string,
  assignPaths: (tmpDir: string, storePath: string) => void,
) {
  let dir = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    assignPaths(dir, path.join(dir, "sessions.json"));
  });
  afterAll(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function writeTranscript(tmpDir: string, sessionId: string, lines: unknown[]): string {
  const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
  return transcriptPath;
}

function buildBasicSessionTranscript(
  sessionId: string,
  userText = "Hello world",
  assistantText = "Hi there",
): unknown[] {
  return [
    { type: "session", version: 1, id: sessionId },
    { message: { role: "user", content: userText } },
    { message: { role: "assistant", content: assistantText } },
  ];
}

describe("readFirstUserMessageFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test.each([
    {
      sessionId: "test-session-1",
      lines: [
        JSON.stringify({ type: "session", version: 1, id: "test-session-1" }),
        JSON.stringify({ message: { role: "user", content: "Hello world" } }),
        JSON.stringify({ message: { role: "assistant", content: "Hi there" } }),
      ],
      expected: "Hello world",
    },
    {
      sessionId: "test-session-2",
      lines: [
        JSON.stringify({ type: "session", version: 1, id: "test-session-2" }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "Array message content" }],
          },
        }),
      ],
      expected: "Array message content",
    },
    {
      sessionId: "test-session-2b",
      lines: [
        JSON.stringify({ type: "session", version: 1, id: "test-session-2b" }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "input_text", text: "Input text content" }],
          },
        }),
      ],
      expected: "Input text content",
    },
  ] as const)("extracts first user text for $sessionId", ({ sessionId, lines, expected }) => {
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result, sessionId).toBe(expected);
  });
  test("skips non-user messages to find first user message", () => {
    const sessionId = "test-session-3";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "system", content: "System prompt" } }),
      JSON.stringify({ message: { role: "assistant", content: "Greeting" } }),
      JSON.stringify({ message: { role: "user", content: "First user question" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("First user question");
  });

  test("skips inter-session user messages by default", () => {
    const sessionId = "test-session-inter-session";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        message: {
          role: "user",
          content: "Forwarded by session tool",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      }),
      JSON.stringify({
        message: { role: "user", content: "Real user message" },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Real user message");
  });

  test("returns null when no user messages exist", () => {
    const sessionId = "test-session-4";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "system", content: "System prompt" } }),
      JSON.stringify({ message: { role: "assistant", content: "Greeting" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBeNull();
  });

  test("handles malformed JSON lines gracefully", () => {
    const sessionId = "test-session-5";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      "not valid json",
      JSON.stringify({ message: { role: "user", content: "Valid message" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Valid message");
  });

  test("returns null for empty content", () => {
    const sessionId = "test-session-8";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "" } }),
      JSON.stringify({ message: { role: "user", content: "Second message" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Second message");
  });
});

describe("readLastMessagePreviewFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("returns null for empty file", () => {
    const sessionId = "test-last-empty";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBeNull();
  });

  test.each([
    {
      sessionId: "test-last-user",
      lines: [
        JSON.stringify({ message: { role: "user", content: "First user" } }),
        JSON.stringify({ message: { role: "assistant", content: "First assistant" } }),
        JSON.stringify({ message: { role: "user", content: "Last user message" } }),
      ],
      expected: "Last user message",
    },
    {
      sessionId: "test-last-assistant",
      lines: [
        JSON.stringify({ message: { role: "user", content: "User question" } }),
        JSON.stringify({ message: { role: "assistant", content: "Final assistant reply" } }),
      ],
      expected: "Final assistant reply",
    },
  ] as const)(
    "returns the last user or assistant message from transcript for $sessionId",
    ({ sessionId, lines, expected }) => {
      const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
      const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
      expect(result).toBe(expected);
    },
  );

  test("skips system messages to find last user/assistant", () => {
    const sessionId = "test-last-skip-system";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "Real last" } }),
      JSON.stringify({ message: { role: "system", content: "System at end" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Real last");
  });

  test("returns null when no user/assistant messages exist", () => {
    const sessionId = "test-last-no-match";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "system", content: "Only system" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBeNull();
  });

  test("handles malformed JSON lines gracefully (last preview)", () => {
    const sessionId = "test-last-malformed";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "Valid first" } }),
      "not valid json at end",
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Valid first");
  });

  test.each([
    {
      sessionId: "test-last-array",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Array content response" }],
      },
      expected: "Array content response",
    },
    {
      sessionId: "test-last-output-text",
      message: {
        role: "assistant",
        content: [{ type: "output_text", text: "Output text response" }],
      },
      expected: "Output text response",
    },
  ] as const)(
    "handles array/output_text content format for $sessionId",
    ({ sessionId, message, expected }) => {
      const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(transcriptPath, JSON.stringify({ message }), "utf-8");
      const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
      expect(result, sessionId).toBe(expected);
    },
  );

  test("skips empty content to find previous message", () => {
    const sessionId = "test-last-skip-empty";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "Has content" } }),
      JSON.stringify({ message: { role: "user", content: "" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Has content");
  });

  test("reads from end of large file (16KB window)", () => {
    const sessionId = "test-last-large";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const padding = JSON.stringify({ message: { role: "user", content: "x".repeat(500) } });
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(padding);
    }
    lines.push(JSON.stringify({ message: { role: "assistant", content: "Last in large file" } }));
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Last in large file");
  });

  test("handles valid UTF-8 content", () => {
    const sessionId = "test-last-utf8";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const validLine = JSON.stringify({
      message: { role: "user", content: "Valid UTF-8: 你好世界 🌍" },
    });
    fs.writeFileSync(transcriptPath, validLine, "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Valid UTF-8: 你好世界 🌍");
  });

  test("strips inline directives from last preview text", () => {
    const sessionId = "test-last-strip-inline-directives";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: "Hello [[reply_to_current]] world [[audio_as_voice]]",
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Hello  world");
  });
});

describe("shared transcript read behaviors", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("returns null for missing transcript files", () => {
    expect(readFirstUserMessageFromTranscript("missing-session", storePath)).toBeNull();
    expect(readLastMessagePreviewFromTranscript("missing-session", storePath)).toBeNull();
  });

  test("uses sessionFile overrides when provided", () => {
    const sessionId = "test-shared-custom";
    const firstPath = path.join(tmpDir, "custom-first.jsonl");
    const lastPath = path.join(tmpDir, "custom-last.jsonl");

    fs.writeFileSync(
      firstPath,
      [
        JSON.stringify({ type: "session", version: 1, id: sessionId }),
        JSON.stringify({ message: { role: "user", content: "Custom file message" } }),
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      lastPath,
      JSON.stringify({ message: { role: "assistant", content: "Custom file last" } }),
      "utf-8",
    );

    expect(readFirstUserMessageFromTranscript(sessionId, storePath, firstPath)).toBe(
      "Custom file message",
    );
    expect(readLastMessagePreviewFromTranscript(sessionId, storePath, lastPath)).toBe(
      "Custom file last",
    );
  });

  test("trims whitespace in extracted previews", () => {
    const firstSessionId = "test-shared-first-trim";
    const lastSessionId = "test-shared-last-trim";

    fs.writeFileSync(
      path.join(tmpDir, `${firstSessionId}.jsonl`),
      JSON.stringify({ message: { role: "user", content: "  Padded message  " } }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, `${lastSessionId}.jsonl`),
      JSON.stringify({ message: { role: "assistant", content: "  Padded response  " } }),
      "utf-8",
    );

    expect(readFirstUserMessageFromTranscript(firstSessionId, storePath)).toBe("Padded message");
    expect(readLastMessagePreviewFromTranscript(lastSessionId, storePath)).toBe("Padded response");
  });
});

describe("readSessionTitleFieldsFromTranscript cache", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("returns cached values without re-reading when unchanged", () => {
    const sessionId = "test-cache-1";
    writeTranscript(tmpDir, sessionId, buildBasicSessionTranscript(sessionId));

    const readSpy = vi.spyOn(fs, "readSync");

    const first = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    const readsAfterFirst = readSpy.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    expect(second).toEqual(first);
    expect(readSpy.mock.calls.length).toBe(readsAfterFirst);
    readSpy.mockRestore();
  });

  test("invalidates cache when transcript changes", () => {
    const sessionId = "test-cache-2";
    const transcriptPath = writeTranscript(
      tmpDir,
      sessionId,
      buildBasicSessionTranscript(sessionId, "First", "Old"),
    );

    const readSpy = vi.spyOn(fs, "readSync");

    const first = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    const readsAfterFirst = readSpy.mock.calls.length;
    expect(first.lastMessagePreview).toBe("Old");

    fs.appendFileSync(
      transcriptPath,
      `\n${JSON.stringify({ message: { role: "assistant", content: "New" } })}`,
      "utf-8",
    );

    const second = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    expect(second.lastMessagePreview).toBe("New");
    expect(readSpy.mock.calls.length).toBeGreaterThan(readsAfterFirst);
    readSpy.mockRestore();
  });
});

describe("readSessionMessages", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("includes synthetic compaction markers for compaction entries", () => {
    const sessionId = "test-session-compaction";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "Hello" } }),
      JSON.stringify({
        type: "compaction",
        id: "comp-1",
        timestamp: "2026-02-07T00:00:00.000Z",
        summary: "Compacted history",
        firstKeptEntryId: "x",
        tokensBefore: 123,
      }),
      JSON.stringify({ message: { role: "assistant", content: "World" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const out = readSessionMessages(sessionId, storePath);
    expect(out).toHaveLength(3);
    const marker = out[1] as {
      role: string;
      content?: Array<{ text?: string }>;
      __openclaw?: { kind?: string; id?: string };
      timestamp?: number;
    };
    expect(marker.role).toBe("system");
    // FORK 2026-07-28: the marker SURFACES the compaction summary when the entry carries one,
    // falling back to the literal "Compaction" only when it does not (session-utils.fs.ts:157
    // and :209, `summary?.trim() || "Compaction"`, which also store it on __openclaw.summary).
    // This expectation still asserted the old always-literal behaviour and so failed against the
    // fixture's own `summary: "Compacted history"`. Both branches are now covered — see the
    // sibling case below — because pinning only one of them is how the stale half survived.
    expect(marker.content?.[0]?.text).toBe("Compacted history");
    expect(marker.__openclaw?.kind).toBe("compaction");
    expect(marker.__openclaw?.id).toBe("comp-1");
    expect(typeof marker.timestamp).toBe("number");
  });

  // FORK 2026-09-07 (the architect: "I clicked compact ... nothing seem to have happened") — an
  // ENGRAM-mode compaction writes a POINTER MANIFEST, not an LLM summary, and its record has a
  // shape neither branch of this mapper read: `details.tokensEvicted` carries the saving, and
  // there is NO `tokensAfter` at all. The chat banner needs before+after to draw "x → y", so it
  // fell through to printing `tokensBefore` on its own — and `tokensBefore` is NOT this session's
  // size. The fixture below is the verbatim record from the live incident: a session whose
  // conversation was 175,850 tokens produced `tokensBefore: 7855029` (a store-wide running
  // total), so the banner would have announced "7855k tok compacted" for a compaction that freed
  // 128,260. Pin the real counter through BOTH mapper branches — flat and tree — because the file
  // duplicates the block and fixing one is how half a bug survives.
  const ENGRAM_COMPACTION_RECORD = {
    type: "compaction",
    id: "comp-engram",
    timestamp: "2026-09-07T08:15:31.465Z",
    summary:
      "[Pointer manifest: events 01M1XEZKKR0000RM..01M1XEZKM60001T6 (48 events, ~128260 tokens). Use recall(query) to retrieve.]",
    firstKeptEntryId: "comp-engram",
    tokensBefore: 7855029,
    details: { engramEventsStored: 48, tokensEvicted: 128260 },
    fromHook: true,
  } as const;

  test("surfaces details.tokensEvicted as evictedTokens on the compaction marker (flat transcript)", () => {
    const sessionId = "test-session-compaction-engram-flat";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "Hello" } }),
      JSON.stringify(ENGRAM_COMPACTION_RECORD),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const out = readSessionMessages(sessionId, storePath);
    const marker = out.find(
      (m) => (m as { __openclaw?: { kind?: string } }).__openclaw?.kind === "compaction",
    ) as { __openclaw?: { evictedTokens?: number; tokensBefore?: number; tokensAfter?: number } };
    expect(marker).toBeDefined();
    expect(marker.__openclaw?.evictedTokens).toBe(128260);
    // The misleading pair is still passed through unchanged — the renderer decides which to
    // prefer, and it can only do that if it can see both.
    expect(marker.__openclaw?.tokensBefore).toBe(7855029);
    expect(marker.__openclaw?.tokensAfter).toBeUndefined();
  });

  // FORK 2026-09-07 (the architect: "I can see a message like it was me prompting it but with some
  // strange html code") — OpenClaw injects runtime events (a finished subagent, a cron result)
  // into the conversation as a role:"user" message wrapped in
  // <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> … <<<END_OPENCLAW_INTERNAL_CONTEXT>>>. The LIVE stream
  // hides it — live-chat-projector.ts:53 calls stripInternalRuntimeContext — but this reader,
  // which serves chat.history, never did. So the block was invisible while it happened and
  // reappeared, wearing the user's own bubble, the moment the tab was reloaded or switched to.
  // 3,249 such entries were sitting in 273 transcripts when this was found.
  const INTERNAL_CONTEXT_BLOCK = [
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "OpenClaw runtime context (internal):",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
    "[Internal task completion event]",
    "source: subagent",
    "task: customerco-video-audit",
    "status: completed successfully",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  ].join("\n");

  function markerTexts(messages: unknown[]): string[] {
    return messages.map((m) => {
      const msg = m as { content?: unknown };
      const c = msg.content;
      if (typeof c === "string") {
        return c;
      }
      if (Array.isArray(c)) {
        return c.map((b) => (b as { text?: string })?.text ?? "").join("\n");
      }
      return "";
    });
  }

  test("chat.history strips the internal runtime-context envelope the live stream already hides", () => {
    const sessionId = "test-session-internal-context";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "what is the plan?" } }),
      // A message that is ONLY the envelope: the user never wrote it, so it must not survive
      // as an empty bubble either — it has to disappear entirely.
      JSON.stringify({ message: { role: "user", content: INTERNAL_CONTEXT_BLOCK } }),
      JSON.stringify({ message: { role: "assistant", content: "here it is" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const out = readSessionMessages(sessionId, storePath);
    const texts = markerTexts(out);
    expect(texts.join("\n")).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
    expect(texts.join("\n")).not.toContain("customerco-video-audit");
    // The real conversation is untouched.
    expect(texts).toContain("what is the plan?");
    expect(texts).toContain("here it is");
    expect(out).toHaveLength(2);
  });

  test("keeps the user's own words when the envelope is only appended to them", () => {
    const sessionId = "test-session-internal-context-mixed";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: `check the cameras\n\n${INTERNAL_CONTEXT_BLOCK}` }],
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const out = readSessionMessages(sessionId, storePath);
    expect(out).toHaveLength(1);
    const text = markerTexts(out)[0] ?? "";
    expect(text).toContain("check the cameras");
    expect(text).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
  });

  test("surfaces details.tokensEvicted as evictedTokens on the compaction marker (tree transcript)", () => {
    const sessionId = "test-session-compaction-engram-tree";
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        cwd: tmpDir,
        timestamp: "2026-09-07T08:00:00.000Z",
      },
      {
        type: "message",
        id: "ask",
        parentId: null,
        timestamp: "2026-09-07T08:00:01.000Z",
        message: { role: "user", content: "Hello", timestamp: 1 },
      },
      { ...ENGRAM_COMPACTION_RECORD, parentId: "ask" },
    ];
    fs.writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");

    const out = readSessionMessages(sessionId, storePath, sessionFile);
    const marker = out.find(
      (m) => (m as { __openclaw?: { kind?: string } }).__openclaw?.kind === "compaction",
    ) as { __openclaw?: { evictedTokens?: number } } | undefined;
    expect(marker).toBeDefined();
    expect(marker?.__openclaw?.evictedTokens).toBe(128260);
  });

  // FORK 2026-07-28 — the fallback half of the branch above. A compaction entry with no summary
  // (or a whitespace-only one) must still render a readable marker rather than an empty bubble.
  test("falls back to the literal 'Compaction' when the entry carries no summary", () => {
    const sessionId = "test-session-compaction-nosummary";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "Hello" } }),
      JSON.stringify({
        type: "compaction",
        id: "comp-2",
        timestamp: "2026-02-07T00:00:00.000Z",
        summary: "   ",
        firstKeptEntryId: "x",
        tokensBefore: 123,
      }),
      JSON.stringify({ message: { role: "assistant", content: "World" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const out = readSessionMessages(sessionId, storePath);
    const marker = out[1] as {
      role: string;
      content?: Array<{ text?: string }>;
      __openclaw?: { kind?: string; summary?: string };
    };
    expect(marker.role).toBe("system");
    expect(marker.content?.[0]?.text).toBe("Compaction");
    // A blank summary must not be stored as if it were real content.
    expect(marker.__openclaw?.summary).toBeUndefined();
  });

  test("reads only the active branch when transcript rewrites abandon older entries", () => {
    const sessionId = "test-session-active-branch";
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        cwd: tmpDir,
        timestamp: "2026-04-27T00:00:00.000Z",
      },
      {
        type: "message",
        id: "original",
        parentId: null,
        timestamp: "2026-04-27T00:00:01.000Z",
        message: {
          role: "user",
          content: "Sender (untrusted metadata): webchat\n\noriginal wrapped prompt",
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "clean",
        parentId: null,
        timestamp: "2026-04-27T00:00:02.000Z",
        message: { role: "user", content: "clean prompt", timestamp: 2 },
      },
      {
        type: "message",
        id: "answer",
        parentId: "clean",
        timestamp: "2026-04-27T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "clean answer" }],
          api: "chat",
          provider: "openclaw",
          model: "test",
          usage: {},
          stopReason: "stop",
          timestamp: 3,
        },
      },
    ];
    fs.writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
    const rawTranscript = fs.readFileSync(sessionFile, "utf-8");
    expect(rawTranscript).toContain("original wrapped prompt");
    expect(rawTranscript).toContain("clean prompt");

    const out = readSessionMessages(sessionId, storePath, sessionFile);
    expect(out).toHaveLength(2);
    expect(out).toEqual([
      expect.objectContaining({
        role: "user",
        content: "clean prompt",
        __openclaw: expect.objectContaining({ seq: 1 }),
      }),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "clean answer" }],
        __openclaw: expect.objectContaining({ seq: 2 }),
      }),
    ]);
    expect(JSON.stringify(out)).not.toContain("original wrapped prompt");
  });

  test.each([
    {
      sessionId: "cross-agent-default-root",
      sessionFileParts: ["agents", "ops", "sessions", "cross-agent-default-root.jsonl"],
      wrongStorePathParts: ["agents", "main", "sessions", "sessions.json"],
      message: { role: "user", content: "from-ops" },
    },
    {
      sessionId: "cross-agent-custom-root",
      sessionFileParts: ["custom", "agents", "ops", "sessions", "cross-agent-custom-root.jsonl"],
      wrongStorePathParts: ["custom", "agents", "main", "sessions", "sessions.json"],
      message: { role: "assistant", content: "from-custom-ops" },
    },
  ] as const)(
    "reads cross-agent absolute sessionFile across store-root layouts for $sessionId",
    ({ sessionId, sessionFileParts, wrongStorePathParts, message }) => {
      const sessionFile = path.join(tmpDir, ...sessionFileParts);
      const wrongStorePath = path.join(tmpDir, ...wrongStorePathParts);
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({ type: "session", version: 1, id: sessionId }),
          JSON.stringify({ message }),
        ].join("\n"),
        "utf-8",
      );

      const out = readSessionMessages(sessionId, wrongStorePath, sessionFile);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject(message);
      expect((out[0] as { __openclaw?: { seq?: number } }).__openclaw?.seq).toBe(1);
    },
  );
});

describe("readSessionPreviewItemsFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-preview-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  function writeTranscriptLines(sessionId: string, lines: string[]) {
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
  }

  function readPreview(sessionId: string, maxItems = 3, maxChars = 120) {
    return readSessionPreviewItemsFromTranscript(
      sessionId,
      storePath,
      undefined,
      undefined,
      maxItems,
      maxChars,
    );
  }

  test("returns recent preview items with tool summary", () => {
    const sessionId = "preview-session";
    const lines = createToolSummaryPreviewTranscriptLines(sessionId);
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId);

    expect(result.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result[1]?.text).toContain("call weather");
  });

  test("detects tool calls from tool_use/tool_call blocks and toolName field", () => {
    const sessionId = "preview-session-tools";
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "assistant", content: "Hi" } }),
      JSON.stringify({
        message: {
          role: "assistant",
          toolName: "camera",
          content: [
            { type: "tool_use", name: "read" },
            { type: "tool_call", name: "write" },
          ],
        },
      }),
      JSON.stringify({ message: { role: "assistant", content: "Done" } }),
    ];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId);

    expect(result.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result[1]?.text).toContain("call");
    expect(result[1]?.text).toContain("camera");
    expect(result[1]?.text).toContain("read");
    // Preview text may not list every tool name; it should at least hint there were multiple calls.
    expect(result[1]?.text).toMatch(/\+\d+/);
  });

  test("truncates preview text to max chars", () => {
    const sessionId = "preview-truncate";
    const longText = "a".repeat(60);
    const lines = [JSON.stringify({ message: { role: "assistant", content: longText } })];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId, 1, 24);

    expect(result).toHaveLength(1);
    expect(result[0]?.text.length).toBe(24);
    expect(result[0]?.text.endsWith("...")).toBe(true);
  });

  test("strips inline directives from preview items", () => {
    const sessionId = "preview-strip-inline-directives";
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: "A [[reply_to:abc-123]] B [[audio_as_voice]]",
        },
      }),
    ];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId, 1, 120);

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("A  B");
  });

  test("prefers final_answer text for assistant preview items", () => {
    const sessionId = "preview-final-answer";
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "thinking like caveman",
              textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
            },
            {
              type: "text",
              text: "Actual final answer",
              textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
            },
          ],
        },
      }),
    ];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId, 1, 120);

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("Actual final answer");
  });

  test("hides commentary-only assistant preview items", () => {
    const sessionId = "preview-commentary-only";
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "thinking like caveman",
              textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
            },
          ],
        },
      }),
    ];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId, 1, 120);

    expect(result).toHaveLength(0);
  });
});

describe("readLatestSessionUsageFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-usage-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  // Several tests below spy on fs.readSync/fs.readFileSync/fs.fstatSync; vi.spyOn on an
  // already-spied method returns the SAME persistent mock instance with its call history intact,
  // so a spy left unrestored here would leak call counts into every later test's assertions.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns the latest assistant usage snapshot and skips delivery mirrors", () => {
    const sessionId = "usage-session";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input: 1200,
            output: 300,
            cacheRead: 50,
            cost: { total: 0.0042 },
          },
        },
      },
      {
        message: {
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ]);

    expect(readLatestSessionUsageFromTranscript(sessionId, storePath)).toEqual({
      modelProvider: "openai",
      model: "gpt-5.4",
      inputTokens: 1200,
      outputTokens: 300,
      cacheRead: 50,
      totalTokens: 1250,
      totalTokensFresh: true,
      costUsd: 0.0042,
    });
  });

  test("aggregates assistant usage across the full transcript and keeps the latest context snapshot", () => {
    const sessionId = "usage-aggregate";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: {
            input: 1_800,
            output: 400,
            cacheRead: 600,
            cost: { total: 0.0055 },
          },
        },
      },
      {
        message: {
          role: "assistant",
          usage: {
            input: 2_400,
            output: 250,
            cacheRead: 900,
            cost: { total: 0.006 },
          },
        },
      },
    ]);

    const snapshot = readLatestSessionUsageFromTranscript(sessionId, storePath);
    expect(snapshot).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 4200,
      outputTokens: 650,
      cacheRead: 1500,
      totalTokens: 3300,
      totalTokensFresh: true,
    });
    expect(snapshot?.costUsd).toBeCloseTo(0.0115, 8);
  });

  test("falls back to a full scan when BOTH usage records sit outside the 256 KiB tail, and still aggregates them", () => {
    // Plan task 6 (ruling R6): readLatestSessionUsageFromTranscript now reads only the last 256 KiB
    // first. Both usage-bearing lines here are pushed well outside that window (80 filler lines
    // before the second one, 20 more filler lines after it — the trailing block alone is ~400 KB,
    // so the tail read lands entirely inside pure filler and finds nothing). That must trigger the
    // full-scan fallback and reproduce EXACTLY the old, full-file aggregate — not a partial one.
    const sessionId = "usage-full-transcript";
    const filler = "x".repeat(20_000);
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input: 1_000,
            output: 200,
            cacheRead: 100,
            cost: { total: 0.0042 },
          },
        },
      },
      ...Array.from({ length: 80 }, () => ({ message: { role: "user", content: filler } })),
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input: 500,
            output: 150,
            cacheRead: 50,
            cost: { total: 0.0021 },
          },
        },
      },
      // Pushes the second usage record itself outside the 256 KiB tail window (~400 KB of filler).
      ...Array.from({ length: 20 }, () => ({ message: { role: "user", content: filler } })),
    ]);

    const snapshot = readLatestSessionUsageFromTranscript(sessionId, storePath);
    expect(snapshot).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.4",
      inputTokens: 1500,
      outputTokens: 350,
      cacheRead: 150,
      totalTokens: 550,
      totalTokensFresh: true,
    });
    expect(snapshot?.costUsd).toBeCloseTo(0.0063, 8);
  });

  test("reads the tail only (bounded fs.readSync bytes, no fallback) when the last usage record is within 256 KiB of the end", () => {
    // Part (b) of the task-6 brief: a 2 MB transcript whose only usage record sits in the final
    // 10 KB must be served from the tail read alone — total bytes read must stay bounded, proving
    // no full-file fallback ran.
    const sessionId = "usage-tail-only";
    const filler = "x".repeat(20_000);
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      ...Array.from({ length: 110 }, () => ({ message: { role: "user", content: filler } })),
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: {
            input: 900,
            output: 180,
            cacheRead: 40,
            cost: { total: 0.0033 },
          },
        },
      },
    ]);
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    expect(fs.statSync(transcriptPath).size).toBeGreaterThan(2 * 1024 * 1024);

    // spyOn without mockImplementation still delegates to the real fs.readSync — it only observes.
    const readSyncSpy = vi.spyOn(fs, "readSync");
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

    const snapshot = readLatestSessionUsageFromTranscript(sessionId, storePath);

    expect(snapshot).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 900,
      outputTokens: 180,
      cacheRead: 40,
      // totalTokens is a prompt/context snapshot (input + cacheRead), deliberately excluding
      // output — see deriveSessionTotalTokens in src/agents/usage.ts.
      totalTokens: 940,
      totalTokensFresh: true,
    });
    expect(readFileSyncSpy).not.toHaveBeenCalled();
    expect(readSyncSpy).toHaveBeenCalledTimes(1);
    // fs.readSync is overloaded (a 3-arg options-object form exists alongside the 5-arg positional
    // form); the implementation always uses the positional form (fd, buffer, offset, length,
    // position), so the call args are cast to that shape rather than the union `Parameters<>` infers.
    const [, , , length] = readSyncSpy.mock.calls[0] as unknown as [
      number,
      NodeJS.ArrayBufferView,
      number,
      number,
      number | null,
    ];
    expect(length).toBeLessThanOrEqual(256 * 1024);
  });

  test("a transcript smaller than 256 KiB is read in full by the tail path (no fallback needed)", () => {
    const sessionId = "usage-small-file";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: { input: 10, output: 5, cacheRead: 0, cost: { total: 0.0001 } },
        },
      },
      {
        message: {
          role: "assistant",
          usage: { input: 20, output: 8, cacheRead: 0, cost: { total: 0.0002 } },
        },
      },
    ]);
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    expect(fs.statSync(transcriptPath).size).toBeLessThan(256 * 1024);

    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    const snapshot = readLatestSessionUsageFromTranscript(sessionId, storePath);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      inputTokens: 30,
      outputTokens: 13,
      cacheRead: 0,
    });
    expect(snapshot?.costUsd).toBeCloseTo(0.0003, 8);
  });

  test("returns null when the transcript has no assistant usage snapshot", () => {
    const sessionId = "usage-empty";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "hello" } },
      { message: { role: "assistant", content: "hi" } },
    ]);

    expect(readLatestSessionUsageFromTranscript(sessionId, storePath)).toBeNull();
  });

  test("a short read (file shrunk in place between fstatSync and readSync) does not corrupt the real latest record into a stale one — CONTROL vs the old buf.toString() behavior", () => {
    // Controller fix round 1: readTranscriptTailChunk used to decode fs.readSync's WHOLE declared
    // buffer, ignoring its actual return value. Buffer.alloc zero-fills, so a short read (the real,
    // documented behavior of a positional fs.readSync near EOF — not an error) leaves the untouched
    // tail as NUL bytes, glued directly onto whatever real content WAS read, with no separating
    // newline. Reproduced here by lying only to fstatSync (a bigger `size` than the file truly is);
    // the REAL fs.readSync then genuinely short-reads because the requested length exceeds the
    // real, current EOF — exactly the shape of a concurrent in-place truncate/rewrite race.
    const sessionId = "usage-short-read";
    const header = { type: "session", version: 1, id: sessionId };
    const earlyEntry = {
      message: {
        role: "assistant",
        provider: "openai",
        model: "early-model",
        usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.001 } },
      },
    };
    // The file's REAL last byte is this record's closing brace — no trailing newline, matching how
    // writeTranscript (and real transcripts mid-write) leave the tail.
    const newLatestEntry = {
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "new-latest-model",
        usage: { input: 900, output: 300, cacheRead: 50, cost: { total: 0.009 } },
      },
    };
    const realText = [header, earlyEntry, newLatestEntry].map((l) => JSON.stringify(l)).join("\n");
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, realText, "utf-8");

    // A size fstatSync would have reported BEFORE a since-happened shrink: bigger than the real
    // file, but still well under the 256 KiB tail window so readStart stays 0.
    const fakeStaleSize = realText.length + 10_000;
    const realFstatSync = fs.fstatSync.bind(fs);
    const fstatSpy = vi
      .spyOn(fs, "fstatSync")
      .mockImplementationOnce(
        (fd: number) => ({ ...realFstatSync(fd), size: fakeStaleSize }) as fs.Stats,
      );

    // CONTROL: replicate ONLY the buggy line the fix removed (`buf.toString()` over the whole
    // declared length) against the SAME real file and the SAME oversized length, to show exactly
    // what the old code handed to the JSON parser.
    const controlFd = fs.openSync(transcriptPath, "r");
    const controlReadLen = Math.min(fakeStaleSize, USAGE_TAIL_MAX_BYTES);
    const controlBuf = Buffer.alloc(controlReadLen);
    const controlBytesRead = fs.readSync(controlFd, controlBuf, 0, controlReadLen, 0);
    fs.closeSync(controlFd);
    expect(controlBytesRead).toBe(realText.length); // the short read really happened
    expect(controlBytesRead).toBeLessThan(controlReadLen);
    const buggyRaw = controlBuf.toString("utf-8"); // the OLD, pre-fix decode
    const fixedRaw = controlBuf.subarray(0, controlBytesRead).toString("utf-8"); // the NEW decode
    expect(fixedRaw).toBe(realText);
    expect(buggyRaw).not.toBe(realText);
    expect(buggyRaw.startsWith(realText)).toBe(true);
    expect(buggyRaw.length).toBeGreaterThan(realText.length);
    const buggyLastLine = buggyRaw.split("\n").at(-1) ?? "";
    const fixedLastLine = fixedRaw.split("\n").at(-1) ?? "";
    // The real, current "latest" record — glued to NUL padding with no newline in between — fails
    // to parse under the old decode. The earlier record's own line is untouched either way (each
    // full line is terminated by its own real newline), so the old code would still find IT and
    // report success instead of falling back — returning the stale early record.
    expect(() => JSON.parse(buggyLastLine)).toThrow();
    expect(JSON.parse(fixedLastLine)).toEqual(newLatestEntry);

    // The real, shipped function: under the identical race, it must see the CURRENT tail correctly
    // and report the true latest record (new-latest), not the stale early one.
    const snapshot = readLatestSessionUsageFromTranscript(sessionId, storePath);
    expect(fstatSpy).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      modelProvider: "anthropic",
      model: "new-latest-model",
      inputTokens: 1_000,
      outputTokens: 320,
      cacheRead: 55,
    });
    expect(snapshot?.costUsd).toBeCloseTo(0.01, 8);
  });

  test("a multi-byte UTF-8 character split at the 256 KiB cut is dropped along with the rest of the partial line (no mangled character reaches the parser)", () => {
    // The reviewer reasoned this case is already safe (the whole leading partial line is dropped,
    // regardless of WHY it's partial) — pinned here cheaply since it shares the same tail-read path
    // as the fix above.
    const sessionId = "usage-utf8-cut";
    const header = { type: "session", version: 1, id: sessionId };
    // Padding built from "€" (U+20AC, 3 bytes in UTF-8). Verified by direct computation for this
    // exact fixture (sessionId, N, and entry shapes all fixed): the 256 KiB tail boundary lands 1
    // byte into a "€" sequence (readStart - runStart === 938017, mod 3 === 1) — a genuine
    // mid-character split, not a probabilistic one.
    const paddingText = "€".repeat(400_000);
    const lines = [
      header,
      { message: { role: "user", content: paddingText } },
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: { input: 700, output: 140, cacheRead: 30, cost: { total: 0.0025 } },
        },
      },
    ];
    writeTranscript(tmpDir, sessionId, lines);
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    expect(fs.statSync(transcriptPath).size).toBeGreaterThan(USAGE_TAIL_MAX_BYTES);

    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    const snapshot = readLatestSessionUsageFromTranscript(sessionId, storePath);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 700,
      outputTokens: 140,
      cacheRead: 30,
    });
    expect(snapshot?.costUsd).toBeCloseTo(0.0025, 8);
  });
});

describe("resolveSessionTranscriptCandidates", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("fallback candidate uses OPENCLAW_HOME instead of os.homedir()", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const candidates = resolveSessionTranscriptCandidates("sess-1", undefined);
    const fallback = candidates[candidates.length - 1];
    expect(fallback).toBe(
      path.join(path.resolve("/srv/openclaw-home"), ".openclaw", "sessions", "sess-1.jsonl"),
    );
  });
});

describe("resolveSessionTranscriptCandidates safety", () => {
  test.each([
    {
      storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
      sessionFile: "/tmp/openclaw/agents/ops/sessions/sess-safe.jsonl",
    },
    {
      storePath: "/srv/custom/agents/main/sessions/sessions.json",
      sessionFile: "/srv/custom/agents/ops/sessions/sess-safe.jsonl",
    },
  ] as const)(
    "keeps cross-agent absolute sessionFile candidate for $storePath",
    ({ storePath, sessionFile }) => {
      const candidates = resolveSessionTranscriptCandidates("sess-safe", storePath, sessionFile);
      expect(candidates.map((value) => path.resolve(value))).toContain(path.resolve(sessionFile));
    },
  );

  test("drops unsafe session IDs instead of producing traversal paths", () => {
    const candidates = resolveSessionTranscriptCandidates(
      "../etc/passwd",
      "/tmp/openclaw/agents/main/sessions/sessions.json",
    );

    expect(candidates).toEqual([]);
  });

  test("drops unsafe sessionFile candidates and keeps safe fallbacks", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const candidates = resolveSessionTranscriptCandidates(
      "sess-safe",
      storePath,
      "../../etc/passwd",
    );
    const normalizedCandidates = candidates.map((value) => path.resolve(value));
    const expectedFallback = path.resolve(path.dirname(storePath), "sess-safe.jsonl");

    expect(candidates.some((value) => value.includes("etc/passwd"))).toBe(false);
    expect(normalizedCandidates).toContain(expectedFallback);
  });

  test("prefers the current sessionId transcript before a stale sessionFile candidate", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const candidates = resolveSessionTranscriptCandidates(
      "11111111-1111-4111-8111-111111111111",
      storePath,
      "/tmp/openclaw/agents/main/sessions/22222222-2222-4222-8222-222222222222.jsonl",
    );

    expect(candidates[0]).toBe(
      path.resolve("/tmp/openclaw/agents/main/sessions/11111111-1111-4111-8111-111111111111.jsonl"),
    );
    expect(candidates).toContain(
      path.resolve("/tmp/openclaw/agents/main/sessions/22222222-2222-4222-8222-222222222222.jsonl"),
    );
  });

  test("keeps explicit custom sessionFile ahead of synthesized fallback", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionFile = "/tmp/openclaw/agents/main/sessions/custom-transcript.jsonl";
    const candidates = resolveSessionTranscriptCandidates(
      "11111111-1111-4111-8111-111111111111",
      storePath,
      sessionFile,
    );

    expect(candidates[0]).toBe(path.resolve(sessionFile));
  });

  test("keeps custom topic-like transcript paths ahead of synthesized fallback", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionFile = "/tmp/openclaw/agents/main/sessions/custom-topic-notes.jsonl";
    const candidates = resolveSessionTranscriptCandidates(
      "11111111-1111-4111-8111-111111111111",
      storePath,
      sessionFile,
    );

    expect(candidates[0]).toBe(path.resolve(sessionFile));
  });

  test("keeps forked transcript paths ahead of synthesized fallback", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const sessionFile =
      "/tmp/openclaw/agents/main/sessions/2026-03-23T16-30-00-000Z_11111111-1111-4111-8111-111111111111.jsonl";
    const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);

    expect(candidates[0]).toBe(path.resolve(sessionFile));
  });

  test("keeps timestamped custom transcript paths ahead of synthesized fallback", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const sessionFile = "/tmp/openclaw/agents/main/sessions/2026-03-23T16-30-00-000Z_notes.jsonl";
    const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);

    expect(candidates[0]).toBe(path.resolve(sessionFile));
  });

  test("still treats generated topic transcripts from another session as stale", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const staleSessionFile =
      "/tmp/openclaw/agents/main/sessions/22222222-2222-4222-8222-222222222222-topic-thread.jsonl";
    const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, staleSessionFile);

    expect(candidates[0]).toBe(
      path.resolve("/tmp/openclaw/agents/main/sessions/11111111-1111-4111-8111-111111111111.jsonl"),
    );
    expect(candidates).toContain(path.resolve(staleSessionFile));
  });
});

describe("archiveSessionTranscripts", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-archive-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  beforeAll(() => {
    vi.stubEnv("OPENCLAW_HOME", tmpDir);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test.each([
    {
      sessionId: "sess-archive-1",
      transcriptFileName: "sess-archive-1.jsonl",
      buildArgs: () => ({ sessionId: "sess-archive-1", storePath, reason: "reset" as const }),
    },
    {
      sessionId: "sess-archive-2",
      transcriptFileName: "custom-transcript.jsonl",
      buildArgs: () => ({
        sessionId: "sess-archive-2",
        storePath: undefined,
        sessionFile: path.join(tmpDir, "custom-transcript.jsonl"),
        reason: "reset" as const,
      }),
    },
  ] as const)(
    "archives transcript from default and explicit sessionFile path for $sessionId",
    ({ transcriptFileName, buildArgs }) => {
      const transcriptPath = path.join(tmpDir, transcriptFileName);
      const args = buildArgs();
      fs.writeFileSync(transcriptPath, '{"type":"session"}\n', "utf-8");
      const archived = archiveSessionTranscripts(args);
      expect(archived).toHaveLength(1);
      expect(archived[0]).toContain(".reset.");
      expect(fs.existsSync(transcriptPath)).toBe(false);
      expect(fs.existsSync(archived[0])).toBe(true);
    },
  );

  test("returns empty array when no transcript files exist", () => {
    const archived = archiveSessionTranscripts({
      sessionId: "nonexistent-session",
      storePath,
      reason: "reset",
    });

    expect(archived).toEqual([]);
  });

  test("skips files that do not exist and archives only existing ones", () => {
    const sessionId = "sess-archive-3";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, '{"type":"session"}\n', "utf-8");

    const archived = archiveSessionTranscripts({
      sessionId,
      storePath,
      sessionFile: "/nonexistent/path/file.jsonl",
      reason: "deleted",
    });

    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain(".deleted.");
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });
});
