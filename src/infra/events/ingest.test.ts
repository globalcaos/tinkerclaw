import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CatalogEvent, EVENT_CATALOG, getCatalogEvent } from "./catalog.js";
import type { EmitEventRecord } from "./emit.js";
import {
  buildIngestRules,
  createIngestRateLimiter,
  INGEST_MAX_BATCH,
  INGEST_REJECT_REASONS,
  ingestUiEvents,
  ingestVocabularyGaps,
  meaningValues,
  UI_PROMPT_STATES,
  validateIngestRecord,
} from "./ingest.js";

const NOW = 1_758_700_000_000;

/** Captures what the gate would have written, so each case can assert names AND records. */
function recorder(): {
  emit: (name: string, record: EmitEventRecord) => void;
  rows: Array<{ name: string; record: EmitEventRecord }>;
} {
  const rows: Array<{ name: string; record: EmitEventRecord }> = [];
  return { emit: (name, record) => void rows.push({ name, record }), rows };
}

function ingest(events: unknown[], emit = recorder().emit, limiter = createIngestRateLimiter()) {
  return ingestUiEvents(events, { clientKey: "device-a|127.0.0.1", limiter, emit, now: () => NOW });
}

/** A valid ui.outbox.state transition, the shape tinker-ui/src/event-ingest.ts sends. */
function outbox(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "ui.outbox.state",
    label: "proven",
    n1: 2,
    n2: 1450,
    runId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    fields: { from: "acked", proof: "keyed" },
    ...overrides,
  };
}

describe("logs.ingest gate: §9 step 7's four named refusals (CONTROL: no gate existed before)", () => {
  it("rejects an UNDECLARED NAME and records one unknown_name row", () => {
    const sink = recorder();
    const result = ingest([{ name: "ui.not.a.row", label: "queued" }], sink.emit);
    expect(result).toEqual({
      accepted: 0,
      rejected: 1,
      rejectedByReason: { unknown_name: 1 },
      rejections: [{ index: 0, reason: "unknown_name" }],
    });
    expect(sink.rows).toEqual([
      { name: "logs.ingest.rejected", record: { tsMs: NOW, label: "unknown_name" } },
    ]);
  });

  it("rejects an UNDECLARED KEY, in fields or at the top level, as undeclared_field", () => {
    const sink = recorder();
    const result = ingest(
      [outbox({ fields: { from: "acked", smuggled: 1 } }), outbox({ note: "why it failed" })],
      sink.emit,
    );
    expect(result.accepted).toBe(0);
    expect(result.rejectedByReason).toEqual({ undeclared_field: 2 });
    expect(sink.rows.map((row) => row.name)).toEqual([
      "logs.ingest.rejected",
      "logs.ingest.rejected",
    ]);
  });

  it("rejects a FREE-TEXT VALUE on a declared enum key, and the text reaches no row", () => {
    const sink = recorder();
    // A fictional NANP 555-01xx number, the repo's fixture convention: never a real line.
    const text = "sent after 3 tries, call +15555550142";
    const result = ingest(
      [outbox({ fields: { from: "acked", proof: text } }), outbox({ label: text })],
      sink.emit,
    );
    expect(result.accepted).toBe(0);
    expect(result.rejectedByReason).toEqual({ undeclared_field: 2 });
    expect(JSON.stringify(sink.rows)).not.toContain("5555550142");
  });

  it("rejects a GATEWAY-ONLY name as not_ingestable: the UI cannot forge a gateway row", () => {
    const sink = recorder();
    // gw.boot and lane.wait are real catalog rows; the refusal is about WHO may write them.
    const result = ingest(
      [
        { name: "gw.boot", label: "abc1234" },
        { name: "lane.wait", label: "session", durMs: 5 },
      ],
      sink.emit,
    );
    expect(result.rejectedByReason).toEqual({ not_ingestable: 2 });
    expect(sink.rows.every((row) => row.name === "logs.ingest.rejected")).toBe(true);
    expect(sink.rows.map((row) => row.record.label)).toEqual(["not_ingestable", "not_ingestable"]);
  });
});

