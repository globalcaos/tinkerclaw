import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../node-sqlite.js";
import {
  emitEvent,
  getEventWriterStats,
  ingestEventSpool,
  resetEventWriterForTest,
  startEventSpool,
  startEventWriter,
  stopEventWriter,
} from "./emit.js";
import { EVENTS_SPOOL_DIRNAME } from "./paths.js";

// CONTROL: before this change a process with no writer (scripts/engram-sleep.mjs, the nightly
// consolidation) counted every emit as `not_started` and dropped it, so `j.consolidation.run` held
// 0 rows over 930,816 events (09-25 → 10-09) although the job ran every night at 04:15.

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "events-spool-"));
  await resetEventWriterForTest();
});

afterEach(async () => {
  await resetEventWriterForTest();
  rmSync(tmpDir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { OPENCLAW_EVENTS_DB_PATH: join(tmpDir, "events.sqlite") };
}

function spoolDir(): string {
  return join(tmpDir, EVENTS_SPOOL_DIRNAME);
}

/** The gateway side: start the process-wide writer with its timers off, wait for the spool pass. */
async function gatewayStartsAndIngests(): Promise<void> {
  startEventWriter({
    env: env(),
    statsIntervalMs: 0,
    maintenanceIntervalMs: 0,
    flushIntervalMs: 3_600_000,
  });
  await ingestEventSpool();
  await stopEventWriter();
}

function readRows(): Array<Record<string, unknown>> {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(join(tmpDir, "events.sqlite"));
  try {
    return db
      .prepare(
        "SELECT ts_ms, name, session_hash, session_kind, dur_ms, n1, n2, n3 FROM events " +
          "WHERE name = 'j.consolidation.run' ORDER BY ts_ms, n1",
      )
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("the events spool: a process with no writer stops dropping its events", () => {
  it("a script's emit is spooled, then lands when the gateway's writer starts", async () => {
    const tsMs = Date.now() - 3_600_000;
    const sessionKey = "agent:main:whatsapp:+15555550100";

    // The script side: no writer in this process, one opt-in call.
    const file = startEventSpool(env());
    expect(file).not.toBeNull();
    emitEvent("j.consolidation.run", { tsMs, durMs: 12, n1: 3, n2: 0, n3: 0, sessionKey });
    expect(getEventWriterStats().dropped).toBe(0);
    expect(
      readFileSync(file ?? "", "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(1);

    await gatewayStartsAndIngests();

    const rows = readRows();
    expect(rows).toEqual([
      {
        ts_ms: tsMs,
        name: "j.consolidation.run",
        session_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
        session_kind: "whatsapp",
        dur_ms: 12,
        n1: 3,
        n2: 0,
        n3: 0,
      },
    ]);
    // L4 still holds: the raw key reached the spool, never a column.
    expect(JSON.stringify(rows)).not.toContain("+15555550100");
    // The spool is consumed, so a second start cannot write the row twice.
    expect(readdirSync(spoolDir())).toEqual([]);
  }, 30_000);

  it("a torn line is skipped and the rest of the file still lands", async () => {
    const file = startEventSpool(env());
    emitEvent("j.consolidation.run", { durMs: 1, n1: 1, n2: 0, n3: 0 });
    appendFileSync(file ?? "", '{"name":"j.consolidation.run","rec\n');
    emitEvent("j.consolidation.run", { durMs: 2, n1: 2, n2: 0, n3: 0 });

    await gatewayStartsAndIngests();

    expect(readRows().map((row) => row.n1)).toEqual([1, 2]);
    expect(readdirSync(spoolDir())).toEqual([]);
  }, 30_000);

  it("under a test runner with no explicit database the spool is refused, as the writer is", () => {
    const { OPENCLAW_EVENTS_DB_PATH: _ignored, ...runnerEnv } = process.env;
    expect(startEventSpool(runnerEnv)).toBeNull();
    emitEvent("j.consolidation.run", { durMs: 1 });
    expect(getEventWriterStats().droppedByReason).toEqual({ not_started: 1 });
  });

  it("without the opt-in nothing touches the disk and the drop is still counted", () => {
    emitEvent("j.consolidation.run", { durMs: 1 });
    expect(getEventWriterStats().droppedByReason).toEqual({ not_started: 1 });
    expect(existsSync(spoolDir())).toBe(false);
  });
});
