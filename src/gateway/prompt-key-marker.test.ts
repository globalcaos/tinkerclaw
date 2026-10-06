import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prepareSessionManagerForRun } from "../agents/embedded-agent-runner/session-manager-init.js";
import {
  appendMissingPromptKeyMarkers,
  attachPromptKeysToUserRows,
  buildPromptKeyMarker,
  findPromptKeyMarker,
  findPromptRowClaimedOnBranch,
  isPromptKeyMarkerEntry,
  PROMPT_KEY_CUSTOM_TYPE,
  type PromptKeyMarkerRef,
  readPromptKeyMarkerRef,
} from "./prompt-key-marker.js";
import { createTranscriptFixtureSync } from "./server-methods/chat.test-helpers.js";
import { readSessionMessages } from "./session-utils.fs.js";

// FORK 2026-09-08 (durable prompt key): pins the ORDERING contract (marker first, prompt row after)
// and both readers. See the header of prompt-key-marker.ts for the defect.

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

const markerLine = (idempotencyKey: string, ts = 1_000): string =>
  JSON.stringify({
    type: "custom",
    id: `e-${idempotencyKey}`,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    customType: PROMPT_KEY_CUSTOM_TYPE,
    data: buildPromptKeyMarker({ idempotencyKey, sessionKey: "agent:main:tinker:x", ts }),
  });

const user = (text: string): Record<string, unknown> => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string): Record<string, unknown> => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const at = (idempotencyKey: string, messageIndex: number): PromptKeyMarkerRef => ({
  idempotencyKey,
  ts: 1_000,
  messageIndex,
});
const keyOf = (row: unknown): unknown => (row as { idempotencyKey?: unknown }).idempotencyKey;

describe("buildPromptKeyMarker / readPromptKeyMarkerRef", () => {
  it("round-trips the data payload into a positioned ref", () => {
    const data = buildPromptKeyMarker({ idempotencyKey: "key-a", sessionKey: "main", ts: 42 });
    expect(data).toEqual({ idempotencyKey: "key-a", sessionKey: "main", ts: 42 });
    expect(readPromptKeyMarkerRef(data, 3)).toEqual({
      idempotencyKey: "key-a",
      ts: 42,
      messageIndex: 3,
    });
  });

  it("rejects data with no usable key and tolerates a missing ts", () => {
    expect(readPromptKeyMarkerRef({}, 0)).toBeNull();
    expect(readPromptKeyMarkerRef({ idempotencyKey: "" }, 0)).toBeNull();
    expect(readPromptKeyMarkerRef(null, 0)).toBeNull();
    expect(readPromptKeyMarkerRef({ idempotencyKey: "key-a" }, 1)).toEqual({
      idempotencyKey: "key-a",
      messageIndex: 1,
    });
  });
});

describe("findPromptKeyMarker", () => {
  it("finds a marker written for this key, with its ts", () => {
    const lines = [JSON.stringify({ type: "session", id: "s" }), markerLine("key-a", 4_242)];
    expect(findPromptKeyMarker(lines, "key-a")).toEqual({ found: true, ts: 4_242 });
  });

  it("does not find a key that was never written", () => {
    expect(findPromptKeyMarker([markerLine("key-a")], "key-b")).toEqual({ found: false });
    expect(findPromptKeyMarker([markerLine("key-a")], "")).toEqual({ found: false });
  });

  it("never throws on an empty, blank or truncated transcript", () => {
    expect(findPromptKeyMarker([], "key-a")).toEqual({ found: false });
    expect(findPromptKeyMarker(["", "   ", "{not json", markerLine("key-a")], "key-a").found).toBe(
      true,
    );
  });

  // The substring gate must not turn a MENTION of the key into proof of acceptance: a prompt that
  // pastes a log line, or the `${key}:assistant-final` keyed assistant row, both contain the key.
  it("ignores message rows that merely contain the key or the custom type", () => {
    const decoyUser = JSON.stringify({
      type: "message",
      message: { role: "user", content: `why did ${PROMPT_KEY_CUSTOM_TYPE} key-a run twice?` },
    });
    const keyedAssistant = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: "done", idempotencyKey: "key-a:assistant-final" },
    });
    expect(findPromptKeyMarker([decoyUser, keyedAssistant], "key-a")).toEqual({ found: false });
  });
});

