import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetTranscriptIndexRegistryForTest,
  __setTranscriptIndexRegistryLimitsForTest,
  __setTranscriptIndexThrashLogForTest,
  __setTranscriptParentCycleLogForTest,
  __transcriptIndexRegistryKeysForTest,
  getTranscriptIndex,
  noteTranscriptParentCycle,
  resolveTranscriptIndexMaxBytes,
  TRANSCRIPT_INDEX_REGISTRY_MAX_BYTES,
  TRANSCRIPT_INDEX_REGISTRY_MAX_ENTRIES,
  TranscriptIndex,
  walkParentChain,
} from "./transcript-index.js";

const H = { type: "session", version: 3, id: "s", timestamp: "t", cwd: "/" };
const m = (id: string, parentId: string | null) => ({
  type: "message",
  id,
  parentId,
  timestamp: "t",
  message: { role: "user", content: "x" },
});
const line = (o: object) => JSON.stringify(o) + "\n";

const createdDirs: string[] = [];
function tmp(lines: object[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ti-"));
  createdDirs.push(dir);
  const p = path.join(dir, "t.jsonl");
  fs.writeFileSync(p, lines.map(line).join(""));
  return p;
}
const ids = (v: { entries: readonly { id: string }[] }) => v.entries.map((e) => e.id);

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  __resetTranscriptIndexRegistryForTest();
});

