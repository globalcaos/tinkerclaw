import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPromptKeyMarker, PROMPT_KEY_CUSTOM_TYPE } from "./prompt-key-marker.js";
import {
  __resetTranscriptReadCacheForTest,
  indexFidelityGap,
  readSessionBranchCycleSafe,
  readSessionMessages,
  readSessionMessagesWithCursor,
  readTranscriptFileMessages,
} from "./session-utils.fs.js";
import { __setTranscriptParentCycleLogForTest, getTranscriptIndex } from "./transcript-index.js";

// Plan task 4 (rulings R4/R5/R8/R18): the tree path of readSessionMessages is served by the
// incremental TranscriptIndex wherever the index reads exactly what pi's SessionManager.open reads,
// and by the legacy loader everywhere else. Both loaders feed ONE projection, so every case here
// asserts the production read deep-equals the legacy loader's rows AND which loader served it
// (epoch string = index, null = legacy): a silent fallback must not pass as parity.

const tmpDirs: string[] = [];

beforeEach(() => {
  // A compaction entry without a parseable timestamp is stamped with Date.now(): pin it so two
  // reads of the same file can be compared.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetTranscriptReadCacheForTest();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type Served = "index" | "legacy";

/** JSONL text; a string entry is written verbatim (corrupt/blank lines). */
function jsonl(entries: readonly unknown[], trailingNewline = true): string {
  const body = entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n");
  return trailingNewline ? `${body}\n` : body;
}

/**
 * Two copies of one transcript. The legacy loader may REWRITE its file (pi migrates an older
 * version, and replaces a headerless file, on open), which must not leak into the production read.
 */
function writeCopies(sessionId: string, text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsm-parity-"));
  tmpDirs.push(root);
  const make = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, text, "utf-8");
    return { file, storePath: path.join(dir, "sessions.json") };
  };
  return { legacy: make("legacy"), prod: make("prod") };
}

function expectParity(sessionId: string, text: string, served: Served) {
  const { legacy, prod } = writeCopies(sessionId, text);
  const reference = readTranscriptFileMessages(legacy.file, "legacy");
  expect(reference.epoch).toBeNull();
  const read = readSessionMessagesWithCursor(sessionId, prod.storePath, prod.file);
  expect(read.messages).toStrictEqual(reference.messages);
  expect(readSessionMessages(sessionId, prod.storePath, prod.file)).toStrictEqual(
    reference.messages,
  );
  if (served === "index") {
    expect(read.epoch).toEqual(expect.any(String));
  } else {
    expect(read.epoch).toBeNull();
  }
  return { reference, read, legacy, prod };
}

/**
 * Production file gets `entries.slice(0, splitAt)`, is read (index full build), then gets the rest
 * appended and is read again — the second read must go through a TAIL-PARSE, the path that runs
 * on every poll in production, and still equal the legacy loader over the whole file.
 */
function expectIncrementalParity(sessionId: string, entries: readonly unknown[], splitAt: number) {
  const { legacy, prod } = writeCopies(sessionId, jsonl(entries.slice(0, splitAt)));
  fs.writeFileSync(legacy.file, jsonl(entries), "utf-8");
  const before = readSessionMessagesWithCursor(sessionId, prod.storePath, prod.file);
  expect(before.epoch).toEqual(expect.any(String));
  fs.appendFileSync(prod.file, jsonl(entries.slice(splitAt)), "utf-8");
  const after = readSessionMessagesWithCursor(sessionId, prod.storePath, prod.file);
  const reference = readTranscriptFileMessages(legacy.file, "legacy");
  expect(after.messages).toStrictEqual(reference.messages);
  expect(after.epoch).toEqual(expect.any(String));
  expect(getTranscriptIndex(prod.file).stats).toMatchObject({ fullBuilds: 1, tailParses: 1 });
  return { before, after, reference };
}

const header = (id: string, version: number = CURRENT_SESSION_VERSION) => ({
  type: "session",
  version,
  id,
  cwd: "/tmp",
  timestamp: "2026-09-23T10:00:00.000Z",
});

const iso = (ms: number) => new Date(Date.UTC(2026, 8, 23, 10, 0, 0) + ms).toISOString();

