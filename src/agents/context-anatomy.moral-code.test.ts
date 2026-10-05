import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import {
  buildPreCallMessagesSnapshot,
  captureForensicDumpHook,
  rememberPreCallAnatomyContext,
} from "../fork/attempt-hooks.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { MORAL_CODE_MARKER } from "../moral-code/contract.js";
import {
  closeAnatomyDb,
  insertAnatomyEvent,
  openAnatomyDb,
  querySessionEvents,
  setAnatomyDbPathForTests,
} from "./context-anatomy-db.js";
import type { ContextAnatomyEvent } from "./context-anatomy.js";
import { buildContextAnatomy, measureMoralCodeChars } from "./context-anatomy.js";

// The forensic dump writes real files under the state dir; the pre-call hook owns that capture, so
// it is stubbed here — this file tests the ANATOMY half. The live-event emitter is spied on because
// one claim below is that the pre-call row is pushed as exactly ONE live UI event (since 2026-09-25;
// src/fork/attempt-hooks.live-precall.test.ts owns the event's shape).
vi.mock("../forensic/dump-writer.js", () => ({
  captureForensicDump: vi.fn(() => Promise.resolve()),
  finalizeForensicRun: vi.fn(() => Promise.resolve()),
}));
vi.mock("../infra/agent-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/agent-events.js")>()),
  emitAgentEvent: vi.fn(),
}));

// FORK 2026-09-24 — bible context-window-panel.md §6.1 step A9 (findings F5, F6).
//
// Each claim here has a CONTROL that shows the broken behaviour really failing, because every one of
// them is the kind of assertion that passes just as happily against a broken fixture:
//   1. the moral code is counted in its OWN field, carved out of a slab that held it, added when no
//      slab did (F6) — including the JSON-escaped form every block-array message is measured in;
//   2. a PRE-CALL composition itemises the turn's user prompt and a post-turn one cannot (F5), and
//      the hook really builds it from the prompt rather than from the previous turn's tail;
//   3. a pre-call row and a post-turn row for one call are ONE row, not two, and the migration that
//      makes it so tolerates the duplicates history already holds.
//
// Isolated tmp DB per test (same reason as context-anatomy-db-index-wal.test.ts): insertAnatomyEvent
// writes REAL rows and has no mock, so the production DB would otherwise be polluted.

const dir = mkdtempSync(join(tmpdir(), "anatomy-moral-code-"));
let seq = 0;

/** A pack shaped exactly like the real one: the shared opening marker, a body, the closing tag. */
const PACK = `${MORAL_CODE_MARKER}\n\n# Ethical rules\n${"x".repeat(4000)}\n</moral_code>`;

const REPORT_SYSTEM_CHARS = 15_000;
const REPORT_NON_PROJECT_CHARS = 10_000;

function makeReport(): SessionSystemPromptReport {
  return {
    source: "run",
    generatedAt: 1_700_000_000_000,
    systemPrompt: {
      chars: REPORT_SYSTEM_CHARS,
      projectContextChars: REPORT_SYSTEM_CHARS - REPORT_NON_PROJECT_CHARS,
      nonProjectContextChars: REPORT_NON_PROJECT_CHARS,
    },
    injectedWorkspaceFiles: [
      {
        name: "MEMORY.md",
        path: "memory/MEMORY.md",
        missing: false,
        rawChars: 500,
        injectedChars: 500,
        truncated: false,
      },
    ],
    skills: { promptChars: 2_000, entries: [] },
    tools: { listChars: 500, schemaChars: 3_000, entries: [] },
  };
}

type BuildParams = Parameters<typeof buildContextAnatomy>[0];

function build(
  overrides: Partial<BuildParams> & { messagesSnapshot: BuildParams["messagesSnapshot"] },
): ContextAnatomyEvent {
  return buildContextAnatomy({
    turn: 1,
    roundNumber: 0,
    compactionCycle: 0,
    provider: "xai",
    model: "grok-4",
    sessionKey: `anatomy-moral-${seq}`,
    systemPromptReport: makeReport(),
    contextWindowTokens: 1_000_000,
    ...overrides,
  });
}

const quietLog = { warn: () => {}, info: () => {} };