describe("TranscriptIndex", () => {
  it("builds the branch root→leaf", () => {
    expect(
      ids(new TranscriptIndex(tmp([H, m("a", null), m("b", "a"), m("c", "b")])).refresh()),
    ).toEqual(["a", "b", "c"]);
  });

  it("no-op when unchanged, tail-parse on append, same epoch", () => {
    const p = tmp([H, m("a", null), m("b", "a")]);
    const ix = new TranscriptIndex(p);
    const v1 = ix.refresh();
    ix.refresh();
    fs.appendFileSync(p, line(m("c", "b")));
    const v2 = ix.refresh();
    expect(ids(v2)).toEqual(["a", "b", "c"]);
    expect(v2.epoch).toBe(v1.epoch);
    expect(ix.stats).toEqual({ fullBuilds: 1, tailParses: 1, noops: 1 });
  });

  it("ignores a torn last line until it completes", () => {
    const p = tmp([H, m("a", null)]);
    const ix = new TranscriptIndex(p);
    ix.refresh();
    const full = line(m("b", "a"));
    fs.appendFileSync(p, full.slice(0, 10));
    expect(ids(ix.refresh())).toEqual(["a"]);
    fs.appendFileSync(p, full.slice(10));
    expect(ids(ix.refresh())).toEqual(["a", "b"]);
  });

  it("rebuilds with a new epoch on tmp+rename rewrite", () => {
    const p = tmp([H, m("a", null), m("b", "a")]);
    const ix = new TranscriptIndex(p);
    const v1 = ix.refresh();
    fs.writeFileSync(p + ".tmp", [H, m("z", null)].map(line).join(""));
    fs.renameSync(p + ".tmp", p);
    const v2 = ix.refresh();
    expect(ids(v2)).toEqual(["z"]);
    expect(v2.epoch).not.toBe(v1.epoch);
  });

  it("rebuilds on same-inode rewrite (R2: probe reads from the start of the line, not the tail)", () => {
    const p = tmp([H, m("a", null), m("b", "a")]);
    const ix = new TranscriptIndex(p);
    const v1 = ix.refresh();
    // Same length as "b"'s line, so a trailing 64-byte tail probe would NOT catch this: the id
    // sits at the START of the line, and everything after it (timestamp/message) is identical.
    fs.writeFileSync(p, [H, m("a", null), m("q", "a"), m("r", "q")].map(line).join(""));
    const v2 = ix.refresh();
    expect(ids(v2)).toEqual(["a", "q", "r"]);
    expect(v2.epoch).not.toBe(v1.epoch);
  });

  it("rebuilds on a same-length, header-only rewrite (R2)", () => {
    const p = tmp([H, m("a", null), m("b", "a")]);
    const ix = new TranscriptIndex(p);
    const v1 = ix.refresh();
    expect(ix.stats.fullBuilds).toBe(1);
    // Same total file size (single digit → single digit); only the header line's bytes change.
    const beforeMtimeMs = fs.statSync(p).mtimeMs;
    const rewrittenHeader = { ...H, version: 7 };
    fs.writeFileSync(p, [rewrittenHeader, m("a", null), m("b", "a")].map(line).join(""));
    // Force mtime to differ deterministically: same size means the stat-equality no-op check
    // (ino/size/mtimeMs) relies entirely on mtime, and a same-millisecond write would otherwise
    // make this test flaky rather than exercising the rewrite probe.
    const bumped = new Date(beforeMtimeMs + 1000);
    fs.utimesSync(p, bumped, bumped);
    const v2 = ix.refresh();
    expect(ids(v2)).toEqual(["a", "b"]);
    expect(v2.epoch).not.toBe(v1.epoch);
    expect(ix.stats.fullBuilds).toBe(2);
    expect(ix.stats.tailParses).toBe(0);
  });

  it("rebuilds after the file is truncated to empty and regrown (R2)", () => {
    const p = tmp([H, m("a", null), m("b", "a")]);
    const ix = new TranscriptIndex(p);
    const v1 = ix.refresh();
    expect(ix.stats.fullBuilds).toBe(1);

    fs.writeFileSync(p, "");
    const v2 = ix.refresh();
    expect(ids(v2)).toEqual([]);
    expect(v2.epoch).not.toBe(v1.epoch);
    expect(ix.stats.fullBuilds).toBe(2);

    fs.writeFileSync(p, [H, m("z", null)].map(line).join(""));
    const v3 = ix.refresh();
    expect(ids(v3)).toEqual(["z"]);
    expect(v3.epoch).not.toBe(v2.epoch);
    expect(ix.stats.fullBuilds).toBe(3);
  });

  it("new epoch on branch switch without rewrite", () => {
    const p = tmp([H, m("a", null), m("b", "a"), m("c", "b")]);
    const ix = new TranscriptIndex(p);
    const v1 = ix.refresh();
    fs.appendFileSync(p, line(m("d", "a")));
    const v2 = ix.refresh();
    expect(ids(v2)).toEqual(["a", "d"]);
    expect(v2.epoch).not.toBe(v1.epoch);
    expect(ix.allEntries().map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("exposes hasParentKey for the legacy tree-transcript probe (R4)", () => {
    const withKey = m("a", null); // parentId key present, value null
    const withoutKey = {
      type: "message",
      id: "b",
      timestamp: "t",
      message: { role: "user", content: "x" },
    }; // no parentId key at all — legacy flat transcript shape
    const p = tmp([H, withKey, withoutKey]);
    const ix = new TranscriptIndex(p);
    ix.refresh();
    const all = ix.allEntries();
    const a = all.find((e) => e.id === "a");
    const b = all.find((e) => e.id === "b");
    expect(a?.hasParentKey).toBe(true);
    expect(a?.parentId).toBeNull();
    expect(b?.hasParentKey).toBe(false);
    expect(b?.parentId).toBeNull();
  });

  it("holds the parsed object once, not a second copy of the line text", () => {
    const ix = new TranscriptIndex(tmp([H, m("a", null)]));
    ix.refresh();
    expect(Object.keys(ix.allEntries()[0]).toSorted()).toEqual([
      "hasParentKey",
      "id",
      "parentId",
      "raw",
      "type",
    ]);
  });

  it("throws ENOENT when the file disappears between stat and open", () => {
    const p = tmp([H, m("a", null)]);
    const ix = new TranscriptIndex(p);
    ix.refresh();
    fs.appendFileSync(p, line(m("b", "a")));
    const realOpenSync = fs.openSync;
    const spy = vi
      .spyOn(fs, "openSync")
      .mockImplementationOnce((...args: Parameters<typeof fs.openSync>) => {
        fs.rmSync(p);
        return realOpenSync(...args);
      });
    try {
      expect(() => ix.refresh()).toThrow(/ENOENT/);
    } finally {
      spy.mockRestore();
    }
  });
});

// Task 4 serves chat.history from this index only where it would read the same entries pi's
// SessionManager.open reads; fidelity() is how the reader knows. Each case is a shape pi reads
// differently from the index.
describe("TranscriptIndex fidelity", () => {
  it("is clean for a well-formed transcript and exposes the byte-0 header", () => {
    const ix = new TranscriptIndex(tmp([H, m("a", null), m("b", "a")]));
    ix.refresh();
    expect(ix.fidelity()).toEqual({
      header: H,
      unindexedLines: 0,
      duplicateIds: 0,
      unterminatedTail: false,
      parentCycleAt: null,
    });
  });

  it("header is undefined when byte 0 starts a blank or non-JSON line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ti-"));
    createdDirs.push(dir);
    const blank = path.join(dir, "blank.jsonl");
    fs.writeFileSync(blank, "\n" + [H, m("a", null)].map(line).join(""));
    const corrupt = path.join(dir, "corrupt.jsonl");
    fs.writeFileSync(corrupt, "{not json\n" + [H, m("a", null)].map(line).join(""));
    for (const p of [blank, corrupt]) {
      const ix = new TranscriptIndex(p);
      ix.refresh();
      expect(ix.fidelity().header).toBeUndefined();
    }
  });

  it("counts JSON lines that became no entry, but not corrupt or blank lines", () => {
    const p = tmp([H, m("a", null)]);
    fs.appendFileSync(p, "null\n5\n[1]\n{not json\n\n");
    fs.appendFileSync(p, line({ type: "message", message: { role: "user", content: "flat" } }));
    fs.appendFileSync(p, line({ type: "message", id: 7, parentId: "a" }));
    fs.appendFileSync(p, line({ type: "session", version: 3, id: "second-header" }));
    const ix = new TranscriptIndex(p);
    ix.refresh();
    expect(ix.fidelity().unindexedLines).toBe(5);
    expect(ix.fidelity().duplicateIds).toBe(0);
  });

  it("counts duplicate ids", () => {
    const ix = new TranscriptIndex(tmp([H, m("a", null), m("b", "a"), m("a", "b")]));
    ix.refresh();
    expect(ix.fidelity().duplicateIds).toBe(1);
  });

  it("flags a complete but unterminated last line until its newline lands", () => {
    const p = tmp([H, m("a", null)]);
    const ix = new TranscriptIndex(p);
    const full = line(m("b", "a"));
    fs.appendFileSync(p, full.slice(0, 10)); // torn: not JSON yet
    ix.refresh();
    expect(ix.fidelity().unterminatedTail).toBe(false);
    fs.appendFileSync(p, full.slice(10, -1)); // complete JSON, newline still missing
    expect(ids(ix.refresh())).toEqual(["a"]);
    expect(ix.fidelity().unterminatedTail).toBe(true);
    fs.appendFileSync(p, "\n");
    expect(ids(ix.refresh())).toEqual(["a", "b"]);
    expect(ix.fidelity().unterminatedTail).toBe(false);
  });

  it("accumulates across tail-parses and resets on a full rebuild", () => {
    const p = tmp([H, m("a", null)]);
    const ix = new TranscriptIndex(p);
    ix.refresh();
    fs.appendFileSync(p, line({ message: { role: "user", content: "flat" } }) + line(m("a", null)));
    ix.refresh();
    expect(ix.stats.tailParses).toBe(1);
    expect(ix.fidelity()).toMatchObject({ unindexedLines: 1, duplicateIds: 1 });
    fs.writeFileSync(p + ".tmp", [{ ...H, version: 2 }, m("z", null)].map(line).join(""));
    fs.renameSync(p + ".tmp", p);
    ix.refresh();
    expect(ix.stats.fullBuilds).toBe(2);
    expect(ix.fidelity()).toEqual({
      header: { ...H, version: 2 },
      unindexedLines: 0,
      duplicateIds: 0,
      unterminatedTail: false,
      parentCycleAt: null,
    });
  });
});

