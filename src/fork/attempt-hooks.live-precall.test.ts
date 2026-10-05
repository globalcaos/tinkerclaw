/**
 * FORK 2026-09-25 — the PRE-CALL anatomy row reaches the UI live (context-window-panel.md F5).
 *
 * The context bar was painted from the POST-TURN snapshot, where the reply is last, so the turn's
 * own prompt has slid into conversation history and `userMessageChars` reads 0 (F5). The pre-call
 * row that fixes that was written to SQLite but never pushed: `captureForensicDumpHook` passed
 * `emitLiveEvent: false`, because tinker-ui then routed a round-0 row in WITHOUT its runId and a
 * turn's two rows painted two bars. B6 removed that reason (app.ts always passes the envelope runId;
 * `pushEvent` merges by (runId, roundNumber) and keeps the pre-call composition, as the DB upsert
 * does), and the flag went with it.
 *
 * CONTROL: against attempt-hooks.ts as it stood before this change, the first two cases fail: no
 * live pre-call event (0 where 1 is expected; only the post-turn event in the second case).
 *
 * Isolated tmp DB per test, as in src/agents/context-anatomy.moral-code.test.ts: the hook and
 * onTurnComplete write REAL rows through insertAnatomyEvent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  closeAnatomyDb,
  querySessionEvents,
  setAnatomyDbPathForTests,
} from "../agents/context-anatomy-db.js";
import type { ContextAnatomyEvent } from "../agents/context-anatomy.js";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  captureForensicDumpHook,
  onTurnComplete,
  rememberPreCallAnatomyContext,
} from "./attempt-hooks.js";

// The hook owns the forensic capture, which writes real files under the state dir: stubbed. The
// event bus is spied on because the event IS the claim.
vi.mock("../forensic/dump-writer.js", () => ({
  captureForensicDump: vi.fn(() => Promise.resolve()),
  finalizeForensicRun: vi.fn(() => Promise.resolve()),
}));
vi.mock("../infra/agent-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/agent-events.js")>()),
  emitAgentEvent: vi.fn(),
}));
// onTurnComplete runs for real in the second case. Its side paths that could write outside the tmp
// dir or start background work are stubbed: a hedge in the reply appends a curiosity gap under the
// real home directory, the overseer may spawn a critic, and idle-goals arms a timer.
vi.mock("./curiosity-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./curiosity-store.js")>()),
  appendGap: vi.fn(),
}));
vi.mock("./overseer-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./overseer-runtime.js")>()),
  maybeRunOverseerFromHook: vi.fn(() => Promise.resolve()),
}));
vi.mock("./idle-goals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./idle-goals.js")>()),
  noteTurnActivity: vi.fn(),
}));

const dir = mkdtempSync(join(tmpdir(), "attempt-hooks-live-precall-"));
let seq = 0;

function makeReport(): SessionSystemPromptReport {
  return {
    source: "run",
    generatedAt: 1_700_000_000_000,
    systemPrompt: { chars: 15_000, projectContextChars: 5_000, nonProjectContextChars: 10_000 },
    injectedWorkspaceFiles: [],
    skills: { promptChars: 2_000, entries: [] },
    tools: { listChars: 500, schemaChars: 3_000, entries: [] },
  };
}

type LiveAnatomyEvent = {
  runId: string;
  stream: string;
  data: { phase?: unknown; sessionKey?: unknown; anatomy: ContextAnatomyEvent };
};

/** Every `lifecycle:context-anatomy` event pushed so far, oldest first. */
function liveAnatomyEvents(): LiveAnatomyEvent[] {
  return vi
    .mocked(emitAgentEvent)
    .mock.calls.map(([event]) => event as unknown as LiveAnatomyEvent)
    .filter((event) => event.stream === "lifecycle" && event.data?.phase === "context-anatomy");
}

const quietLog = { warn: () => {}, info: () => {} };
const history = [
  { role: "user", content: "earlier question" },
  { role: "assistant", content: "earlier answer" },
];

function seedPreCallContext(sessionKey: string): void {
  rememberPreCallAnatomyContext(sessionKey, {
    systemPromptReport: makeReport(),
    contextWindowTokens: 1_000_000,
    atMs: Date.now(),
  });
}

function hookParams(runId: string, sessionKey: string, prompt: string) {
  return {
    runId,
    sessionKey,
    model: "grok-4",
    provider: "xai",
    systemPromptText: "You are an agent.",
    messages: history,
    effectivePrompt: prompt,
    log: quietLog,
  };
}

