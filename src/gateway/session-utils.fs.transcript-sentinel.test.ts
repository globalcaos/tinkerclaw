import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readLatestSessionUsageFromTranscript } from "./session-utils.fs.js";

/**
 * FORK 2026-07-31 — regression pins for the TRANSCRIPT-ONLY SENTINEL guard inside
 * `extractLatestUsageFromTranscriptChunk` (src/gateway/session-utils.fs.ts).
 *
 * `provider:"openclaw"` assistant entries whose model is `delivery-mirror` (channel delivery
 * mirror, src/config/sessions/transcript.ts) or `gateway-injected` (restart warnings / abort
 * envelopes, src/gateway/server-methods/chat-transcript-inject.ts) are records the gateway wrote
 * into the transcript itself — not model output. That scan feeds the SESSION ROW, so a sentinel
 * that reaches the row's model poisons every downstream reader: the Tinker UI thinking indicator
 * loses its provider colour (a grey dot reading "gatewa" while opus was answering) and the
 * Models panel counts live runs under "gateway-injected".
 *
 * Only `delivery-mirror` was excluded before 2026-07-31; `gateway-injected` leaked through.
 */

let tmpDir = "";
let storePath = "";

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-sentinel-"));
  storePath = path.join(tmpDir, "sessions.json");
});

afterAll(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writeTranscript(sessionId: string, lines: unknown[]): void {
  fs.writeFileSync(
    path.join(tmpDir, `${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf-8",
  );
}

function assistantTurn(provider: string, model: string): unknown {
  return {
    message: {
      role: "assistant",
      provider,
      model,
      usage: { input: 1_200, output: 300, cacheRead: 50, cost: { total: 0.0042 } },
    },
  };
}

/**
 * Mirrors the envelope the gateway actually writes (chat-transcript-inject.ts): all-zero token
 * counts but a real `cost.total: 0`. That makes `hasMeaningfulUsage` TRUE, so the sentinel is NOT
 * dropped by the zero-usage early-continue — it has to be excluded on provider+model or it wins
 * the session row. Do not "simplify" this fixture to a usage-less message; that would test a
 * different (already-working) code path.
 */
function sentinelTurn(model: "delivery-mirror" | "gateway-injected"): unknown {
  return {
    message: {
      role: "assistant",
      provider: "openclaw",
      model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

describe("readLatestSessionUsageFromTranscript — transcript-only openclaw sentinels", () => {
  test("a trailing gateway-injected entry does not become the session row's model", () => {
    const sessionId = "sentinel-gateway-injected-tail";
    writeTranscript(sessionId, [
      { type: "session", version: 1, id: sessionId },
      assistantTurn("claude-code", "claude-opus-5"),
      sentinelTurn("gateway-injected"),
    ]);

    const snapshot = readLatestSessionUsageFromTranscript(sessionId, storePath);
    expect(snapshot).toMatchObject({
      modelProvider: "claude-code",
      model: "claude-opus-5",
    });
    // the real turn's context snapshot must survive the sentinel too
    expect(snapshot?.totalTokens).toBe(1250);
  });

  test("a trailing delivery-mirror entry does not become the session row's model", () => {
    const sessionId = "sentinel-delivery-mirror-tail";
    writeTranscript(sessionId, [
      { type: "session", version: 1, id: sessionId },
      assistantTurn("claude-code", "claude-opus-5"),
      sentinelTurn("delivery-mirror"),
    ]);

    expect(readLatestSessionUsageFromTranscript(sessionId, storePath)).toMatchObject({
      modelProvider: "claude-code",
      model: "claude-opus-5",
    });
  });

  test("a transcript of nothing but sentinels resolves to no model at all", () => {
    const sessionId = "sentinel-only";
    writeTranscript(sessionId, [
      { type: "session", version: 1, id: sessionId },
      sentinelTurn("gateway-injected"),
      sentinelTurn("delivery-mirror"),
      sentinelTurn("gateway-injected"),
    ]);

    const snapshot = readLatestSessionUsageFromTranscript(sessionId, storePath);
    expect(snapshot?.model).toBeUndefined();
    expect(snapshot?.modelProvider).toBeUndefined();
  });

  test("a real model tail is unaffected", () => {
    const sessionId = "sentinel-real-model-tail";
    writeTranscript(sessionId, [
      { type: "session", version: 1, id: sessionId },
      assistantTurn("openai", "gpt-5.4"),
      assistantTurn("claude-code", "claude-opus-5"),
    ]);

    expect(readLatestSessionUsageFromTranscript(sessionId, storePath)).toMatchObject({
      modelProvider: "claude-code",
      model: "claude-opus-5",
      inputTokens: 2400,
      outputTokens: 600,
    });
  });

  test("provider-scoped: a non-openclaw model named gateway-injected is kept", () => {
    const sessionId = "sentinel-provider-scoped";
    writeTranscript(sessionId, [
      { type: "session", version: 1, id: sessionId },
      assistantTurn("claude-code", "claude-opus-5"),
      assistantTurn("acme", "gateway-injected"),
    ]);

    expect(readLatestSessionUsageFromTranscript(sessionId, storePath)).toMatchObject({
      modelProvider: "acme",
      model: "gateway-injected",
    });
  });
});
