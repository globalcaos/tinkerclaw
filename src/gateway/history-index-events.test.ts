import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetChatHistoryRollupForTest,
  buildChatHistoryCursor,
  flushChatHistoryRollup,
  planChatHistoryWindow,
} from "./chat-history-cursor.js";
import {
  __resetTranscriptIndexRegistryForTest,
  __setLegacyLoaderFallbackLogForTest,
  __setTranscriptIndexRegistryLimitsForTest,
  __setTranscriptIndexThrashLogForTest,
  flushTranscriptIndexRollup,
  getTranscriptIndex,
  noteLegacyLoaderFallback,
} from "./transcript-index.js";

/**
 * logging.md §9 step 8 — the `history.*` and `transcript.*` rows.
 *
 * CONTROL: none of these events exists today, so an assertion made against a real events database
 * would pass while nothing at all was emitted. The writer is replaced with a recorder, and every
 * assertion is pinned to the CATALOG's meanings for the slot it reads (src/infra/events/catalog.ts)
 * rather than to whatever the code happens to put there.
 */
const { emitted } = vi.hoisted(() => ({
  emitted: [] as Array<{ name: string; record: Record<string, unknown> }>,
}));
vi.mock("../infra/events/emit.js", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    emitted.push({ name, record });
  },
}));

const rowsNamed = (name: string) => emitted.filter((row) => row.name === name);
const labelsOf = (name: string) => rowsNamed(name).map((row) => row.record.label);

const EPOCH = "epoch-a";

function seqRow(seq: number): unknown {
  return { role: "user", content: `p${seq}`, timestamp: 1_000 + seq, __openclaw: { seq } };
}

function plan(
  request: { afterSeq?: number; beforeSeq?: number; epoch?: string },
  opts: { local?: unknown[]; serverEpoch?: string | null; limit?: number } = {},
) {
  return planChatHistoryWindow({
    local: opts.local ?? [seqRow(1), seqRow(2), seqRow(3)],
    serverEpoch: opts.serverEpoch === undefined ? EPOCH : opts.serverEpoch,
    request,
    limit: opts.limit ?? 200,
  });
}

