import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  appendRestartNoticeToTranscript,
  buildRestartNoticeRow,
  describeRestartNotice,
  isRestartNoticeData,
  notedRestartReason,
  noteRestartReason,
  RESTART_NOTICE_CUSTOM_TYPE,
  takeRestartContext,
  writeRestartContext,
} from "./restart-notice.js";
import { readSessionMessages } from "./session-utils.fs.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("restart notice", () => {
  it("describes the pause window, the reason and how the chat came back", () => {
    const text = describeRestartNotice({
      stoppedAt: new Date("2026-09-29T21:58:05").getTime(),
      backAt: new Date("2026-09-29T21:59:40").getTime(),
      reason: "upgrade to 4059bb6",
      how: "continued",
    });
    expect(text).toBe(
      "Gateway restarted · paused 21:58:05 → back 21:59:40 · upgrade to 4059bb6 · continued where it stopped",
    );
  });

  it("builds a system display row the UI can render and recovery skips", () => {
    const row = buildRestartNoticeRow({ backAt: 5, how: "reattached" }, { id: "e1", seq: 7 });
    expect(row).toMatchObject({
      role: "system",
      __openclaw: { kind: "restart-notice", id: "e1", seq: 7, backAt: 5, how: "reattached" },
    });
  });

  it("guards its data", () => {
    expect(isRestartNoticeData({ backAt: 1, how: "prompted" })).toBe(true);
    expect(isRestartNoticeData({ backAt: 1, how: "other" })).toBe(false);
    expect(isRestartNoticeData(null)).toBe(false);
  });

  it("appends a custom entry, never a message", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-notice-"));
    dirs.push(dir);
    const file = path.join(dir, "s.jsonl");
    // a real transcript: SessionManager only writes a file once it holds an assistant message
    const seed = SessionManager.open(file);
    seed.appendMessage({ role: "user", content: "go", timestamp: 1 } as never);
    seed.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "on it" }],
      stopReason: "toolUse",
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    } as never);
    const r = appendRestartNoticeToTranscript({
      transcriptPath: file,
      data: { backAt: 1, how: "continued" },
    });
    expect(r.ok).toBe(true);
    const entries = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type?: string; customType?: string });
    const last = entries[entries.length - 1];
    expect(last).toMatchObject({ type: "custom", customType: RESTART_NOTICE_CUSTOM_TYPE });
    // the notice added no message: still exactly the two seeded ones
    expect(entries.filter((e) => e.type === "message")).toHaveLength(2);

    // chat.history serves it as a display row, in transcript order
    const served = readSessionMessages("s", path.join(dir, "sessions.json"), file) as Array<{
      role?: string;
      __openclaw?: { kind?: string; seq?: number };
    }>;
    expect(served.map((m) => m.__openclaw?.kind ?? m.role)).toEqual([
      "user",
      "assistant",
      "restart-notice",
    ]);
    expect(served[2]).toMatchObject({ role: "system", __openclaw: { seq: 3, how: "continued" } });
  });

  it("serves a notice from a flat (pre-tree) transcript too", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-notice-"));
    dirs.push(dir);
    const file = path.join(dir, "flat.jsonl");
    const lines = [
      { message: { role: "user", content: "go", timestamp: 1 } },
      {
        type: "custom",
        id: "n1",
        customType: RESTART_NOTICE_CUSTOM_TYPE,
        data: { backAt: 9, how: "prompted" },
      },
    ];
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const served = readSessionMessages("flat", path.join(dir, "sessions.json"), file);
    expect(served[1]).toMatchObject({
      role: "system",
      __openclaw: { kind: "restart-notice", id: "n1", seq: 2, how: "prompted" },
    });
  });

  it("starts an empty transcript (a chat cut in its first turn) instead of refusing it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-notice-"));
    dirs.push(dir);
    const file = path.join(dir, "first-turn.jsonl");
    fs.writeFileSync(file, "");
    const r = appendRestartNoticeToTranscript({
      transcriptPath: file,
      data: { backAt: 1, how: "reattached" },
    });
    expect(r.ok).toBe(true);
    const entries = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type?: string; customType?: string });
    expect(entries[0]?.type).toBe("session");
    expect(entries.at(-1)).toMatchObject({
      type: "custom",
      customType: RESTART_NOTICE_CUSTOM_TYPE,
    });
  });

  it("refuses to write a transcript with no session header (SessionManager.open would truncate it)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-notice-"));
    dirs.push(dir);
    const file = path.join(dir, "flat.jsonl");
    const content = `${JSON.stringify({ message: { role: "user", content: "go" } })}\n`;
    fs.writeFileSync(file, content);
    const r = appendRestartNoticeToTranscript({
      transcriptPath: file,
      data: { backAt: 1, how: "continued" },
    });
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });
});

describe("restart context", () => {
  let stateDir: string;
  let previous: string | undefined;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-ctx-"));
    dirs.push(stateDir);
    previous = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    __testing.reset();
  });
  afterEach(() => {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
    __testing.reset();
  });

  it("carries the stop's time and the drain's reason to the next boot, once", () => {
    noteRestartReason("upgrade to 4059bb6");
    writeRestartContext({ stoppedAt: Date.now(), reason: notedRestartReason() });
    expect(notedRestartReason()).toBeUndefined(); // spent by the stop

    const first = takeRestartContext();
    expect(first?.reason).toBe("upgrade to 4059bb6");
    // every chat recovered in this boot gets the same context, and the file is gone
    expect(takeRestartContext()).toEqual(first);
    expect(fs.existsSync(path.join(stateDir, "gateway-restart-context.json"))).toBe(false);
  });

  it("ignores a context older than a day (some other stop)", () => {
    writeRestartContext({ stoppedAt: Date.now() - 25 * 3600_000 });
    expect(takeRestartContext()).toBeUndefined();
  });
});
