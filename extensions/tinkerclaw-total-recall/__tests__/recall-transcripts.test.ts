/**
 * FORK 2026-10-09 (J1) — `recall` answers from the session TRANSCRIPTS.
 *
 * Before: the tool searched the per-session engram store, which holds assistant text only, and
 * read its session key from `execute`'s third argument — which is not a context object — so every
 * call searched the "main" store. What the architect said and what a command printed never came back.
 *
 * These tests seed a real session store + transcript under the isolated test HOME and call the
 * registered tool the way the gateway does: factory(ctx) → execute(toolCallId, params).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const transcript = (id: string, userText: string) =>
  line({ type: "session", version: 3, id, timestamp: "2026-10-01T06:00:00.000Z" }) +
  line({
    type: "message",
    timestamp: "2026-10-01T06:47:57.222Z",
    message: { role: "user", content: [{ type: "text", text: userText }] },
  }) +
  line({
    type: "message",
    timestamp: "2026-10-01T06:48:30.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Understood." }] },
  });

const MINE = "agent:main:tinker:recallmine";
const OTHER = "agent:main:whatsapp:group:recallother";

type RecallTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

function registerAndGetFactory(): Promise<(ctx: Record<string, unknown>) => RecallTool> {
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
  return import("../index.js").then((mod) => {
    mod.default.register(api as never);
    return registerTool.mock.calls[0][0];
  });
}

async function recall(ctx: Record<string, unknown>, params: Record<string, unknown>) {
  const factory = await registerAndGetFactory();
  const tool = factory(ctx);
  const res = await tool.execute("call-1", params);
  return JSON.parse(res.content[0].text) as {
    scope: string;
    results: Array<{ sessionKey?: string; role: string; text: string; thisSession: boolean }>;
  };
}

describe("recall tool reads the session transcripts", () => {
  beforeAll(() => {
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    const sessionsDir = dirname(storePath);
    mkdirSync(sessionsDir, { recursive: true });
    const mineFile = join(sessionsDir, "11111111-1111-4111-8111-111111111111.jsonl");
    const otherFile = join(sessionsDir, "22222222-2222-4222-8222-222222222222.jsonl");
    writeFileSync(
      mineFile,
      transcript("mine", "the quokka password lives on the programming wiki"),
    );
    writeFileSync(otherFile, transcript("other", "private quokka note from another chat"));
    writeFileSync(
      storePath,
      JSON.stringify({
        [MINE]: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          sessionFile: mineFile,
          updatedAt: Date.now(),
        },
        [OTHER]: {
          sessionId: "22222222-2222-4222-8222-222222222222",
          sessionFile: otherFile,
          updatedAt: Date.now(),
        },
      }),
    );
  });

  afterAll(async () => {
    vi.resetModules();
  });

  it("returns what the user said in this chat (the engram store never held user turns)", async () => {
    const out = await recall(
      { sessionKey: MINE, agentId: "main", senderIsOwner: true },
      { query: "quokka wiki" },
    );
    const own = out.results.filter((r) => r.thisSession);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ sessionKey: MINE, role: "user" });
    expect(own[0].text).toContain("programming «wiki»");
  });

  it("lets the owner search every chat, labelled with each chat's session key", async () => {
    const out = await recall(
      { sessionKey: MINE, agentId: "main", senderIsOwner: true },
      { query: "quokka", limit: 10 },
    );
    expect(out.scope).toBe("all");
    expect(new Set(out.results.map((r) => r.sessionKey))).toEqual(new Set([MINE, OTHER]));
  });

  it("keeps a non-owner inside its own chat even when it asks for all", async () => {
    const out = await recall(
      { sessionKey: MINE, agentId: "main", senderIsOwner: false },
      { query: "quokka", scope: "all" },
    );
    expect(out.scope).toBe("session");
    expect(out.results.map((r) => r.sessionKey)).toEqual([MINE]);
  });
});
