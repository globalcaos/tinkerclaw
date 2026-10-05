/**
 * FORK 2026-09-29 (plan jarvis-icu docs/superpowers/plans/2026-09-29-chat-usage-chips-and-typed-
 * outcomes.md, unit U7). The chat.history projection stamps each turn's skill / recipe / plugin
 * marks on the turn's served user row (`__openclaw.usage`), and serves the prompt errors that ended
 * their run as typed assistant rows. Tree fixtures are asserted to be served by the TranscriptIndex
 * (the production path) and to equal the legacy loader's rows.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createUsageRegistry, type UsageMark } from "../fork/usage-attribution.js";
import { planChatHistoryWindow } from "./chat-history-cursor.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";
import {
  __resetTranscriptReadCacheForTest,
  __setHistoryUsageRegistryForTest,
  readSessionMessagesWithCursor,
  readTranscriptFileMessages,
} from "./session-utils.fs.js";

type Entry = Record<string, unknown>;
type Row = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  outcome?: Record<string, unknown>;
  __openclaw?: {
    kind?: string;
    phase?: string;
    id?: string;
    seq?: number;
    runId?: string;
    usage?: UsageMark[];
  };
};

const BASE_MS = Date.UTC(2026, 8, 29, 8, 0, 0);
const iso = (seconds: number) => new Date(BASE_MS + seconds * 1000).toISOString();
/** The shape attempt.ts persists: formatErrorMessage repeats the cause after " | ". */
const IDLE_TIMEOUT =
  "LLM idle timeout (120s): no response from model | LLM idle timeout (120s): no response from model";

let root = "";
let skillMd = "";
let skillScript = "";
let recipeFile = "";
let fileCount = 0;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "u7-history-usage-"));
  const skillsRoot = path.join(root, "claude", "skills");
  const skillDir = path.join(skillsRoot, "demo-skill");
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  skillMd = path.join(skillDir, "SKILL.md");
  skillScript = path.join(skillDir, "scripts", "run.sh");
  fs.writeFileSync(skillMd, "---\nname: demo-skill\ndescription: fixture skill\n---\n# Demo\n");
  fs.writeFileSync(skillScript, "#!/bin/sh\necho ok\n");
  const recipeRoot = path.join(root, "recipes");
  fs.mkdirSync(path.join(recipeRoot, "ops"), { recursive: true });
  recipeFile = path.join(recipeRoot, "ops", "deploy-thing.md");
  fs.writeFileSync(recipeFile, "---\ntitle: Deploy the thing\n---\n# Deploy\n");
  __setHistoryUsageRegistryForTest(
    createUsageRegistry({
      skillRoots: [skillsRoot],
      recipeRoots: [recipeRoot],
      pluginToolOwner: (tool) =>
        tool === "memory_search" ? { pluginId: "tinkerclaw-memory" } : undefined,
    }),
  );
});

afterEach(() => {
  __resetTranscriptReadCacheForTest();
});

