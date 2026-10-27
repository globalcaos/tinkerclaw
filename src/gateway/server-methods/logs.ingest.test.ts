import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushEventWriter,
  getEventWriterStats,
  resetEventWriterForTest,
  startEventWriter,
  stopEventWriter,
} from "../../infra/events/emit.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { isGatewayMethodClassified, isReadMethod, isWriteMethod } from "../method-scopes.js";
import { listGatewayMethods } from "../server-methods-list.js";
import { logsHandlers } from "./logs.js";

const noop = () => false;

type IngestOpts = Parameters<(typeof logsHandlers)["logs.tail"]>[0];

async function callIngest(params: Record<string, unknown>) {
  const respond = vi.fn();
  await logsHandlers["logs.ingest"]({
    params,
    respond,
    context: {} as unknown as IngestOpts["context"],
    client: null,
    req: { id: "req-1", type: "req", method: "logs.ingest" },
    isWebchatConnect: noop,
  });
  return respond;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "logs-ingest-"));
});

afterEach(async () => {
  await resetEventWriterForTest();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("logs.ingest RPC (logging.md §8.2, §9 step 7) — CONTROL: the method did not exist before", () => {
  it("is listed, has a handler, and is classified WRITE — never READ", () => {
    expect(listGatewayMethods()).toContain("logs.ingest");
    expect(typeof logsHandlers["logs.ingest"]).toBe("function");
    expect(isGatewayMethodClassified("logs.ingest")).toBe(true);
    expect(isWriteMethod("logs.ingest")).toBe(true);
    // READ is also granted to WRITE holders: a READ classification would hand every read-only
    // operator token a write path into the events database.
    expect(isReadMethod("logs.ingest")).toBe(false);
  });

  it("answers INVALID_REQUEST when params carry no events array", async () => {
    const respond = await callIngest({});
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("lands a valid ui.* batch in the database through the RPC, and records the refusal (temp db)", async () => {
    startEventWriter({
      env: { OPENCLAW_EVENTS_DB_PATH: join(tmpDir, "events.sqlite") },
      statsIntervalMs: 0,
      maintenanceIntervalMs: 0,
      flushIntervalMs: 3_600_000,
    });
    const rawKey = "agent:main:tinker:ms39dshj";
    const respond = await callIngest({
      events: [
        {
          name: "ui.outbox.state",
          label: "proven",
          n1: 2,
          n2: 1450,
          runId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
          sessionKey: rawKey,
          fields: { from: "acked", proof: "keyed" },
        },
        {
          name: "ui.prompt.state",
          label: "answered",
          n1: 4200,
          fields: { from: "running", reason: "progress" },
        },
        { name: "ui.context.action", label: "compact", fields: { result: "noop" } },
        { name: "gw.boot", label: "abc1234" },
      ],
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        accepted: 3,
        rejected: 1,
        rejectedByReason: { not_ingestable: 1 },
        rejections: [{ index: 3, reason: "not_ingestable" }],
      },
      undefined,
    );

    await flushEventWriter();
    const stats = getEventWriterStats();
    expect(stats.written).toBe(4);
    // The gate is stricter than the writer: nothing it accepted was stripped on the way in.
    expect(stats.undeclaredKeys).toBe(0);
    expect(stats.invalidValues).toBe(0);
    await stopEventWriter();

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(join(tmpDir, "events.sqlite"));
    try {
      const outbox = db
        .prepare(
          'SELECT to_state, attempts, age_ms, "from", proof, run_id, session_kind, session_hash FROM v_ui_outbox_state',
        )
        .all() as Array<Record<string, unknown>>;
      expect(outbox).toEqual([
        {
          to_state: "proven",
          attempts: 2,
          age_ms: 1450,
          from: "acked",
          proof: "keyed",
          run_id: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
          session_kind: "tinker",
          session_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
        },
      ]);
      const prompt = db
        .prepare('SELECT to_state, ms_in_from_state, "from", reason FROM v_ui_prompt_state')
        .get() as Record<string, unknown>;
      expect(prompt).toEqual({
        to_state: "answered",
        ms_in_from_state: 4200,
        from: "running",
        reason: "progress",
      });
      const action = db.prepare("SELECT action, result FROM v_ui_context_action").get() as Record<
        string,
        unknown
      >;
      expect(action).toEqual({ action: "compact", result: "noop" });
      const refusals = db.prepare("SELECT reason FROM v_logs_ingest_rejected").all() as Array<{
        reason: string;
      }>;
      expect(refusals).toEqual([{ reason: "not_ingestable" }]);
      // The forged gateway row never landed, and the raw session key is in no column (L4).
      expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'gw.boot'").get()).toEqual({
        n: 0,
      });
      const all = db.prepare("SELECT * FROM events").all();
      expect(JSON.stringify(all)).not.toContain(rawKey);
    } finally {
      db.close();
    }
  }, 30_000);
});