describe("logs.ingest gate: the rest of the boundary", () => {
  it("accepts a valid batch of every ui.* row and hands the writer exactly what was declared", () => {
    const sink = recorder();
    const result = ingest(
      [
        outbox({ sessionKey: "agent:main:tinker:ms39dshj", tsMs: NOW - 5_000 }),
        {
          name: "ui.prompt.state",
          label: "running",
          n1: 320,
          fields: { from: "preparing", reason: "progress" },
        },
        { name: "ui.context.action", label: "evict", fields: { result: "ok" } },
      ],
      sink.emit,
    );
    expect(result).toEqual({ accepted: 3, rejected: 0, rejectedByReason: {}, rejections: [] });
    expect(sink.rows).toEqual([
      {
        name: "ui.outbox.state",
        record: {
          label: "proven",
          n1: 2,
          n2: 1450,
          runId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
          sessionKey: "agent:main:tinker:ms39dshj",
          tsMs: NOW - 5_000,
          fields: { from: "acked", proof: "keyed" },
        },
      },
      {
        name: "ui.prompt.state",
        record: { label: "running", n1: 320, fields: { from: "preparing", reason: "progress" } },
      },
      { name: "ui.context.action", record: { label: "evict", fields: { result: "ok" } } },
    ]);
  });

  it("refuses a value outside its CLOSED set even when it is id-shaped", () => {
    const rules = buildIngestRules();
    // `queued` is the word prompt-queue.md retired; it is not a prompt state.
    const retired = { name: "ui.prompt.state", label: "queued" };
    expect(validateIngestRecord(retired, rules, NOW)).toEqual({
      ok: false,
      reason: "undeclared_field",
    });
    const offSet = { name: "ui.context.action", label: "evict", fields: { result: "maybe" } };
    expect(validateIngestRecord(offSet, rules, NOW)).toEqual({
      ok: false,
      reason: "undeclared_field",
    });
  });

  it("refuses a missing label, an unused slot, a workerId, and a non-object record", () => {
    const rules = buildIngestRules();
    const refused = (input: unknown) => validateIngestRecord(input, rules, NOW);
    expect(refused(outbox({ label: undefined }))).toEqual({
      ok: false,
      reason: "undeclared_field",
    });
    // ui.outbox.state declares n1 and n2 only: an n3 means the client drifted.
    expect(refused(outbox({ n3: 1 }))).toEqual({ ok: false, reason: "undeclared_field" });
    expect(refused(outbox({ workerId: "w1" }))).toEqual({ ok: false, reason: "undeclared_field" });
    expect(refused(outbox({ runId: "+15555550142" }))).toEqual({
      ok: false,
      reason: "undeclared_field",
    });
    expect(refused("ui.outbox.state")).toEqual({ ok: false, reason: "unknown_name" });
  });

  it("replaces an out-of-window client clock with the receipt time instead of refusing", () => {
    const rules = buildIngestRules();
    const check = validateIngestRecord(outbox({ tsMs: NOW + 3_600_000 }), rules, NOW);
    expect(check.ok && check.record.tsMs).toBe(NOW);
  });

  it("refuses an OVERSIZE batch whole, as ONE row, never one per record", () => {
    const sink = recorder();
    const batch = Array.from({ length: INGEST_MAX_BATCH + 1 }, () => outbox());
    const result = ingest(batch, sink.emit);
    expect(result).toEqual({
      accepted: 0,
      rejected: INGEST_MAX_BATCH + 1,
      rejectedByReason: { oversize: INGEST_MAX_BATCH + 1 },
      rejections: [],
    });
    expect(sink.rows).toEqual([
      { name: "logs.ingest.rejected", record: { tsMs: NOW, label: "oversize" } },
    ]);
  });

  it("bounds writes per client: budget rows, then ONE rate_limited row, then silence", () => {
    const sink = recorder();
    const limiter = createIngestRateLimiter({ windowMs: 1_000, maxRecords: 2 });
    let nowMs = NOW;
    const call = (clientKey: string, events: unknown[]) =>
      ingestUiEvents(events, { clientKey, limiter, emit: sink.emit, now: () => nowMs });

    const first = call("a", [outbox(), outbox(), outbox(), outbox()]);
    expect(first.accepted).toBe(2);
    expect(first.rejectedByReason).toEqual({ rate_limited: 2 });
    const second = call("a", [outbox({ note: "bad" })]);
    expect(second.rejectedByReason).toEqual({ rate_limited: 1 });
    // Two accepted rows and exactly one rate_limited row, however much more was sent.
    expect(sink.rows.map((row) => row.record.label ?? row.name)).toEqual([
      "proven",
      "proven",
      "rate_limited",
    ]);

    // Another client has its own budget, and the next window reopens.
    expect(call("b", [outbox()]).accepted).toBe(1);
    nowMs += 1_000;
    expect(call("a", [outbox()]).accepted).toBe(1);
  });
});

describe("logs.ingest gate: the closed sets cannot drift from their owners", () => {
  it("every UI-ingestable row resolves every set, and nothing is declared for nothing", () => {
    expect(ingestVocabularyGaps()).toEqual([]);
    expect(EVENT_CATALOG.filter((entry) => entry.uiIngestable).map((entry) => entry.name)).toEqual([
      "ui.outbox.state",
      "ui.prompt.state",
      "ui.context.action",
    ]);
  });

  it("a doctored UI row with an unlisted label or a json field is reported, not silently open", () => {
    // Doctored IN the full catalog: a one-row catalog would also orphan every other row's sets.
    const index = EVENT_CATALOG.findIndex((entry) => entry.name === "ui.context.action");
    expect(index).toBeGreaterThanOrEqual(0);
    const doctored: CatalogEvent[] = [...EVENT_CATALOG];
    doctored[index] = {
      ...EVENT_CATALOG[index],
      label: "action, whatever the UI says",
      fields: { blob: "json" },
    };
    expect(ingestVocabularyGaps(doctored)).toEqual([
      "ui.context.action: label has no closed set",
      "ui.context.action: fields.blob is json, which this door refuses",
      "UI_FIELD_VALUES.ui.context.action.result: not an enum field this door resolves from here",
    ]);
  });

  it("ui.prompt.state's states are tinker-ui prompt-state.ts's PROMPT_STATES, lowercased", () => {
    const source = readFileSync(
      new URL("../../../tinker-ui/src/prompt-state.ts", import.meta.url),
      "utf8",
    );
    const block = /export const PROMPT_STATES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]/.exec(source);
    expect(block).not.toBeNull();
    const states = [...(block?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1].toLowerCase());
    expect(states.length).toBeGreaterThan(0);
    expect([...UI_PROMPT_STATES]).toEqual(states);
  });

  it("the reasons this gate records are exactly the ones §4.10's catalog row declares", () => {
    const row = getCatalogEvent("logs.ingest.rejected");
    expect(meaningValues(row?.label ?? null)).toEqual([...INGEST_REJECT_REASONS]);
  });

  it("meaningValues reads a value list and refuses prose and pattern families", () => {
    expect(meaningValues("action (evict, compact)")).toEqual(["evict", "compact"]);
    expect(meaningValues("to_state (prompt-queue.md's vocabulary, not restated here)")).toBeNull();
    expect(meaningValues("exit_class (clean, signal, killed.cause, crash, init_stall)")).toBeNull();
    expect(meaningValues("site")).toBeNull();
    expect(meaningValues(null)).toBeNull();
  });
});