describe("history.minute (logging.md §4.4)", () => {
  beforeEach(() => {
    // Pinned mid-minute so no test straddles a boundary by accident; the tests that cross one move
    // the clock themselves.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T09:00:30.000Z"));
    __resetChatHistoryRollupForTest();
    emitted.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names every reset with its own reason, which one boolean could not", () => {
    // The defect this enum removes: seven distinct causes collapsed into `reset: true`, so "why did
    // this tab refetch everything" had no answer at all.
    plan({}); // tail
    plan({ afterSeq: 1, epoch: EPOCH }); // delta
    plan({ beforeSeq: 3, epoch: EPOCH }); // before
    plan({ afterSeq: 1, epoch: EPOCH }, { serverEpoch: null }); // reset.epoch_null
    plan({ afterSeq: 1, epoch: "stale" }); // reset.epoch_mismatch
    plan({ afterSeq: 99, epoch: EPOCH }); // reset.anchor_missing
    plan({ beforeSeq: 99, epoch: EPOCH }); // reset.past_end
    plan({ afterSeq: 1, epoch: EPOCH }, { limit: 1 }); // reset.over_window
    plan({ beforeSeq: 2, epoch: EPOCH }, { local: [seqRow(1), seqRow(3)] }); // before_anchor_missing

    flushChatHistoryRollup();
    expect(new Set(labelsOf("history.minute"))).toEqual(
      new Set([
        "tail",
        "delta",
        "before",
        "reset.epoch_null",
        "reset.epoch_mismatch",
        "reset.anchor_missing",
        "reset.past_end",
        "reset.over_window",
        "reset.before_anchor_missing",
      ]),
    );
  });

  it("serves the SAME plan it served before the reasons existed", () => {
    // The reasons ride the rollup's label only: every reset is still the one legacy RESET plan,
    // so neither the handler nor the wire cursor can tell the rollup was added.
    for (const request of [
      { afterSeq: 1, epoch: "stale" },
      { afterSeq: 99, epoch: EPOCH },
      { beforeSeq: 99, epoch: EPOCH },
    ]) {
      expect(plan(request)).toEqual({ kind: "tail", reset: true });
    }
    expect(plan({ afterSeq: 1, epoch: EPOCH }, { serverEpoch: null })).toEqual({
      kind: "tail",
      reset: true,
    });
  });

  it("rolls N polls into one row per outcome and counts the rows it served", () => {
    vi.setSystemTime(new Date("2026-09-25T10:00:05.000Z"));
    __resetChatHistoryRollupForTest();
    emitted.length = 0;

    for (let i = 0; i < 5; i++) {
      plan({});
    }
    expect(rowsNamed("history.minute")).toHaveLength(0);

    vi.setSystemTime(new Date("2026-09-25T10:01:02.000Z"));
    plan({}); // a poll in the next minute closes the window

    const rows = rowsNamed("history.minute");
    expect(rows).toHaveLength(1);
    expect(rows[0].record.label).toBe("tail");
    expect(rows[0].record.n1).toBe(5);
    // A rollup row is stamped at the START of its window, and the minute grid is what makes that
    // stamp true: a lazily-opened window would let one poll at T0 and one at T0+10 min share a row
    // stamped T0, and the reader would compute a tenfold poll rate.
    expect(rows[0].record.tsMs).toBe(Date.parse("2026-09-25T10:00:00.000Z"));
  });

  it("MOVES a byte-capped delta into reset.byte_cap instead of counting it twice", () => {
    const local = [seqRow(1), seqRow(2), seqRow(3)];
    const windowPlan = plan({ afterSeq: 1, epoch: EPOCH }, { local });
    expect(windowPlan.kind).toBe("after");

    // The caps dropped the oldest row of the delta, so it no longer joins up with afterSeq (R10) —
    // the one outcome the plan itself cannot know.
    const cursor = buildChatHistoryCursor({
      plan: windowPlan,
      epoch: EPOCH,
      local,
      window: [local[1], local[2]],
      served: [local[2]],
    });
    expect(cursor.reset).toBe(true);

    flushChatHistoryRollup();
    const rows = rowsNamed("history.minute");
    expect(rows).toHaveLength(1);
    expect(rows[0].record.label).toBe("reset.byte_cap");
    expect(rows[0].record.n1).toBe(1); // the ONE call, not one here and one under `delta`
    expect(rows[0].record.n2).toBe(1); // rows_served
  });
});

