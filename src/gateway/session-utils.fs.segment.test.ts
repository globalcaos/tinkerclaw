import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readSessionMessages } from "./session-utils.fs.js";

/**
 * FORK (Mechanism A — thinking/answer split): tinker-bridge fuses a turn's
 * interleaved text into ONE coalesced assistant-text block on persist, and
 * writes each tool call as a separate `tinker-bridge-tool` custom entry. On
 * read, the legacy `reorderTinkerBridgeToolBlocks` splices ALL tools BEFORE
 * that single text block — so the UI sees `[tool, tool, …, ONE text]` and its
 * narration splitter treats the whole blob as the answer.
 *
 * The fix records WHERE in the turn's text each tool fired (`textOffset`) and,
 * on read, SLICES the coalesced text at those ascending offsets into
 * interleaved per-segment assistant messages so the existing UI splitter
 * works with zero UI change.
 *
 * Test A: tools carry `textOffset` → reconstructed interleaved segments.
 * Test B: SAME entries WITHOUT `textOffset` → byte-identical to legacy splice.
 */

function registerTempSessionStore(
  prefix: string,
  onReady: (tmpDir: string, storePath: string) => void,
) {
  let dir = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    onReady(dir, path.join(dir, "sessions.json"));
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

type RenderMsg = {
  role?: string;
  content?: Array<{ type?: string; text?: string; name?: string; tool_use_id?: string }>;
  __openclaw?: { kind?: string; phase?: string };
};

function isToolUse(m: RenderMsg): boolean {
  return m.__openclaw?.kind === "tinker-bridge-tool" && m.__openclaw?.phase === "start";
}
function isToolResult(m: RenderMsg): boolean {
  return m.__openclaw?.kind === "tinker-bridge-tool" && m.__openclaw?.phase === "result";
}
function isAssistantText(m: RenderMsg): boolean {
  return (
    m.role === "assistant" &&
    m.__openclaw?.kind !== "tinker-bridge-tool" &&
    Array.isArray(m.content) &&
    m.content.some((c) => c?.type === "text")
  );
}
function assistantTextOf(m: RenderMsg): string {
  return (m.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

const ASSISTANT_TEXT = "segA. segB. segC.";
const OFF1 = "segA.".length; // end of "segA." == 5
const OFF2 = "segA. segB.".length; // end of "segB." == 11

function toolEntries(withOffset: boolean): unknown[] {
  const startData = (i: number, offset: number) => {
    const base: Record<string, unknown> = {
      runId: "run-test",
      phase: "start",
      toolCallId: `tc-${i}`,
      name: `Tool${i}`,
      args: { idx: i },
      purpose: `purpose ${i}`,
      startedAt: 1000 + i,
    };
    if (withOffset) {
      base.textOffset = offset;
    }
    return base;
  };
  const resultData = (i: number) => ({
    runId: "run-test",
    phase: "result",
    toolCallId: `tc-${i}`,
    result: `result ${i}`,
    isError: false,
    purpose: `purpose ${i}`,
    endedAt: 2000 + i,
  });
  return [
    {
      type: "custom",
      customType: "tinker-bridge-tool",
      timestamp: "2026-06-25T00:00:01Z",
      data: startData(1, OFF1),
    },
    {
      type: "custom",
      customType: "tinker-bridge-tool",
      timestamp: "2026-06-25T00:00:02Z",
      data: resultData(1),
    },
    {
      type: "custom",
      customType: "tinker-bridge-tool",
      timestamp: "2026-06-25T00:00:03Z",
      data: startData(2, OFF2),
    },
    {
      type: "custom",
      customType: "tinker-bridge-tool",
      timestamp: "2026-06-25T00:00:04Z",
      data: resultData(2),
    },
  ];
}

function buildTranscript(sessionId: string, withOffset: boolean): unknown[] {
  return [
    { type: "session", version: 1, id: sessionId },
    { message: { role: "user", content: "do the thing" } },
    // The coalesced single assistant-text block, persisted AFTER the tools fired.
    { message: { role: "assistant", content: [{ type: "text", text: ASSISTANT_TEXT }] } },
    ...toolEntries(withOffset),
  ];
}

describe("readSessionMessages — tinker-bridge textOffset segmentation", () => {
  let tmpDir = "";
  let storePath = "";
  registerTempSessionStore("openclaw-fs-segment-test-", (d, s) => {
    tmpDir = d;
    storePath = s;
  });

  test("Test A: with textOffset → interleaved per-segment assistant messages", () => {
    const sessionId = "seg-with-offset";
    const sessionFile = writeTranscript(tmpDir, sessionId, buildTranscript(sessionId, true));
    const msgs = readSessionMessages(sessionId, storePath, sessionFile) as RenderMsg[];

    // Expected order: assistant(segA.), tool1 use+result, assistant(segB.),
    // tool2 use+result, assistant(segC.) — plus the leading user message.
    const seq = msgs.map((m) => {
      if (m.role === "user" && !isToolResult(m)) {
        return "user";
      }
      if (isToolUse(m)) {
        return "tool_use";
      }
      if (isToolResult(m)) {
        return "tool_result";
      }
      if (isAssistantText(m)) {
        return `assistant:${assistantTextOf(m)}`;
      }
      return `other:${m.role}`;
    });

    expect(seq).toEqual([
      "user",
      "assistant:segA.",
      "tool_use",
      "tool_result",
      "assistant: segB.",
      "tool_use",
      "tool_result",
      "assistant: segC.",
    ]);
  });

  test("Test B: without textOffset → byte-identical to legacy splice", () => {
    const sessionId = "seg-no-offset";
    const sessionFile = writeTranscript(tmpDir, sessionId, buildTranscript(sessionId, false));
    const msgs = readSessionMessages(sessionId, storePath, sessionFile) as RenderMsg[];

    const seq = msgs.map((m) => {
      if (m.role === "user" && !isToolResult(m)) {
        return "user";
      }
      if (isToolUse(m)) {
        return "tool_use";
      }
      if (isToolResult(m)) {
        return "tool_result";
      }
      if (isAssistantText(m)) {
        return `assistant:${assistantTextOf(m)}`;
      }
      return `other:${m.role}`;
    });

    // Legacy behavior: ALL tools spliced before the single coalesced text.
    expect(seq).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "tool_use",
      "tool_result",
      `assistant:${ASSISTANT_TEXT}`,
    ]);

    // And there is exactly ONE assistant-text message carrying the full blob.
    const assistantTexts = msgs.filter(isAssistantText);
    expect(assistantTexts).toHaveLength(1);
    expect(assistantTextOf(assistantTexts[0])).toBe(ASSISTANT_TEXT);
  });
});