afterAll(() => {
  __setHistoryUsageRegistryForTest(undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

const storePath = () => path.join(root, "sessions.json");

function writeFile(name: string, text: string): string {
  fileCount += 1;
  const file = path.join(root, `${name}-${fileCount}.jsonl`);
  fs.writeFileSync(file, text, "utf-8");
  return file;
}

/** pi stamps every message with its own ms timestamp. */
function stamp(entry: Entry, seconds: number): Entry {
  const message = entry.message as Entry | undefined;
  return message
    ? { ...entry, message: { timestamp: BASE_MS + seconds * 1000, ...message } }
    : entry;
}

/** A current-version tree transcript, each entry chained to the one before it. */
function treeJsonl(sessionId: string, entries: readonly Entry[]): string {
  const lines: Entry[] = [
    {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      cwd: root,
      timestamp: iso(0),
    },
  ];
  let parentId: string | null = null;
  for (const [i, entry] of entries.entries()) {
    const id = `${sessionId}-e${i + 1}`;
    lines.push({ ...stamp(entry, i + 1), id, parentId, timestamp: iso(i + 1) });
    parentId = id;
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** A flat (pre-tree) transcript: no entry carries a `parentId` key. */
function flatJsonl(sessionId: string, entries: readonly Entry[]): string {
  const lines: Entry[] = [{ type: "session", version: 1, id: sessionId }];
  for (const [i, entry] of entries.entries()) {
    lines.push({ ...stamp(entry, i + 1), id: `${sessionId}-f${i + 1}`, timestamp: iso(i + 1) });
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

const user = (text: string): Entry => ({
  type: "message",
  message: { role: "user", content: text },
});
const assistant = (content: unknown[], stopReason = "stop", extra: Entry = {}): Entry => ({
  type: "message",
  message: {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: {},
    stopReason,
    ...extra,
  },
});
const say = (text: string) => assistant([{ type: "text", text }]);
const toolCall = (id: string, name: string, args: Entry) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const toolResult = (id: string, name: string): Entry => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: "ok" }],
    isError: false,
  },
});
const bridgeStart = (id: string, name: string, args: Entry): Entry => ({
  type: "custom",
  customType: "tinker-bridge-tool",
  data: { runId: "run-bridge", phase: "start", toolCallId: id, name, args, textOffset: 0 },
});
const bridgeResult = (id: string): Entry => ({
  type: "custom",
  customType: "tinker-bridge-tool",
  data: { runId: "run-bridge", phase: "result", toolCallId: id, result: "ok", isError: false },
});
const promptError = (runId: string, error: string, atSeconds: number): Entry => ({
  type: "custom",
  customType: "openclaw:prompt-error",
  data: {
    timestamp: BASE_MS + atSeconds * 1000,
    runId,
    sessionId: "s",
    provider: "xai",
    model: "grok",
    api: "openai-responses",
    error,
  },
});

/** Read a tree fixture on the production path, and prove the legacy loader serves the same rows. */
function readTree(sessionId: string, entries: readonly Entry[]) {
  const text = treeJsonl(sessionId, entries);
  const file = writeFile(sessionId, text);
  const read = readSessionMessagesWithCursor(sessionId, storePath(), file);
  expect(read.epoch).toEqual(expect.any(String)); // the TranscriptIndex served it
  const legacyCopy = writeFile(`${sessionId}-legacy`, text);
  expect(readTranscriptFileMessages(legacyCopy, "legacy").messages).toStrictEqual(read.messages);
  return { file, text, epoch: read.epoch, rows: read.messages as Row[] };
}

const promptRows = (rows: readonly Row[]) =>
  rows.filter((row) => row.role === "user" && row.__openclaw?.kind === undefined);
const kinds = (rows: readonly Row[]) => rows.map((row) => row.__openclaw?.kind ?? row.role);

describe("chat.history usage marks (U7)", () => {
  it("stamps each turn's marks on its own served user row (tree transcript)", () => {
    const { rows } = readTree("tree-usage", [
      user("use the demo skill"),
      bridgeStart("toolu_1", "Bash", { command: `sed -n 1,80p ${skillMd}`, description: "read" }),
      bridgeResult("toolu_1"),
      say("done with the skill"),
      user("read the recipe, then browse and recall"),
      assistant([toolCall("call_r", "read", { path: recipeFile })], "toolUse"),
      toolResult("call_r", "read"),
      assistant(
        [
          toolCall("call_b", "mcp__jarvis__browser", { action: "open" }),
          toolCall("call_m", "memory_search", { query: "deploys" }),
        ],
        "toolUse",
      ),
      toolResult("call_b", "mcp__jarvis__browser"),
      toolResult("call_m", "memory_search"),
      say("all read"),
      user("edit the skill, do not use it"),
      assistant(
        [toolCall("call_e", "edit", { path: skillMd, oldText: "a", newText: "b" })],
        "toolUse",
      ),
      toolResult("call_e", "edit"),
      say("edited"),
    ]);
    const prompts = promptRows(rows);
    expect(prompts).toHaveLength(3);
    // D1: a Bash read of SKILL.md is skill use; the row keeps its own __openclaw fields.
    expect(prompts[0].__openclaw).toMatchObject({
      id: "tree-usage-e1",
      seq: 1,
      usage: [
        { kind: "skill", name: "demo-skill", path: skillMd, via: "exec", toolCallId: "toolu_1" },
      ],
    });
    expect(prompts[1].__openclaw?.usage).toEqual([
      {
        kind: "recipe",
        name: "Deploy the thing",
        path: recipeFile,
        via: "read",
        toolCallId: "call_r",
      },
      { kind: "plugin", name: "jarvis", via: "mcp", toolCallId: "call_b" },
      { kind: "plugin", name: "tinkerclaw-memory", via: "plugin-tool", toolCallId: "call_m" },
    ]);
    // Nothing leaks into the next turn, and editing a skill is not using it.
    expect(prompts[2].__openclaw?.usage).toBeUndefined();
    // The bridge rows fed the marks, and the tree projection still does not serve them.
    expect(kinds(rows)).not.toContain("tinker-bridge-tool");
  });

  it("does the same on a flat transcript, where the bridge rows are also served", () => {
    const sessionId = "flat-usage";
    const file = writeFile(
      sessionId,
      flatJsonl(sessionId, [
        user("run the skill's script"),
        bridgeStart("toolu_f1", "Bash", { command: `bash ${skillScript} --dry-run` }),
        bridgeResult("toolu_f1"),
        say("script ran"),
        user("and now nothing"),
        say("nothing"),
      ]),
    );
    const read = readSessionMessagesWithCursor(sessionId, storePath(), file);
    expect(read.epoch).toBeNull(); // the flat path, not the index
    const rows = read.messages as Row[];
    const prompts = promptRows(rows);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].__openclaw?.usage).toEqual([
      { kind: "skill", name: "demo-skill", path: skillMd, via: "exec", toolCallId: "toolu_f1" },
    ]);
    expect(prompts[1].__openclaw?.usage).toBeUndefined();
    expect(
      rows.some(
        (row) => row.__openclaw?.kind === "tinker-bridge-tool" && row.__openclaw.phase === "start",
      ),
    ).toBe(true);
  });

  it("keeps a local user row's marks when claude-cli imports of the same turn merge in", () => {
    const prompt = "use the demo skill and tell me what it says about deployments";
    const answer = "It says to deploy on Fridays, with the checklist in the skill.";
    const mark: UsageMark = { kind: "skill", name: "demo-skill", path: skillMd, via: "exec" };
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [
        {
          role: "user",
          content: prompt,
          timestamp: BASE_MS,
          __openclaw: { seq: 1, usage: [mark] },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: answer }],
          timestamp: BASE_MS + 5_000,
        },
      ],
      importedMessages: [
        {
          role: "user",
          content: prompt,
          timestamp: BASE_MS + 1_000,
          __openclaw: { importedFrom: "claude-cli", externalId: "u-1" },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: answer }],
          timestamp: BASE_MS + 4_000,
          __openclaw: { importedFrom: "claude-cli", externalId: "a-1" },
        },
      ],
    }) as Row[];
    const users = merged.filter((row) => row.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].__openclaw?.usage).toEqual([mark]);
  });
});