describe("transcript.* (logging.md §4.4)", () => {
  const HEADER = JSON.stringify({ type: "session", id: "s1", version: 3 });
  const entry = (id: string, parentId: string | null) =>
    JSON.stringify({ type: "message", id, parentId });

  let dir: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T09:00:30.000Z"));
    __resetTranscriptIndexRegistryForTest();
    __setTranscriptIndexThrashLogForTest(() => {});
    __setLegacyLoaderFallbackLogForTest(() => {});
    dir = mkdtempSync(join(tmpdir(), "transcript-index-events-"));
    emitted.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetTranscriptIndexRegistryForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it("labels a full build by its cause and leaves a tail parse unreported", () => {
    const file = join(dir, "sess.jsonl");
    writeFileSync(file, `${HEADER}\n${entry("a", null)}\n`);
    const ix = getTranscriptIndex(file);

    ix.refresh();
    expect(labelsOf("transcript.index.build")).toEqual(["first"]);
    expect(rowsNamed("transcript.index.build")[0].record.n2).toBe(1); // entries

    appendFileSync(file, `${entry("b", "a")}\n`);
    ix.refresh();
    expect(labelsOf("transcript.index.build")).toEqual(["first"]); // a tail parse is not a build

    // Same inode, new bytes at offset 0: an in-place rewrite.
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", id: "s2-rewritten", version: 3 })}\n${entry("c", null)}\n`,
    );
    ix.refresh();
    expect(labelsOf("transcript.index.build")).toEqual(["first", "rewrite"]);

    // A different file renamed over it: a new inode, which is a different failure with a different
    // fix, and must not read as a rewrite.
    const other = join(dir, "other.jsonl");
    writeFileSync(other, `${HEADER}\n${entry("z", null)}\n`);
    renameSync(other, file);
    ix.refresh();
    expect(labelsOf("transcript.index.build")).toEqual(["first", "rewrite", "inode"]);
  });

  it("reports DELTAS that survive an eviction taking its index's counters with it", () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, `${HEADER}\n${entry("a", null)}\n`);
    writeFileSync(b, `${HEADER}\n${entry("b", null)}\n`);

    getTranscriptIndex(a).refresh(); // full build 1
    getTranscriptIndex(a).refresh(); // noop 1
    emitted.length = 0;
    flushTranscriptIndexRollup();

    let row = rowsNamed("transcript.index.minute")[0].record as Record<string, unknown>;
    expect(row.n1).toBe(1); // noops
    expect(row.n2).toBe(0); // tail parses
    expect(row.n3).toBe(1); // full builds
    expect(row.n4).toBe(0); // evictions
    expect((row.fields as Record<string, unknown>).registry_entries).toBe(1);

    // Nothing happened since: a delta, not a running total.
    emitted.length = 0;
    flushTranscriptIndexRollup();
    row = rowsNamed("transcript.index.minute")[0].record as Record<string, unknown>;
    expect(row.n3).toBe(0);

    // Now evict the index that did that build. Its counters die with the instance, so a naive
    // cumulative-minus-reported delta would go NEGATIVE here.
    __setTranscriptIndexRegistryLimitsForTest({ maxEntries: 1 });
    getTranscriptIndex(b).refresh(); // full build 2, and evicts a
    emitted.length = 0;
    flushTranscriptIndexRollup();
    row = rowsNamed("transcript.index.minute")[0].record as Record<string, unknown>;
    expect(row.n1).toBe(0); // a's one noop was already reported; folding it in must not re-report it
    expect(row.n3).toBe(1); // the new build, not -1
    expect(row.n4).toBe(1); // one eviction
  });

  it("closes the minute on the first registry call of the next minute", () => {
    const a = join(dir, "a.jsonl");
    writeFileSync(a, `${HEADER}\n${entry("a", null)}\n`);
    getTranscriptIndex(a).refresh();
    expect(rowsNamed("transcript.index.minute")).toHaveLength(0);

    vi.setSystemTime(new Date("2026-09-25T09:01:05.000Z"));
    getTranscriptIndex(a);
    const rows = rowsNamed("transcript.index.minute");
    expect(rows).toHaveLength(1);
    expect(rows[0].record.tsMs).toBe(Date.parse("2026-09-25T09:00:00.000Z"));
    expect(rows[0].record.n3).toBe(1);
  });

  it("marks a thrash eviction with the cap it did not fit", () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, `${HEADER}\n${entry("a", null)}\n`);
    writeFileSync(b, `${HEADER}\n${entry("b", null)}\n`);
    __setTranscriptIndexRegistryLimitsForTest({ maxEntries: 1, maxBytes: 1 });

    getTranscriptIndex(a).refresh(); // read just now, so evicting it IS thrashing
    emitted.length = 0;
    getTranscriptIndex(b);

    const rows = rowsNamed("transcript.index.thrash");
    expect(rows).toHaveLength(1);
    expect(rows[0].record.n2).toBe(1); // cap_bytes, the cap the working set did not fit
    expect(rows[0].record.n3).toBe(1); // registry_entries after the eviction
  });

  it("folds a legacy-loader reason into a label the writer will keep, once per file", () => {
    // "no session header" contains SPACES: the writer's label rule would null it, and the row would
    // land looking valid while saying nothing.
    noteLegacyLoaderFallback(join(dir, "x.jsonl"), "no session header");
    noteLegacyLoaderFallback(join(dir, "x.jsonl"), "no session header");
    noteLegacyLoaderFallback(join(dir, "y.jsonl"), "header version 3");
    noteLegacyLoaderFallback(join(dir, "z.jsonl"), "unindexed-lines");

    expect(labelsOf("transcript.legacy_fallback")).toEqual([
      "no_session_header",
      "header_version_3",
      "unindexed-lines",
    ]);
    for (const label of labelsOf("transcript.legacy_fallback")) {
      expect(String(label)).toMatch(/^[\x21-\x7e]{1,128}$/);
    }
  });
});