describe("attachPromptKeysToUserRows", () => {
  // THE ORDERING CONTRACT. chat.send writes the marker BEFORE it dispatches; pi persists the user
  // row at message_end, inside the run. Marker first, always.
  it("attaches to the user row that FOLLOWS the marker", () => {
    const out = attachPromptKeysToUserRows(
      [assistant("previous answer"), user("the prompt")],
      [at("key-a", 1)],
    );
    expect(keyOf(out[1])).toBe("key-a");
    expect(keyOf(out[0])).toBeUndefined();
  });

  it("never attaches to the user row that PRECEDES it", () => {
    const out = attachPromptKeysToUserRows(
      [user("an earlier prompt"), assistant("answer"), user("the prompt")],
      [at("key-a", 2)],
    );
    expect(keyOf(out[0])).toBeUndefined();
    expect(keyOf(out[2])).toBe("key-a");
  });

  it("never attaches to an assistant row", () => {
    const out = attachPromptKeysToUserRows([assistant("one"), assistant("two")], [at("key-a", 0)]);
    expect(out.every((row) => keyOf(row) === undefined)).toBe(true);
  });

  it("gives each marker its own prompt, in order", () => {
    const out = attachPromptKeysToUserRows(
      [user("first"), assistant("a1"), user("second"), assistant("a2")],
      [at("key-a", 0), at("key-b", 2)],
    );
    expect(keyOf(out[0])).toBe("key-a");
    expect(keyOf(out[2])).toBe("key-b");
  });

  // THE DATA-LOSS GUARD. A turn accepted but dead before pi persisted its user row leaves a marker
  // with no prompt. It must claim NOTHING: historyMatchesEntry (tinker-ui/src/outbox.ts) trusts a
  // keyed match unconditionally, so a key on the wrong row retires — deletes — the wrong prompt.
  it("an orphan marker claims nothing; the live marker still claims its own prompt", () => {
    const back = attachPromptKeysToUserRows(
      [user("surviving prompt")],
      [at("key-dead", 0), at("key-live", 0)],
    );
    expect(keyOf(back[0])).toBe("key-live");

    const gap = attachPromptKeysToUserRows(
      [assistant("orphan answer"), user("next prompt")],
      [at("key-dead", 0), at("key-live", 1)],
    );
    expect(keyOf(gap[0])).toBeUndefined();
    expect(keyOf(gap[1])).toBe("key-live");
  });

  // FORK 2026-09-14 — the orphan is REPORTED on the row the next marker claims, so a client can
  // retire an entry that was accepted but whose run never persisted its row (Goku tab: two
  // markers back to back, one answered row, "NOT DELIVERED — WILL RETRY" forever on the first).
  describe("supersededIdempotencyKeys", () => {
    const supersededOf = (row: unknown): unknown =>
      (row as { supersededIdempotencyKeys?: unknown }).supersededIdempotencyKeys;

    it("lists the orphaned key(s) on the row the live marker claims, in order", () => {
      const out = attachPromptKeysToUserRows(
        [user("surviving prompt")],
        [at("key-dead-1", 0), at("key-dead-2", 0), at("key-live", 0)],
      );
      expect(keyOf(out[0])).toBe("key-live");
      expect(supersededOf(out[0])).toEqual(["key-dead-1", "key-dead-2"]);
    });

    it("is absent when every marker claimed its own row", () => {
      const out = attachPromptKeysToUserRows(
        [user("first"), assistant("a1"), user("second")],
        [at("key-a", 0), at("key-b", 2)],
      );
      expect(supersededOf(out[0])).toBeUndefined();
      expect(supersededOf(out[2])).toBeUndefined();
    });

    it("an orphan with no later claimed row is dropped, never attached backwards", () => {
      const out = attachPromptKeysToUserRows(
        [user("earlier prompt"), assistant("answer")],
        [at("key-a", 0), at("key-dead", 2)],
      );
      expect(keyOf(out[0])).toBe("key-a");
      expect(supersededOf(out[0])).toBeUndefined();
    });

    it("rides along even when the claimed row already carried its own key", () => {
      const out = attachPromptKeysToUserRows(
        [{ ...user("the prompt"), idempotencyKey: "key-original" }],
        [at("key-dead", 0), at("key-new", 0)],
      );
      expect(keyOf(out[0])).toBe("key-original");
      expect(supersededOf(out[0])).toEqual(["key-dead"]);
    });

    it("is copy-on-write: the input rows are never mutated", () => {
      const original = user("surviving prompt");
      attachPromptKeysToUserRows([original], [at("key-dead", 0), at("key-live", 0)]);
      expect("supersededIdempotencyKeys" in original).toBe(false);
      expect("idempotencyKey" in original).toBe(false);
    });
  });

  it("never overwrites a key that is already on the row", () => {
    const out = attachPromptKeysToUserRows(
      [{ ...user("the prompt"), idempotencyKey: "key-original" }],
      [at("key-new", 0)],
    );
    expect(keyOf(out[0])).toBe("key-original");
  });

  it("skips a synthetic tinker-bridge tool_result row even though it wears role:user", () => {
    const toolResult = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      __openclaw: { kind: "tinker-bridge-tool", phase: "result" },
    };
    const out = attachPromptKeysToUserRows([toolResult, user("the prompt")], [at("key-a", 0)]);
    expect(keyOf(out[0])).toBeUndefined();
    expect(keyOf(out[1])).toBe("key-a");
  });

  it("is idempotent and never mutates its input", () => {
    const input = [assistant("a"), user("the prompt")];
    const markers = [at("key-a", 1)];
    const once = attachPromptKeysToUserRows(input, markers);
    const twice = attachPromptKeysToUserRows(once, markers);
    expect(twice).toEqual(once);
    expect(keyOf(input[1])).toBeUndefined();
  });

  it("is a no-op with no markers and safe with no messages", () => {
    expect(attachPromptKeysToUserRows([user("untouched")], [])).toEqual([user("untouched")]);
    expect(attachPromptKeysToUserRows([], [at("key-a", 0)])).toEqual([]);
  });
});