function msg(id: string, parentId: string | null, role: string, content: unknown, ms: number) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso(ms),
    message: { role, content, timestamp: ms },
  };
}

const text = (t: string) => [{ type: "text", text: t }];

function marker(id: string, parentId: string | null, key: string, ms: number) {
  return {
    type: "custom",
    customType: PROMPT_KEY_CUSTOM_TYPE,
    id,
    parentId,
    timestamp: iso(ms),
    data: buildPromptKeyMarker({ idempotencyKey: key, sessionKey: "main", ts: ms }),
  };
}

const INTERNAL_CONTEXT_BLOCK = [
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "OpenClaw runtime context (internal):",
  "This context is runtime-generated, not user-authored. Keep internal details private.",
  "",
  "[Internal task completion event]",
  "source: subagent",
  "status: completed successfully",
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
].join("\n");

const ENGRAM_COMPACTION_RECORD = {
  type: "compaction",
  id: "comp-engram",
  timestamp: "2026-09-07T08:15:31.465Z",
  summary: "[Pointer manifest: events A..B (48 events, ~128260 tokens). Use recall(query).]",
  firstKeptEntryId: "comp-engram",
  tokensBefore: 7855029,
  details: { engramEventsStored: 48, tokensEvicted: 128260 },
  fromHook: true,
};

// The transcripts session-utils.fs.test.ts feeds readSessionMessages, verbatim in shape.
const EXISTING_FIXTURES: Array<{ name: string; tree: boolean; entries: unknown[] }> = [
  {
    name: "flat: compaction marker",
    tree: false,
    entries: [
      { type: "session", version: 1, id: "s" },
      { message: { role: "user", content: "Hello" } },
      {
        type: "compaction",
        id: "comp-1",
        timestamp: "2026-02-07T00:00:00.000Z",
        summary: "Compacted history",
        firstKeptEntryId: "x",
        tokensBefore: 123,
      },
      { message: { role: "assistant", content: "World" } },
    ],
  },
  {
    name: "flat: engram compaction",
    tree: false,
    entries: [
      { type: "session", version: 1, id: "s" },
      { message: { role: "user", content: "Hello" } },
      ENGRAM_COMPACTION_RECORD,
    ],
  },
  {
    name: "flat: runtime-context-only message",
    tree: false,
    entries: [
      { type: "session", version: 1, id: "s" },
      { message: { role: "user", content: "what is the plan?" } },
      { message: { role: "user", content: INTERNAL_CONTEXT_BLOCK } },
      { message: { role: "assistant", content: "here it is" } },
    ],
  },
  {
    name: "flat: envelope appended to the user's words",
    tree: false,
    entries: [
      { type: "session", version: 1, id: "s" },
      {
        message: {
          role: "user",
          content: text(`check the cameras\n\n${INTERNAL_CONTEXT_BLOCK}`),
        },
      },
    ],
  },
  {
    name: "tree: engram compaction",
    tree: true,
    entries: [
      header("s"),
      msg("ask", null, "user", "Hello", 1),
      { ...ENGRAM_COMPACTION_RECORD, parentId: "ask" },
    ],
  },
  {
    name: "flat: compaction without summary",
    tree: false,
    entries: [
      { type: "session", version: 1, id: "s" },
      { message: { role: "user", content: "Hello" } },
      {
        type: "compaction",
        id: "comp-2",
        timestamp: "2026-02-07T00:00:00.000Z",
        summary: "   ",
        firstKeptEntryId: "x",
        tokensBefore: 123,
      },
      { message: { role: "assistant", content: "World" } },
    ],
  },
  {
    name: "tree: active branch after a rewrite abandoned older entries",
    tree: true,
    entries: [
      header("s"),
      msg("original", null, "user", "Sender (untrusted metadata): webchat\n\noriginal", 1),
      msg("clean", null, "user", "clean prompt", 2),
      msg("answer", "clean", "assistant", text("clean answer"), 3),
    ],
  },
  {
    name: "flat: cross-agent single message",
    tree: false,
    entries: [
      { type: "session", version: 1, id: "s" },
      { message: { role: "user", content: "from-ops" } },
    ],
  },
  {
    name: "flat: basic transcript",
    tree: false,
    entries: [
      { type: "session", version: 1, id: "s" },
      { message: { role: "user", content: "Hello world" } },
      { message: { role: "assistant", content: "Hi there" } },
    ],
  },
];

