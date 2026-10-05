import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVED_QUERY_NAMES } from "../infra/events/saved-queries.js";
import { openEventsDatabase, type EventsDatabase } from "../infra/events/schema.js";
import { registerLogsCli } from "./logs-cli.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  }),
}));

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

/** Production's root program enables positional options (program/build-program.ts); so does this one. */
async function runLogsCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.enablePositionalOptions();
  program.exitOverride();
  registerLogsCli(program);
  await program.parseAsync(argv, { from: "user" });
}

function capture(stream: NodeJS.WriteStream): string[] {
  const writes: string[] = [];
  vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

const HOUR_MS = 3_600_000;
const MiB = 1_048_576;

let tmpDir: string;
let dbPath: string;
let handle: EventsDatabase;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "logs-cli-query-"));
  dbPath = join(tmpDir, "events.sqlite");
  handle = openEventsDatabase(dbPath, { walMaintenance: { checkpointIntervalMs: 0 } });
  const insert = handle.db.prepare(
    "INSERT INTO events (ts_ms, name, kind, boot_id, worker_id, label, n1, n4, fields) " +
      "VALUES (?, 'worker.sample', 'sample', 'boot-fixture', ?, ?, ?, ?, ?)",
  );
  const start = Date.now() - 24 * HOUR_MS;
  for (let hour = 0; hour <= 10; hour++) {
    const ts = start + hour * HOUR_MS;
    insert.run(
      ts,
      "fixture-growing",
      "tinker_bridge",
      (100 + hour) * MiB,
      120 * MiB,
      '{"source":"cgroup"}',
    );
    insert.run(ts, "fixture-flat", "gateway", 300 * MiB, 310 * MiB, '{"source":"process"}');
  }
});

afterEach(() => {
  callGatewayFromCli.mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  handle.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function eventCount(): number {
  return (handle.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
}

describe("logs query / sql / catalog (logging.md §8.2, §9 step 10) — CONTROL: no subcommand existed before", () => {
  it("`logs query <name>` asks logs.query by name with its params and row limit — never SQL", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      name: "history-resets-by-reason",
      columns: ["day", "reason", "calls"],
      rows: [{ day: "2026-09-25", reason: "byte_cap", calls: 3 }],
      rowCount: 1,
      truncated: null,
      elapsedMs: 2,
      redactedSessionKeys: 0,
    });
    const stdout = capture(process.stdout);
    await runLogsCli([
      "logs",
      "query",
      "history-resets-by-reason",
      "--since",
      "3d",
      "--limit",
      "50",
      "--json",
    ]);
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "logs.query",
      expect.anything(),
      { name: "history-resets-by-reason", params: { since: "3d" }, limit: 50 },
      { progress: false },
    );
    expect(JSON.parse(stdout.join("")).rows).toEqual([
      { day: "2026-09-25", reason: "byte_cap", calls: 3 },
    ]);
  });

  it("`logs query` with no name lists every saved query without a gateway call", async () => {
    const stdout = capture(process.stdout);
    await runLogsCli(["logs", "query", "--json"]);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    const listed = JSON.parse(stdout.join("")) as { queries: Array<{ name: string }> };
    expect(listed.queries.map((query) => query.name)).toEqual([...SAVED_QUERY_NAMES]);
  });

  it("`logs catalog --silent` asks logs.catalog", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      columns: ["name", "rows_since", "last_ts_ms"],
      rows: [{ name: "gw.boot", rows_since: 0, last_ts_ms: null }],
      rowCount: 1,
      truncated: null,
      elapsedMs: 1,
      redactedSessionKeys: 0,
    });
    capture(process.stdout);
    await runLogsCli(["logs", "catalog", "--silent", "--json"]);
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "logs.catalog",
      expect.anything(),
      { silent: true },
      { progress: false },
    );
  });

  it("`logs query --local` runs the worker trend on the file and shows the growing worker's positive slope", async () => {
    const stdout = capture(process.stdout);
    await runLogsCli(["logs", "query", "worker-memory-trend", "--local", "--db", dbPath, "--json"]);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    const answer = JSON.parse(stdout.join("")) as { rows: Array<Record<string, unknown>> };
    expect(answer.rows[0]).toMatchObject({ worker_id: "fixture-growing" });
    expect(answer.rows[0]?.mib_per_hour).toBeGreaterThan(0);
  });

  it("`logs sql` runs one SELECT locally with a row cap", async () => {
    const stdout = capture(process.stdout);
    await runLogsCli([
      "logs",
      "sql",
      "SELECT worker_id, n1 FROM events ORDER BY id",
      "--db",
      dbPath,
      "--limit",
      "2",
      "--json",
    ]);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    const answer = JSON.parse(stdout.join("")) as { rowCount: number; truncated: string };
    expect(answer.rowCount).toBe(2);
    expect(answer.truncated).toBe("row_cap");
  });

  it("`logs sql` refuses a write statement and leaves the file untouched", async () => {
    const before = eventCount();
    const stderr = capture(process.stderr);
    capture(process.stdout);
    await runLogsCli(["logs", "sql", "DELETE FROM events", "--db", dbPath, "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr.join("")).message).toMatch(/only SELECT and WITH/);
    expect(eventCount()).toBe(before);
  });

  it("a bare `logs` still tails: positional options did not take the tail's own flags", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ file: "/tmp/openclaw.log", lines: [] });
    capture(process.stdout);
    await runLogsCli(["logs", "--limit", "5", "--json"]);
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "logs.tail",
      expect.anything(),
      expect.objectContaining({ limit: 5 }),
      expect.anything(),
    );
  });
});
