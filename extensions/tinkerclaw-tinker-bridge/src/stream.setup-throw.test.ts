import { describe, expect, it, vi } from "vitest";

// FORK 2026-10-09 — a turn whose setup throws must END. run() picks its worker (pool, adoption
// scan, spawn, the Fractal fork lookup) before its try/finally, and `void run()` dropped the
// rejection, so the stream never ended and the turn hung until the gateway's own timeout. Found
// when a fork lookup threw on a pool without get(): ten stream tests sat at 120 s each.
//
// CONTROL. Before the guard, stream.result() never resolves here and the test times out.
vi.mock("./worker-pool.js", () => ({
  getPool: () => ({
    get: () => undefined,
    getOrCreate: () => {
      throw new Error("synthetic pool failure");
    },
    takeThinkLevelPending: () => undefined,
  }),
}));

import { createClaudeCodeStreamFn } from "./stream.js";

const MODEL = { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5" };

describe("a turn whose setup throws", () => {
  it("ends with the error envelope a failed turn carries, instead of hanging", async () => {
    const stream = await createClaudeCodeStreamFn()(
      MODEL as never,
      { systemPrompt: "setup-throw test", messages: [{ role: "user", content: "hi" }] } as never,
      { __openclawRunId: "run-setup-throw", __openclawSessionKey: "agent:main:main" } as never,
    );
    const message = (await stream.result()) as { content?: Array<{ text?: string }> };
    const text = (message.content ?? []).map((b) => b.text ?? "").join("");
    expect(text.startsWith("__ERR_ENV__:")).toBe(true);
    expect(text).toContain("synthetic pool failure");
  }, 5_000);
});
