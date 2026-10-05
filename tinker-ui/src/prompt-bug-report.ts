// FORK 2026-09-26 (the architect: "my prompt already went through, and yet I see another prompt with the
// same text with an orange outline with 'not in history' and a resend-dismiss button ... add a bug
// icon button, which should log that this particular prompt feature did not work correctly. It
// should be logging whatever we need to, in addition to our forensic dumps, to be able to find the
// bug").
//
// The 🐛 on a LOST prompt (prompt-state.ts action `report-bug`) calls app.ts `reportPromptBug`,
// which gathers plain data and hands it to `buildPromptBugReport`. The report holds every fact the
// LOST verdict was derived from, plus the transcript proof RE-RUN at click time over two fresh
// `chat.history` reads, so it says whether the proof fails now and why. `headline` answers the
// first question a reader has: is the text in the served history, under which key, and does the
// proof pass. The prod-ui server (scripts/tinker-prod-ui.mjs `/api/bug-report`) adds the gateway
// journal and transcript lines for the key and writes the file under ~/.openclaw/data/bug-reports/.
//
// This is NOT an events-database row: logs.ingest refuses free text and session keys by design
// (logging.md L4), and a prompt report is made of exactly those. The file stays on this machine,
// under a git-ignored directory.
//
// Pure: no DOM, no globals, no clock. Every input is data the caller already holds.

import {
  normalizeForMatch,
  reconcileWithHistory,
  type HistoryUserMsg,
  type JournalEntry,
  type OutboxEntry,
} from "./outbox.js";

export const PROMPT_BUG_REPORT_VERSION = 1;
/** Characters of each served history row kept in the report (the prompt itself is kept whole). */
export const BUG_REPORT_ROW_TEXT = 240;
/** Longest string kept anywhere else in the report (bubbles, snapshots). */
export const BUG_REPORT_MAX_STRING = 4000;

/** One served `chat.history` row, already reduced by app.ts to what the proof reads. */
export type BugHistoryInputRow = {
  role: string;
  idempotencyKey?: string;
  supersededIdempotencyKeys?: unknown[];
  text: string;
  ts?: number;
  seq?: number;
};

/** One `chat.history` read made at click time: the request, and its rows or its failure. */
export type BugHistoryRead = {
  request: unknown;
  rows: BugHistoryInputRow[] | null;
  error?: string;
};

export type PromptBugInputs = {
  promptId: string;
  reportedAt: number;
  entry: OutboxEntry | null;
  /** The journal rows whose id, retryOf or resentAs is this prompt's key. */
  journal: JournalEntry[];
  /** The message objects on any page that draw this prompt (same key) or carry its text. */
  bubbles: unknown[];
  /** The LOST verdict's inputs as the page holds them now (app.ts `promptHolderFacts` and kin). */
  derivation: Record<string, unknown>;
  /** The proof read `flushOutbox` would make for this session, and a plain tail read. */
  proofRead: BugHistoryRead;
  tailRead: BugHistoryRead;
  /** Page and transport state: viewed session, socket, bundle, event-ingest stats. */
  page: Record<string, unknown>;
  /** The DOM of the bubbles that draw this prompt or its text, outerHTML. */
  dom: string[];
};

type RowVerdict = {
  index: number;
  role: string;
  seq?: number;
  ts?: number;
  idempotencyKey?: string;
  supersededIdempotencyKeys?: unknown[];
  keyMatches: boolean;
  supersededMatches: boolean;
  textMatches: boolean;
  textLength: number;
  textHead: string;
};

/** Does this served row hold the prompt's text? `includes`: the served body leads with an envelope. */
function rowHoldsText(row: BugHistoryInputRow, want: string): boolean {
  return want.length > 0 && normalizeForMatch(row.text).includes(want);
}

function judgeRows(rows: BugHistoryInputRow[], id: string, want: string): RowVerdict[] {
  return rows.map((row, index) => ({
    index,
    role: row.role,
    ...(typeof row.seq === "number" ? { seq: row.seq } : {}),
    ...(typeof row.ts === "number" ? { ts: row.ts } : {}),
    ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    ...(row.supersededIdempotencyKeys
      ? { supersededIdempotencyKeys: row.supersededIdempotencyKeys }
      : {}),
    keyMatches: row.idempotencyKey === id,
    supersededMatches:
      Array.isArray(row.supersededIdempotencyKeys) && row.supersededIdempotencyKeys.includes(id),
    textMatches: rowHoldsText(row, want),
    textLength: row.text.length,
    textHead: row.text.slice(0, BUG_REPORT_ROW_TEXT),
  }));
}

