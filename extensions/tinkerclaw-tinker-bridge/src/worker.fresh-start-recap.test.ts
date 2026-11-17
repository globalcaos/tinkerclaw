import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FreshStartWhy } from "./fresh-start-recap.js";

// REGRESSION 2026-11-13 (bug-log.md `fresh-session-no-recap`): the worker's side of the recap. start() records why
// it began a new Claude session; the first prose turn of that session takes the chat's last turns in front of its
// prompt, once. The constructor is inert (no subprocess), so the private state is driven directly, as in
// worker.dead-resume.test.ts. HOME and the session map are redirected for the same reason as there.
let tmpHome: string;
let realHome: string | undefined;
let ClaudeCodeWorker: typeof import("./worker.js").ClaudeCodeWorker;

const WHY: FreshStartWhy = {
  reason: "oversized",
  transcriptPath: "/tmp/x.jsonl",
  sizeBytes: 32_500_000,
  limitBytes: 8_000_000,
};

beforeAll(async () => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-recap-home-"));
  process.env.HOME = tmpHome;
  process.env.OPENCLAW_TINKER_BRIDGE_SESSION_MAP = path.join(tmpHome, "session-map.json");
  vi.resetModules();
  ({ ClaudeCodeWorker } = await import("./worker.js"));
});

afterAll(() => {
  if (realHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = realHome;
  }
  delete process.env.OPENCLAW_TINKER_BRIDGE_SESSION_MAP;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function worker(freshStart: FreshStartWhy | null) {
  const w = new ClaudeCodeWorker({ sessionKey: "tinker-sp-recap", cwd: "/tmp" } as never);
  // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
  const wAny = w as any;
  wAny.freshStart = freshStart;
  return wAny as {
    freshStart: FreshStartWhy | null;
    takeFreshStartRecap(p: {
      userText: string;
      freshRecap?: (why: FreshStartWhy) => string | null;
    }): string | null;
  };
}

describe("ClaudeCodeWorker.takeFreshStartRecap", () => {
  it("gives a session that resumed nothing, and does not ask for a recap", () => {
    const build = vi.fn(() => "BLOCK");
    expect(worker(null).takeFreshStartRecap({ userText: "hi", freshRecap: build })).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it("gives a session started new the recap once, with the reason", () => {
    const build = vi.fn(() => "BLOCK");
    const w = worker(WHY);
    expect(w.takeFreshStartRecap({ userText: "hi", freshRecap: build })).toBe("BLOCK");
    expect(build).toHaveBeenCalledWith(WHY);
    expect(w.takeFreshStartRecap({ userText: "again", freshRecap: build })).toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("keeps the recap owed while a turn brings no way to build it", () => {
    const w = worker(WHY);
    expect(w.takeFreshStartRecap({ userText: "hi" })).toBeNull();
    expect(w.freshStart).toEqual(WHY);
    expect(w.takeFreshStartRecap({ userText: "hi", freshRecap: () => "BLOCK" })).toBe("BLOCK");
  });

  it("sends the prompt without a recap when the builder throws or returns nothing", () => {
    const thrower = worker(WHY);
    expect(
      thrower.takeFreshStartRecap({
        userText: "hi",
        freshRecap: () => {
          throw new Error("history unreadable");
        },
      }),
    ).toBeNull();
    expect(thrower.freshStart).toBeNull();
    expect(
      worker(WHY).takeFreshStartRecap({ userText: "hi", freshRecap: () => "  \n" }),
    ).toBeNull();
    expect(worker(WHY).takeFreshStartRecap({ userText: "hi", freshRecap: () => null })).toBeNull();
  });
});
