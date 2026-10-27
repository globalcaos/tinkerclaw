import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitEvent,
  flushEventWriter,
  resetEventWriterForTest,
  startEventWriter,
} from "../../infra/events/emit.js";
import { isGatewayMethodClassified, isReadMethod, isWriteMethod } from "../method-scopes.js";
import { listGatewayMethods } from "../server-methods-list.js";
import { logsHandlers } from "./logs.js";

const noop = () => false;
// A fictional number (the 555-01xx range): the key's shape is what matters, never a real contact.
const RAW_KEY_TAIL = "+15555550142";
const RAW_KEY = `agent:main:whatsapp:${RAW_KEY_TAIL}`;

type HandlerOpts = Parameters<(typeof logsHandlers)["logs.tail"]>[0];

async function call(method: "logs.query" | "logs.catalog", params: Record<string, unknown>) {
  const respond = vi.fn();
  await logsHandlers[method]({
    params,
    respond,
    context: {} as unknown as HandlerOpts["context"],
    client: null,
    req: { id: "req-1", type: "req", method },
    isWebchatConnect: noop,
  });
  return respond;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "logs-query-"));
});

afterEach(async () => {
  await resetEventWriterForTest();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("logs.query / logs.catalog RPC (logging.md §8.2, §9 step 10) — CONTROL: neither method existed before", () => {
  it("both are listed, have handlers, and are classified READ — never WRITE", () => {
    for (const method of ["logs.query", "logs.catalog"]) {
      expect(listGatewayMethods()).toContain(method);
      expect(typeof logsHandlers[method]).toBe("function");
      expect(isGatewayMethodClassified(method)).toBe(true);
      expect(isReadMethod(method)).toBe(true);
      expect(isWriteMethod(method)).toBe(false);
    }
  });

  it("refuses SQL text, unknown names and unknown keys as INVALID_REQUEST, before any database work", async () => {
    for (const params of [
      { name: "SELECT * FROM events" },
      { name: "no-such-query" },
      { name: "worker-memory-daily", sql: "SELECT 1" },
      { name: "worker-memory-daily", params: { since: "forever" } },
      { name: "worker-memory-daily", limit: 1_000_000 },
    ]) {
      const respond = await call("logs.query", params);
      expect(respond, JSON.stringify(params)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    const catalog = await call("logs.catalog", { silent: "yes" });
    expect(catalog).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("answers UNAVAILABLE, not a crash, when no events writer runs", async () => {
    const respond = await call("logs.query", { name: "history-resets-by-reason" });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });

  it("runs a saved query on the writer thread and never returns the raw session key (temp db)", async () => {
    startEventWriter({
      env: { OPENCLAW_EVENTS_DB_PATH: join(tmpDir, "events.sqlite") },
      statsIntervalMs: 0,
      maintenanceIntervalMs: 0,
      flushIntervalMs: 3_600_000,
    });
    emitEvent("history.minute", { label: "reset.byte_cap", n1: 3, sessionKey: RAW_KEY });
    emitEvent("history.minute", { label: "delta", n1: 40, sessionKey: RAW_KEY });
    await flushEventWriter();

    const respond = await call("logs.query", {
      name: "history-resets-by-reason",
      params: { since: "1d" },
      limit: 10,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        name: "history-resets-by-reason",
        columns: ["day", "reason", "calls"],
        rows: [expect.objectContaining({ reason: "byte_cap", calls: 3 })],
        rowCount: 1,
        truncated: null,
        redactedSessionKeys: 0,
      }),
      undefined,
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain(RAW_KEY_TAIL);

    const catalog = await call("logs.catalog", { silent: true });
    expect(catalog).toHaveBeenCalledWith(true, expect.anything(), undefined);
    const answer = catalog.mock.calls[0]?.[1] as { rows: Array<Record<string, unknown>> };
    expect(answer.rows[0]?.rows_since).toBe(0);
    const history = answer.rows.find((row) => row.name === "history.minute");
    expect(history).toMatchObject({ rows_since: 2 });
    expect(typeof history?.last_ts_ms).toBe("number");
    expect(JSON.stringify(catalog.mock.calls)).not.toContain(RAW_KEY_TAIL);
  });
});
