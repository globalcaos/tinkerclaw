/**
 * FORK 2026-10-25 — `recall({ id })` brings an evicted tool result back whole.
 *
 * Round trip: a transcript holds a long tool result; junk-first eviction (core
 * fork/attempt-hooks.ts) swaps it in context for a marker; the id the marker names goes through
 * the registered recall tool the way the gateway calls it, and the whole result comes back from
 * the transcript, which eviction never edits.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evictOldToolResults } from "../../../src/fork/attempt-hooks.js";
import { findTranscriptItem } from "../../../src/memory/engram/transcript-item.js";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

const MINE = "agent:main:tinker:recallbyid";
const OTHER = "agent:main:tinker:recallbyidother";
const MINE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";

// A command log far longer than one recall page (20,000 chars).
const BUILD_LOG = `$ make build\n${"compiling module...\n".repeat(2_500)}BUILD OK in 41s`;

function toolTurn(n: number, text: string) {
  return [
    { role: "user", content: [{ type: "text", text: `step ${n}` }] },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${n}`, name: "exec", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: `call-${n}`,
      toolName: "exec",
      isError: false,
      content: [{ type: "text", text }],
    },
  ];
}

// Six turns; the first holds the long log, the hot tail is large enough to keep the desk full.
const MESSAGES = [
  ...toolTurn(1, BUILD_LOG),
  ...[2, 3, 4, 5, 6].flatMap((n) => toolTurn(n, "x".repeat(20_000))),
];

function transcriptFor(sessionId: string, messages: unknown[]): string {
  let prev: string | null = null;
  let out = line({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-25T08:00:00Z" });
  messages.forEach((message, i) => {
    const id = `e${String(i).padStart(7, "0")}`;
    out += line({
      type: "message",
      id,
      parentId: prev,
      timestamp: "2026-10-25T08:00:01Z",
      message,
    });
    prev = id;
  });
  return out;
}

type RecallTool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

async function recallTool(ctx: Record<string, unknown>): Promise<RecallTool> {
  const registerTool = vi.fn();
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pluginConfig: { budgetTokens: 2000 },
    rootDir: __dirname,
    registerTool,
    registerGatewayMethod: vi.fn(),
    registerHook: vi.fn(),
    registerService: vi.fn(),
    resolvePath: (p: string) => p,
    on: vi.fn(),
    config: {},
    id: "tinkerclaw-total-recall",
    name: "Total Recall",
    source: "local" as const,
    runtime: {} as never,
  };
  const mod = await import("../index.js");
  mod.default.register(api as never);
  return (registerTool.mock.calls[0][0] as (c: Record<string, unknown>) => RecallTool)(ctx);
}

async function recall(params: Record<string, unknown>, sessionKey = MINE) {
  const tool = await recallTool({ sessionKey, agentId: "main", senderIsOwner: true });
  const res = await tool.execute("call-recall", params);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

let mineFile = "";

describe("recall({ id }) brings an evicted tool result back whole", () => {
  beforeAll(() => {
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    const sessionsDir = dirname(storePath);
    mkdirSync(sessionsDir, { recursive: true });
    mineFile = join(sessionsDir, `${MINE_ID}.jsonl`);
    const otherFile = join(sessionsDir, `${OTHER_ID}.jsonl`);
    // A context-engine rewrite appends a shortened copy and leaves the original: the longest wins.
    const shortenedCopy = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      isError: false,
      content: [{ type: "text", text: "[truncated]" }],
    };
    writeFileSync(mineFile, transcriptFor(MINE_ID, [...MESSAGES, shortenedCopy]));
    writeFileSync(
      otherFile,
      transcriptFor(OTHER_ID, toolTurn(9, "a secret printed in another chat")),
    );
    writeFileSync(
      storePath,
      JSON.stringify({
        [MINE]: { sessionId: MINE_ID, sessionFile: mineFile, updatedAt: Date.now() },
        [OTHER]: { sessionId: OTHER_ID, sessionFile: otherFile, updatedAt: Date.now() },
      }),
    );
  });

  afterAll(() => {
    vi.resetModules();
  });

  it("follows the marker junk-first eviction leaves, page by page, to the exact original", async () => {
    const evicted = evictOldToolResults(MESSAGES, 40_000).messages;
    expect(evicted).not.toBeNull();
    const marker = JSON.stringify(evicted![2].content);
    expect(marker).toContain("Evicted exec output");
    const args = /recall\((\{.*?\})\)/.exec(JSON.parse(marker)[0].text);
    expect(args).not.toBeNull();
    const { id } = JSON.parse(args![1]) as { id: string };
    expect(id).toBe("call-1");

    const page1 = await recall({ id });
    expect(page1).toMatchObject({
      found: true,
      kind: "tool_result",
      toolName: "exec",
      totalChars: BUILD_LOG.length,
      offset: 0,
      nextOffset: 20_000,
    });
    const page2 = await recall({ id, offset: page1.nextOffset, length: 100_000 });
    expect(page2.nextOffset).toBeUndefined();
    expect(String(page1.text) + String(page2.text)).toBe(BUILD_LOG);
  });

  it("answers a transcript entry id too (a compaction marker's address)", async () => {
    const out = await recall({ id: "e0000003" });
    expect(out).toMatchObject({ found: true, kind: "entry", role: "user", text: "step 2" });
  });

  it("reads only this chat's transcript", async () => {
    const out = await recall({ id: "call-9" });
    expect(out).toMatchObject({ found: false });
    expect(findTranscriptItem(mineFile, "call-9")).toBeUndefined();
  });

  it("asks for a query or an id when it gets neither", async () => {
    expect(await recall({})).toMatchObject({ error: expect.stringContaining("query") });
  });
});