describe("chat.history prompt errors (U7)", () => {
  it("serves a prompt error that ended its run as a typed assistant row", () => {
    const { rows } = readTree("pe-served", [user("hello?"), promptError("run-a", IDLE_TIMEOUT, 5)]);
    expect(kinds(rows)).toEqual(["user", "prompt-error"]);
    expect(rows[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: IDLE_TIMEOUT,
      timestamp: BASE_MS + 5_000,
      outcome: {
        kind: "timeout",
        recoverable: true,
        headline: "Timed out",
        source: "prompt-error",
      },
      __openclaw: { kind: "prompt-error", id: "pe-served-e2", runId: "run-a", seq: 2 },
    });
  });

  it("does not duplicate an error the run's own assistant row already carries", () => {
    const { rows } = readTree("pe-after-error", [
      user("again?"),
      assistant([], "error", { errorMessage: "429 Too Many Requests: rate limit reached" }),
      promptError("run-b", "429 Too Many Requests: rate limit reached", 3),
    ]);
    expect(kinds(rows)).toEqual(["user", "assistant"]);
    expect(rows[1].stopReason).toBe("error");
  });

  it("hides a prompt error once the same run answered or stopped, and never serves an abort", () => {
    const { rows } = readTree("pe-hidden", [
      user("list the files"),
      assistant([toolCall("call_x", "exec", { command: "ls" })], "toolUse"),
      toolResult("call_x", "exec"),
      promptError("run-c", IDLE_TIMEOUT, 4),
      say("here are the files"),
      user("and stop"),
      promptError("run-d", IDLE_TIMEOUT, 7),
      assistant([], "aborted"),
      user("abort me"),
      promptError("run-e", "This operation was aborted | This operation was aborted", 10),
    ]);
    expect(kinds(rows)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    // A servable prompt error spends its seq even when a later row hides it (fork note: SEQ); an
    // abort is never servable, so it spends none.
    expect(rows.map((row) => row.__openclaw?.seq)).toEqual([1, 2, 3, 5, 6, 8, 9]);
  });

  it("retires a served prompt error on a later answer without renumbering any other row", () => {
    const sessionId = "pe-append";
    const head = [user("slow?"), promptError("run-f", IDLE_TIMEOUT, 3)];
    const { file, text, epoch, rows: before } = readTree(sessionId, head);
    expect(kinds(before)).toEqual(["user", "prompt-error"]);

    const full = treeJsonl(sessionId, [...head, say("late answer")]);
    expect(full.startsWith(text)).toBe(true);
    fs.appendFileSync(file, full.slice(text.length), "utf-8");
    const after = readSessionMessagesWithCursor(sessionId, storePath(), file);
    expect(after.epoch).toBe(epoch); // a plain append keeps the cursor identity
    const rows = after.messages as Row[];
    expect(kinds(rows)).toEqual(["user", "assistant"]);
    expect(rows.map((row) => row.__openclaw?.seq)).toEqual([1, 3]);

    const plan = (afterSeq: number) =>
      planChatHistoryWindow({
        local: rows,
        serverEpoch: after.epoch,
        request: { afterSeq, epoch: epoch ?? undefined },
        limit: 50,
      });
    // The tab that saw the retired row resets, which is how it drops the bubble...
    expect(plan(2)).toEqual({ kind: "tail", reset: true });
    // ...and a tab one row behind gets the answer as a delta, without the retired row.
    const delta = plan(1);
    expect(delta.kind).toBe("after");
    expect(delta.kind === "after" ? kinds(delta.local as Row[]) : []).toEqual(["assistant"]);
  });

  it("serves it from a flat transcript too", () => {
    const sessionId = "pe-flat";
    const file = writeFile(
      sessionId,
      flatJsonl(sessionId, [user("flat hello?"), promptError("run-g", IDLE_TIMEOUT, 2)]),
    );
    const read = readSessionMessagesWithCursor(sessionId, storePath(), file);
    expect(read.epoch).toBeNull();
    const rows = read.messages as Row[];
    expect(kinds(rows)).toEqual(["user", "prompt-error"]);
    expect(rows[1]).toMatchObject({
      stopReason: "error",
      outcome: { kind: "timeout", source: "prompt-error" },
      __openclaw: { kind: "prompt-error", runId: "run-g", seq: 2 },
    });
  });
});
