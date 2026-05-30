/**
 * ENGRAM — Reconciliation ledger (Upgrade 8, working-memory plane).
 *
 * The JSONL audit plane is append-only and immutable. UPDATE/DELETE decisions
 * from the nightly reconciliation sweep take effect HERE, as *logical*
 * supersede/tombstone rows, never as physical JSONL mutations.
 *
 * The ledger is itself bounded (risk #3, state explosion):
 *   - one supersede/tombstone row per logical fact-key (latest wins)
 *   - a rolling tail of the most recent raw decisions for audit
 *
 * FORK-ISOLATED: unique to our fork (Total Recall paper, Upgrade 8).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReconciliationDecision } from "./reconciliation.js";

export interface LedgerEntry {
  targetEventId: string;
  action: "UPDATE" | "DELETE";
  reason?: string;
  at: string;
}

export interface ReconciliationLedgerData {
  /** Logical state per targeted event id (latest decision wins). */
  entries: Record<string, LedgerEntry>;
  /** Rolling tail of raw decisions for audit. */
  tail: LedgerEntry[];
}

export interface ReconciliationLedger {
  supersede(targetEventId: string, decision: ReconciliationDecision): void;
  tombstone(targetEventId: string, decision: ReconciliationDecision): void;
  /** True if an event has been logically tombstoned. */
  isTombstoned(eventId: string): boolean;
  /** True if an event has been logically superseded. */
  isSuperseded(eventId: string): boolean;
  /** Count of logical entries (bounded). */
  size(): number;
  data(): ReconciliationLedgerData;
  flush(): void;
}

const DEFAULT_TAIL_CAP = 500;

export interface ReconciliationLedgerOptions {
  /** Path to persist the ledger JSON. If absent, the ledger is in-memory only. */
  filePath?: string;
  /** Rolling tail cap. Default 500. */
  tailCap?: number;
  now?: () => string;
}

export function createReconciliationLedger(
  opts: ReconciliationLedgerOptions = {},
): ReconciliationLedger {
  const tailCap = opts.tailCap ?? DEFAULT_TAIL_CAP;
  const now = opts.now ?? (() => new Date().toISOString());

  let data: ReconciliationLedgerData = { entries: {}, tail: [] };
  if (opts.filePath && existsSync(opts.filePath)) {
    try {
      data = JSON.parse(readFileSync(opts.filePath, "utf-8")) as ReconciliationLedgerData;
      if (!data.entries) {
        data.entries = {};
      }
      if (!data.tail) {
        data.tail = [];
      }
    } catch {
      data = { entries: {}, tail: [] };
    }
  }

  function record(action: "UPDATE" | "DELETE", targetEventId: string, reason?: string): void {
    const entry: LedgerEntry = { targetEventId, action, reason, at: now() };
    data.entries[targetEventId] = entry; // latest wins (bounded: one per key)
    data.tail.push(entry);
    if (data.tail.length > tailCap) {
      data.tail.splice(0, data.tail.length - tailCap);
    }
  }

  function flush(): void {
    if (!opts.filePath) {
      return;
    }
    mkdirSync(dirname(opts.filePath), { recursive: true });
    writeFileSync(opts.filePath, JSON.stringify(data, null, 2));
  }

  return {
    supersede(targetEventId, decision) {
      record("UPDATE", targetEventId, decision.reason);
    },
    tombstone(targetEventId, decision) {
      record("DELETE", targetEventId, decision.reason);
    },
    isTombstoned(eventId) {
      return data.entries[eventId]?.action === "DELETE";
    },
    isSuperseded(eventId) {
      return data.entries[eventId]?.action === "UPDATE";
    },
    size() {
      return Object.keys(data.entries).length;
    },
    data() {
      return data;
    },
    flush,
  };
}