/** The proof, re-run exactly as app.ts `reconcileOutboxAgainst` runs it: every user row, in order. */
function proofNow(entry: OutboxEntry | null, rows: BugHistoryInputRow[] | null): string {
  if (entry === null) {
    return "no-outbox-entry";
  }
  if (rows === null) {
    return "read-failed";
  }
  const users: HistoryUserMsg[] = rows
    .filter((r) => r.role.toLowerCase() === "user")
    .map((r) => ({
      idempotencyKey: r.idempotencyKey,
      supersededIdempotencyKeys: r.supersededIdempotencyKeys,
      text: r.text,
      ts: r.ts,
    }));
  return reconcileWithHistory([entry], users).delivered.length > 0 ? "delivered" : "unproven";
}

function readSummary(read: BugHistoryRead, entry: OutboxEntry | null, id: string, want: string) {
  const rows = read.rows ?? [];
  const judged = judgeRows(rows, id, want);
  const textRows = judged.filter((r) => r.textMatches && r.role.toLowerCase() === "user");
  return {
    request: read.request,
    ...(read.error ? { error: read.error } : {}),
    rowCount: read.rows === null ? null : rows.length,
    userRowCount: judged.filter((r) => r.role.toLowerCase() === "user").length,
    keyedUserRowCount: judged.filter((r) => r.role.toLowerCase() === "user" && r.idempotencyKey)
      .length,
    keyFound: judged.some((r) => r.keyMatches),
    supersededFound: judged.some((r) => r.supersededMatches),
    textFoundAt: textRows.map((r) => r.index),
    textFoundUnderKeys: textRows.map((r) => r.idempotencyKey ?? null),
    proofNow: proofNow(entry, read.rows),
    rows: judged,
  };
}

/** JSON-safe copy with long strings cut and cycles broken. Never throws. */
export function compactForReport(value: unknown, maxString = BUG_REPORT_MAX_STRING): unknown {
  const seen = new WeakSet<object>();
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === "string" && v.length > maxString) {
          return `${v.slice(0, maxString)}… [${v.length - maxString} more chars]`;
        }
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) {
            return "[cycle]";
          }
          seen.add(v);
        }
        return v;
      }),
    ) as unknown;
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

export function buildPromptBugReport(inputs: PromptBugInputs): Record<string, unknown> {
  const { entry, promptId: id } = inputs;
  const want = entry ? normalizeForMatch(entry.text) : "";
  const proof = readSummary(inputs.proofRead, entry, id, want);
  const tail = readSummary(inputs.tailRead, entry, id, want);
  return {
    kind: "prompt-lost",
    version: PROMPT_BUG_REPORT_VERSION,
    reportedAt: new Date(inputs.reportedAt).toISOString(),
    promptId: id,
    sessionKey: entry?.sessionKey ?? null,
    headline: {
      outboxEntry: entry !== null,
      keyedProofExpected: entry?.keyedProofExpected === true,
      acked: typeof entry?.ackedAt === "number",
      msSinceTyped: entry ? inputs.reportedAt - entry.ts : null,
      msSinceAck: typeof entry?.ackedAt === "number" ? inputs.reportedAt - entry.ackedAt : null,
      msSinceProofCheck:
        typeof entry?.lastProofCheckAt === "number"
          ? inputs.reportedAt - entry.lastProofCheckAt
          : null,
      keyInHistory: proof.keyFound || tail.keyFound,
      textInHistory: proof.textFoundAt.length > 0 || tail.textFoundAt.length > 0,
      textUnderKeys: [...new Set([...proof.textFoundUnderKeys, ...tail.textFoundUnderKeys])],
      proofNow: { proofRead: proof.proofNow, tailRead: tail.proofNow },
      bubblesForKey: inputs.bubbles.length,
    },
    outboxEntry: entry,
    journal: inputs.journal,
    derivation: compactForReport(inputs.derivation),
    history: { proofRead: proof, tailRead: tail },
    bubbles: compactForReport(inputs.bubbles),
    dom: inputs.dom.map((html) => compactForReport(html, 12000)),
    page: compactForReport(inputs.page),
  };
}
