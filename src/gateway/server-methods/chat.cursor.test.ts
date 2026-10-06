import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import {
  projectRecentChatDisplayMessages,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { augmentChatHistoryWithCliSessionImports } from "../cli-session-history.js";
import { ErrorCodes, validateChatHistoryResult } from "../protocol/index.js";
import {
  __setMaxChatHistoryMessagesBytesForTest,
  getMaxChatHistoryMessagesBytes,
} from "../server-constants.js";
import { __resetTranscriptReadCacheForTest } from "../session-utils.fs.js";
import { capArrayByJsonBytes, loadSessionEntry, readSessionMessages } from "../session-utils.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  chatHandlers,
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
} from "./chat.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

// Plan task 5 (chat.history rehaul): seq cursors, end to end through the real handler, the real
// session store and a real tree transcript served by the TranscriptIndex. The planner's edge cases
// are unit-tested in ../chat-history-cursor.test.ts. The handler is invoked directly, as
// chat.history-store-clone.test.ts does: this directory runs in the non-isolated gateway-methods
// project, where the WS server harness is not used.

const SESSION_KEY = "agent:main:main";
const SESSION_ID = "sess-main";
const CLI_SESSION_ID = "c0ffee00-0000-4000-8000-000000000005";
const BASE_MS = Date.parse("2026-09-23T10:00:00.000Z");
const ORIGINAL_HOME = process.env.HOME;

type Payload = {
  sessionKey: string;
  sessionId?: string;
  messages: Array<Record<string, unknown>>;
  cursor: {
    epoch: string | null;
    firstSeq: number;
    lastSeq: number;
    hasMoreBefore: boolean;
    reset: boolean;
    userRowsBefore?: number;
  };
};

type Fixture = {
  sessionsDir: string;
  transcriptPath: string;
  claudeTranscriptPath: string;
  leaf: string | null;
  nextId: number;
};

let fx: Fixture;
let finishStateDir: (() => void) | undefined;
let stateDirDone: Promise<unknown> | undefined;

const context = {
  logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  loadGatewayModelCatalog: async () => [],
} as unknown as GatewayRequestContext;

