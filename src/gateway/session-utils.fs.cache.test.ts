import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetTranscriptReadCacheForTest,
  readSessionMessages,
  readSessionMessagesUncached,
} from "./session-utils.fs.js";
import { __setLegacyLoaderFallbackLogForTest, getTranscriptIndex } from "./transcript-index.js";

// FORK 2026-09-23 (M20, chat.history rehaul task 2) — `readSessionMessages` now caches its parsed
// result by the resolved transcript file's (ino, size, mtimeMs), so `chat.history` (polled ~22x/min
// per open tab) stops re-parsing a 10-24 MB transcript on every call when nothing changed. These
// tests prove: (1) a cache hit skips the file read entirely and a real change is still detected,
// (2) the array handed back is a fresh copy so a caller mutating it cannot corrupt the cache.

const header = {
  type: "session",
  version: 3,
  id: "sess-1",
  timestamp: "2026-09-23T10:00:00Z",
  cwd: "/",
};

function msg(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-23T10:00:01Z",
    message: { role, content: [{ type: "text", text }] },
  };
}

// A pre-tree transcript: no entry has a parentId, so it is only ever read by the legacy
// readFileSync path — the one the TranscriptIndex (task 4) never serves.
const flatHeader = { type: "session", version: 1, id: "sess-1" };
function flatMsg(role: string, text: string) {
  return { message: { role, content: [{ type: "text", text }] } };
}

// Since task 4 a tree transcript is loaded by the TranscriptIndex (fs.openSync + readSync), a flat
// one by fs.readFileSync; a "read of p" is either.
function countReadsOf(p: string): () => number {
  const readSpy = vi.spyOn(fs, "readFileSync");
  const openSpy = vi.spyOn(fs, "openSync");
  return () =>
    readSpy.mock.calls.filter((c) => c[0] === p).length +
    openSpy.mock.calls.filter((c) => c[0] === p).length;
}

const tmpDirs: string[] = [];

function writeSession(dir: string, sessionId: string, lines: object[]): string {
  const p = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf-8");
  return p;
}

function setup(lines: object[]): { p: string; storePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsm-cache-"));
  tmpDirs.push(dir);
  const p = writeSession(dir, "sess-1", lines);
  return { p, storePath: path.join(dir, "sessions.json") };
}

