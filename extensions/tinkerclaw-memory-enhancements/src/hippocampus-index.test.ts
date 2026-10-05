/**
 * J14 `j.mnemo.lookup` — TINKER_UI_DESIGN_BIBLE/logging.md §4.12 (§9 step 9): a 60 s ROLLUP of
 * concept lookups, stamped at the window's start.
 *
 * CONTROL: before this change lookup() writes nothing, so every expectation that a row exists
 * fails on zero emitEvent calls.
 *
 * `emitEvent` is mocked at the plugin-sdk subpath (no writer, no database); `Date.now` is driven
 * by hand so window boundaries are exact. `performance.now` stays real, so total_ms is asserted
 * only as a non-negative number — its exact value is the machine's, not the producer's.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HippocampusIndex,
  MNEMO_LOOKUP_ROLLUP_WINDOW_MS,
  resetMnemoLookupRollup,
} from "./hippocampus-index.js";

type EmittedRow = { name: string; record: Record<string, unknown> };

const emitted = vi.hoisted(() => ({ rows: [] as EmittedRow[] }));

vi.mock("openclaw/plugin-sdk/fork-telemetry", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    emitted.rows.push({ name, record });
  },
}));

const rows = (): EmittedRow[] => emitted.rows.filter((r) => r.name === "j.mnemo.lookup");

let dir: string;
let now = 0;

beforeEach(async () => {
  emitted.rows.length = 0;
  resetMnemoLookupRollup();
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  dir = await mkdtemp(join(tmpdir(), "hippo-j14-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function makeIndex(): HippocampusIndex {
  const index = new HippocampusIndex({
    indexDir: dir,
    minConceptLength: 3,
    importanceThreshold: 0,
  });
  index.ingest("chunk-1", "tinkerclaw gateway telemetry");
  return index;
}

describe("J14 j.mnemo.lookup — one rollup row per window, never one per lookup", () => {
  it("writes nothing while the window is open", () => {
    const index = makeIndex();
    index.lookup("gateway");
    now += 10_000;
    index.lookup("telemetry");
    expect(rows()).toHaveLength(0);
  });

  it("the first lookup after the window closes flushes it, stamped at the window START", () => {
    const index = makeIndex();
    const windowStart = now;
    index.lookup("gateway");
    now += 5_000;
    index.lookup("telemetry");
    now = windowStart + MNEMO_LOOKUP_ROLLUP_WINDOW_MS;
    index.lookup("tinkerclaw");

    expect(rows()).toHaveLength(1);
    const row = rows()[0].record;
    expect(row.tsMs).toBe(windowStart);
    // n1 = the two lookups of the closed window; the closing lookup opens the next one.
    expect(row.n1).toBe(2);
    expect(typeof row.n2).toBe("number");
    expect(row.n2 as number).toBeGreaterThanOrEqual(0);
    // n3 = the concepts held at flush: the three ingested tokens.
    expect(row.n3).toBe(3);
  });

  it("an idle gap never smears a late lookup onto a stale start time", () => {
    const index = makeIndex();
    index.lookup("gateway");
    now += 3_600_000; // an idle hour
    const lateStart = now;
    index.lookup("telemetry");
    index.persist();

    expect(rows().map((r) => r.record.tsMs)).toEqual([1_000_000, lateStart]);
    expect(rows().map((r) => r.record.n1)).toEqual([1, 1]);
  });

  it("persist() closes a partial window so it still reaches the database", () => {
    const index = makeIndex();
    index.lookup("gateway");
    index.persist();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].record.n1).toBe(1);

    // Nothing left to flush: a second persist writes no empty row.
    index.persist();
    expect(rows()).toHaveLength(1);
  });

  it("counts the empty-index short circuit too — the cheap end of the curve", () => {
    const empty = new HippocampusIndex({
      indexDir: dir,
      minConceptLength: 3,
      importanceThreshold: 0,
    });
    empty.lookup("anything");
    empty.persist();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].record).toMatchObject({ n1: 1, n3: 0 });
  });
});