// The reader that actually retires an outbox entry: chat.history serves readSessionMessages, and
// the client's reconcileWithHistory reads `idempotencyKey` off the user rows it returns.
describe("readSessionMessages serves the prompt key on the user row", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tree transcript (SessionManager-written): key on the row after each marker, marker never rendered", () => {
    const sessionId = "sess-prompt-key-tree";
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-prompt-key-tree-",
      sessionId,
      fileName: `${sessionId}.jsonl`,
    });
    dirs.push(dir);
    const sm = SessionManager.open(transcriptPath);
    sm.appendCustomEntry(
      PROMPT_KEY_CUSTOM_TYPE,
      buildPromptKeyMarker({ idempotencyKey: "key-1", sessionKey: "main", ts: 1_000 }),
    );
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first prompt" }],
      timestamp: 1_001,
    } as unknown as AppendMessageArg);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      timestamp: 1_002,
      stopReason: "stop",
      api: "openai-responses",
      provider: "openclaw",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as unknown as AppendMessageArg);
    sm.appendCustomEntry(
      PROMPT_KEY_CUSTOM_TYPE,
      buildPromptKeyMarker({ idempotencyKey: "key-2", sessionKey: "main", ts: 2_000 }),
    );
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "second prompt" }],
      timestamp: 2_001,
    } as unknown as AppendMessageArg);

    const rows = readSessionMessages(sessionId, path.join(dir, "sessions.json"), transcriptPath);
    expect(rows).toHaveLength(3);
    expect((rows[0] as { role?: unknown }).role).toBe("user");
    expect(keyOf(rows[0])).toBe("key-1");
    expect(keyOf(rows[1])).toBeUndefined();
    expect(keyOf(rows[2])).toBe("key-2");
  });

  // FORK 2026-09-23 — a prompt sent while a turn runs is forked off the branch by the run's reply.
  const treeLine = (
    id: string,
    parentId: string | null,
    ts: number,
    body: Record<string, unknown>,
  ): string => JSON.stringify({ id, parentId, timestamp: new Date(ts).toISOString(), ...body });
  const strandedFixture = (name: string, replyTs: number): string[] => {
    const sessionId = `sess-stranded-${name}`;
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: `openclaw-stranded-${name}-`,
      sessionId,
      fileName: `${sessionId}.jsonl`,
    });
    dirs.push(dir);
    const marker = (key: string) => ({
      type: "custom",
      customType: PROMPT_KEY_CUSTOM_TYPE,
      data: buildPromptKeyMarker({ idempotencyKey: key, sessionKey: "main", ts: 0 }),
    });
    const msg = (role: string, text: string, ts: number) => ({
      type: "message",
      message: { role, content: [{ type: "text", text }], timestamp: ts },
    });
    fs.appendFileSync(
      transcriptPath,
      [
        treeLine("m-a", null, 1_000, marker("key-a")),
        treeLine("u-a", "m-a", 1_001, msg("user", "prompt A", 1_001)),
        // prompt B, sent while A's turn runs, lands on the file leaf (u-a)...
        treeLine("m-b", "u-a", 2_000, marker("key-b")),
        treeLine("u-b", "m-b", 2_001, msg("user", "prompt B", 2_001)),
        // ...and A's reply is appended to the run's stale leaf (u-a), stranding B.
        treeLine("a-a", "u-a", replyTs, msg("assistant", "answer", replyTs)),
      ].join("\n") + "\n",
      "utf-8",
    );
    return readSessionMessages(sessionId, path.join(dir, "sessions.json"), transcriptPath) as never;
  };
  const textOf = (row: unknown): string =>
    ((row as { content: Array<{ text: string }> }).content[0]?.text ?? "") as string;

  it("serves a prompt stranded by a concurrent reply, keyed, at its place in time", () => {
    const rows = strandedFixture("race", 3_000);
    expect(rows.map(textOf)).toEqual(["prompt A", "prompt B", "answer"]);
    expect(keyOf(rows[0])).toBe("key-a");
    expect(keyOf(rows[1])).toBe("key-b");
    expect((rows[1] as { __openclaw?: { stranded?: unknown } }).__openclaw?.stranded).toBe(true);
  });

  it("keeps a DELIBERATE fork hidden: the branch moved on before the off-branch row existed", () => {
    const rows = strandedFixture("deliberate", 1_500);
    expect(rows.map(textOf)).toEqual(["prompt A", "answer"]);
  });

  it("flat transcript (no ids): same contract", () => {
    const sessionId = "sess-prompt-key-flat";
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-prompt-key-flat-",
      sessionId,
      fileName: `${sessionId}.jsonl`,
    });
    dirs.push(dir);
    fs.appendFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "custom",
          customType: PROMPT_KEY_CUSTOM_TYPE,
          data: buildPromptKeyMarker({ idempotencyKey: "key-flat", sessionKey: "main", ts: 1 }),
        }),
        JSON.stringify({ message: { role: "user", content: "Hello" } }),
        JSON.stringify({ message: { role: "assistant", content: "World" } }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const rows = readSessionMessages(sessionId, path.join(dir, "sessions.json"), transcriptPath);
    expect(rows).toHaveLength(2);
    expect(keyOf(rows[0])).toBe("key-flat");
    expect(keyOf(rows[1])).toBeUndefined();
  });
});