describe("readSessionMessages cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetTranscriptReadCacheForTest();
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // CONTROL (commit-rules.md #11): `readSessionMessagesUncached` is `readSessionMessages` without
  // this cache. Running the SAME "unchanged file" assertion against it must fail the way the
  // caching wrapper's version does not: on a flat transcript it re-reads on every call, so a
  // second call on a byte-identical file still adds a read. (A tree transcript's uncached re-read
  // is an index no-op since task 4 — the next control covers that path.)
  it("control: the uncached reader re-reads an unchanged flat transcript on every call", () => {
    __resetTranscriptReadCacheForTest();
    const { p, storePath } = setup([flatHeader, flatMsg("user", "q")]);
    const reads = countReadsOf(p);
    readSessionMessagesUncached("sess-1", storePath);
    const r1 = reads();
    expect(r1).toBeGreaterThan(0);
    readSessionMessagesUncached("sess-1", storePath);
    expect(reads()).toBeGreaterThan(r1);
  });

  it("does not re-read an unchanged flat transcript and re-reads after an append", () => {
    __resetTranscriptReadCacheForTest();
    const { p, storePath } = setup([flatHeader, flatMsg("user", "q"), flatMsg("assistant", "r")]);
    const reads = countReadsOf(p);
    const first = readSessionMessages("sess-1", storePath);
    const r1 = reads();
    expect(r1).toBeGreaterThan(0);
    expect(readSessionMessages("sess-1", storePath)).toEqual(first);
    expect(reads()).toBe(r1);
    fs.appendFileSync(p, `${JSON.stringify(flatMsg("user", "again"))}\n`);
    expect(readSessionMessages("sess-1", storePath).length).toBe(first.length + 1);
    expect(reads()).toBeGreaterThan(r1);
  });

  // CONTROL for the tree path: without this cache, every call on an unchanged tree transcript
  // still refreshes the index (a stat + no-op) and re-projects every row.
  it("control: the uncached reader refreshes the index again for an unchanged tree transcript", () => {
    __resetTranscriptReadCacheForTest();
    const { p, storePath } = setup([header, msg("a1", null, "user", "q")]);
    readSessionMessagesUncached("sess-1", storePath);
    readSessionMessagesUncached("sess-1", storePath);
    expect(getTranscriptIndex(p).stats).toEqual({ fullBuilds: 1, tailParses: 0, noops: 1 });
  });

  it("does not re-read an unchanged tree transcript and re-reads after an append", () => {
    __resetTranscriptReadCacheForTest();
    const { p, storePath } = setup([
      header,
      msg("a1", null, "user", "q"),
      msg("a2", "a1", "assistant", "r"),
    ]);
    const reads = countReadsOf(p);
    const first = readSessionMessages("sess-1", storePath);
    const r1 = reads();
    expect(r1).toBeGreaterThan(0);
    expect(readSessionMessages("sess-1", storePath)).toEqual(first);
    expect(reads()).toBe(r1);
    // The hit never reached the index either.
    expect(getTranscriptIndex(p).stats.noops).toBe(0);
    fs.appendFileSync(p, `${JSON.stringify(msg("a3", "a2", "user", "again"))}\n`);
    expect(readSessionMessages("sess-1", storePath).length).toBe(first.length + 1);
    expect(reads()).toBeGreaterThan(r1);
  });

  it("returns a fresh array so callers cannot mutate the cache", () => {
    __resetTranscriptReadCacheForTest();
    const { storePath } = setup([header, msg("a1", null, "user", "q")]);
    (readSessionMessages("sess-1", storePath) as unknown[]).pop();
    expect(readSessionMessages("sess-1", storePath).length).toBe(1);
  });

  // Controller ruling: cap is 16 (not the brief snippet's 32), LRU by re-insertion. Write 17
  // distinct transcripts, touching each once in order, then re-read the first: with a correct
  // cap+LRU it must have been evicted (a cache miss re-reads the file); a cap that is too loose
  // (e.g. 32) would still hold it and the re-read would never happen. Flat transcripts, so a miss
  // is a readFileSync whatever the TranscriptIndex registry (also LRU 16) happens to hold.
  it("evicts the least-recently-used entry once the cache holds more than 16 files", () => {
    __resetTranscriptReadCacheForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsm-cache-lru-"));
    tmpDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    const sessionIds = Array.from({ length: 17 }, (_, i) => `lru-${i}`);
    const paths: string[] = [];
    for (const sessionId of sessionIds) {
      paths.push(
        writeSession(dir, sessionId, [
          { ...flatHeader, id: sessionId },
          flatMsg("user", sessionId),
        ]),
      );
      readSessionMessages(sessionId, storePath);
    }
    const spy = vi.spyOn(fs, "readFileSync");
    readSessionMessages(sessionIds[0], storePath);
    expect(spy.mock.calls.some((c) => c[0] === paths[0])).toBe(true);
  });

  // Controller ruling: the stat (cache side) and the read (uncached side) must share ONE
  // resolution. Passing the already-resolved path into readSessionMessagesUncached must produce
  // the exact same result the caching wrapper serves for the same inputs.
  it("readSessionMessagesUncached with a pre-resolved path matches the cached read", () => {
    __resetTranscriptReadCacheForTest();
    const { p, storePath } = setup([header, msg("a1", null, "user", "q")]);
    const direct = readSessionMessagesUncached("sess-1", storePath, undefined, p);
    expect(direct).toEqual(readSessionMessages("sess-1", storePath));
  });
});

// FORK 2026-09-24 (final review item 10) — a tree transcript the TranscriptIndex cannot serve
// row-for-row goes to the legacy loader (full re-read + pi SessionManager.open on every miss). That
// fallback was silent; it now logs once per file per process, with the reason and the basename.
describe("legacy-loader fallback log", () => {
  afterEach(() => {
    __resetTranscriptReadCacheForTest();
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  const capture = () => {
    const lines: string[] = [];
    __setLegacyLoaderFallbackLogForTest((m) => lines.push(m));
    return lines;
  };

  it("logs the reason and the file's basename once, however often the file is read", () => {
    const lines = capture();
    const { p, storePath } = setup([
      header,
      msg("a", null, "user", "one"),
      msg("b", "a", "assistant", "two"),
      msg("b", "a", "assistant", "a duplicate id, same parent (no cycle: pi walks parents)"),
    ]);
    readSessionMessages("sess-1", storePath);
    fs.appendFileSync(p, `${JSON.stringify(msg("c", "a", "assistant", "three"))}\n`);
    readSessionMessages("sess-1", storePath); // a cache miss: the legacy loader runs again
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("sess-1.jsonl");
    expect(lines[0]).toContain("duplicate-ids");
    expect(lines[0]).not.toContain(path.dirname(p));
  });

  it("names each fidelity reason", () => {
    const lines = capture();
    const unindexed = setup([header, msg("a", null, "user", "one"), { type: "note" }]);
    readSessionMessages("sess-1", unindexed.storePath);
    const oldHeader = setup([{ ...header, version: 2 }, msg("a", null, "user", "one")]);
    readSessionMessages("sess-1", oldHeader.storePath);
    expect(lines.map((l) => /\(([^)]+)\)/.exec(l)?.[1])).toEqual([
      "unindexed-lines",
      "header version 2",
    ]);
  });

  it("control: a transcript the index serves logs nothing", () => {
    const lines = capture();
    const { storePath } = setup([
      header,
      msg("a", null, "user", "one"),
      msg("b", "a", "assistant", "two"),
    ]);
    expect(readSessionMessages("sess-1", storePath)).toHaveLength(2);
    expect(lines).toEqual([]);
  });
});
