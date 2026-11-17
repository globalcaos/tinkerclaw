// FORK 2026-11-03 (context-window-panel.md A11) — the bridge's EVICT hand-off: find the chat's Claude Code session,
// refuse under a live reply, fork, point the chat at the fork, retire the idle worker. Every dependency is injected,
// so no test reads the live session map or the live ~/.claude.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliEvictResult } from "./cli-evict.js";
import { BRIDGE_EVICT_SLOT, createEvictSeam, findClaudeTranscript } from "./evict-seam.js";

const OK = (forkPath: string): CliEvictResult => ({
  ok: true,
  forkPath,
  forkSessionId: "fork-id",
  evictedPrompts: 3,
  keptPrompts: 2,
  tokensBefore: 1000,
  tokensAfter: 400,
  evictedTokens: 600,
});

function setup(o: { busy?: boolean[]; moved?: number; lookup?: string | undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evict-seam-"));
  const forkPath = path.join(dir, "fork-id.jsonl");
  const busy = [...(o.busy ?? [false, false])];
  const pool = {
    isBusyOnSession: vi.fn(() => busy.shift() ?? false),
    retireIdleOnSession: vi.fn(() => 1),
  };
  const rebind = vi.fn(() => o.moved ?? 1);
  const fork = vi.fn(() => {
    fs.writeFileSync(forkPath, "{}\n");
    return OK(forkPath);
  });
  const seam = createEvictSeam({
    pool: () => pool,
    lookup: () => ("lookup" in o ? o.lookup : "claude-id"),
    findTranscript: () => path.join(dir, "claude-id.jsonl"),
    rebind,
    fork,
  });
  return { seam, pool, rebind, fork, forkPath };
}

describe("createEvictSeam", () => {
  it("forks, points the chat at the fork and retires the idle worker", () => {
    const { seam, pool, rebind, fork, forkPath } = setup();
    expect(seam.evict("oc-session", 0.5)).toEqual(OK(forkPath));
    expect(fork).toHaveBeenCalledWith(expect.stringMatching(/claude-id\.jsonl$/), {
      keepFraction: 0.5,
      recallHint: true,
    });
    expect(rebind).toHaveBeenCalledWith("claude-id", "fork-id");
    expect(pool.retireIdleOnSession).toHaveBeenCalledWith("claude-id");
    expect(fs.existsSync(forkPath)).toBe(true);
  });

  it("refuses under a live reply without writing anything", () => {
    const { seam, fork, rebind } = setup({ busy: [true] });
    expect(seam.evict("oc-session", 0.5)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/reply/),
    });
    expect(fork).not.toHaveBeenCalled();
    expect(rebind).not.toHaveBeenCalled();
  });

  it("drops the fork when a reply started while it was written", () => {
    const { seam, rebind, pool, forkPath } = setup({ busy: [false, true] });
    expect(seam.evict("oc-session", 0.5)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/reply/),
    });
    expect(rebind).not.toHaveBeenCalled();
    expect(pool.retireIdleOnSession).not.toHaveBeenCalled();
    expect(fs.existsSync(forkPath)).toBe(false);
  });

  it("drops the fork when nothing could be pointed at it", () => {
    const { seam, pool, forkPath } = setup({ moved: 0 });
    expect(seam.evict("oc-session", 0.5)).toMatchObject({ ok: false });
    expect(pool.retireIdleOnSession).not.toHaveBeenCalled();
    expect(fs.existsSync(forkPath)).toBe(false);
  });

  it("says so when the chat has no Claude Code session", () => {
    const { seam, fork } = setup({ lookup: undefined });
    expect(seam.evict("oc-session", 0.5)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no Claude Code/),
    });
    expect(fork).not.toHaveBeenCalled();
  });
});

describe("findClaudeTranscript", () => {
  it("finds <id>.jsonl in any project folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-"));
    fs.mkdirSync(path.join(root, "-a"));
    fs.mkdirSync(path.join(root, "-b"));
    fs.writeFileSync(path.join(root, "-b", "sid.jsonl"), "");
    expect(findClaudeTranscript("sid", root)).toBe(path.join(root, "-b", "sid.jsonl"));
    expect(findClaudeTranscript("other", root)).toBeNull();
    expect(findClaudeTranscript("sid", path.join(root, "missing"))).toBeNull();
  });
});

describe("the slot", () => {
  it("is the name the gateway's EVICT handler reads", () => {
    const gateway = fs.readFileSync(
      path.resolve(__dirname, "../../../src/gateway/session-eviction.ts"),
      "utf8",
    );
    expect(gateway).toContain(`export const BRIDGE_EVICT_SLOT = "${BRIDGE_EVICT_SLOT}";`);
  });
});