beforeEach(() => {
  setAnatomyDbPathForTests(join(dir, `anatomy-${seq++}.db`));
  vi.mocked(emitAgentEvent).mockClear();
});

afterAll(() => {
  closeAnatomyDb();
  setAnatomyDbPathForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// measureMoralCodeChars
// ---------------------------------------------------------------------------

describe("measureMoralCodeChars", () => {
  test("measures the span from the shared opening marker to the derived closing tag", () => {
    expect(measureMoralCodeChars(`before ${PACK} after`)).toBe(PACK.length);
    expect(measureMoralCodeChars("nothing here")).toBe(0);
    expect(measureMoralCodeChars(undefined)).toBe(0);
  });

  test("counts EVERY copy — the pack is re-delivered after each compaction", () => {
    expect(measureMoralCodeChars(`${PACK}\n\nmid\n\n${PACK}`)).toBe(PACK.length * 2);
  });

  test("an unterminated pack counts to the end of the text, not to zero", () => {
    // Those bytes reached the model whether or not the closing tag survived. Reporting 0 would be
    // the same class of defect as the historical "tool results 0": absence read as a measurement.
    const truncated = `${MORAL_CODE_MARKER}\nrules that were cut off`;
    expect(measureMoralCodeChars(truncated)).toBe(truncated.length);
  });

  test("finds the pack in JSON-serialised text, where the marker's quotes are escaped", () => {
    const serialised = JSON.stringify([{ type: "text", text: `${PACK}question` }]);
    // CONTROL — the raw marker is simply not in the serialised form. A raw-only search reads 0 on
    // every block-array message, which is every prompt pi-agent-core stores.
    expect(serialised.includes(MORAL_CODE_MARKER)).toBe(false);
    expect(measureMoralCodeChars(serialised)).toBe(JSON.stringify(PACK).length - 2);
  });
});

// ---------------------------------------------------------------------------
// F6 — marker attribution
// ---------------------------------------------------------------------------

describe("moral code attribution (F6)", () => {
  test("a pack at the head of the user prompt is counted in moralCode, NOT in the user message", () => {
    const question = "What is the plan?";
    const withPack = build({
      messagesSnapshot: [{ role: "user", content: `${PACK}${question}` }] as never,
    });

    expect(withPack.contextSent.moralCodeChars).toBe(PACK.length);
    expect(withPack.contextSent.userMessageChars).toBe(question.length);

    // CONTROL — the identical call without the pack. Before A9 the two runs were indistinguishable
    // except by a userMessage span 4k larger, i.e. the moral code was silently billed to the human.
    const without = build({ messagesSnapshot: [{ role: "user", content: question }] as never });
    expect(without.contextSent.moralCodeChars).toBe(0);
    expect(without.contextSent.userMessageChars).toBe(question.length);

    // CARVED OUT, never added on top: the only difference in the total is the pack itself.
    expect(withPack.contextSent.totalChars - without.contextSent.totalChars).toBe(PACK.length);
  });

  test("a pack inside block-array content (the stored shape) is carved out too", () => {
    const question = "What is the plan?";
    const content = [{ type: "text", text: `${PACK}${question}` }];
    const event = build({ messagesSnapshot: [{ role: "user", content }] as never });
    const packInJson = JSON.stringify(PACK).length - 2;
    expect(event.contextSent.moralCodeChars).toBe(packInJson);
    expect(event.contextSent.userMessageChars).toBe(JSON.stringify(content).length - packInJson);
  });

  test("a pack appended to the system prompt AFTER the report was built is ADDED, not carved", () => {
    // The common case: the pack arrives as before_prompt_build prependContext, and with a transcript
    // prompt attempt.ts moves that context into a turn-local system-prompt override — bytes the
    // report (built from the base prompt) never counted.
    const base = "b".repeat(REPORT_SYSTEM_CHARS);
    const withPack = build({
      messagesSnapshot: [{ role: "user", content: "hi" }] as never,
      systemPromptText: `${base}\n\n${PACK}`,
    });
    const without = build({
      messagesSnapshot: [{ role: "user", content: "hi" }] as never,
      systemPromptText: base,
    });

    expect(withPack.contextSent.moralCodeChars).toBe(PACK.length);
    // CONTROL — carving here would have read REPORT_NON_PROJECT_CHARS - PACK.length: a system prompt
    // under-reported by the size of a pack it never contained, and a total that did not grow.
    expect(withPack.contextSent.systemPromptChars).toBe(REPORT_NON_PROJECT_CHARS);
    expect(withPack.contextSent.totalChars - without.contextSent.totalChars).toBe(PACK.length);
  });

  test("a pack inside the bytes the report measured is carved out of systemPromptChars", () => {
    // Same length as the report's `chars`, so there are no unreported bytes for the pack to be in.
    const systemPromptText = `${PACK}${"b".repeat(REPORT_SYSTEM_CHARS - PACK.length)}`;
    const event = build({
      messagesSnapshot: [{ role: "user", content: "hi" }] as never,
      systemPromptText,
    });
    const without = build({
      messagesSnapshot: [{ role: "user", content: "hi" }] as never,
      systemPromptText: "b".repeat(REPORT_SYSTEM_CHARS),
    });
    expect(event.contextSent.moralCodeChars).toBe(PACK.length);
    expect(event.contextSent.systemPromptChars).toBe(REPORT_NON_PROJECT_CHARS - PACK.length);
    expect(event.contextSent.totalChars).toBe(without.contextSent.totalChars);
  });

  test("cc-bridge: the published pack size is ADDED only when nothing local carries the marker", () => {
    // The pack lives inside the Claude Code --resume transcript the gateway never sees, so there is
    // nothing to detect and nothing to carve out — those bytes were in no slab at all.
    const viaTranscript = build({
      messagesSnapshot: [{ role: "user", content: "hi" }] as never,
      moralCodeInTranscript: true,
      moralCodePackChars: 40_331,
    });
    expect(viaTranscript.contextSent.moralCodeChars).toBe(40_331);

    // ...and NEVER both. A pack visible in the snapshot is measured, not re-added from the file: a
    // double count would read as a 2x moral code and nothing downstream could tell.
    const both = build({
      messagesSnapshot: [{ role: "user", content: PACK }] as never,
      moralCodeInTranscript: true,
      moralCodePackChars: 40_331,
    });
    expect(both.contextSent.moralCodeChars).toBe(PACK.length);
  });
});

// ---------------------------------------------------------------------------
// F5 — pre-call vs post-turn composition
// ---------------------------------------------------------------------------

describe("pre-call composition (F5)", () => {
  test("a pre-call snapshot itemises the turn's prompt; a post-turn one structurally cannot", () => {
    const prompt = "build the feature";
    const pre = build({
      messagesSnapshot: [{ role: "user", content: prompt }] as never,
      snapshot: "pre-call",
    });
    expect(pre.snapshot).toBe("pre-call");
    expect(pre.contextSent.userMessageChars).toBeGreaterThan(0);

    // CONTROL — the SAME turn seen after the reply committed. The assistant's message is now last,
    // so the user prompt is no longer "the last message" and lands in conversation history. That is
    // F5 exactly, and it is the entire reason a pre-call row has to exist.
    const post = build({
      messagesSnapshot: [
        { role: "user", content: prompt },
        { role: "assistant", content: "done" },
      ] as never,
      snapshot: "post-turn",
    });
    expect(post.contextSent.userMessageChars).toBe(0);
    expect(post.contextSent.conversationHistoryChars).toBeGreaterThan(0);
  });

  test("the hook's messages end with the PREVIOUS reply; the prompt must be appended", () => {
    // attempt.ts hands captureForensicDumpHook `activeSession.messages` and calls
    // `activeSession.prompt(prompt)` on the next line, so the prompt is not in the array yet.
    const history = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    // CONTROL — built from the array as handed over, a "pre-call" row reads userMessage 0: F5 again.
    const asHanded = build({ messagesSnapshot: history as never, snapshot: "pre-call" });
    expect(asHanded.contextSent.userMessageChars).toBe(0);

    const fixed = build({
      messagesSnapshot: buildPreCallMessagesSnapshot(history, "go") as never,
      snapshot: "pre-call",
    });
    expect(fixed.contextSent.userMessageChars).toBe("go".length);
    // The history itself is not mutated — the live session array must never be touched.
    expect(history).toHaveLength(2);
  });
});

describe("captureForensicDumpHook writes the pre-call row (A9 wiring)", () => {
  test("call 1 of a turn writes ONE pre-call row with the prompt itemised; call 2 writes nothing", () => {
    const sessionKey = "agent:main:hook-precall";
    rememberPreCallAnatomyContext(sessionKey, {
      systemPromptReport: makeReport(),
      contextWindowTokens: 1_000_000,
      atMs: Date.now(),
    });
    const history = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    const question = "build the feature";
    const hookParams = {
      runId: "run-hook-1",
      sessionKey,
      model: "grok-4",
      provider: "xai",
      systemPromptText: "You are an agent.",
      messages: history,
      effectivePrompt: `${PACK}${question}`,
      log: quietLog,
    };

    captureForensicDumpHook(hookParams);

    const rows = querySessionEvents(sessionKey, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snapshot).toBe("pre-call");
    expect(rows[0]!.contextSent.userMessageChars).toBe(question.length);
    expect(rows[0]!.contextSent.moralCodeChars).toBe(PACK.length);
    // Row written AND pushed live, once: tinker-ui merges it by (runId, round) since B6.
    expect(emitAgentEvent).toHaveBeenCalledTimes(1);

    // A tool-loop call of the SAME run: not call 1, so no second pre-call write.
    captureForensicDumpHook({
      ...hookParams,
      messages: [
        ...history,
        { role: "user", content: hookParams.effectivePrompt },
        { role: "assistant", content: "calling a tool" },
      ],
    });
    expect(querySessionEvents(sessionKey, 50)).toHaveLength(1);
  });

  test("the first turn of a session (no remembered report) writes no row and says so once", () => {
    const sessionKey = "agent:main:hook-first-turn";
    const info = vi.fn();
    const params = {
      sessionKey,
      model: "grok-4",
      provider: "xai",
      systemPromptText: "You are an agent.",
      messages: [],
      effectivePrompt: "hello",
      log: { warn: vi.fn(), info },
    };
    captureForensicDumpHook({ ...params, runId: "run-first-a" });
    captureForensicDumpHook({ ...params, runId: "run-first-b" });
    expect(querySessionEvents(sessionKey, 50)).toHaveLength(0);
    expect(info).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The (run_id, round_number) uniqueness + upsert
// ---------------------------------------------------------------------------

describe("UNIQUE(run_id, round_number) — a turn is ONE row, not two", () => {
  test("a post-turn emit upserts onto the pre-call row and keeps its composition", () => {
    const sessionKey = "agent:main:upsert";
    const prompt = "ship it";

    insertAnatomyEvent({
      ...build({
        messagesSnapshot: [{ role: "user", content: prompt }] as never,
        sessionKey,
        snapshot: "pre-call",
      }),
      runId: "run-upsert",
      timestampMs: 1_000,
    });
    insertAnatomyEvent({
      ...build({
        messagesSnapshot: [
          { role: "user", content: prompt },
          { role: "assistant", content: "done" },
        ] as never,
        sessionKey,
        snapshot: "post-turn",
      }),
      runId: "run-upsert",
      timestampMs: 9_000,
      responseTokens: 512,
    });

    const rows = querySessionEvents(sessionKey, 50);
    expect(rows).toHaveLength(1);
    // The pre-call composition SURVIVES — it is the only one that can itemise this turn's prompt.
    expect(rows[0]!.snapshot).toBe("pre-call");
    expect(rows[0]!.contextSent.userMessageChars).toBeGreaterThan(0);
    // ...and so does the pre-call timestamp, which makes the EEG interval [send, end].
    expect(rows[0]!.timestampMs).toBe(1_000);
    // ...while the response side the pre-call write could not have known is filled in.
    expect(rows[0]!.responseTokens).toBe(512);
  });

  test("CONTROL: rows nothing stamped (snapshot NULL) still duplicate — the index is PARTIAL on purpose", () => {
    // This is the pre-A9 behaviour, and it is deliberately preserved: the live DB holds 40k+ rows
    // written before the constraint existed, and a unique index covering them would either fail to
    // build or force a migration that DELETES history to satisfy itself. The predicate
    // `snapshot IS NOT NULL` means "rows a snapshot-aware writer wrote", and only those.
    const sessionKey = "agent:main:legacy";
    const legacy = build({ messagesSnapshot: [{ role: "user", content: "hi" }] as never });
    expect(legacy.snapshot).toBeUndefined();

    insertAnatomyEvent({ ...legacy, sessionKey, runId: "run-legacy", timestampMs: 1_000 });
    insertAnatomyEvent({ ...legacy, sessionKey, runId: "run-legacy", timestampMs: 1_001 });

    expect(querySessionEvents(sessionKey, 50)).toHaveLength(2);
  });

  test("re-emitting the same stamped row does not grow the table", () => {
    const sessionKey = "agent:main:reemit";
    const event: ContextAnatomyEvent = {
      ...build({
        messagesSnapshot: [{ role: "user", content: "hi" }] as never,
        sessionKey,
        snapshot: "post-turn",
      }),
      runId: "run-reemit",
    };
    insertAnatomyEvent(event);
    insertAnatomyEvent(event);
    insertAnatomyEvent(event);
    expect(querySessionEvents(sessionKey, 50)).toHaveLength(1);
  });

  test("the v6 migration opens a DB that ALREADY holds duplicate keys, and deletes nothing", () => {
    // A schema-v5 database (no snapshot column) with two rows on the same (run_id, round_number) —
    // the state the live DB is in, since nothing ever prevented it.
    const dbPath = join(dir, `legacy-v5-${seq}.db`);
    closeAnatomyDb();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE anatomy_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL, run_id TEXT, turn INTEGER NOT NULL, round_number INTEGER,
        timestamp_ms INTEGER NOT NULL, model TEXT, provider TEXT, auth_profile_id TEXT,
        duration_ms INTEGER, stop_reason TEXT, compaction_cycle INTEGER, context_sent TEXT,
        context_window TEXT, tools_triggered TEXT, topics TEXT, topic_transition TEXT,
        memories_injected TEXT, response_tokens INTEGER, response_thinking_tokens INTEGER,
        response_text_tokens INTEGER, response_tool_call_tokens INTEGER,
        cache_read_tokens INTEGER, cache_creation_tokens INTEGER, response_content TEXT,
        user_message TEXT, assistant_response TEXT, harness TEXT, effort TEXT, route TEXT,
        harness_version TEXT
      );
      INSERT INTO anatomy_events (session_key, run_id, turn, round_number, timestamp_ms)
        VALUES ('agent:main:v5', 'run-dup', 1, 0, 1000), ('agent:main:v5', 'run-dup', 1, 0, 1001);
    `);
    legacy.pragma("user_version = 5");
    // CONTROL — a plain (non-partial) unique index cannot even be created on this table.
    expect(() =>
      legacy.exec("CREATE UNIQUE INDEX idx_plain ON anatomy_events(run_id, round_number)"),
    ).toThrow(/UNIQUE constraint failed/);
    legacy.close();

    setAnatomyDbPathForTests(dbPath);
    const database = openAnatomyDb();
    expect(database.pragma("user_version", { simple: true })).toBe(6);
    const indexed = database
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_run_round_unique'")
      .all();
    expect(indexed).toHaveLength(1);
    // History kept verbatim — both duplicates are still there.
    expect(querySessionEvents("agent:main:v5", 50)).toHaveLength(2);

    // A stamped write on the same key is OUTSIDE the old rows' reach (they are NULL-snapshot), and
    // a second stamped write upserts onto it rather than adding a fourth row.
    const stamped: ContextAnatomyEvent = {
      ...build({
        messagesSnapshot: [{ role: "user", content: "hi" }] as never,
        sessionKey: "agent:main:v5",
        snapshot: "pre-call",
      }),
      runId: "run-dup",
    };
    insertAnatomyEvent(stamped);
    insertAnatomyEvent({ ...stamped, snapshot: "post-turn" });
    expect(querySessionEvents("agent:main:v5", 50)).toHaveLength(3);
  });
});
