import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import {
  closeAnatomyDb,
  insertAnatomyEvent,
  setAnatomyDbPathForTests,
} from "./context-anatomy-db.js";
import { handleContextAnatomyRequest } from "./context-anatomy-http.js";
import { buildContextAnatomy } from "./context-anatomy.js";

// FORK 2026-07-16 (bug-log [eeg-subagent-single-session-gap]): isolate each test to a
// fresh tmp DB so insertAnatomyEvent (which has no mock) stops polluting the REAL
// anatomy DB and ordering assertions are deterministic. Previously these tests wrote
// to ~/.openclaw/data/anatomy-timeline.db and the "event list with limit" case was
// permanently red from accumulated rows.
const tmpDir = mkdtempSync(join(tmpdir(), "anatomy-http-"));
let seq = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(): SessionSystemPromptReport {
  return {
    source: "run",
    generatedAt: Date.now(),
    systemPrompt: { chars: 15000, projectContextChars: 5000, nonProjectContextChars: 10000 },
    injectedWorkspaceFiles: [
      {
        name: "MEMORY.md",
        path: "MEMORY.md",
        missing: false,
        rawChars: 500,
        injectedChars: 500,
        truncated: false,
      },
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

beforeEach(() => {
  // Fresh isolated tmp DB per test — no real-DB pollution, exact/deterministic counts.
  setAnatomyDbPathForTests(join(tmpDir, `http-${seq++}.db`));
});

afterAll(() => {
  closeAnatomyDb();
  setAnatomyDbPathForTests(null);
  rmSync(tmpDir, { recursive: true, force: true });
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
    // Explicit, distinct timestamps: buildContextAnatomy stamps Date.now(), which
    // collides in a tight loop and makes DESC ordering nondeterministic.
    insertAnatomyEvent({ ...makeEvent(1), sessionKey: "http-test", timestampMs: 1000 });
    insertAnatomyEvent({ ...makeEvent(2), sessionKey: "http-test", timestampMs: 1001 });

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
      // Distinct, increasing timestamps so "newest 3" is deterministic (Date.now()
      // collides in this loop → arbitrary tie-break otherwise).
      insertAnatomyEvent({ ...makeEvent(i), sessionKey: "list-test", timestampMs: 1000 + i });
    }

    const req = mockReq("GET", "/api/context-anatomy/list-test?limit=3");
    const res = mockRes();
    const handled = await handleContextAnatomyRequest(req, res as unknown as ServerResponse);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(3);
    expect(body.events).toHaveLength(3);
    // The endpoint returns the newest N (querySessionEvents = ORDER BY timestamp DESC),
    // so the last 3 of turns 0-4 are the SET {2,3,4}. Assert the set, order-independent.
    expect(body.events.map((e: { turn: number }) => e.turn).sort()).toEqual([2, 3, 4]);
  });

  test("?tree=1 includes the session's subagent family; plain query excludes it", async () => {
    // FORK 2026-07-16 (EEG fan-out visibility): subagents are minted FLAT under the
    // agent root (agent:main:subagent:<uuid>). tree=1 must pull them alongside the
    // viewed main session so the seismograph can paint fan-out branches reload-proof.
    const mainKey = "agent:main:main";
    const subKey = "agent:main:subagent:tree-test-uuid";
    insertAnatomyEvent({ ...makeEvent(1), sessionKey: mainKey });
    insertAnatomyEvent({ ...makeEvent(1), sessionKey: subKey });

    // Membership assertions (not counts): the real DB may hold other subagent rows.
    const treeReq = mockReq(
      "GET",
      `/api/context-anatomy/${encodeURIComponent(mainKey)}?tree=1&limit=500`,
    );
    const treeRes = mockRes();
    await handleContextAnatomyRequest(treeReq, treeRes as unknown as ServerResponse);
    expect(treeRes.statusCode).toBe(200);
    const treeBody = JSON.parse(treeRes.body);
    const treeKeys = new Set(treeBody.events.map((e: { sessionKey?: string }) => e.sessionKey));
    expect(treeKeys.has(subKey)).toBe(true);
    expect(treeKeys.has(mainKey)).toBe(true);

    const plainReq = mockReq(
      "GET",
      `/api/context-anatomy/${encodeURIComponent(mainKey)}?limit=500`,
    );
    const plainRes = mockRes();
    await handleContextAnatomyRequest(plainReq, plainRes as unknown as ServerResponse);
    const plainBody = JSON.parse(plainRes.body);
    const plainKeys = new Set(plainBody.events.map((e: { sessionKey?: string }) => e.sessionKey));
    expect(plainKeys.has(subKey)).toBe(false);
    expect(plainKeys.has(mainKey)).toBe(true);
  });

  test("handles URL-encoded session keys", async () => {
    const key = "agent:main:main";
    insertAnatomyEvent({ ...makeEvent(1), sessionKey: key });

    const req = mockReq("GET", `/api/context-anatomy/${encodeURIComponent(key)}/latest`);
    const res = mockRes();
    const handled = await handleContextAnatomyRequest(req, res as unknown as ServerResponse);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turn).toBe(1);
  });
});
