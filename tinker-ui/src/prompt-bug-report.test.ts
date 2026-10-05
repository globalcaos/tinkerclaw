import { describe, expect, it } from "vitest";
import type { OutboxEntry } from "./outbox.js";
import {
  BUG_REPORT_ROW_TEXT,
  buildPromptBugReport,
  compactForReport,
  type BugHistoryRead,
  type PromptBugInputs,
} from "./prompt-bug-report.js";

const KEY = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const TEXT = "In the models panel, there is an astra6";

const entry: OutboxEntry = {
  id: KEY,
  sessionKey: "agent:main:tinker:abc",
  text: TEXT,
  ts: 1_000,
  attempts: 1,
  lastAttemptAt: 1_000,
  ackedAt: 1_100,
  keyedProofExpected: true,
  lastProofCheckAt: 5_000,
};

function inputs(proofRead: BugHistoryRead, tailRead: BugHistoryRead = proofRead): PromptBugInputs {
  return {
    promptId: KEY,
    reportedAt: 10_000,
    entry,
    journal: [],
    bubbles: [{ _clientMsgId: KEY }],
    derivation: {},
    proofRead,
    tailRead,
    page: {},
    dom: [],
  };
}

const envelope = (t: string) => `[Sat 2026-09-26 10:01 GMT+2] ${t}`;

describe("prompt bug report — what the 🐛 records about a LOST prompt", () => {
  it("names a prompt whose text is served under ANOTHER key: in history, unproven", () => {
    const read: BugHistoryRead = {
      request: { sessionKey: entry.sessionKey, limit: 200 },
      rows: [
        { role: "user", text: envelope("older prompt"), idempotencyKey: OTHER.replace("9", "8") },
        { role: "user", text: envelope(TEXT), idempotencyKey: OTHER },
        { role: "assistant", text: "answer" },
      ],
    };
    const report = buildPromptBugReport(inputs(read));
    const headline = report.headline as Record<string, unknown>;
    expect(headline.keyInHistory).toBe(false);
    expect(headline.textInHistory).toBe(true);
    expect(headline.textUnderKeys).toEqual([OTHER]);
    expect(headline.proofNow).toEqual({ proofRead: "unproven", tailRead: "unproven" });
    expect(headline.msSinceAck).toBe(8_900);
  });

  it("says delivered when a served row carries the key (the page's own proof would pass now)", () => {
    const read: BugHistoryRead = {
      request: {},
      rows: [{ role: "user", text: envelope(TEXT), idempotencyKey: KEY }],
    };
    const headline = buildPromptBugReport(inputs(read)).headline as Record<string, unknown>;
    expect(headline.keyInHistory).toBe(true);
    expect(headline.proofNow).toEqual({ proofRead: "delivered", tailRead: "delivered" });
  });

  it("keeps a failed read as evidence instead of calling the prompt unproven", () => {
    const failed: BugHistoryRead = { request: {}, rows: null, error: "disconnected" };
    const report = buildPromptBugReport(inputs(failed, { request: {}, rows: [] }));
    const history = report.history as Record<string, Record<string, unknown>>;
    expect(history.proofRead.proofNow).toBe("read-failed");
    expect(history.proofRead.error).toBe("disconnected");
    expect(history.tailRead.proofNow).toBe("unproven");
  });

  it("keeps the prompt whole but cuts every served row to its head", () => {
    const long = `${TEXT} ${"x".repeat(1000)}`;
    const report = buildPromptBugReport(
      inputs({ request: {}, rows: [{ role: "user", text: long }] }),
    );
    const rows = (report.history as { proofRead: { rows: { textHead: string }[] } }).proofRead.rows;
    expect(rows[0].textHead).toHaveLength(BUG_REPORT_ROW_TEXT);
    expect((report.outboxEntry as OutboxEntry).text).toBe(TEXT);
  });
});

describe("compactForReport", () => {
  it("cuts long strings and breaks cycles without throwing", () => {
    const a: Record<string, unknown> = { s: "y".repeat(50) };
    a.self = a;
    const out = compactForReport(a, 10) as Record<string, unknown>;
    expect(out.s).toMatch(/^y{10}… \[40 more chars\]$/);
    expect(out.self).toBe("[cycle]");
  });
});