async function call(params: Record<string, unknown>) {
  const respond = vi.fn() as unknown as RespondFn;
  await chatHandlers["chat.history"]({
    req: { id: "req-history" } as never,
    params,
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  const [ok, payload, error] = (respond as unknown as { mock: { calls: unknown[][] } }).mock
    .calls[0] as [boolean, unknown, { code?: string; message?: string } | undefined];
  // Round-trip through JSON: this is what reaches a client over the wire.
  const wire = payload === undefined ? undefined : (JSON.parse(JSON.stringify(payload)) as Payload);
  if (wire) {
    expect(validateChatHistoryResult(wire)).toBe(true);
  }
  return { ok, payload: wire as Payload, error };
}

async function history(params: Record<string, unknown>): Promise<Payload> {
  const res = await call({ sessionKey: SESSION_KEY, ...params });
  expect(res.ok).toBe(true);
  return res.payload;
}

const seqOf = (m: Record<string, unknown>) =>
  (m.__openclaw as { seq?: number } | undefined)?.seq ?? null;
const isImported = (m: Record<string, unknown>) =>
  (m.__openclaw as { importedFrom?: unknown } | undefined)?.importedFrom != null;
const textOf = (m: Record<string, unknown>) =>
  typeof m.content === "string"
    ? m.content
    : ((m.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "");

function writeStore(extra: Record<string, unknown> = {}) {
  fs.writeFileSync(
    path.join(fx.sessionsDir, "sessions.json"),
    JSON.stringify({ [SESSION_KEY]: { sessionId: SESSION_ID, updatedAt: BASE_MS, ...extra } }),
  );
  clearSessionStoreCacheForTest();
}

function messageEntry(role: "user" | "assistant", text: string, atMs: number) {
  const id = `m${fx.nextId++}`;
  const entry = {
    type: "message",
    id,
    parentId: fx.leaf,
    timestamp: new Date(BASE_MS + atMs).toISOString(),
    message: { role, content: [{ type: "text", text }], timestamp: BASE_MS + atMs },
  };
  fx.leaf = id;
  return entry;
}

/** Append one user + assistant turn to the tree transcript, chained onto the current leaf. */
function appendTurn(question: string, answer: string, atMs: number) {
  const lines = [
    messageEntry("user", question, atMs),
    messageEntry("assistant", answer, atMs + 1000),
  ];
  fs.appendFileSync(fx.transcriptPath, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

/** Turns 1..n, one minute apart; turn k is rows 2k-1 (user) and 2k (assistant). */
function seedTurns(n: number) {
  for (let k = 1; k <= n; k++) {
    appendTurn(`q${k}`, `a${k}`, (k - 1) * 60_000);
  }
}

/** Claude-cli import rows (tool-loop steps) at BASE + atMs[i]. */
function appendImportSteps(label: string, atMs: number[]) {
  const lines = atMs.map((ms, i) =>
    JSON.stringify({
      type: "user",
      uuid: `${label}-${i}`,
      timestamp: new Date(BASE_MS + ms).toISOString(),
      message: { role: "user", content: `${label} step ${i} with distinctive text` },
    }),
  );
  fs.appendFileSync(fx.claudeTranscriptPath, `${lines.join("\n")}\n`);
}

/** chat.history's message pipeline exactly as it stood before plan task 5 (ruling R9). */
function preCursorHistoryMessages(limit?: number): unknown[] {
  const { cfg, storePath, entry } = loadSessionEntry(SESSION_KEY);
  const sessionId = entry?.sessionId;
  const local =
    sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
  const raw = augmentChatHistoryWithCliSessionImports({
    entry,
    sessionKey: SESSION_KEY,
    localMessages: local,
  });
  const max = Math.min(1000, typeof limit === "number" ? limit : 200);
  const normalized = augmentChatHistoryWithCanvasBlocks(
    projectRecentChatDisplayMessages(raw, {
      maxChars: resolveEffectiveChatHistoryMaxChars(cfg, undefined),
      maxMessages: max,
    }),
  );
  const maxBytes = getMaxChatHistoryMessagesBytes();
  const replaced = replaceOversizedChatHistoryMessages({
    messages: normalized,
    maxSingleMessageBytes: Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxBytes),
  });
  const capped = capArrayByJsonBytes(replaced.messages, maxBytes).items;
  return JSON.parse(
    JSON.stringify(enforceChatHistoryFinalBudget({ messages: capped, maxBytes }).messages),
  ) as unknown[];
}

describe("chat.history seq cursors", () => {
  beforeEach(async () => {
    resetConfigRuntimeState();
    clearSessionStoreCacheForTest();
    __resetTranscriptReadCacheForTest();
    // Hold a temp state dir open for the whole test; the afterEach releases it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    stateDirDone = withStateDirEnv("chat-history-cursor-", async ({ tempRoot, stateDir }) => {
      const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const homeDir = path.join(tempRoot, "home");
      const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
      fs.mkdirSync(claudeProjectsDir, { recursive: true });
      process.env.HOME = homeDir;
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);
      fx = {
        sessionsDir,
        transcriptPath: path.join(sessionsDir, `${SESSION_ID}.jsonl`),
        claudeTranscriptPath: path.join(claudeProjectsDir, `${CLI_SESSION_ID}.jsonl`),
        leaf: null,
        nextId: 1,
      };
      fs.writeFileSync(
        fx.transcriptPath,
        `${JSON.stringify({
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: SESSION_ID,
          timestamp: new Date(BASE_MS).toISOString(),
          cwd: "/tmp",
        })}\n`,
      );
      writeStore();
      ready();
      await held;
    });
    finishStateDir = release;
    await isReady;
  });

  afterEach(async () => {
    // Let the fire-and-forget managed-image cleanup settle inside the temp state dir.
    await new Promise((resolve) => setImmediate(resolve));
    finishStateDir?.();
    await stateDirDone;
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    __resetTranscriptReadCacheForTest();
    clearSessionStoreCacheForTest();
    resetConfigRuntimeState();
    vi.clearAllMocks();
  });

  it("no cursor params: the pre-change messages, plus a cursor (R9)", async () => {
    seedTurns(6);
    // A hidden row (NO_REPLY) and claude-cli imports put the projection and the merge on the path.
    fs.appendFileSync(
      fx.transcriptPath,
      `${JSON.stringify(messageEntry("assistant", "NO_REPLY", 6 * 60_000))}\n`,
    );
    appendImportSteps("tool", [5 * 60_000 + 10_000, 5 * 60_000 + 20_000, 5 * 60_000 + 30_000]);
    writeStore({ cliSessionBindings: { "claude-cli": { sessionId: CLI_SESSION_ID } } });

    const full = await history({});
    expect(full.messages).toEqual(preCursorHistoryMessages());
    expect(full.messages.filter(isImported)).toHaveLength(3); // the merge really ran
    expect(
      Object.keys(full).filter(
        (key) =>
          ![
            "sessionKey",
            "sessionId",
            "messages",
            "thinkingLevel",
            "fastMode",
            "verboseLevel",
          ].includes(key),
      ),
    ).toEqual(["cursor"]);
    expect(full.cursor).toEqual({
      epoch: expect.any(String),
      firstSeq: 1,
      lastSeq: 13,
      hasMoreBefore: false,
      reset: false,
      userRowsBefore: 0,
    });

    const window = await history({ limit: 4 });
    expect(window.messages).toEqual(preCursorHistoryMessages(4));
    // LOCAL_TAIL_FLOOR fills limit 4 with rows 9-12 and cuts all 3 imports, which are NEWER than
    // every served row. No local row follows the newest cut one, so paging resumes one past the
    // end (R23), not at row 9, from where no page would ever reach them.
    expect(window.messages.map(seqOf)).toEqual([9, 10, 11, 12]);
    expect(window.cursor).toMatchObject({
      firstSeq: 14,
      lastSeq: 13,
      hasMoreBefore: true,
      reset: false,
    });
  });

  it("afterSeq returns only new rows with the same epoch", async () => {
    seedTurns(3);
    const first = await history({ limit: 50 });
    expect(first.cursor).toMatchObject({ firstSeq: 1, lastSeq: 6, reset: false });
    expect(first.cursor.epoch).toEqual(expect.any(String));

    appendTurn("q2", "a2", 10 * 60_000);
    const next = await history({ afterSeq: first.cursor.lastSeq, epoch: first.cursor.epoch });
    expect(next.cursor.reset).toBe(false);
    expect(next.messages.map(seqOf)).toEqual([first.cursor.lastSeq + 1, first.cursor.lastSeq + 2]);
    expect(next.cursor).toEqual({
      epoch: first.cursor.epoch,
      firstSeq: 7,
      lastSeq: 8,
      hasMoreBefore: true,
      reset: false,
    });
  });

  it("an empty afterSeq delta pins firstSeq = lastSeq = afterSeq", async () => {
    seedTurns(2);
    const first = await history({});
    const idle = await history({ afterSeq: first.cursor.lastSeq, epoch: first.cursor.epoch });
    expect(idle.messages).toEqual([]);
    expect(idle.cursor).toEqual({
      epoch: first.cursor.epoch,
      firstSeq: 4,
      lastSeq: 4,
      hasMoreBefore: true,
      reset: false,
    });
  });

  it("stale or missing epoch → reset window of the last `limit` rows (R22)", async () => {
    seedTurns(8);
    const legacy = await history({ limit: 10 });
    const stale = await history({ afterSeq: 3, epoch: "bogus", limit: 10 });
    expect(stale.cursor.reset).toBe(true);
    expect(stale.messages.length).toBeLessThanOrEqual(10);
    expect(stale.messages).toEqual(legacy.messages);
    expect(stale.cursor).toEqual({ ...legacy.cursor, reset: true });

    const noEpoch = await history({ beforeSeq: 5, limit: 10 });
    expect(noEpoch.cursor.reset).toBe(true);
    expect(noEpoch.messages).toEqual(legacy.messages);
  });

  it("a flat transcript has no epoch: every cursor request resets", async () => {
    fs.writeFileSync(
      fx.transcriptPath,
      ["one", "two", "three"]
        .map((text, i) =>
          JSON.stringify({ message: { role: "user", content: text, timestamp: BASE_MS + i } }),
        )
        .join("\n"),
    );
    const first = await history({});
    expect(first.cursor).toMatchObject({ epoch: null, firstSeq: 1, lastSeq: 3, reset: false });
    const next = await history({ afterSeq: 3, epoch: "anything" });
    expect(next.cursor).toMatchObject({ epoch: null, reset: true });
    expect(next.messages).toEqual(first.messages);
  });

  it("beforeSeq pages older rows until the start", async () => {
    seedTurns(3);
    const tail = await history({ limit: 2 });
    expect(tail.cursor).toMatchObject({ firstSeq: 5, lastSeq: 6, hasMoreBefore: true });

    const older = await history({
      beforeSeq: tail.cursor.firstSeq,
      limit: 2,
      epoch: tail.cursor.epoch,
    });
    expect(older.cursor.lastSeq).toBe(tail.cursor.firstSeq - 1);
    expect(older.messages.map(seqOf)).toEqual([3, 4]);
    expect(older.cursor).toMatchObject({ firstSeq: 3, hasMoreBefore: true, reset: false });

    const oldest = await history({
      beforeSeq: older.cursor.firstSeq,
      limit: 2,
      epoch: tail.cursor.epoch,
    });
    expect(oldest.messages.map(seqOf)).toEqual([1, 2]);
    expect(oldest.cursor).toMatchObject({ firstSeq: 1, lastSeq: 2, hasMoreBefore: false });
  });

  it("tail + beforeSeq pages deliver every row of the full window, floor or not (R23)", async () => {
    // 30 turns (rows 1-60); turns 20-30 each ran 3 tool-loop import steps between the prompt and
    // the answer. A limit-30 tail keeps the newest 24 local rows (LOCAL_TAIL_FLOOR, rows 37-60)
    // and fills the other 6 slots with the newest imports (turns 29-30): the imports of turns
    // 20-28 sit between served local rows and are cut.
    seedTurns(30);
    for (let turn = 20; turn <= 30; turn++) {
      const at = (turn - 1) * 60_000;
      appendImportSteps(`t${turn}`, [at + 100, at + 200, at + 300]);
    }
    writeStore({ cliSessionBindings: { "claude-cli": { sessionId: CLI_SESSION_ID } } });
    const identity = (m: Record<string, unknown>) => {
      const meta = m.__openclaw as { id?: string; externalId?: string };
      return isImported(m) ? `import:${meta.externalId}` : `local:${meta.id}`;
    };
    const walkBack = async (fromSeq: number, epoch: string | null) => {
      const rows: Array<Record<string, unknown>> = [];
      let next = { firstSeq: fromSeq, hasMoreBefore: fromSeq > 1 };
      for (let i = 0; next.hasMoreBefore && i < 10; i++) {
        const page = await history({ beforeSeq: next.firstSeq, limit: 30, epoch });
        expect(page.cursor.reset).toBe(false);
        rows.push(...page.messages);
        next = page.cursor;
      }
      expect(next.hasMoreBefore).toBe(false);
      return rows;
    };

    const full = await history({ limit: 1000 });
    expect(full.cursor).toMatchObject({ firstSeq: 1, lastSeq: 60, hasMoreBefore: false });
    expect(full.messages).toHaveLength(93); // 60 local + 33 imports
    const fullIds = full.messages.map(identity).toSorted();

    const tail = await history({ limit: 30 });
    // Served rows stay byte-identical to the pre-change tail (R9) ...
    expect(tail.messages).toEqual(preCursorHistoryMessages(30));
    const tailLocal = tail.messages.map(seqOf).filter((seq): seq is number => seq !== null); // imports carry no seq
    expect(tailLocal).toEqual(Array.from({ length: 24 }, (_, i) => 37 + i));
    expect(tail.messages.filter(isImported)).toHaveLength(6);
    // ... while the cursor resumes after the newest cut import (turn 28's), at its answer row 56.
    expect(tail.cursor).toMatchObject({ firstSeq: 56, lastSeq: 60, hasMoreBefore: true });

    const pages = await walkBack(tail.cursor.firstSeq, tail.cursor.epoch);
    const union = new Set([...tail.messages, ...pages].map(identity));
    expect([...union].toSorted()).toEqual(fullIds);

    // CONTROL: the pre-R23 cursor resumed at the oldest served local row (37). Paging from there
    // never delivers the 27 imports of turns 20-28.
    const oldPages = await walkBack(Math.min(...tailLocal), tail.cursor.epoch);
    const oldUnion = new Set([...tail.messages, ...oldPages].map(identity));
    const missed = fullIds.filter((id) => !oldUnion.has(id));
    expect(missed).toHaveLength(27);
    expect(missed.every((id) => id.startsWith("import:t2"))).toBe(true);
  });

  it("more new rows than `limit` → reset:true with the last `limit` rows, not a gap (R10)", async () => {
    seedTurns(2);
    const first = await history({});
    for (let k = 3; k <= 5; k++) {
      appendTurn(`q${k}`, `a${k}`, k * 60_000);
    }
    const next = await history({
      afterSeq: first.cursor.lastSeq,
      epoch: first.cursor.epoch,
      limit: 4,
    });
    expect(next.cursor).toMatchObject({
      reset: true,
      firstSeq: 7,
      lastSeq: 10,
      hasMoreBefore: true,
    });
    expect(next.messages.map(seqOf)).toEqual([7, 8, 9, 10]);
  });

  it("counts the user rows before a partial window's firstSeq (R36)", async () => {
    seedTurns(6); // turn k = user row 2k-1, assistant row 2k
    const tail = await history({ limit: 4 });
    expect(tail.messages.map(seqOf)).toEqual([9, 10, 11, 12]);
    expect(tail.cursor).toMatchObject({ firstSeq: 9, userRowsBefore: 4 }); // q1..q4
    const older = await history({ beforeSeq: 9, limit: 2, epoch: tail.cursor.epoch });
    expect(older.cursor).toMatchObject({ firstSeq: 7, userRowsBefore: 3 });
    // A plain delta leaves it out: the client keeps the count it has.
    const idle = await history({ afterSeq: 12, epoch: tail.cursor.epoch });
    expect(idle.cursor.userRowsBefore).toBeUndefined();
  });

  it("counts the claude-cli IMPORTED user rows before the window too, as the UI counts them (R36)", async () => {
    // A cc-bridge tab. claude-cli recorded every prompt as well (a twin carrying the bridge's
    // narration suffix, which the merge dedups by text) plus two user rows the local store never
    // saw: those two are turns on the Tinker page, so they are turns before the window too.
    const prompt = (k: number) =>
      `prompt ${k}: long enough that the merge dedups its claude-cli twin by text`;
    for (let k = 1; k <= 6; k++) {
      appendTurn(prompt(k), `a${k}`, (k - 1) * 60_000); // turn k = user row 2k-1, answer row 2k
    }
    const twins = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({
        type: "user",
        uuid: `twin-${i + 1}`,
        timestamp: new Date(BASE_MS + i * 60_000 + 50).toISOString(),
        message: {
          role: "user",
          content: `${prompt(i + 1)}\n<!-- TINKERCLAW narration contract -->`,
        },
      }),
    );
    fs.appendFileSync(fx.claudeTranscriptPath, `${twins.join("\n")}\n`);
    appendImportSteps("inj", [10_000, 70_000]); // inside turns 1 and 2
    writeStore({ cliSessionBindings: { "claude-cli": { sessionId: CLI_SESSION_ID } } });

    const users = (rows: Array<Record<string, unknown>>) => rows.filter((m) => m.role === "user");
    // The Tinker UI's number (tinker-ui history-paging.ts turnNumberOf): userRowsBefore, less the
    // LOCAL user rows the page holds below firstSeq, plus every user row on the page.
    const uiTurn = (page: Array<Record<string, unknown>>, cursor: Payload["cursor"]) => {
      const onPage = users(page);
      const heldBelow = onPage.filter((m) => {
        const seq = seqOf(m);
        return seq !== null && seq < cursor.firstSeq;
      }).length;
      return Math.max(0, (cursor.userRowsBefore ?? 0) - heldBelow) + onPage.length;
    };
    const whole = await history({ limit: 1000 });
    expect(users(whole.messages)).toHaveLength(8); // 6 prompts + 2 imports; the twins merged away

    const tail = await history({ limit: 4 });
    expect(tail.messages.map(seqOf)).toEqual([9, 10, 11, 12]);
    // Prompts 1-4 plus the 2 imports the limit cut (local rows only, before this fix: 4).
    expect(tail.cursor).toMatchObject({ firstSeq: 9, userRowsBefore: 6 });
    expect(uiTurn(tail.messages, tail.cursor)).toBe(8);

    const older = await history({ beforeSeq: 9, limit: 2, epoch: tail.cursor.epoch });
    expect(older.messages.map(seqOf)).toEqual([7, 8]);
    // Prompts 1-3 plus the 2 imports below the page's floor. The window merge saw rows 7-8 only,
    // so twins 1-3 were among the imports it dropped for age: counted as they stand, 8.
    expect(older.cursor).toMatchObject({ firstSeq: 7, userRowsBefore: 5 });
    const page = [...older.messages, ...tail.messages];
    expect(uiTurn(page, older.cursor)).toBe(8);

    const oldest = await history({ beforeSeq: 7, limit: 10, epoch: tail.cursor.epoch });
    expect(oldest.cursor).toMatchObject({ firstSeq: 1, hasMoreBefore: false, userRowsBefore: 0 });
    expect(uiTurn([...oldest.messages, ...page], oldest.cursor)).toBe(8);
  });

  // FORK 2026-09-24 (task 5 review test gaps; final fix brief F13) — handler-level pins for three
  // paths the planner's unit tests cover only in isolation. No behaviour change.
  const appendEntry = (entry: Record<string, unknown>) =>
    fs.appendFileSync(fx.transcriptPath, `${JSON.stringify(entry)}\n`);
  const at = (ms: number) => new Date(BASE_MS + ms).toISOString();

  it("a prompt stranded by a concurrent append reaches the afterSeq delta, seq-less and keyed", async () => {
    seedTurns(2); // rows 1-4; leaf m4
    const first = await history({});
    expect(first.cursor.lastSeq).toBe(4);
    const fork = fx.leaf as string;
    // chat.send's marker and pi's user row, forked off m4 by a concurrent append ...
    appendEntry({
      type: "custom",
      customType: "openclaw.prompt-key",
      id: "mk1",
      parentId: fork,
      timestamp: at(10 * 60_000),
      data: { idempotencyKey: "idem-stranded" },
    });
    appendEntry({
      type: "message",
      id: "su1",
      parentId: "mk1",
      timestamp: at(10 * 60_000 + 1_000),
      message: { role: "user", content: [{ type: "text", text: "the stranded prompt" }] },
    });
    // ... while the served branch moved on from m4 AFTER it (rows 5-6).
    fx.leaf = fork;
    appendTurn("q3", "a3", 11 * 60_000);

    const delta = await history({ afterSeq: 4, epoch: first.cursor.epoch });
    expect(delta.cursor).toMatchObject({ reset: false, firstSeq: 5, lastSeq: 6 });
    expect(delta.messages.map(seqOf).filter((seq) => seq !== null)).toEqual([5, 6]);
    const strandedRows = delta.messages.filter((m) => m.idempotencyKey === "idem-stranded");
    expect(strandedRows).toHaveLength(1);
    expect(seqOf(strandedRows[0])).toBeNull();
    expect(textOf(strandedRows[0])).toBe("the stranded prompt");
  });

  it("a branch switch without a rewrite answers the old cursor with a reset of the new branch", async () => {
    seedTurns(3); // rows 1-6
    const first = await history({});
    fx.leaf = "m2"; // continue from row 2: rows 3-6 leave the served branch
    appendTurn("q-branch", "a-branch", 20 * 60_000);
    const next = await history({ afterSeq: first.cursor.lastSeq, epoch: first.cursor.epoch });
    expect(next.cursor.reset).toBe(true);
    expect(next.cursor.epoch).not.toBe(first.cursor.epoch);
    expect(next.messages.map(textOf)).toEqual(["q1", "a1", "q-branch", "a-branch"]);
    expect(next.cursor).toMatchObject({ firstSeq: 1, lastSeq: 4, hasMoreBefore: false });
  });

  it("a new sessionId behind the same key answers the old cursor with a reset of the new transcript", async () => {
    seedTurns(3);
    const first = await history({});
    const next2 = path.join(fx.sessionsDir, "sess-2.jsonl");
    fs.writeFileSync(
      next2,
      [
        {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "sess-2",
          timestamp: at(0),
          cwd: "/tmp",
        },
        {
          type: "message",
          id: "n1",
          parentId: null,
          timestamp: at(1_000),
          message: { role: "user", content: [{ type: "text", text: "fresh q" }] },
        },
        {
          type: "message",
          id: "n2",
          parentId: "n1",
          timestamp: at(2_000),
          message: { role: "assistant", content: [{ type: "text", text: "fresh a" }] },
        },
      ]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join(""),
    );
    fs.writeFileSync(
      path.join(fx.sessionsDir, "sessions.json"),
      JSON.stringify({ [SESSION_KEY]: { sessionId: "sess-2", updatedAt: BASE_MS + 5_000 } }),
    );
    clearSessionStoreCacheForTest();
    const next = await history({ afterSeq: first.cursor.lastSeq, epoch: first.cursor.epoch });
    expect(next.sessionId).toBe("sess-2");
    expect(next.cursor.reset).toBe(true);
    expect(next.messages.map(textOf)).toEqual(["fresh q", "fresh a"]);
    expect(next.cursor).toMatchObject({ firstSeq: 1, lastSeq: 2 });
  });

  it("a delta the byte caps cut is a reset whose firstSeq resumes at the first row served (R10/R23)", async () => {
    seedTurns(2);
    const first = await history({});
    for (let k = 3; k <= 6; k++) {
      appendTurn(`q${k}`, `a${k} ${"x".repeat(3_000)}`, k * 60_000);
    }
    __setMaxChatHistoryMessagesBytesForTest(8_000);
    try {
      const next = await history({ afterSeq: 4, epoch: first.cursor.epoch });
      const served = next.messages.map(seqOf);
      expect(served.length).toBeLessThan(8); // rows 5-12 did not all fit
      expect(served[served.length - 1]).toBe(12);
      expect(next.cursor).toMatchObject({
        reset: true,
        firstSeq: served[0],
        lastSeq: 12,
        hasMoreBefore: true,
      });
      expect(served).toEqual(
        Array.from({ length: served.length }, (_, i) => (served[0] as number) + i),
      );
    } finally {
      __setMaxChatHistoryMessagesBytesForTest();
    }
  });

  it("rejects afterSeq together with beforeSeq as invalid params", async () => {
    seedTurns(1);
    const res = await call({ sessionKey: SESSION_KEY, afterSeq: 1, beforeSeq: 2, epoch: "e" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(res.error?.message).toContain("afterSeq and beforeSeq");
  });

  it("an afterSeq delta carries every import from row afterSeq's time on, unlimited and unvalved", async () => {
    // 5 local turns; 3 import steps inside turn 5. The client reads, then turn 6 lands with 20
    // new import steps. Sized by the 2-row delta the flood valve would keep 6 of them, and a
    // `limit: 5` window would keep 5 rows; the delta must carry all 22.
    seedTurns(5);
    appendImportSteps("old", [4 * 60_000 + 100, 4 * 60_000 + 200, 4 * 60_000 + 300]);
    writeStore({ cliSessionBindings: { "claude-cli": { sessionId: CLI_SESSION_ID } } });
    const first = await history({});
    expect(first.cursor.lastSeq).toBe(10);

    appendTurn("q6", "a6", 10 * 60_000);
    appendImportSteps(
      "new",
      Array.from({ length: 20 }, (_, i) => 10 * 60_000 + 100 + i * 10),
    );
    const next = await history({ afterSeq: 10, epoch: first.cursor.epoch, limit: 5 });
    expect(next.cursor).toMatchObject({ reset: false, firstSeq: 11, lastSeq: 12 });
    expect(next.messages.filter((m) => !isImported(m)).map(seqOf)).toEqual([11, 12]);
    const deltaImports = next.messages.filter(isImported);
    expect(deltaImports).toHaveLength(20);
    expect(deltaImports.every((m) => textOf(m).startsWith("new step"))).toBe(true);

    // Identical to the imports the whole-store window serves from row 10's time on.
    const anchorTs = BASE_MS + 4 * 60_000 + 1000;
    const whole = await history({});
    expect(deltaImports).toEqual(
      whole.messages.filter((m) => isImported(m) && (m.timestamp as number) >= anchorTs),
    );
  });

  // FORK 2026-10-05 — a slice served a prompt's claude-cli copy whose local row sat outside the
  // slice: the merge paired imports only against the slice's own local rows. The page drew the
  // prompt twice until a refresh read the whole store (bug-log `cursor-slice-prompt-twin`).
  describe("a cursor slice never serves a prompt's claude-cli copy beside the prompt", () => {
    const appendRow = (role: "user" | "assistant", text: string, atMs: number) =>
      fs.appendFileSync(fx.transcriptPath, `${JSON.stringify(messageEntry(role, text, atMs))}\n`);
    const appendCliPrompt = (uuid: string, text: string, atMs: number) =>
      fs.appendFileSync(
        fx.claudeTranscriptPath,
        `${JSON.stringify({
          type: "user",
          uuid,
          timestamp: new Date(BASE_MS + atMs).toISOString(),
          message: {
            role: "user",
            content: `${text}\n\n<!-- TINKERCLAW chat-row contract -->\nnarrate`,
          },
        })}\n`,
      );
    const prompt = "q6: a prompt long enough that the merge pairs its claude-cli copy by text";
    const copiesOf = (rows: Array<Record<string, unknown>>, text: string) =>
      rows.filter((m) => m.role === "user" && textOf(m).startsWith(text));
    const t0 = 10 * 60_000;

    it("a delta anchored at the prompt itself", async () => {
      seedTurns(5);
      appendRow("user", prompt, t0); // row 11
      writeStore({ cliSessionBindings: { "claude-cli": { sessionId: CLI_SESSION_ID } } });
      const first = await history({});
      expect(first.cursor.lastSeq).toBe(11); // the page now holds the prompt
      appendCliPrompt("cli-q6", prompt, t0 + 50);
      appendRow("assistant", "a6", t0 + 5_000); // row 12

      const delta = await history({ afterSeq: 11, epoch: first.cursor.epoch });
      expect(delta.cursor).toMatchObject({ reset: false, firstSeq: 12, lastSeq: 12 });
      expect(copiesOf(delta.messages, prompt)).toHaveLength(0);
      expect(copiesOf((await history({ limit: 1000 })).messages, prompt)).toHaveLength(1);
    });

    it("a prompt sent during a turn, which the CLI records only when the turn ends", async () => {
      seedTurns(5);
      appendRow("user", "q6 starts a long turn", t0); // row 11
      appendRow("user", prompt, t0 + 20_000); // row 12, sent while row 11's turn runs
      appendRow("assistant", "a6", t0 + 90_000); // row 13
      writeStore({ cliSessionBindings: { "claude-cli": { sessionId: CLI_SESSION_ID } } });
      const first = await history({});
      expect(first.cursor.lastSeq).toBe(13);
      appendCliPrompt("cli-q7", prompt, t0 + 95_000); // delivered after a6
      appendRow("assistant", "a7", t0 + 120_000); // row 14

      const delta = await history({ afterSeq: 13, epoch: first.cursor.epoch });
      expect(delta.messages.filter((m) => !isImported(m)).map(seqOf)).toEqual([14]);
      expect(copiesOf(delta.messages, prompt)).toHaveLength(0);
      expect(copiesOf((await history({ limit: 1000 })).messages, prompt)).toHaveLength(1);
    });

    it("a CLI-only prompt with no local row is still served by the delta", async () => {
      seedTurns(5);
      writeStore({ cliSessionBindings: { "claude-cli": { sessionId: CLI_SESSION_ID } } });
      const first = await history({});
      appendCliPrompt("cli-only", "a prompt only the claude-cli transcript holds, long text", t0);
      appendRow("assistant", "a6", t0 + 5_000);

      const delta = await history({ afterSeq: first.cursor.lastSeq, epoch: first.cursor.epoch });
      expect(
        copiesOf(delta.messages, "a prompt only the claude-cli transcript holds"),
      ).toHaveLength(1);
    });
  });

  describe("a tool loop longer than the merge's 15-minute prehistory grace", () => {
    // Task 5 review, fix round 1. The import merge drops imports older than its earliest LOCAL
    // row minus 15 minutes (cli-session-history.merge.ts, layer 1). A slice starts later than the
    // store, so a floor measured from the slice sits too high. Fixture: 5 turns; prompt row 11 at
    // t0; the client reads (lastSeq 11); 30 claude-cli steps land at t0+1..30 min while the tab is
    // not polling; the answer (row 12) lands at t0+31 min.
    const t0 = 10 * 60_000;
    const appendRow = (role: "user" | "assistant", text: string, atMs: number) =>
      fs.appendFileSync(fx.transcriptPath, `${JSON.stringify(messageEntry(role, text, atMs))}\n`);
    const importIds = (rows: Array<Record<string, unknown>>) =>
      rows
        .filter(isImported)
        .map((m) => (m.__openclaw as { externalId?: string }).externalId)
        .toSorted();
    const runLoop = async () => {
      seedTurns(5);
      appendRow("user", "q6 starts a long tool loop", t0);
      writeStore({ cliSessionBindings: { "claude-cli": { sessionId: CLI_SESSION_ID } } });
      const first = await history({});
      expect(first.cursor.lastSeq).toBe(11);
      appendImportSteps(
        "run",
        Array.from({ length: 30 }, (_, i) => t0 + (i + 1) * 60_000),
      );
      appendRow("assistant", "a6 after 31 minutes", t0 + 31 * 60_000);
      return first;
    };

    it("the afterSeq delta carries every step the whole window serves", async () => {
      const first = await runLoop();
      const whole = await history({ limit: 1000 });
      expect(importIds(whole.messages)).toHaveLength(30);

      const delta = await history({ afterSeq: 11, epoch: first.cursor.epoch });
      expect(delta.cursor).toMatchObject({ reset: false, firstSeq: 12, lastSeq: 12 });
      // CONTROL: before the whole-store floor, the slice [row 12] floored at t0+16 min and this
      // delta carried 15 of 30 (run-15..run-29) while advancing lastSeq past the rest.
      expect(importIds(delta.messages)).toEqual(importIds(whole.messages));
    });

    it("beforeSeq pages over the loop deliver every step too", async () => {
      // A page's own earliest local row is its import floor's anchor, and its imports start at
      // that row's time, so a page never needed the whole-store floor; this pins that down.
      await runLoop();
      const whole = await history({ limit: 1000 });
      const tail = await history({ limit: 1 });
      expect(tail.messages.map(seqOf)).toEqual([12]);
      const rows: Array<Record<string, unknown>> = [...tail.messages];
      let next = tail.cursor;
      for (let i = 0; next.hasMoreBefore && i < 20; i++) {
        const page = await history({
          beforeSeq: next.firstSeq,
          limit: 1,
          epoch: tail.cursor.epoch,
        });
        expect(page.cursor.reset).toBe(false);
        rows.push(...page.messages);
        next = page.cursor;
      }
      expect(next.hasMoreBefore).toBe(false);
      expect([...new Set(importIds(rows))]).toEqual(importIds(whole.messages));
    });
  });
});
