import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { ErrorCodes, validateChatHistoryResult } from "../protocol/index.js";
import { __resetTranscriptReadCacheForTest } from "../session-utils.fs.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

// FORK 2026-10-02 (the architect: "The parallel worker's chat history seems to not be loading") — a session
// reset before every turn keeps its transcript path; each reset renames what it held to
// `<path>.reset.<time>`. `chat.history {resetArchiveBefore: T}` serves the newest archive reset before T,
// imports included, through the real handler and store (the chat.cursor.test.ts harness).

const SESSION_KEY = "agent:main:main";
const SESSION_ID = "sess-live";
const OLD_SESSION_ID = "sess-before-reset";
const OLD_CLI_SESSION_ID = "c0ffee00-0000-4000-8000-0000000000aa";
const BASE_MS = Date.parse("2026-10-02T08:00:00.000Z");
const ORIGINAL_HOME = process.env.HOME;

type Payload = {
  sessionKey: string;
  messages: Array<Record<string, unknown>>;
  cursor?: unknown;
  archive?: { resetAt: number | null; olderCount: number; rowsBefore: number; kind?: string };
};

let sessionsDir: string;
let homeDir: string;
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
    params: { sessionKey: SESSION_KEY, ...params },
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  const [ok, payload, error] = (respond as unknown as { mock: { calls: unknown[][] } }).mock
    .calls[0] as [boolean, unknown, { code?: string } | undefined];
  const wire = payload === undefined ? undefined : (JSON.parse(JSON.stringify(payload)) as Payload);
  if (wire) {
    expect(validateChatHistoryResult(wire)).toBe(true);
  }
  return { ok, payload: wire as Payload, error };
}