// FORK 2026-09-24 (fix-cycle-hang): pi's getBranch() never returns on a parent chain that loops,
// so the reader must know when the leaf's chain does, and what the index's own walk served.
describe("TranscriptIndex parent-chain loops", () => {
  it("a duplicated id pointing back down its own chain: stops at the first repeated id", () => {
    // a's second copy (last wins) is parented on b: the leaf a walks a → b → a …
    const ix = new TranscriptIndex(tmp([H, m("a", null), m("b", "a"), m("a", "b")]));
    expect(ids(ix.refresh())).toEqual(["b", "a"]);
    expect(ix.fidelity()).toMatchObject({ duplicateIds: 1, parentCycleAt: "a" });
  });

  it("two entries naming each other, no duplicated id", () => {
    const ix = new TranscriptIndex(tmp([H, m("a", "b"), m("b", "a")]));
    expect(ids(ix.refresh())).toEqual(["a", "b"]);
    expect(ix.fidelity()).toMatchObject({ duplicateIds: 0, parentCycleAt: "b" });
  });

  it("a longer loop entered from a leaf outside it", () => {
    // b's second copy closes b → d → c → b; the leaf e hangs off c.
    const ix = new TranscriptIndex(
      tmp([H, m("a", null), m("b", "a"), m("c", "b"), m("d", "c"), m("b", "d"), m("e", "c")]),
    );
    expect(ids(ix.refresh())).toEqual(["d", "b", "c", "e"]);
    expect(ix.fidelity().parentCycleAt).toBe("c");
  });

  it("is re-derived on a tail-parse: a leaf that walks away from the loop clears it", () => {
    const p = tmp([H, m("a", "b"), m("b", "a")]);
    const ix = new TranscriptIndex(p);
    ix.refresh();
    expect(ix.fidelity().parentCycleAt).toBe("b");
    fs.appendFileSync(p, line(m("z", null)));
    expect(ids(ix.refresh())).toEqual(["z"]);
    expect(ix.stats.tailParses).toBe(1);
    // CONTROL: the loop is still in the file. Only the leaf's chain is checked (the one chain
    // pi's getBranch() walks) and it no longer enters the loop.
    expect(ix.allEntries().map((e) => e.id)).toEqual(["a", "b", "z"]);
    expect(ix.fidelity().parentCycleAt).toBeNull();
  });

  it("a dangling parent ends the chain; it is not a loop", () => {
    const ix = new TranscriptIndex(tmp([H, m("a", "missing"), m("b", "a")]));
    expect(ids(ix.refresh())).toEqual(["a", "b"]);
    expect(ix.fidelity().parentCycleAt).toBeNull();
  });

  it("allEntries keeps every copy of a duplicated id, in file order (pi's getEntries())", () => {
    const ix = new TranscriptIndex(tmp([H, m("a", null), m("b", "a"), m("a", "b")]));
    ix.refresh();
    expect(ix.allEntries().map((e) => [e.id, e.parentId])).toEqual([
      ["a", null],
      ["b", "a"],
      ["a", "b"],
    ]);
  });

  it("walkParentChain keys on the id looked up, so a get that copies entries still terminates", () => {
    const graph = new Map([
      ["x", { parentId: "y" }],
      ["y", { parentId: "x" }],
    ]);
    // A fresh object per lookup: a visited set keyed on object identity would never see a repeat.
    const walked = walkParentChain("y", (id) => {
      const entry = graph.get(id);
      return entry ? { ...entry, id } : undefined;
    });
    expect(walked.branch.map((e) => e.id)).toEqual(["x", "y"]);
    expect(walked.cycleAt).toBe("y");
  });

  it("noteTranscriptParentCycle warns once per file, naming the basename, the id and the walk", () => {
    const warnings: string[] = [];
    __setTranscriptParentCycleLogForTest((msg) => warnings.push(msg));
    const p = path.join(os.tmpdir(), "ti-cycle-dir", "looping.jsonl");
    noteTranscriptParentCycle(p, "a", "index");
    noteTranscriptParentCycle(p, "b", "legacy");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("looping.jsonl");
    expect(warnings[0]).toContain("entry a");
    expect(warnings[0]).toContain("(index walk)");
    expect(warnings[0]).not.toContain(path.dirname(p));
    __resetTranscriptIndexRegistryForTest(); // also forgets which files were logged
    __setTranscriptParentCycleLogForTest((msg) => warnings.push(msg));
    noteTranscriptParentCycle(p, "a", "legacy");
    expect(warnings).toHaveLength(2);
  });
});

