import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildContextAnatomy, writeAnatomyEvent } from "./context-anatomy.js";
import { handleContextAnatomyRequest } from "./context-anatomy-http.js";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(): SessionSystemPromptReport {
  return {
    source: "run",
    generatedAt: Date.now(),
    systemPrompt: { chars: 15000, projectContextChars: 5000, nonProjectContextChars: 10000 },
    injectedWorkspaceFiles: [
      { name: "MEMORY.md", path: "MEMORY.md", missing: false, rawChars: 500, injectedChars: 500, truncated: false },
    ],
    skills: { promptChars: 2000, entries: [] },
    tools: { listChars: 500, schemaChars: 3000, entries: [] },
  };
}

function makeEvent(turn: number) {
  return buildContextAnatomy({
    turn,
    compactionCycle: 0,
    provider: "anthropic",
    model: "claude-opus-4-6",
    sessionKey: "test-http",
    systemPromptReport: makeReport(),
    messagesSnapshot: [{ role: "user", content: "hi" }],
    contextWindowTokens: 200000,
  });
}

type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
};

function mockReq(method: string, url: string): IncomingMessage {
  return {
    method,
    url,
    headers: { host: "localhost:18789" },
  } as unknown as IncomingMessage;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(body: string) {
      res.body = body;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testDir = path.join(os.tmpdir(), `anatomy-http-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const originalHome = process.env.HOME;

beforeEach(async () => {
  process.env.HOME = testDir;
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
});

describe("handleContextAnatomyRequest", () => {
  test("ignores non-matching paths", async () => {
    const req = mockReq("GET", "/budget");
    const res = mockRes();
    const handled = await handleContextAnatomyRequest(req, res as unknown as ServerResponse);
    expect(handled).toBe(false);
  });

  test("rejects non-GET methods", async () => {
    const req = mockReq("POST", "/api/context-anatomy/test-session");
    const res = mockRes();
    const handled = await handleContextAnatomyRequest(req, res as unknown as ServerResponse);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
  });

  test("returns 404 for session with no events", async () => {
    const req = mockReq("GET", "/api/context-anatomy/nonexistent/latest");
    const res = mockRes();
    const handled = await handleContextAnatomyRequest(req, res as unknown as ServerResponse);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  test("returns latest event", async () => {
    await writeAnatomyEvent("http-test", makeEvent(1));
    await writeAnatomyEvent("http-test", makeEvent(2));

    const req = mockReq("GET", "/api/context-anatomy/http-test/latest");
    const res = mockRes();
    const handled = await handleContextAnatomyRequest(req, res as unknown as ServerResponse);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turn).toBe(2);
  });

  test("returns event list with limit", async () => {
    for (let i = 0; i < 5; i++) {
      await writeAnatomyEvent("list-test", makeEvent(i));
    }

    const req = mockReq("GET", "/api/context-anatomy/list-test?limit=3");
    const res = mockRes();
    const handled = await handleContextAnatomyRequest(req, res as unknown as ServerResponse);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(3);
    expect(body.events).toHaveLength(3);
    expect(body.events[0].turn).toBe(2); // last 3 of 0-4
  });

  test("handles URL-encoded session keys", async () => {
    const key = "agent:main:main";
    await writeAnatomyEvent(key, makeEvent(1));

    const req = mockReq("GET", `/api/context-anatomy/${encodeURIComponent(key)}/latest`);
    const res = mockRes();
    const handled = await handleContextAnatomyRequest(req, res as unknown as ServerResponse);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turn).toBe(1);
  });
});