describe("readSessionMessages index/legacy parity: existing fixtures", () => {
  // session-utils.fs.test.ts writes its fixtures WITHOUT a trailing newline; pi always writes one.
  // An unterminated last line is read by pi and deferred by the index, so those copies must take
  // the legacy path — and a newline-terminated tree transcript must take the index.
  for (const fixture of EXISTING_FIXTURES) {
    for (const trailingNewline of [false, true]) {
      const served: Served = fixture.tree && trailingNewline ? "index" : "legacy";
      it(`${fixture.name} (trailing newline: ${trailingNewline}) → ${served}`, () => {
        const { reference } = expectParity(
          "parity-existing",
          jsonl(fixture.entries, trailingNewline),
          served,
        );
        expect(reference.messages.length).toBeGreaterThan(0);
      });
    }
  }
});

// Synthetic tree transcripts, each exercising one step of the shared projection.
const COMPACTION_TREE = [
  header("s"),
  msg("u1", null, "user", "first", 1),
  msg("a1", "u1", "assistant", text("first answer"), 2),
  {
    type: "compaction",
    id: "c1",
    parentId: "a1",
    timestamp: iso(3),
    summary: "  summary of the first turn  ",
    firstKeptEntryId: "a1",
    tokensBefore: 5000,
    tokensAfter: 1200,
  },
  msg("u2", "c1", "user", "second", 4),
  msg("a2", "u2", "assistant", text("second answer"), 5),
  // No timestamp and no summary: the Date.now() fallback and the literal "Compaction" text.
  { type: "compaction", id: "c2", parentId: "a2", firstKeptEntryId: "u2", tokensBefore: 900 },
  msg("u3", "c2", "user", "third", 6),
];

// A prompt sent while a turn runs lands on the file leaf; the running turn's reply is appended to
// its stale leaf, stranding the prompt off-branch (prompt-key-marker.ts findStrandedPromptRows).
const strandedTree = (replyMs: number) => [
  header("s"),
  marker("m-a", null, "key-a", 1_000),
  msg("u-a", "m-a", "user", text("prompt A"), 1_001),
  marker("m-b", "u-a", "key-b", 2_000),
  msg("u-b", "m-b", "user", text("prompt B"), 2_001),
  msg("a-a", "u-a", "assistant", text("answer"), replyMs),
];

const PROMPT_KEY_TREE = [
  header("s"),
  marker("m1", null, "key-1", 1),
  msg("u1", "m1", "user", text("first prompt"), 2),
  msg("a1", "u1", "assistant", text("first answer"), 3),
  // An orphaned marker (its run died before pi wrote the user row) followed by a real one: the
  // next row carries the orphan as supersededIdempotencyKeys.
  marker("m2", "a1", "key-2-orphan", 4),
  marker("m3", "m2", "key-3", 5),
  msg("u3", "m3", "user", text("third prompt"), 6),
];

const RUNTIME_CONTEXT_TREE = [
  header("s"),
  msg("u1", null, "user", "what is the plan?", 1),
  msg("ctx", "u1", "user", INTERNAL_CONTEXT_BLOCK, 2),
  msg("mixed", "ctx", "user", text(`check the cameras\n\n${INTERNAL_CONTEXT_BLOCK}`), 3),
  msg("a1", "mixed", "assistant", text("done"), 4),
];

const BRANCH_SWITCH_TREE = [
  header("s"),
  msg("a", null, "user", "root", 1),
  msg("b", "a", "assistant", text("abandoned answer"), 2),
  msg("c", "b", "user", "abandoned follow-up", 3),
  msg("d", "a", "assistant", text("regenerated answer"), 4),
];