// Ruling R19: epochs are cursor identities (task 5) and must never repeat. Epoch format:
// `${nonce}:${ino}:${generation}:${branchRootId}`.
describe("epoch uniqueness (R19)", () => {
  const parts = (epoch: string) => {
    const [nonce, ino, generation, root] = epoch.split(":");
    return { nonce, ino, generation, root };
  };

  it("two indexes on the same path never mint the same epoch, even for identical bytes", () => {
    const p = tmp([H, m("a", null), m("b", "a")]);
    const e1 = new TranscriptIndex(p).refresh().epoch;
    const e2 = new TranscriptIndex(p).refresh().epoch;
    const e3 = getTranscriptIndex(p).refresh().epoch;
    __resetTranscriptIndexRegistryForTest();
    const e4 = getTranscriptIndex(p).refresh().epoch;
    expect(new Set([e1, e2, e3, e4]).size).toBe(4);
  });

  it("an evicted-then-recreated index after an in-place rewrite repeats no earlier epoch", () => {
    const p = tmp([H, m("a", null), m("b", "a")]);
    const first = getTranscriptIndex(p);
    const e1 = first.refresh().epoch;
    // Same inode, same root entry "a", different history after it.
    fs.writeFileSync(p, [H, m("a", null), m("q", "a"), m("r", "q")].map(line).join(""));
    const e2 = first.refresh().epoch;
    __resetTranscriptIndexRegistryForTest(); // eviction
    const recreated = getTranscriptIndex(p);
    expect(recreated).not.toBe(first);
    const e3 = recreated.refresh().epoch;
    expect([e1, e2]).not.toContain(e3);
    // CONTROL: e1 and e3 share ino and root and each is its instance's FIRST epoch — exactly the
    // pair a per-instance counter (`${ino}:1:${root}` for both) could not tell apart. Only the
    // shared generation separates them.
    expect(parts(e3).ino).toBe(parts(e1).ino);
    expect(parts(e3).root).toBe(parts(e1).root);
    expect(parts(e3).generation).not.toBe(parts(e1).generation);
  });

  it("a fresh module (a restarted process) mints different epochs for the same file", async () => {
    const p = tmp([H, m("a", null)]);
    vi.resetModules();
    const before = await import("./transcript-index.js");
    const e1 = new before.TranscriptIndex(p).refresh().epoch;
    vi.resetModules();
    const after = await import("./transcript-index.js");
    const e2 = new after.TranscriptIndex(p).refresh().epoch;
    expect(e2).not.toBe(e1);
    // CONTROL: both are generation 1 of a freshly loaded module, same ino and root, so without the
    // per-process nonce they would be identical strings.
    expect({ ...parts(e2), nonce: "" }).toEqual({ ...parts(e1), nonce: "" });
    expect(parts(e2).nonce).not.toBe(parts(e1).nonce);
    expect(parts(e1).nonce).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("getTranscriptIndex registry (R16: LRU cap 16)", () => {
  it("returns the same instance for the same path and evicts the LRU past 16 entries", () => {
    const paths = Array.from({ length: 17 }, (_, i) => tmp([H, m(`e${i}`, null)]));
    const first = getTranscriptIndex(paths[0]);
    expect(getTranscriptIndex(paths[0])).toBe(first);
    for (let i = 1; i < 17; i++) getTranscriptIndex(paths[i]);
    expect(getTranscriptIndex(paths[0])).not.toBe(first);
  });

  it("clears via __resetTranscriptIndexRegistryForTest", () => {
    const p = tmp([H, m("a", null)]);
    const first = getTranscriptIndex(p);
    __resetTranscriptIndexRegistryForTest();
    expect(getTranscriptIndex(p)).not.toBe(first);
  });
});

// Ruling R20: the registry also bounds the summed byte size of the indexed files. Tiny files with
// injected limits stand in for the real cap (512 MiB since R31).
describe("getTranscriptIndex registry byte bound (R20)", () => {
  const keys = () => __transcriptIndexRegistryKeysForTest();
  /** Same-length ids, so every file has the same byte size. */
  const files = (count: number) =>
    Array.from({ length: count }, (_, i) => tmp([H, m(`x${i}`, null)]));

  it("exports the ruled limits (R31: 512 MiB)", () => {
    expect(TRANSCRIPT_INDEX_REGISTRY_MAX_ENTRIES).toBe(16);
    expect(TRANSCRIPT_INDEX_REGISTRY_MAX_BYTES).toBe(512 * 1024 * 1024);
  });

  it("indexedBytes is the file size as of the last refresh", () => {
    const p = tmp([H, m("a", null)]);
    const ix = new TranscriptIndex(p);
    expect(ix.indexedBytes).toBe(0);
    ix.refresh();
    expect(ix.indexedBytes).toBe(fs.statSync(p).size);
    fs.appendFileSync(p, line(m("b", "a")));
    expect(ix.indexedBytes).toBeLessThan(fs.statSync(p).size);
    ix.refresh();
    expect(ix.indexedBytes).toBe(fs.statSync(p).size);
  });

  it("evicts LRU indexes while the summed size exceeds the byte cap, far below the count cap", () => {
    const [pa, pb, pc] = files(3);
    const n = fs.statSync(pa).size;
    __setTranscriptIndexRegistryLimitsForTest({ maxBytes: Math.floor(2.5 * n) });
    getTranscriptIndex(pa).refresh();
    getTranscriptIndex(pb).refresh();
    getTranscriptIndex(pc).refresh(); // counted from the next call: 2n held at this one
    expect(keys()).toEqual([pa, pb, pc]);
    getTranscriptIndex(pa); // 3n > 2.5n: the LRU (pb) goes, 2n remains
    expect(keys()).toEqual([pc, pa]);
  });

  it("control: with only the count cap, the same sequence keeps all three", () => {
    const [pa, pb, pc] = files(3);
    __setTranscriptIndexRegistryLimitsForTest({ maxBytes: Number.POSITIVE_INFINITY });
    getTranscriptIndex(pa).refresh();
    getTranscriptIndex(pb).refresh();
    getTranscriptIndex(pc).refresh();
    getTranscriptIndex(pa);
    expect(keys()).toEqual([pb, pc, pa]);
  });

  it("never evicts the index being returned, even when it alone exceeds the byte cap", () => {
    const [pa, pb] = files(2);
    __setTranscriptIndexRegistryLimitsForTest({ maxBytes: 1 });
    const a = getTranscriptIndex(pa);
    a.refresh();
    expect(getTranscriptIndex(pa)).toBe(a);
    expect(keys()).toEqual([pa]);
    const b = getTranscriptIndex(pb); // a alone is over the cap and is not the one returned
    expect(keys()).toEqual([pb]);
    b.refresh();
    expect(getTranscriptIndex(pb)).toBe(b);
    expect(keys()).toEqual([pb]);
  });

  it("the count cap still evicts LRU on its own", () => {
    const [pa, pb, pc] = files(3);
    __setTranscriptIndexRegistryLimitsForTest({ maxEntries: 2 });
    getTranscriptIndex(pa);
    getTranscriptIndex(pb);
    getTranscriptIndex(pc);
    expect(keys()).toEqual([pb, pc]);
  });

  it("__resetTranscriptIndexRegistryForTest restores the default limits", () => {
    const [pa, pb] = files(2);
    __setTranscriptIndexRegistryLimitsForTest({ maxBytes: 1, maxEntries: 1 });
    __resetTranscriptIndexRegistryForTest();
    getTranscriptIndex(pa).refresh();
    getTranscriptIndex(pb).refresh();
    getTranscriptIndex(pa);
    expect(keys()).toEqual([pb, pa]);
  });
});

// Ruling R31: the byte cap is overridable by env, and evicting an index that was read within the
// last minute (the working set does not fit) is logged, at most once a minute.
describe("getTranscriptIndex registry byte cap override and thrash warning (R31)", () => {
  const keys = () => __transcriptIndexRegistryKeysForTest();
  const ENV = "OPENCLAW_TRANSCRIPT_INDEX_MAX_BYTES";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    __resetTranscriptIndexRegistryForTest();
  });

  it("resolves the env override in bytes; unset, invalid or non-positive values → the default", () => {
    expect(resolveTranscriptIndexMaxBytes({ [ENV]: "1048576" })).toBe(1048576);
    expect(resolveTranscriptIndexMaxBytes({ [ENV]: " 2048.9 " })).toBe(2048);
    for (const bad of [undefined, "", "abc", "0", "-5", "Infinity"]) {
      expect(resolveTranscriptIndexMaxBytes({ [ENV]: bad })).toBe(
        TRANSCRIPT_INDEX_REGISTRY_MAX_BYTES,
      );
    }
  });

  it("the registry honours the env cap", () => {
    const [pa, pb, pc] = Array.from({ length: 3 }, (_, i) => tmp([H, m(`y${i}`, null)]));
    const n = fs.statSync(pa).size;
    vi.stubEnv(ENV, String(Math.floor(2.5 * n)));
    __resetTranscriptIndexRegistryForTest(); // re-reads the env
    getTranscriptIndex(pa).refresh();
    getTranscriptIndex(pb).refresh();
    getTranscriptIndex(pc).refresh();
    getTranscriptIndex(pa); // 3n > 2.5n: the LRU (pb) goes
    expect(keys()).toEqual([pc, pa]);
  });

  it("warns once a minute when it evicts an index read within the last 60 s, naming the basename only", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const warnings: string[] = [];
    __setTranscriptIndexThrashLogForTest((msg) => warnings.push(msg));
    __setTranscriptIndexRegistryLimitsForTest({ maxBytes: 1 });
    const [pa, pb, pc, pd] = Array.from({ length: 4 }, (_, i) => tmp([H, m(`z${i}`, null)]));

    getTranscriptIndex(pa).refresh();
    vi.setSystemTime(1_010_000);
    getTranscriptIndex(pb).refresh(); // evicts pa, read 10 s ago
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("evicted t.jsonl 10s after its last read");
    expect(warnings[0]).not.toContain(path.dirname(pa));

    vi.setSystemTime(1_020_000);
    getTranscriptIndex(pc).refresh(); // evicts pb (10 s) — inside the minute: suppressed
    expect(warnings).toHaveLength(1);

    vi.setSystemTime(1_071_000);
    getTranscriptIndex(pd).refresh(); // evicts pc (51 s) — a minute after the first warning
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("2 such eviction(s)");
  });

  it("control: evicting an index idle for 60 s or more is not a thrash signal", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    const warnings: string[] = [];
    __setTranscriptIndexThrashLogForTest((msg) => warnings.push(msg));
    __setTranscriptIndexRegistryLimitsForTest({ maxBytes: 1 });
    const [pa, pb] = Array.from({ length: 2 }, (_, i) => tmp([H, m(`w${i}`, null)]));
    getTranscriptIndex(pa).refresh();
    vi.setSystemTime(2_060_000);
    getTranscriptIndex(pb).refresh(); // evicts pa, idle exactly 60 s
    expect(keys()).toEqual([pb]);
    expect(warnings).toEqual([]);
  });
});
