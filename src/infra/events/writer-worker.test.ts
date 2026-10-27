import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventWireRow } from "./emit.js";
import { openEventsDatabase, type EventsDatabase } from "./schema.js";
import {
  createWriterCore,
  databaseBytes,
  EVENT_WINDOW_DAYS,
  handleWriterRequest,
  HOT_WINDOW_DAYS,
  type WriterCore,
} from "./writer-worker.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW_MS = 1_790_000_000_000 - (1_790_000_000_000 % HOUR_MS);
const BUDGET = 512 * 1024 * 1024;

let tmpDir: string;
const opened: EventsDatabase[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "events-writer-"));
});

afterEach(() => {
  for (const handle of opened.splice(0)) {
    handle.close();
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function open(): { handle: EventsDatabase; core: WriterCore } {
  const handle = openEventsDatabase(join(tmpDir, "events.sqlite"), {
    walMaintenance: { checkpointIntervalMs: 0 },
  });
  opened.push(handle);
  const core = createWriterCore(handle, { saltId: "cafe0123cafe0123", bootId: "boot-1" });
  return { handle, core };
}

function row(
  name: string,
  kind: string,
  tsMs: number,
  extra: Partial<EventWireRow> = {},
): EventWireRow {
  return {
    ts_ms: tsMs,
    name,
    kind,
    boot_id: "boot-1",
    session_hash: null,
    session_kind: null,
    run_id: null,
    worker_id: null,
    label: null,
    dur_ms: null,
    n1: null,
    n2: null,
    n3: null,
    n4: null,
    fields: null,
    ...extra,
  };
}

describe("writer core (§7.5) — CONTROL: this module did not exist before this change", () => {
  it("inserts a batch in one transaction and records the salt fingerprint, never the salt", () => {
    const { handle, core } = open();
    const inserted = core.insert([
      row("gw.boot", "mark", NOW_MS, { label: "abc1234" }),
      row("turn.span", "span", NOW_MS, { dur_ms: 12, label: "resolve" }),
    ]);
    expect(inserted).toBe(2);
    const count = handle.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number };
    expect(count.n).toBe(2);
    const salt = handle.db.prepare("SELECT value FROM meta WHERE key = 'salt_id'").get() as {
      value: string;
    };
    expect(salt.value).toBe("cafe0123cafe0123");
    expect(core.stats().dbBytes).toBeGreaterThan(0);
    expect(core.stats().schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it("maintenance rolls FULL hours of hot rows into rollup_1h (nearest-rank p99) and deletes them", () => {
    const { handle, core } = open();
    const oldHour = NOW_MS - 20 * DAY_MS;
    core.insert([
      row("turn.span", "span", oldHour + 1_000, { dur_ms: 10, label: "resolve" }),
      row("turn.span", "span", oldHour + 2_000, { dur_ms: 20, label: "resolve" }),
      row("turn.span", "span", oldHour + 3_000, { dur_ms: 100, label: "resolve" }),
      row("turn.span", "span", NOW_MS - HOUR_MS, { dur_ms: 7, label: "resolve" }),
    ]);
    const outcome = core.maintenance({ nowMs: NOW_MS, budgetBytes: BUDGET, force: true });
    expect(outcome.ran).toBe(true);
    expect(outcome.hotDays).toBe(HOT_WINDOW_DAYS);
    expect(outcome.rowsDeleted).toBeGreaterThanOrEqual(3);
    const rollup = handle.db
      .prepare("SELECT count, dur_max, dur_p99 FROM rollup_1h WHERE name = 'turn.span'")
      .get() as { count: number; dur_max: number; dur_p99: number };
    expect(rollup).toEqual({ count: 3, dur_max: 100, dur_p99: 100 });
    const left = handle.db
      .prepare("SELECT count(*) AS n FROM events WHERE name = 'turn.span'")
      .get() as { n: number };
    expect(left.n).toBe(1); // the in-window row survives
    const retention = handle.db
      .prepare("SELECT n1, fields FROM events WHERE name = 'logs.retention.run'")
      .get() as { n1: number; fields: string };
    expect(retention.n1).toBe(outcome.rowsDeleted);
    expect(JSON.parse(retention.fields)).toEqual({
      hot_days: HOT_WINDOW_DAYS,
      event_days: EVENT_WINDOW_DAYS,
      shortened: false,
    });
  });

  it("maintenance is daily-gated via meta, and force reruns it", () => {
    const { core } = open();
    expect(core.maintenance({ nowMs: NOW_MS, budgetBytes: BUDGET, force: true }).ran).toBe(true);
    expect(core.maintenance({ nowMs: NOW_MS + HOUR_MS, budgetBytes: BUDGET }).ran).toBe(false);
    expect(core.maintenance({ nowMs: NOW_MS + 25 * HOUR_MS, budgetBytes: BUDGET }).ran).toBe(true);
  });

  it("event class ages out at its window; research is NEVER deleted (§7.4)", () => {
    const { handle, core } = open();
    core.insert([
      row("gw.boot", "mark", NOW_MS - 200 * DAY_MS, { label: "old" }),
      row("gw.boot", "mark", NOW_MS - DAY_MS, { label: "fresh" }),
      row("j.fractal.run", "outcome", NOW_MS - 400 * DAY_MS, { label: "success" }),
    ]);
    core.maintenance({ nowMs: NOW_MS, budgetBytes: BUDGET, force: true });
    const names = handle.db
      .prepare("SELECT name, label FROM events WHERE name <> 'logs.retention.run' ORDER BY id")
      .all() as Array<{ name: string; label: string | null }>;
    expect(names).toEqual([
      { name: "gw.boot", label: "fresh" },
      { name: "j.fractal.run", label: "success" },
    ]);
  });

  it("a starved budget shortens the derived windows and says so (§7.4)", () => {
    const { core } = open();
    const rows: EventWireRow[] = [];
    for (let day = 0; day < 10; day++) {
      for (let i = 0; i < 20; i++) {
        rows.push(row("turn.span", "span", NOW_MS - day * DAY_MS - i * 60_000, { dur_ms: 5 }));
      }
    }
    core.insert(rows);
    const outcome = core.maintenance({ nowMs: NOW_MS, budgetBytes: 4096, force: true });
    expect(outcome.ran).toBe(true);
    expect(outcome.shortened).toBe(true);
    expect(outcome.hotDays).toBeLessThan(HOT_WINDOW_DAYS);
    expect(outcome.hotDays).toBeGreaterThanOrEqual(1);
  });

  it("handleWriterRequest answers stats and turns a thrown error into an error response", () => {
    const { core } = open();
    const stats = handleWriterRequest(core, { id: 7, type: "stats" });
    expect(stats).toMatchObject({ id: 7, ok: true, type: "stats" });
    const broken: WriterCore = {
      ...core,
      insert: () => {
        throw new Error("boom");
      },
    };
    const errored = handleWriterRequest(broken, { id: 8, type: "insert", rows: [] });
    expect(errored).toMatchObject({ id: 8, ok: false, type: "error" });
  });

  it("databaseBytes measures the file, not a guess", () => {
    const { handle } = open();
    const bytes = databaseBytes(handle);
    expect(bytes.dbBytes).toBeGreaterThan(0);
    expect(bytes.walBytes).toBeGreaterThanOrEqual(0);
  });
});
