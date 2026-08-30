import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDanglingToolCall } from "./interrupted-run-probe.js";

let tmpDir: string;
let entrySeq = 0;

beforeEach(async () => {
  entrySeq = 0;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-interrupted-run-probe-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A persisted `tinker-bridge-tool` custom entry, as `appendCustomEntry` writes it. */
function toolLine(data: Record<string, unknown>): string {
  entrySeq += 1;
  return JSON.stringify({
    type: "custom",
    customType: "tinker-bridge-tool",
    id: `entry-${entrySeq}`,
    parentId: entrySeq > 1 ? `entry-${entrySeq - 1}` : null,
    timestamp: new Date(1_700_000_000_000 + entrySeq * 1_000).toISOString(),
    data,
  });
}

function messageLine(role: string, text: string): string {
  return JSON.stringify({ message: { role, content: [{ type: "text", text }] } });
}

async function writeTranscript(lines: string[], name = "session.jsonl"): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

describe("findDanglingToolCall", () => {
  it("returns an unpaired start with its name, runId and startedAt", async () => {
    const filePath = await writeTranscript([
      messageLine("user", "run the tool"),
      toolLine({
        runId: "run-1",
        phase: "start",
        toolCallId: "call-1",
        name: "exec",
        args: { command: "ls" },
        startedAt: 1_700_000_500_000,
      }),
    ]);

    expect(findDanglingToolCall(filePath)).toEqual({
      toolCallId: "call-1",
      name: "exec",
      runId: "run-1",
      startedAt: 1_700_000_500_000,
    });
  });

  it("returns null when the start got its matching result", async () => {
    const filePath = await writeTranscript([
      toolLine({ runId: "run-1", phase: "start", toolCallId: "call-1", name: "exec" }),
      toolLine({ runId: "run-1", phase: "result", toolCallId: "call-1", result: "ok" }),
    ]);

    expect(findDanglingToolCall(filePath)).toBeNull();
  });

  it("returns the one trailing unpaired start among several paired calls", async () => {
    const filePath = await writeTranscript([
      toolLine({ runId: "run-1", phase: "start", toolCallId: "call-1", name: "read" }),
      toolLine({ runId: "run-1", phase: "result", toolCallId: "call-1", result: "ok" }),
      toolLine({ runId: "run-1", phase: "start", toolCallId: "call-2", name: "grep" }),
      toolLine({ runId: "run-1", phase: "result", toolCallId: "call-2", result: "ok" }),
      messageLine("assistant", "partial narration before the interruption"),
      toolLine({
        runId: "run-1",
        phase: "start",
        toolCallId: "call-3",
        name: "exec",
        startedAt: 1_700_000_600_000,
      }),
    ]);

    expect(findDanglingToolCall(filePath)).toEqual({
      toolCallId: "call-3",
      name: "exec",
      runId: "run-1",
      startedAt: 1_700_000_600_000,
    });
  });

  it("returns null for a transcript with no custom records", async () => {
    const filePath = await writeTranscript([
      messageLine("user", "hello"),
      messageLine("assistant", "complete answer"),
    ]);

    expect(findDanglingToolCall(filePath)).toBeNull();
  });

  it("returns null (never throws) when the transcript file does not exist", () => {
    expect(findDanglingToolCall(path.join(tmpDir, "missing.jsonl"))).toBeNull();
  });

  it("ignores a torn final line and still finds the preceding unpaired start", async () => {
    const filePath = await writeTranscript([
      toolLine({ runId: "run-1", phase: "start", toolCallId: "call-1", name: "read" }),
      toolLine({ runId: "run-1", phase: "result", toolCallId: "call-1", result: "ok" }),
      toolLine({ runId: "run-1", phase: "start", toolCallId: "call-2", name: "exec" }),
      // SIGTERM mid-write: the process died halfway through the next record.
      '{"type":"custom","customType":"tinker-bridge-too',
    ]);

    expect(findDanglingToolCall(filePath)).toEqual({
      toolCallId: "call-2",
      name: "exec",
      runId: "run-1",
    });
  });

  it("ignores records whose toolCallId is missing or not a string", async () => {
    const filePath = await writeTranscript([
      toolLine({ runId: "run-1", phase: "start", name: "no-id" }),
      toolLine({ runId: "run-1", phase: "start", toolCallId: 42, name: "numeric-id" }),
      toolLine({ runId: "run-1", phase: "start", toolCallId: "call-9", name: "exec" }),
    ]);

    expect(findDanglingToolCall(filePath)).toEqual({
      toolCallId: "call-9",
      name: "exec",
      runId: "run-1",
    });
  });

  it("only scans the tail window (a start older than maxRecords is out of scope)", async () => {
    const filePath = await writeTranscript([
      toolLine({ runId: "run-1", phase: "start", toolCallId: "call-old", name: "exec" }),
      messageLine("assistant", "one"),
      messageLine("assistant", "two"),
      messageLine("assistant", "three"),
      messageLine("assistant", "four"),
    ]);

    expect(findDanglingToolCall(filePath, { maxRecords: 3 })).toBeNull();
    expect(findDanglingToolCall(filePath)).toEqual({
      toolCallId: "call-old",
      name: "exec",
      runId: "run-1",
    });
  });
});