const textOf = (m: Record<string, unknown>) =>
  typeof m.content === "string"
    ? m.content
    : ((m.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "");

/** A tree transcript: a session header with `id`, then one user + assistant turn per text. */
function writeTranscript(file: string, id: string, turns: string[], startMs: number) {
  let leaf: string | null = null;
  const lines: unknown[] = [
    {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id,
      timestamp: new Date(startMs).toISOString(),
      cwd: "/tmp",
    },
  ];
  turns.forEach((t, k) => {
    for (const [role, text, dt] of [
      ["user", `${t}?`, 0],
      ["assistant", `${t}.`, 1000],
    ] as const) {
      const entryId = `${id}-${k}-${role}`;
      const at = startMs + k * 60_000 + dt;
      lines.push({
        type: "message",
        id: entryId,
        parentId: leaf,
        timestamp: new Date(at).toISOString(),
        message: { role, content: [{ type: "text", text }], timestamp: at },
      });
      leaf = entryId;
    }
  });
  fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

describe("chat.history resetArchiveBefore", () => {
  beforeEach(async () => {
    resetConfigRuntimeState();
    clearSessionStoreCacheForTest();
    __resetTranscriptReadCacheForTest();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    stateDirDone = withStateDirEnv(
      "chat-history-reset-archive-",
      async ({ tempRoot, stateDir }) => {
        sessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });
        homeDir = path.join(tempRoot, "home");
        fs.mkdirSync(path.join(homeDir, ".claude", "projects", "workspace"), { recursive: true });
        process.env.HOME = homeDir;
        const cfg = {
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);
        const live = path.join(sessionsDir, `${SESSION_ID}.jsonl`);
        // Oldest first: the archive of the first reset, then the one of the second, then the live file.
        writeTranscript(
          `${live}.reset.2026-10-02T08-30-00.000Z`,
          "sess-first",
          ["first-turn"],
          BASE_MS,
        );
        writeTranscript(
          `${live}.reset.2026-10-02T09-30-00.000Z`,
          OLD_SESSION_ID,
          ["second-turn"],
          BASE_MS + 3_600_000,
        );
        writeTranscript(live, SESSION_ID, ["live-turn"], BASE_MS + 7_200_000);
        // The older session ran on claude-cli: the tinker-bridge map keys its CLI transcript on the
        // OpenClaw session id the archive header carries.
        fs.mkdirSync(path.join(homeDir, ".openclaw", "tinker-bridge"), { recursive: true });
        fs.writeFileSync(
          path.join(homeDir, ".openclaw", "tinker-bridge", "session-map.json"),
          JSON.stringify({
            "tinker-sp-old": {
              sessionId: OLD_CLI_SESSION_ID,
              openclawSessionId: OLD_SESSION_ID,
              updatedAt: BASE_MS + 3_600_000,
            },
          }),
        );
        fs.writeFileSync(
          path.join(homeDir, ".claude", "projects", "workspace", `${OLD_CLI_SESSION_ID}.jsonl`),
          `${JSON.stringify({
            type: "user",
            uuid: "old-step-0",
            timestamp: new Date(BASE_MS + 3_600_000 + 500).toISOString(),
            message: { role: "user", content: "old step 0 with distinctive text" },
          })}\n`,
        );
        fs.writeFileSync(
          path.join(sessionsDir, "sessions.json"),
          JSON.stringify({
            [SESSION_KEY]: {
              sessionId: SESSION_ID,
              sessionFile: live,
              updatedAt: BASE_MS + 7_200_000,
            },
          }),
        );
        clearSessionStoreCacheForTest();
        ready();
        await held;
      },
    );
    finishStateDir = release;
    await isReady;
  });

  afterEach(async () => {
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

  it("the live read is unchanged and carries no archive", async () => {
    const res = await call({});
    expect(res.ok).toBe(true);
    expect(res.payload.messages.map(textOf)).toEqual(["live-turn?", "live-turn."]);
    expect(res.payload.archive).toBeUndefined();
  });

  it("before now: the newest reset's transcript, with that session's claude-cli imports", async () => {
    const res = await call({ resetArchiveBefore: BASE_MS + 10_000_000 });
    expect(res.ok).toBe(true);
    const texts = res.payload.messages.map(textOf);
    expect(texts).toContain("second-turn?");
    expect(texts).toContain("second-turn.");
    expect(texts).toContain("old step 0 with distinctive text");
    expect(texts).not.toContain("live-turn?");
    expect(texts).not.toContain("first-turn?");
    expect(res.payload.archive).toEqual({
      resetAt: Date.parse("2026-10-02T09:30:00.000Z"),
      olderCount: 1,
      rowsBefore: 0,
      kind: "reset",
    });
    expect(res.payload.cursor).toBeUndefined();
  });

  it("before that reset: the one before it; before the first, no rows", async () => {
    const one = await call({ resetArchiveBefore: Date.parse("2026-10-02T09:30:00.000Z") });
    expect(one.payload.messages.map(textOf)).toEqual(["first-turn?", "first-turn."]);
    expect(one.payload.archive).toEqual({
      resetAt: Date.parse("2026-10-02T08:30:00.000Z"),
      olderCount: 0,
      rowsBefore: 0,
      kind: "reset",
    });
    const past = await call({ resetArchiveBefore: Date.parse("2026-10-02T08:30:00.000Z") });
    expect(past.ok).toBe(true);
    expect(past.payload.messages).toEqual([]);
    expect(past.payload.archive).toEqual({ resetAt: null, olderCount: 0, rowsBefore: 0 });
  });

  // The worker's newer archives carry a header id the bridge map does not know (measured 2026-10-02:
  // the 14:50 archive served 2 rows and no imports). Its tool-call ids find the CLI transcript.
  it("an archive whose header id the bridge map lacks gets its CLI turns by its tool-call ids", async () => {
    const live = path.join(sessionsDir, `${SESSION_ID}.jsonl`);
    const archive = `${live}.reset.2026-10-02T09-45-00.000Z`;
    const start = BASE_MS + 6_000_000;
    writeTranscript(archive, "header-id-unknown-to-the-map", ["third-turn"], start);
    fs.appendFileSync(
      archive,
      `${JSON.stringify({
        type: "custom",
        customType: "tinker-bridge-tool",
        // Chained into the tree like the real records, after the turn's last message.
        id: "tool-rec-1",
        parentId: "header-id-unknown-to-the-map-0-assistant",
        timestamp: new Date(start + 1_500).toISOString(),
        data: { runId: "r1", phase: "result", toolCallId: "toolu_THIRD_TURN" },
      })}\n`,
    );
    const cliFile = path.join(homeDir, ".claude", "projects", "workspace", "c11-third.jsonl");
    fs.writeFileSync(
      cliFile,
      `${JSON.stringify({
        type: "assistant",
        uuid: "third-step-0",
        timestamp: new Date(start + 2_000).toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "third turn step with distinctive text" },
            { type: "tool_use", id: "toolu_THIRD_TURN", name: "Bash", input: {} },
          ],
        },
      })}\n`,
    );
    // Last written while that session ran, as the real transcripts are.
    fs.utimesSync(cliFile, (start + 60_000) / 1000, (start + 60_000) / 1000);
    const res = await call({ resetArchiveBefore: Date.parse("2026-10-02T10:00:00.000Z") });
    expect(res.ok).toBe(true);
    expect(res.payload.archive?.resetAt).toBe(Date.parse("2026-10-02T09:45:00.000Z"));
    const texts = res.payload.messages.map(textOf);
    expect(texts).toContain("third-turn?");
    expect(texts).toContain("third turn step with distinctive text");
  });

  // Verified live 2026-10-02 after ab52d6fa91f: every archive found its CLI transcript, but the
  // import flood valve (3x the local rows) cut the 14:50 archive to 6 of 215 imported rows. An
  // archive's transcript is identified from the archive itself: it is the turn's only record.
  it("serves an archive's whole claude-cli turn, however few local rows it holds", async () => {
    const cli = path.join(
      homeDir,
      ".claude",
      "projects",
      "workspace",
      `${OLD_CLI_SESSION_ID}.jsonl`,
    );
    const steps = Array.from({ length: 10 }, (_, k) =>
      JSON.stringify({
        type: "user",
        uuid: `old-step-x${k}`,
        timestamp: new Date(BASE_MS + 3_600_000 + 2_000 + k * 1_000).toISOString(),
        message: { role: "user", content: `old loop step ${k} with distinctive text` },
      }),
    );
    fs.appendFileSync(cli, `${steps.join("\n")}\n`);
    const res = await call({ resetArchiveBefore: BASE_MS + 10_000_000 });
    const texts = res.payload.messages.map(textOf);
    for (let k = 0; k < 10; k++) {
      expect(texts).toContain(`old loop step ${k} with distinctive text`);
    }
  });

  // The worker's first archive spans a day and three claude-cli sessions (one rebind per ~8 MB):
  // the bridge map holds a binding for each, and the archive imports them all.
  it("imports every CLI session the bridge map bound to the archive, oldest first", async () => {
    const SECOND_CLI = "c0ffee00-0000-4000-8000-0000000000bb";
    const map = path.join(homeDir, ".openclaw", "tinker-bridge", "session-map.json");
    const entries = JSON.parse(fs.readFileSync(map, "utf8"));
    entries["tinker-sp-old-2"] = {
      sessionId: SECOND_CLI,
      openclawSessionId: OLD_SESSION_ID,
      updatedAt: BASE_MS + 3_700_000,
    };
    fs.writeFileSync(map, JSON.stringify(entries));
    fs.writeFileSync(
      path.join(homeDir, ".claude", "projects", "workspace", `${SECOND_CLI}.jsonl`),
      `${JSON.stringify({
        type: "user",
        uuid: "rebound-step-0",
        timestamp: new Date(BASE_MS + 3_600_000 + 40_000).toISOString(),
        message: { role: "user", content: "after the rebind, distinctive text" },
      })}\n`,
    );
    const texts = (await call({ resetArchiveBefore: BASE_MS + 10_000_000 })).payload.messages.map(
      textOf,
    );
    expect(texts).toContain("old step 0 with distinctive text");
    expect(texts).toContain("after the rebind, distinctive text");
  });

  it("pages a long archive from its end: archiveOffset rows are on the page, rowsBefore remain", async () => {
    const cli = path.join(
      homeDir,
      ".claude",
      "projects",
      "workspace",
      `${OLD_CLI_SESSION_ID}.jsonl`,
    );
    const steps = Array.from({ length: 30 }, (_, k) =>
      JSON.stringify({
        type: "user",
        uuid: `long-step-${k}`,
        timestamp: new Date(BASE_MS + 3_600_000 + 2_000 + k * 1_000).toISOString(),
        message: { role: "user", content: `long step ${k}` },
      }),
    );
    fs.appendFileSync(cli, `${steps.join("\n")}\n`);
    const before = BASE_MS + 10_000_000;
    const seen: string[] = [];
    let offset = 0;
    let rowsBefore = Number.POSITIVE_INFINITY;
    for (let page = 0; page < 10 && rowsBefore > 0; page++) {
      const res = await call({ resetArchiveBefore: before, archiveOffset: offset, limit: 10 });
      expect(res.payload.archive?.resetAt).toBe(Date.parse("2026-10-02T09:30:00.000Z"));
      seen.unshift(...res.payload.messages.map(textOf));
      offset += res.payload.messages.length;
      rowsBefore = res.payload.archive?.rowsBefore ?? 0;
    }
    expect(rowsBefore).toBe(0);
    for (let k = 0; k < 30; k++) {
      expect(seen).toContain(`long step ${k}`);
    }
    // Paged from the end, nothing twice, the archive's own prompt first.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toBe("second-turn?");
  });

  // FORK 2026-10-03 (the architect: "There are still tabs where the history has been erased") — Main's
  // `/new` moved it to a new transcript path; its resets sat beside the old one, served by nothing.
  // The old session's trajectory names the key, and that is how the archive is found.
  it("pages into the resets of a transcript the session left, found by its trajectory", async () => {
    const left = path.join(sessionsDir, "sess-left.jsonl");
    writeTranscript(
      `${left}.reset.2026-10-02T07-45-00.000Z`,
      "sess-left-1",
      ["left-turn"],
      BASE_MS - 1_800_000,
    );
    const ask = () => call({ resetArchiveBefore: Date.parse("2026-10-02T08:30:00.000Z") });
    expect((await ask()).payload.messages).toEqual([]);
    fs.writeFileSync(
      path.join(sessionsDir, "sess-left-1.trajectory.jsonl"),
      `${JSON.stringify({
        type: "session.started",
        sessionId: "sess-left-1",
        sessionKey: SESSION_KEY,
        data: { sessionFile: left },
      })}\n`,
    );
    const res = await ask();
    expect(res.payload.messages.map(textOf)).toEqual(["left-turn?", "left-turn."]);
    expect(res.payload.archive).toEqual({
      resetAt: Date.parse("2026-10-02T07:45:00.000Z"),
      olderCount: 0,
      rowsBefore: 0,
      kind: "reset",
    });
  });

  // FORK 2026-10-03, 4th report on the worker tab — the page's floor is its OLDEST row, and a page
  // can hold a hole above it: a tab in the background never receives its session's live turns, so
  // the turns a session reset before every turn ran while the tab was hidden exist only in archives
  // newer than rows the page kept. A reset archive never repeats another transcript, so it is
  // served whole, whatever the floor; only copies (which do repeat) are cut by it.
  it("serves a reset archive whole even when the page's floor is older than all of it", async () => {
    const res = await call({
      resetArchiveBefore: BASE_MS + 10_000_000,
      archiveFloor: BASE_MS + 3_600_000, // no row of the 09:30 archive is older than it
    });
    const texts = res.payload.messages.map(textOf);
    expect(texts).toContain("second-turn?");
    expect(texts).toContain("second-turn.");
    expect(texts).toContain("old step 0 with distinctive text");
    expect(res.payload.archive?.resetAt).toBe(Date.parse("2026-10-02T09:30:00.000Z"));
  });

  it("a copy the floor leaves empty is passed over; the next older archive is the reply", async () => {
    const live = path.join(sessionsDir, `${SESSION_ID}.jsonl`);
    writeTranscript(
      `${live}.bak-77-${BASE_MS + 7_000_000}`,
      SESSION_ID,
      ["copy-turn"],
      BASE_MS + 6_500_000,
    );
    const res = await call({
      resetArchiveBefore: BASE_MS + 10_000_000,
      archiveFloor: BASE_MS + 6_000_000, // the copy's rows are all at or after it
    });
    expect(res.payload.archive?.kind).toBe("reset");
    expect(res.payload.archive?.resetAt).toBe(Date.parse("2026-10-02T09:30:00.000Z"));
    expect(res.payload.messages.map(textOf)).not.toContain("copy-turn?");
  });

  // A repair backup (`.bak-<pid>-<ms>`, session-file-repair.ts) holds what the transcript held before
  // a rewrite. It overlaps the live file, so it is served only under a floor.
  it("serves a repair backup only to a page that names its floor", async () => {
    const live = path.join(sessionsDir, `${SESSION_ID}.jsonl`);
    const bakAt = BASE_MS + 7_000_000;
    writeTranscript(`${live}.bak-77-${bakAt}`, SESSION_ID, ["lost-turn"], BASE_MS + 6_500_000);
    const before = BASE_MS + 10_000_000;
    const unfloored = await call({ resetArchiveBefore: before });
    expect(unfloored.payload.archive?.kind).toBe("reset");
    expect(unfloored.payload.messages.map(textOf)).not.toContain("lost-turn?");
    const res = await call({ resetArchiveBefore: before, archiveFloor: BASE_MS + 7_200_000 });
    expect(res.payload.archive).toEqual({
      resetAt: bakAt,
      olderCount: 2,
      rowsBefore: 0,
      kind: "copy",
    });
    expect(res.payload.messages.map(textOf)).toEqual(["lost-turn?", "lost-turn."]);
  });

  it("never imports again a claude-cli session the live window already shows", async () => {
    // The live session is bound to the CLI transcript of the 09:30 archive (it ran across the
    // reset): the live window serves those rows, so the archive must not serve them a second time.
    const store = path.join(sessionsDir, "sessions.json");
    const s = JSON.parse(fs.readFileSync(store, "utf8"));
    s[SESSION_KEY].cliSessionBindings = { "claude-cli": { sessionId: OLD_CLI_SESSION_ID } };
    fs.writeFileSync(store, JSON.stringify(s));
    clearSessionStoreCacheForTest();
    const texts = (await call({ resetArchiveBefore: BASE_MS + 10_000_000 })).payload.messages.map(
      textOf,
    );
    expect(texts).toContain("second-turn?");
    expect(texts).not.toContain("old step 0 with distinctive text");
  });

  it("rejects resetArchiveBefore together with a seq cursor", async () => {
    const res = await call({ resetArchiveBefore: BASE_MS, afterSeq: 3 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });
});