// FORK 2026-10-01 (`[chat-divergence]` cause 1): the RUNNER's write. chat.send skips a
// transcript that does not exist yet or holds no assistant row, so a brand-new session's first
// prompt was never keyed and the outbox redrew it LOST. run/attempt.ts now writes the marker just
// before pi persists the user row. These tests drive a REAL pi SessionManager through the
// attempt's own steps: open, prepareSessionManagerForRun, the marker write, the user row, then
// the assistant row (the flush).
describe("appendMissingPromptKeyMarkers (the runner's write)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const SESSION_KEY = "agent:main:tinker:first-prompt";
  const userRow = (text: string, timestamp: number): AppendMessageArg =>
    ({ role: "user", content: [{ type: "text", text }], timestamp }) as unknown as AppendMessageArg;
  const assistantRow = (
    text: string,
    timestamp: number,
    extra: Record<string, unknown> = {},
  ): AppendMessageArg =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp,
      stopReason: "stop",
      api: "openai-responses",
      provider: "openclaw",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      ...extra,
    }) as unknown as AppendMessageArg;

  /** A header-only transcript, the shape chat.send reports as `no-assistant-yet`. */
  const precreated = (sessionId: string) => {
    const fixture = createTranscriptFixtureSync({
      prefix: "openclaw-first-prompt-",
      sessionId,
      fileName: `${sessionId}.jsonl`,
    });
    dirs.push(fixture.dir);
    return fixture;
  };

  /** What run/attempt.ts does before the prompt: open the file fresh, then prepare it. */
  const openPrepared = async (transcriptPath: string, sessionId: string) => {
    const hadSessionFile = fs.existsSync(transcriptPath);
    const sm = SessionManager.open(transcriptPath);
    await prepareSessionManagerForRun({
      sessionManager: sm,
      sessionFile: transcriptPath,
      hadSessionFile,
      sessionId,
      cwd: "/tmp",
    });
    return sm;
  };

  const mark = (sm: SessionManager, promptKeys: readonly string[], ts: number) =>
    appendMissingPromptKeyMarkers(sm, { promptKeys, sessionKey: SESSION_KEY, ts });

  const transcriptEntries = (transcriptPath: string): Array<Record<string, unknown>> =>
    fs
      .readFileSync(transcriptPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const markerKeysOnDisk = (transcriptPath: string): string[] =>
    transcriptEntries(transcriptPath).flatMap((entry) => {
      if (!isPromptKeyMarkerEntry(entry)) {
        return [];
      }
      const ref = readPromptKeyMarkerRef(entry.data, 0);
      return ref ? [ref.idempotencyKey] : [];
    });

  const servedKeys = (sessionId: string, dir: string, transcriptPath: string): unknown[] =>
    readSessionMessages(sessionId, path.join(dir, "sessions.json"), transcriptPath).map(keyOf);

  it("cold session, pre-created transcript: the first flush keys row 0 and a replay finds the key", async () => {
    const sessionId = "sess-first-prompt-precreated";
    const { dir, transcriptPath } = precreated(sessionId);
    const sm = await openPrepared(transcriptPath, sessionId);
    // sanitizeSessionHistory's pre-run entry, as in the transcripts that showed the bug
    sm.appendCustomEntry("model-snapshot", { timestamp: 1, provider: "openclaw", modelId: "test" });
    expect(mark(sm, ["key-first"], 5_000)).toEqual({ ok: true, appended: ["key-first"] });
    // pi holds every append until an assistant row exists: nothing is on disk yet
    expect(fs.readFileSync(transcriptPath, "utf-8")).toBe("");

    sm.appendMessage(userRow("first prompt", 5_001));
    sm.appendMessage(assistantRow("first answer", 5_002));

    const entries = transcriptEntries(transcriptPath);
    const markerAt = entries.findIndex((entry) => isPromptKeyMarkerEntry(entry));
    const userAt = entries.findIndex(
      (entry) => entry.type === "message" && (entry.message as { role?: unknown }).role === "user",
    );
    // ORDER ON DISK IS FORWARD: the marker is the user row's parent
    expect(markerAt).toBeGreaterThan(0);
    expect(userAt).toBe(markerAt + 1);
    expect(entries[userAt]?.parentId).toBe(entries[markerAt]?.id);

    expect(servedKeys(sessionId, dir, transcriptPath)).toEqual(["key-first", undefined]);
    // the scan chat.send's findDurablePromptKey runs: a replay of the first prompt now echoes
    // the completed run instead of dispatching it again
    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
    expect(findPromptKeyMarker(lines, "key-first")).toEqual({ found: true, ts: 5_000 });
  });

  it("cold session, no transcript yet: same shape once pi creates the file", async () => {
    const sessionId = "sess-first-prompt-new";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-first-prompt-new-"));
    dirs.push(dir);
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    const sm = await openPrepared(transcriptPath, sessionId);
    expect(mark(sm, ["key-first"], 5_000)).toEqual({ ok: true, appended: ["key-first"] });
    expect(fs.existsSync(transcriptPath)).toBe(false);

    sm.appendMessage(userRow("first prompt", 5_001));
    sm.appendMessage(assistantRow("first answer", 5_002));

    expect(markerKeysOnDisk(transcriptPath)).toEqual(["key-first"]);
    expect(servedKeys(sessionId, dir, transcriptPath)).toEqual(["key-first", undefined]);
  });

  it("a second attempt of the same run adds no second marker for the key", async () => {
    const sessionId = "sess-first-prompt-retry";
    const { dir, transcriptPath } = precreated(sessionId);
    // attempt 1: the provider fails, and pi's error reply is the flush that lands the marker
    const first = await openPrepared(transcriptPath, sessionId);
    expect(mark(first, ["key-first"], 5_000).appended).toEqual(["key-first"]);
    first.appendMessage(userRow("first prompt", 5_001));
    first.appendMessage(
      assistantRow("", 5_002, { stopReason: "error", errorMessage: "rate limited" }),
    );
    expect(markerKeysOnDisk(transcriptPath)).toEqual(["key-first"]);

    // attempt 2 opens the file fresh, as run/attempt.ts does
    const second = await openPrepared(transcriptPath, sessionId);
    expect(mark(second, ["key-first"], 6_000)).toEqual({ ok: true, appended: [] });
    second.appendMessage(userRow("first prompt", 6_001));
    second.appendMessage(assistantRow("first answer", 6_002));

    expect(markerKeysOnDisk(transcriptPath)).toEqual(["key-first"]);
    expect(servedKeys(sessionId, dir, transcriptPath)[0]).toBe("key-first");
  });

  // FORK 2026-10-05 (bug-log `failover-reprompt`): the test above appends the prompt again in
  // attempt 2, which is what prompt() did and what the runner no longer does once it finds the row.
  it("a second attempt finds the prompt row the first one wrote, the row its retry continues from", async () => {
    const sessionId = "sess-failover-claim";
    const { transcriptPath } = precreated(sessionId);
    const first = await openPrepared(transcriptPath, sessionId);
    mark(first, ["key-first"], 5_000);
    first.appendMessage(userRow("first prompt", 5_001));
    first.appendMessage(
      assistantRow("", 5_002, { stopReason: "error", errorMessage: "usage limit" }),
    );

    // attempt 2 on another model opens the file fresh; replay notes the model change first
    const second = await openPrepared(transcriptPath, sessionId);
    second.appendCustomEntry("model-snapshot", { timestamp: 6, provider: "xai", modelId: "grok" });
    const promptRow = transcriptEntries(transcriptPath).find(
      (entry) => entry.type === "message" && (entry.message as { role?: unknown }).role === "user",
    );
    expect(findPromptRowClaimedOnBranch(second.getBranch(), ["key-first"])).toEqual({
      entryId: promptRow?.id,
      idempotencyKey: "key-first",
    });
    expect(findPromptRowClaimedOnBranch(second.getBranch(), ["key-other"])).toBeUndefined();
  });

  it("an attempt that died before the first flush left nothing, so the next one writes it once", async () => {
    const sessionId = "sess-first-prompt-died";
    const { dir, transcriptPath } = precreated(sessionId);
    const first = await openPrepared(transcriptPath, sessionId);
    mark(first, ["key-first"], 5_000);
    first.appendMessage(userRow("first prompt", 5_001));
    // no assistant row: the buffer dies with the instance
    expect(fs.readFileSync(transcriptPath, "utf-8")).toBe("");

    const second = await openPrepared(transcriptPath, sessionId);
    expect(mark(second, ["key-first"], 6_000)).toEqual({ ok: true, appended: ["key-first"] });
    second.appendMessage(userRow("first prompt", 6_001));
    second.appendMessage(assistantRow("first answer", 6_002));

    expect(markerKeysOnDisk(transcriptPath)).toEqual(["key-first"]);
    expect(servedKeys(sessionId, dir, transcriptPath)).toEqual(["key-first", undefined]);
  });

  it("an established session whose key chat.send already wrote gets no duplicate", async () => {
    const sessionId = "sess-first-prompt-established";
    const { dir, transcriptPath } = precreated(sessionId);
    const turn0 = await openPrepared(transcriptPath, sessionId);
    mark(turn0, ["key-0"], 1_000);
    turn0.appendMessage(userRow("prompt zero", 1_001));
    turn0.appendMessage(assistantRow("answer zero", 1_002));
    // chat.send on the established session (appendPromptKeyMarkerForChatSend): lands at once
    SessionManager.open(transcriptPath).appendCustomEntry(
      PROMPT_KEY_CUSTOM_TYPE,
      buildPromptKeyMarker({ idempotencyKey: "key-next", sessionKey: SESSION_KEY, ts: 7_000 }),
    );

    const turn1 = await openPrepared(transcriptPath, sessionId);
    expect(mark(turn1, ["key-next"], 7_100)).toEqual({ ok: true, appended: [] });
    turn1.appendMessage(userRow("next prompt", 7_101));
    turn1.appendMessage(assistantRow("next answer", 7_102));

    expect(markerKeysOnDisk(transcriptPath)).toEqual(["key-0", "key-next"]);
    expect(servedKeys(sessionId, dir, transcriptPath)).toEqual([
      "key-0",
      undefined,
      "key-next",
      undefined,
    ]);
  });

  // FORK 2026-10-05 (bug-log `steer-written-twice`): the agent:main:tinker:mue2cvin 10-05 08:25 tree,
  // rebuilt with real SessionManagers. A prompt steered into a running turn: chat.send's marker and
  // the delivery callback's keyed row land on the file's leaf, the running turn appends under its
  // own older leaf (stranding them), and pi persists the injected steer on the served branch.
  const steeredPromptRows = async (sessionId: string, injectedKey: string | undefined) => {
    // Entries are stamped with the wall clock, and a stranded row is served only when the branch
    // moved on AFTER it was written: one second between appends, as in the live tree.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let clock = Date.parse("2026-10-05T06:25:00.000Z");
      const tick = () => vi.setSystemTime((clock += 1_000));
      const { dir, transcriptPath } = precreated(sessionId);
      const running = await openPrepared(transcriptPath, sessionId);
      tick();
      running.appendMessage(userRow("start a long task", clock));
      tick();
      running.appendMessage(assistantRow("working on it", clock));
      tick();
      SessionManager.open(transcriptPath).appendCustomEntry(
        PROMPT_KEY_CUSTOM_TYPE,
        buildPromptKeyMarker({ idempotencyKey: "key-steer", sessionKey: SESSION_KEY, ts: clock }),
      );
      tick();
      // A keyed user row, as appendUserMessageToSessionTranscript writes it: pi's type has no key.
      SessionManager.open(transcriptPath).appendMessage({
        ...userRow("stop the process for now", clock),
        idempotencyKey: "key-steer",
      } as unknown as AppendMessageArg);
      tick();
      running.appendMessage(assistantRow("still working", clock));
      tick();
      running.appendMessage({
        ...userRow("stop the process for now", clock),
        ...(injectedKey ? { idempotencyKey: injectedKey } : {}),
      } as unknown as AppendMessageArg);
      tick();
      running.appendMessage(assistantRow("stopped", clock));
      return readSessionMessages(sessionId, path.join(dir, "sessions.json"), transcriptPath).filter(
        (row) =>
          (row as { role?: unknown }).role === "user" &&
          JSON.stringify((row as { content?: unknown }).content).includes("stop the process"),
      );
    } finally {
      vi.useRealTimers();
    }
  };

  it("a steered row persisted with its prompt's key is served once", async () => {
    const rows = await steeredPromptRows("sess-steer-keyed", "key-steer");
    expect(rows.map(keyOf)).toEqual(["key-steer"]);
  });

  it("CONTROL: pi's unkeyed steered row is served beside the stranded keyed copy", async () => {
    const rows = await steeredPromptRows("sess-steer-unkeyed", undefined);
    expect(rows).toHaveLength(2);
  });

  // WHY the runner writes after prepareSessionManagerForRun and not at SessionManager.open: on a
  // transcript that exists but holds no assistant row, prepare resets the instance to its header.
  it("a marker appended before prepareSessionManagerForRun never reaches the disk", async () => {
    const sessionId = "sess-first-prompt-too-early";
    const { dir, transcriptPath } = precreated(sessionId);
    const sm = SessionManager.open(transcriptPath);
    mark(sm, ["key-early"], 1_000);
    await prepareSessionManagerForRun({
      sessionManager: sm,
      sessionFile: transcriptPath,
      hadSessionFile: true,
      sessionId,
      cwd: "/tmp",
    });
    sm.appendMessage(userRow("first prompt", 1_001));
    sm.appendMessage(assistantRow("first answer", 1_002));

    expect(markerKeysOnDisk(transcriptPath)).toEqual([]);
    expect(servedKeys(sessionId, dir, transcriptPath)).toEqual([undefined, undefined]);
  });

  it("writes one marker per missing key, in order, and skips held, empty and repeated keys", () => {
    const writes: Array<[string, unknown]> = [];
    const sm = {
      getEntries: () => [
        {
          type: "custom",
          customType: PROMPT_KEY_CUSTOM_TYPE,
          data: buildPromptKeyMarker({ idempotencyKey: "key-b", sessionKey: "s", ts: 1 }),
        },
      ],
      appendCustomEntry: (customType: string, data?: unknown) => {
        writes.push([customType, data]);
        return `e-${writes.length}`;
      },
    };
    const result = appendMissingPromptKeyMarkers(sm, {
      promptKeys: ["key-a", "key-b", "", "key-a", "key-c"],
      sessionKey: "s",
      ts: 9,
    });
    expect(result).toEqual({ ok: true, appended: ["key-a", "key-c"] });
    expect(writes).toEqual([
      [PROMPT_KEY_CUSTOM_TYPE, { idempotencyKey: "key-a", sessionKey: "s", ts: 9 }],
      [PROMPT_KEY_CUSTOM_TYPE, { idempotencyKey: "key-c", sessionKey: "s", ts: 9 }],
    ]);
  });

  it("no prompt keys: reads nothing and writes nothing", () => {
    const sm = { getEntries: vi.fn(() => []), appendCustomEntry: vi.fn() };
    for (const promptKeys of [undefined, [], [""]]) {
      expect(appendMissingPromptKeyMarkers(sm, { promptKeys, sessionKey: "s", ts: 1 })).toEqual({
        ok: true,
        appended: [],
      });
    }
    expect(sm.getEntries).not.toHaveBeenCalled();
    expect(sm.appendCustomEntry).not.toHaveBeenCalled();
  });

  it("never throws: a failed append comes back as ok:false with the keys written before it", () => {
    const boom = new Error("ENOSPC");
    let calls = 0;
    const sm = {
      getEntries: () => [],
      appendCustomEntry: () => {
        calls += 1;
        if (calls === 2) {
          throw boom;
        }
        return "e-1";
      },
    };
    expect(
      appendMissingPromptKeyMarkers(sm, { promptKeys: ["key-a", "key-b"], sessionKey: "s", ts: 1 }),
    ).toEqual({ ok: false, appended: ["key-a"], error: boom });
  });
});