describe("readSessionMessages index/legacy parity: synthetic tree transcripts", () => {
  it("compaction entries (firstKeptEntryId, tokensBefore/After, no-timestamp fallback)", () => {
    const { read } = expectParity("parity-compaction", jsonl(COMPACTION_TREE), "index");
    const kinds = read.messages.map(
      (m) => (m as { __openclaw?: { kind?: string } }).__openclaw?.kind ?? "message",
    );
    expect(kinds).toEqual([
      "message",
      "message",
      "compaction",
      "message",
      "message",
      "compaction",
      "message",
    ]);
  });

  it("stranded concurrent append: the off-branch prompt is spliced in, keyed", () => {
    const { read } = expectParity("parity-stranded", jsonl(strandedTree(3_000)), "index");
    const stranded = read.messages.filter(
      (m) => (m as { __openclaw?: { stranded?: boolean } }).__openclaw?.stranded,
    );
    expect(stranded).toHaveLength(1);
    expect((stranded[0] as { idempotencyKey?: string }).idempotencyKey).toBe("key-b");
  });

  it("deliberate fork stays hidden (the branch moved on before the off-branch row)", () => {
    const { read } = expectParity("parity-deliberate", jsonl(strandedTree(1_500)), "index");
    expect(read.messages).toHaveLength(2);
  });

  it("prompt-key marker rows: keys stamped forward, orphan reported as superseded", () => {
    const { read } = expectParity("parity-prompt-key", jsonl(PROMPT_KEY_TREE), "index");
    const rows = read.messages as Array<{
      idempotencyKey?: string;
      supersededIdempotencyKeys?: string[];
    }>;
    expect(rows.map((r) => r.idempotencyKey)).toEqual(["key-1", undefined, "key-3"]);
    expect(rows[2]?.supersededIdempotencyKeys).toEqual(["key-2-orphan"]);
  });

  it("runtime-context-only message is dropped before the seq bump", () => {
    const { read } = expectParity("parity-runtime-context", jsonl(RUNTIME_CONTEXT_TREE), "index");
    const seqs = read.messages.map((m) => (m as { __openclaw?: { seq?: number } }).__openclaw?.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("branch switch: the leaf's chain skips the abandoned entries", () => {
    const { read } = expectParity("parity-branch-switch", jsonl(BRANCH_SWITCH_TREE), "index");
    const ids = read.messages.map((m) => (m as { __openclaw?: { id?: string } }).__openclaw?.id);
    expect(ids).toEqual(["a", "d"]);
  });

  it("corrupt and blank lines between entries are skipped by both readers", () => {
    const entries: unknown[] = [...BRANCH_SWITCH_TREE];
    entries.splice(2, 0, "{not json", "", "   ");
    expectParity("parity-corrupt", jsonl(entries), "index");
  });

  it("CRLF line endings", () => {
    expectParity("parity-crlf", jsonl(COMPACTION_TREE).replaceAll("\n", "\r\n"), "index");
  });

  it("a transcript written by pi's own SessionManager", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsm-parity-pi-"));
    tmpDirs.push(root);
    const piFile = path.join(root, "pi.jsonl");
    fs.writeFileSync(piFile, jsonl([header("pi-written")]), "utf-8");
    const sm = SessionManager.open(piFile);
    type AppendArg = Parameters<SessionManager["appendMessage"]>[0];
    sm.appendCustomEntry(
      PROMPT_KEY_CUSTOM_TYPE,
      buildPromptKeyMarker({
        idempotencyKey: "pi-key",
        sessionKey: "main",
        ts: 1,
      }),
    );
    sm.appendMessage({ role: "user", content: text("hi"), timestamp: 2 } as unknown as AppendArg);
    sm.appendMessage({
      role: "assistant",
      content: text("hello"),
      timestamp: 3,
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
    } as unknown as AppendArg);
    sm.appendCompaction("pi summary", sm.getLeafId() ?? "", 10);
    const { read } = expectParity("parity-pi-written", fs.readFileSync(piFile, "utf-8"), "index");
    expect(read.messages).toHaveLength(3);
  });
});

describe("readSessionMessages index/legacy parity: shapes routed to the legacy loader", () => {
  it("version-2 header: legacy (pi migrates it), and the migrated file is then index-served", () => {
    const entries = [
      header("s", 2),
      msg("u1", null, "user", "hello", 1),
      // v2 → v3 renames this role to "custom"; the migration must not silently disappear.
      msg("h1", "u1", "hookMessage", text("hook"), 2),
      msg("a1", "h1", "assistant", text("answer"), 3),
    ];
    const { reference, prod } = expectParity("parity-v2", jsonl(entries), "legacy");
    expect((reference.messages[1] as { role?: string }).role).toBe("custom");
    // pi rewrote the production copy as v3 during that legacy read; the next read is the index's.
    const again = readSessionMessagesWithCursor("parity-v2", prod.storePath, prod.file);
    expect(again.epoch).toEqual(expect.any(String));
    expect(again.messages).toStrictEqual(reference.messages);
  });

  it("a header newer than this pi (version 4) stays with pi", () => {
    expectParity("parity-v4", jsonl([header("s", 4), ...COMPACTION_TREE.slice(1)]), "legacy");
  });

  it("headerless tree transcript stays with pi", () => {
    // pi's open replaces a headerless file with a fresh header and serves nothing — pre-existing
    // legacy behaviour, out of scope here. What matters is that the index never claims the file.
    const { reference } = expectParity(
      "parity-headerless",
      jsonl(BRANCH_SWITCH_TREE.slice(1)),
      "legacy",
    );
    expect(reference.messages).toEqual([]);
  });

  it("an id-less line after the tree entries stays with pi (pi moves its leaf onto it)", () => {
    const entries = [...BRANCH_SWITCH_TREE, { message: { role: "user", content: "flat line" } }];
    const { reference, prod } = expectParity("parity-idless", jsonl(entries), "legacy");
    // CONTROL: the index alone would serve the a→d branch here; pi serves nothing. Routing is
    // what keeps the rows identical.
    expect(reference.messages).toEqual([]);
    expect(
      getTranscriptIndex(prod.file)
        .refresh()
        .entries.map((e) => e.id),
    ).toEqual(["a", "d"]);
  });

  it("a duplicated entry id stays with pi", () => {
    const entries = [...BRANCH_SWITCH_TREE, msg("b", "d", "user", "reused id", 5)];
    expectParity("parity-duplicate-id", jsonl(entries), "legacy");
  });
});

describe("readSessionMessages index/legacy parity after an append (tail-parse)", () => {
  it("plain append: rows match and the epoch is unchanged", () => {
    const { before, after } = expectIncrementalParity("inc-compaction", COMPACTION_TREE, 4);
    expect(after.epoch).toBe(before.epoch);
    expect(after.messages.length).toBeGreaterThan(before.messages.length);
  });

  it("an append that strands a prompt off-branch", () => {
    const { after } = expectIncrementalParity("inc-stranded", strandedTree(3_000), 3);
    expect(after.messages).toHaveLength(3);
  });

  it("marker + user row appended: key stamped", () => {
    const { after } = expectIncrementalParity("inc-prompt-key", PROMPT_KEY_TREE, 4);
    expect((after.messages[2] as { idempotencyKey?: string }).idempotencyKey).toBe("key-3");
  });

  it("an append that switches branch: rows match and the epoch changes", () => {
    const { before, after } = expectIncrementalParity("inc-branch", BRANCH_SWITCH_TREE, 4);
    expect(after.epoch).not.toBe(before.epoch);
  });
});

describe("readSessionMessagesWithCursor", () => {
  it("a result-cache hit returns the same epoch and never consults the index", () => {
    const { prod } = writeCopies("cursor-hit", jsonl(COMPACTION_TREE));
    const first = readSessionMessagesWithCursor("cursor-hit", prod.storePath, prod.file);
    const second = readSessionMessagesWithCursor("cursor-hit", prod.storePath, prod.file);
    expect(second).toStrictEqual(first);
    expect(getTranscriptIndex(prod.file).stats).toEqual({ fullBuilds: 1, tailParses: 0, noops: 0 });
  });

  it("a transcript that vanishes between stat and open reads as empty, not an exception", () => {
    const { prod } = writeCopies("cursor-vanish", jsonl(COMPACTION_TREE));
    const realOpenSync = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((...args: Parameters<typeof fs.openSync>) => {
      fs.rmSync(prod.file);
      return realOpenSync(...args);
    });
    expect(readSessionMessagesWithCursor("cursor-vanish", prod.storePath, prod.file)).toStrictEqual(
      { epoch: null, messages: [] },
    );
  });

  it("__resetTranscriptReadCacheForTest also resets the index registry", () => {
    const { prod } = writeCopies("cursor-reset", jsonl(COMPACTION_TREE));
    readSessionMessagesWithCursor("cursor-reset", prod.storePath, prod.file);
    const index = getTranscriptIndex(prod.file);
    __resetTranscriptReadCacheForTest();
    expect(getTranscriptIndex(prod.file)).not.toBe(index);
  });
});

// FORK 2026-09-24 (fix-cycle-hang) — a parent chain that loops. pi's getBranch() never returns on
// one, synchronously, on this test's own thread, where a vitest timeout cannot interrupt it. So
// nothing here lets it run on a loop: guardGetBranch() replaces it with a throwing spy (a
// regression that reaches it degrades to wrong rows and fails fast instead of hanging CI), and the
// loader that served each read is asserted directly (epoch string = index, null = legacy).
const MUTUAL_LOOP_TREE = [
  header("s"),
  msg("a", null, "user", "first copy of a", 1),
  msg("b", "a", "assistant", text("b answers a"), 2),
  // A second line reusing "a", parented on b: the leaf a walks a → b → a …
  msg("a", "b", "user", "second copy of a", 3),
];

const LONG_LOOP_TREE = [
  header("s"),
  msg("a", null, "user", "root", 1),
  msg("b", "a", "assistant", text("b"), 2),
  msg("c", "b", "user", "c", 3),
  msg("d", "c", "assistant", text("d"), 4),
  // "b" reused, parented on d, closes b → d → c → b; the leaf e hangs off c, outside the loop.
  msg("b", "d", "assistant", text("b again"), 5),
  msg("e", "c", "user", "e", 6),
];

// The loop's own reused id (x) plus a SECOND reused id (k) whose first copy is a prompt-key marker:
// pi's getEntries() keeps the shadowed marker, and its user row is stranded off the loop's branch.
const SHADOWED_MARKER_LOOP_TREE = [
  header("s"),
  msg("x", null, "user", "x first", 1_000),
  msg("y", "x", "assistant", text("y"), 2_000),
  marker("k", "y", "key-k", 3_000),
  msg("uk", "k", "user", text("prompt sent mid-turn"), 3_001),
  msg("k", "uk", "assistant", text("reuses the marker's id"), 3_500),
  msg("x", "y", "user", "x again", 4_000),
];

const rowIds = (messages: readonly unknown[]) =>
  messages.map((m) => (m as { __openclaw?: { id?: string } }).__openclaw?.id);

function guardGetBranch() {
  return vi.spyOn(SessionManager.prototype, "getBranch").mockImplementation(() => {
    throw new Error("pi getBranch() must never run on a looping transcript");
  });
}

describe("readSessionMessages on a transcript whose parent chain loops", () => {
  let warnings: string[];
  beforeEach(() => {
    warnings = [];
    __setTranscriptParentCycleLogForTest((m) => warnings.push(m));
  });

  it("CONTROL: the fidelity gate alone routes a duplicated-id loop to pi", () => {
    for (const [name, entries] of [
      ["mutual", MUTUAL_LOOP_TREE],
      ["long", LONG_LOOP_TREE],
    ] as const) {
      const { prod } = writeCopies(`loop-control-${name}`, jsonl(entries));
      const index = getTranscriptIndex(prod.file);
      index.refresh();
      // The whole pre-fix routing: any gap → the legacy loader → pi's getBranch() on the loop.
      // Asserted on the decision; pi is never run.
      expect(indexFidelityGap(index.fidelity())).toBe("duplicate-ids");
      expect(index.fidelity().parentCycleAt).not.toBeNull();
    }
  });

  it("a loop made by a reused id is served by the index, row-identical to pi's cycle-safe read", () => {
    const getBranch = guardGetBranch();
    const open = vi.spyOn(SessionManager, "open");
    const { read, legacy, prod } = expectParity("loop-mutual", jsonl(MUTUAL_LOOP_TREE), "index");
    expect(rowIds(read.messages)).toEqual(["b", "a"]);
    expect((read.messages[1] as { content?: unknown }).content).toBe("second copy of a");
    // Only the legacy reference read ever reached pi; the production copy never did.
    expect(open.mock.calls.map((call) => call[0])).toEqual([legacy.file]);
    expect(getBranch).not.toHaveBeenCalled();
    const indexWarnings = warnings.filter((w) => w.includes("(index walk)"));
    expect(indexWarnings).toHaveLength(1);
    expect(indexWarnings[0]).toContain("entry a");
    expect(indexWarnings[0]).toContain(path.basename(prod.file));
  });

  it("a longer loop entered from a leaf outside it: the leaf's chain up to the first repeated id", () => {
    const getBranch = guardGetBranch();
    const { read } = expectParity("loop-long", jsonl(LONG_LOOP_TREE), "index");
    expect(rowIds(read.messages)).toEqual(["d", "b", "c", "e"]);
    expect(getBranch).not.toHaveBeenCalled();
    expect(warnings.find((w) => w.includes("(index walk)"))).toContain("entry c");
  });

  it("a shadowed prompt-key marker survives: the index's allEntries keeps every copy, as pi does", () => {
    const getBranch = guardGetBranch();
    const { read } = expectParity(
      "loop-shadowed-marker",
      jsonl(SHADOWED_MARKER_LOOP_TREE),
      "index",
    );
    const stranded = read.messages.filter(
      (m) => (m as { __openclaw?: { stranded?: boolean } }).__openclaw?.stranded,
    );
    expect(stranded).toHaveLength(1);
    expect((stranded[0] as { idempotencyKey?: string }).idempotencyKey).toBe("key-k");
    expect(getBranch).not.toHaveBeenCalled();
  });

  it("a loop only pi can see (its closing line has no newline yet) is walked cycle-safely by the legacy loader", () => {
    const getBranch = guardGetBranch();
    const entries = [
      header("s"),
      msg("a", "b", "user", "a names b", 1),
      msg("b", "a", "assistant", text("b names a"), 2),
    ];
    // The index waits for b's newline, so it sees a → (no b): no loop, but an unterminated tail,
    // a gap that sends the file to pi, whose read includes b and so loops.
    const { read, prod } = expectParity("loop-tail", jsonl(entries, false), "legacy");
    const fidelity = getTranscriptIndex(prod.file).fidelity();
    expect(indexFidelityGap(fidelity)).toBe("unterminated-tail");
    expect(fidelity.parentCycleAt).toBeNull();
    expect(rowIds(read.messages)).toEqual(["a", "b"]);
    expect(getBranch).not.toHaveBeenCalled();
    // One per file: the legacy reference copy and the production copy share a basename.
    const legacyWarnings = warnings.filter((w) => w.includes("(legacy walk)"));
    expect(legacyWarnings).toHaveLength(2);
    for (const w of legacyWarnings) {
      expect(w).toContain("entry b");
    }
  });

  it("warns once per file however often a looping transcript is re-read", () => {
    guardGetBranch();
    const { prod } = writeCopies("loop-once", jsonl(MUTUAL_LOOP_TREE));
    readSessionMessages("loop-once", prod.storePath, prod.file);
    fs.appendFileSync(prod.file, jsonl([msg("c", "a", "assistant", text("appended"), 4)]));
    const after = readSessionMessagesWithCursor("loop-once", prod.storePath, prod.file);
    expect(after.epoch).toEqual(expect.any(String));
    expect(rowIds(after.messages)).toEqual(["b", "a", "c"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(path.dirname(prod.file));
  });

  it("readSessionBranchCycleSafe is pi's getBranch() exactly wherever the chain ends", () => {
    const shapes: Array<[string, readonly unknown[]]> = [
      ["branch-switch", BRANCH_SWITCH_TREE],
      ["compaction", COMPACTION_TREE],
      [
        "id-less-last-line",
        [...BRANCH_SWITCH_TREE, { message: { role: "user", content: "flat" } }],
      ],
      ["dangling-parent", [header("s"), msg("a", "gone", "user", "orphan", 1)]],
    ];
    for (const [name, entries] of shapes) {
      const { legacy } = writeCopies(`walk-${name}`, jsonl(entries));
      const sm = SessionManager.open(legacy.file);
      expect(readSessionBranchCycleSafe(sm)).toStrictEqual({
        branch: sm.getBranch(),
        cycleAt: null,
      });
    }
  });
});