beforeEach(() => {
  setAnatomyDbPathForTests(join(dir, `anatomy-${seq++}.db`));
  vi.mocked(emitAgentEvent).mockClear();
});

afterAll(() => {
  closeAnatomyDb();
  setAnatomyDbPathForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("the pre-call anatomy row is pushed live (F5)", () => {
  test("call 1 pushes ONE live event carrying the runId, snapshot 'pre-call' and the prompt", () => {
    const sessionKey = "agent:main:live-precall";
    const runId = "run-live-precall-1";
    const question = "build the feature";
    seedPreCallContext(sessionKey);

    captureForensicDumpHook(hookParams(runId, sessionKey, question));

    // CONTROL: 0 before this change. The row reached SQLite and the bar was never told.
    const events = liveAnatomyEvents();
    expect(events).toHaveLength(1);
    // The ENVELOPE runId is what tinker-ui hands pushEvent, and what merges the post-turn row onto
    // this bar rather than opening a second one (B6).
    expect(events[0]).toMatchObject({
      runId,
      stream: "lifecycle",
      data: { phase: "context-anatomy", sessionKey },
    });
    expect(events[0]!.data.anatomy).toMatchObject({ runId, roundNumber: 0, snapshot: "pre-call" });
    // What the bar can show BEFORE the model answers, and a post-turn snapshot cannot: this turn's
    // own prompt, itemised.
    expect(events[0]!.data.anatomy.contextSent.userMessageChars).toBe(question.length);

    // A tool-loop call of the same run is not call 1: no second row, no second event.
    captureForensicDumpHook({
      ...hookParams(runId, sessionKey, question),
      messages: [
        ...history,
        { role: "user", content: question },
        { role: "assistant", content: "calling a tool" },
      ],
    });
    expect(liveAnatomyEvents()).toHaveLength(1);
    expect(querySessionEvents(sessionKey, 50)).toHaveLength(1);
  });

  test("post-turn lands on the same (run, round) key: one bar live, one row in the DB", async () => {
    const sessionKey = "agent:main:live-precall-turn";
    const runId = "run-live-precall-2";
    const question = "ship it";
    seedPreCallContext(sessionKey);
    captureForensicDumpHook(hookParams(runId, sessionKey, question));

    const warnings: string[] = [];
    await onTurnComplete({
      runId,
      sessionManager: {} as never,
      sessionKey,
      messagesSnapshot: [
        ...history,
        { role: "user", content: question },
        { role: "assistant", content: "Shipped." },
      ],
      assistantTexts: ["Shipped."],
      systemPromptReport: makeReport(),
      provider: "xai",
      modelId: "grok-4",
      contextWindowTokens: 1_000_000,
      getUsageTotals: () => ({ total: 900, input: 860, output: 40 }),
      log: {
        info: () => {},
        debug: () => {},
        warn: (msg: string) => {
          warnings.push(msg);
        },
      },
    });

    // The real post-turn writer's event carries the same envelope runId and round as the pre-call
    // one: the key tinker-ui's pushEvent merges on, keeping the pre-call composition.
    const keys = liveAnatomyEvents().map((e) => [
      e.runId,
      e.data.anatomy.roundNumber,
      e.data.anatomy.snapshot,
    ]);
    expect(keys, warnings.join("\n")).toEqual([
      [runId, 0, "pre-call"],
      [runId, 0, "post-turn"],
    ]);
    // ...and the DB upserts the two writes into ONE row that keeps the pre-call composition, so the
    // merged live bar and a reloaded one agree.
    const rows = querySessionEvents(sessionKey, 50);
    expect(rows, warnings.join("\n")).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId, roundNumber: 0, snapshot: "pre-call" });
    expect(rows[0]!.contextSent.userMessageChars).toBe(question.length);
  });

  test("the first turn of a session (no remembered report) pushes nothing", () => {
    // The documented A9 gap: the system-prompt report reaches this module only via onTurnComplete.
    const sessionKey = "agent:main:live-precall-first";
    captureForensicDumpHook(hookParams("run-live-precall-3", sessionKey, "hello"));
    expect(liveAnatomyEvents()).toHaveLength(0);
    expect(querySessionEvents(sessionKey, 50)).toHaveLength(0);
  });
});
