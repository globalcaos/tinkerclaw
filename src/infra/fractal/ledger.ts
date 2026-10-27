/**
 * FORK 2026-10-09: the reader behind `fractal.ledger` (Fractal v2 charter, contracts C2/C3, mechanism M4).
 *
 * WHY. The census found 131 of 536 failed Fractal claims pointed at files that were never on disk. The bridge now writes
 * one row per Fractal run to `<stateDir>/data/fractal/ledger.jsonl` with what the run actually wrote and committed and a
 * check of every path and SHA its text claims. This reads those rows back for the page (the card's ✓/✗) and for the
 * weekly outcome script.
 *
 * The file is append-only and written by another process, so the reader trusts nothing in it: a torn last line, a
 * hand-edited line or a non-object is skipped, never thrown. It streams the file and keeps only the newest `limit`
 * matching rows, so a year of ledger costs a pass, not a year of memory.
 */
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { resolveStateDir } from "../../config/paths.js";

export type FractalLedgerClaim = {
  ref: string;
  kind: "path" | "commit";
  ok: boolean;
  byThisRun: boolean;
  why?: string;
};

/** C2. Every field is optional on read: rows come from another process and older writers. */
export type FractalLedgerRow = {
  v?: number;
  ts?: number;
  parentRunId?: string;
  runId?: string;
  sessionKey?: string;
  model?: string;
  durationMs?: number;
  usage?: { cacheRead?: number; cacheWrite?: number; input?: number; output?: number };
  triggers?: string[];
  writes?: string[];
  commits?: Array<{ sha: string; repo?: string }>;
  claims?: FractalLedgerClaim[];
  verdict?: "acted" | "clean" | "unverified";
  firstLine?: string;
  [k: string]: unknown;
};

export const FRACTAL_LEDGER_DEFAULT_LIMIT = 200;
export const FRACTAL_LEDGER_MAX_LIMIT = 5000;

/** The Fractal's data folder: the ledger, the weekly outcomes and (2026-10-25) the gate's own log live here. */
export function resolveFractalDataDir(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, "data", "fractal");
}

export function resolveFractalLedgerPath(stateDir: string = resolveStateDir()): string {
  return path.join(resolveFractalDataDir(stateDir), "ledger.jsonl");
}

/** C3's params, read without trusting them. */
export function normalizeFractalLedgerParams(raw: unknown): {
  parentRunIds?: string[];
  limit: number;
} {
  const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ids = Array.isArray(p.parentRunIds)
    ? p.parentRunIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : undefined;
  const n =
    typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : Number.NaN;
  const limit = Number.isNaN(n)
    ? FRACTAL_LEDGER_DEFAULT_LIMIT
    : Math.min(FRACTAL_LEDGER_MAX_LIMIT, Math.max(1, n));
  return ids === undefined ? { limit } : { parentRunIds: ids, limit };
}

/** One line to a row, or `undefined` for anything that is not a JSON object. */
export function parseFractalLedgerLine(line: string): FractalLedgerRow | undefined {
  const s = line.trim();
  if (!s || s[0] !== "{") {
    return undefined;
  }
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as FractalLedgerRow) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * C3: the newest `limit` rows, newest last (file order), filtered by `parentRunIds` when given. A missing file is no rows.
 * An empty `parentRunIds` list matches nothing (the caller asked about no run).
 */
export async function readFractalLedger(
  o: { parentRunIds?: string[]; limit?: number; file?: string } = {},
): Promise<{ rows: FractalLedgerRow[] }> {
  const file = o.file ?? resolveFractalLedgerPath();
  const limit = normalizeFractalLedgerParams({ limit: o.limit }).limit;
  const want = o.parentRunIds ? new Set(o.parentRunIds) : undefined;
  if (want && want.size === 0) {
    return { rows: [] };
  }
  const rows: FractalLedgerRow[] = [];
  const stream = createReadStream(file, { encoding: "utf-8" });
  try {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const row = parseFractalLedgerLine(line);
      if (!row) {
        continue;
      }
      if (want && !(typeof row.parentRunId === "string" && want.has(row.parentRunId))) {
        continue;
      }
      rows.push(row);
      // Trim in batches: a shift per row is quadratic on a long file.
      if (rows.length >= limit * 2) {
        rows.splice(0, rows.length - limit);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { rows: [] };
    }
    throw err;
  } finally {
    stream.destroy();
  }
  return { rows: rows.length > limit ? rows.slice(-limit) : rows };
}