// FORK 2026-10-05 (bug-log `failover-reprompt`): the claim a retry continues from. Plain branch
// entries in root-to-leaf order, as SessionManager.getBranch() returns them.
describe("findPromptRowClaimedOnBranch (the prompt row a retry continues from)", () => {
  const markerEntry = (key: string) => ({
    type: "custom",
    customType: PROMPT_KEY_CUSTOM_TYPE,
    id: `m-${key}`,
    data: buildPromptKeyMarker({ idempotencyKey: key, sessionKey: "agent:main:tinker:x", ts: 1 }),
  });
  const userEntry = (id: string) => ({ type: "message", id, message: user("same words") });
  const answerEntry = (id: string) => ({ type: "message", id, message: assistant("an answer") });

  it("claims the first user row after the run's marker", () => {
    const branch = [userEntry("u0"), answerEntry("a0"), markerEntry("k1"), userEntry("u1")];
    expect(findPromptRowClaimedOnBranch(branch, ["k1"])).toEqual({
      entryId: "u1",
      idempotencyKey: "k1",
    });
  });

  it("claims nothing without the marker, without a row after it, or without keys", () => {
    expect(findPromptRowClaimedOnBranch([userEntry("u0")], ["k1"])).toBeUndefined();
    expect(
      findPromptRowClaimedOnBranch([userEntry("u0"), markerEntry("k1")], ["k1"]),
    ).toBeUndefined();
    expect(findPromptRowClaimedOnBranch([markerEntry("k1"), userEntry("u1")], [])).toBeUndefined();
    expect(
      findPromptRowClaimedOnBranch([markerEntry("k1"), userEntry("u1")], undefined),
    ).toBeUndefined();
  });

  it("another prompt's marker closes the claim: a turn that died before its row never reaches forward", () => {
    const branch = [markerEntry("k1"), markerEntry("k2"), userEntry("u2")];
    expect(findPromptRowClaimedOnBranch(branch, ["k1"])).toBeUndefined();
  });

  it("identity, not text: the same words under a new key are a new prompt", () => {
    const branch = [
      markerEntry("k1"),
      userEntry("u1"),
      answerEntry("a1"),
      markerEntry("k2"),
      userEntry("u2"),
    ];
    expect(findPromptRowClaimedOnBranch(branch, ["k1"])?.entryId).toBe("u1");
    expect(findPromptRowClaimedOnBranch(branch, ["k2"])?.entryId).toBe("u2");
  });

  it("a compaction after the row keeps the prompt path", () => {
    const branch = [markerEntry("k1"), userEntry("u1"), { type: "compaction", id: "c1" }];
    expect(findPromptRowClaimedOnBranch(branch, ["k1"])).toBeUndefined();
  });
});
