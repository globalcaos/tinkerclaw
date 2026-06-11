/**
 * FORK: Parallel Fractal Reflection — append-only JSONL results ledger.
 *
 * Bible §5.67b "Result store" (don't-regress): the run-context store CANNOT
 * back `fractal.byRunId` — it refuses writes for closed runs and is cleared
 * on the parent's terminal event, while the fractal result only exists
 * 30–120s AFTER R_main ends. The store is therefore an append-only JSONL
 * ledger at `<dir>/results.jsonl` (the amygdala decisions-log pattern from
 * extensions/tinkerclaw-learned-intuition), restart-safely backing the
 * `fractal.byRunId` / `fractal.feed` / `fractal.stats` RPCs.
 *
 * The CALLER resolves the directory (e.g. `<stateDir>/fractal`); this module
 * stays free of plugin-api imports so it unit-tests cleanly.
 *
 * Readers scan the LIVE file only — rotated `results-<ISOdate>.jsonl` files
 * are archives: kept forever, never read back by this module.
 */

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { FractalRow } from "./types.js";

const LOG_TAG = "[fractal-ledger]";
const HOUR_MS = 3_600_000;

/** Live ledger file name inside the ledger directory. */
export const LEDGER_FILENAME = "results.jsonl";

/**
 * Rotation CEILING for the live file (design-principles #19: a documented
 * safety ceiling, never a tuned working bound). Derivation: rows serialize
 * to ~0.5–1.5 KB, so 5 MB keeps roughly 3k–10k rows — months of always-fire
 * turns — in the live file, which readers scan linearly on every RPC. The
 * ceiling bounds read cost without deleting data: on breach the live file is
 * renamed to `results-<ISOdate>.jsonl` (an archive) and a fresh file starts.
 */
export const LEDGER_ROTATE_BYTES_CEILING = 5 * 1024 * 1024;

/** The KPI set that DEFINES "contributing" (bible §5.67b Result store). */
export interface FractalLedgerStats {
  /** Rows in the window that actually fired (status ≠ skipped). */
  fires: number;
  /**
   * Fire/skip histogram. Keyed by status, except skipped rows which are
   * keyed `skipped:<reason>` so every skip carries its reason arm (#12).
   */
  byStatus: Record<string, number>;
  /** escalated rows / fires (0 when no fires). */
  escalationRate: number;
  /** Of escalated rows, fraction ending in a completed fix (acted|applied). */
  fixYield: number;
  /** abstained rows / fires (0 when no fires). */
  abstainRate: number;
  /**
   * cacheRead / (input + cacheRead + cacheWrite), summed over non-skipped
   * (triage) rows carrying usage — the standing prefix-stability regression
   * detector (bible §5.67b).
   */
  warmRatio: number;
  /** Nearest-rank p50 of timeToDockMs over rows reporting it (0 when none). */
  p50TimeToDockMs: number;
  /** Nearest-rank p95 of timeToDockMs over rows reporting it (0 when none). */
  p95TimeToDockMs: number;
  /** Rows / distinct parentRunIds in window (≈1 healthy; >1 = double-fire). */
  rowsPerTurn: number;
}

interface LedgerUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Tolerant timestamp read: epoch-ms number or ISO string; 0 if unparseable. */
function rowTimeMs(row: FractalRow): number {
  const ts = (row as { ts?: number | string }).ts;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts;
  }
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}

/** Nearest-rank percentile over a pre-sorted ascending array (0 when empty). */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx] ?? 0;
}

/**
 * Append-only JSONL results ledger for fractal reflection rows.
 *
 * Writes are serialized through an internal promise chain (the rotation
 * check and the append never interleave within this process) and each row is
 * ONE `fs.appendFile` call, which opens with O_APPEND — appends never tear a
 * line. Readers tolerate a torn/corrupt line (e.g. crash mid-append) by
 * skipping it.
 */
export class FractalLedger {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly rotateBytesCeiling: number;
  private dirReady = false;
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param dir Explicit ledger directory (caller resolves `<stateDir>/fractal`).
   * @param opts.rotateBytesCeiling Test seam only — production uses the
   *   documented {@link LEDGER_ROTATE_BYTES_CEILING}.
   */
  constructor(dir: string, opts: { rotateBytesCeiling?: number } = {}) {
    this.dir = dir;
    this.filePath = join(dir, LEDGER_FILENAME);
    this.rotateBytesCeiling = opts.rotateBytesCeiling ?? LEDGER_ROTATE_BYTES_CEILING;
  }

  /**
   * Append one row as one JSONL line. NEVER throws upward — a ledger failure
   * must not break the reflection cycle; errors log tagged [fractal-ledger].
   */
  append(row: FractalRow): Promise<void> {
    const task = this.writeChain
      .then(() => this.appendUnsafe(row))
      .catch((err) => {
        console.error(`${LOG_TAG} append failed:`, err);
      });
    this.writeChain = task;
    return task;
  }

  /** Latest row for a parent (main-turn) runId — last matching line wins. */
  async byParentRunId(runId: string): Promise<FractalRow | undefined> {
    const rows = await this.readRows();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row && row.parentRunId === runId) {
        return row;
      }
    }
    return undefined;
  }

  /** Recent rows, newest-first; optional filter applies before the limit. */
  async feed(limit: number, filter?: (row: FractalRow) => boolean): Promise<FractalRow[]> {
    if (limit <= 0) {
      return [];
    }
    const rows = await this.readRows();
    const matched = filter ? rows.filter(filter) : rows;
    return matched.slice(-limit).reverse();
  }

  /** KPI aggregate over rows whose `ts` falls inside the trailing window. */
  async stats(windowHours: number): Promise<FractalLedgerStats> {
    const cutoff = Date.now() - windowHours * HOUR_MS;
    const rows = (await this.readRows()).filter((row) => rowTimeMs(row) >= cutoff);

    const byStatus: Record<string, number> = {};
    const parents = new Set<string>();
    let fires = 0;
    let escalatedCount = 0;
    let abstainedCount = 0;
    let fixedCount = 0;
    let cacheReadSum = 0;
    let warmDenominator = 0;
    const dockTimes: number[] = [];

    for (const row of rows) {
      const status = String(row.status ?? "unknown");
      const skipReason = (row as { skipReason?: string }).skipReason;
      const key = status === "skipped" ? `skipped:${skipReason ?? "unknown"}` : status;
      byStatus[key] = (byStatus[key] ?? 0) + 1;
      if (row.parentRunId) {
        parents.add(String(row.parentRunId));
      }
      if (status === "skipped") {
        continue;
      }
      fires += 1;
      if (row.escalated) {
        escalatedCount += 1;
      }
      if (row.abstained) {
        abstainedCount += 1;
      }
      if (status === "acted" || status === "applied") {
        fixedCount += 1;
      }
      const usage = row.usage as LedgerUsage | undefined;
      if (usage) {
        cacheReadSum += usage.cacheRead ?? 0;
        warmDenominator += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      }
      const dock = (row as { timeToDockMs?: number }).timeToDockMs;
      if (typeof dock === "number" && Number.isFinite(dock)) {
        dockTimes.push(dock);
      }
    }

    dockTimes.sort((a, b) => a - b);
    return {
      fires,
      byStatus,
      escalationRate: fires > 0 ? escalatedCount / fires : 0,
      fixYield: escalatedCount > 0 ? fixedCount / escalatedCount : 0,
      abstainRate: fires > 0 ? abstainedCount / fires : 0,
      warmRatio: warmDenominator > 0 ? cacheReadSum / warmDenominator : 0,
      p50TimeToDockMs: percentile(dockTimes, 50),
      p95TimeToDockMs: percentile(dockTimes, 95),
      rowsPerTurn: parents.size > 0 ? rows.length / parents.size : 0,
    };
  }

  /**
   * Number of prior NON-skipped rows containing a finding with the same
   * kind+path — the §5.67b recurrence signal ("fix the column, not the
   * cell"); the triage runner stamps this onto new rows.
   */
  async recurrenceCount(kind: string, path: string): Promise<number> {
    const rows = await this.readRows();
    let count = 0;
    for (const row of rows) {
      if (String(row.status) === "skipped") {
        continue;
      }
      const findings = row.findings as
        | Array<{ kind?: string; evidence?: { path?: string } }>
        | undefined;
      if (!Array.isArray(findings)) {
        continue;
      }
      if (findings.some((f) => f?.kind === kind && f?.evidence?.path === path)) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * §5.67b negative-evidence detector: the watchdog only converts stubs that
   * EXIST — a dead handler / unloaded plugin / lost enable flag emits no row
   * at all. Under always-fire every main turn yields exactly one ledger row,
   * so `mainTurnCount − rows-in-window > 0` means silent non-fires. The
   * caller supplies the INDEPENDENT main-turn count (e.g. reconciled from
   * the main session jsonl) — the ledger never counts its own liveness. A
   * negative result is also a signal (double-fires), so it is NOT clamped.
   */
  async missedTurns(mainTurnCount: number, windowHours: number): Promise<number> {
    const cutoff = Date.now() - windowHours * HOUR_MS;
    const rows = (await this.readRows()).filter((row) => rowTimeMs(row) >= cutoff);
    return mainTurnCount - rows.length;
  }

  // -- internals ------------------------------------------------------------

  private async appendUnsafe(row: FractalRow): Promise<void> {
    if (!this.dirReady) {
      await fsp.mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    await this.rotateIfOversized();
    // O_APPEND atomicity: one serialized line per appendFile call.
    await fsp.appendFile(this.filePath, `${JSON.stringify(row)}\n`, "utf8");
  }

  private async rotateIfOversized(): Promise<void> {
    let size = 0;
    try {
      size = (await fsp.stat(this.filePath)).size;
    } catch {
      return; // no live file yet — nothing to rotate
    }
    if (size <= this.rotateBytesCeiling) {
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    let archivePath = join(this.dir, `results-${stamp}.jsonl`);
    for (let n = 2; n < 1000; n += 1) {
      try {
        await fsp.access(archivePath);
      } catch {
        break; // free slot
      }
      archivePath = join(this.dir, `results-${stamp}-${n}.jsonl`);
    }
    await fsp.rename(this.filePath, archivePath);
  }

  /**
   * Parse the LIVE file (rotated archives are never read back). ENOENT is an
   * empty ledger; corrupt lines are skipped so one torn write cannot poison
   * every reader-backed RPC.
   */
  private async readRows(): Promise<FractalRow[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return [];
      }
      console.error(`${LOG_TAG} read failed:`, err);
      return [];
    }
    const rows: FractalRow[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        rows.push(JSON.parse(trimmed) as FractalRow);
      } catch {
        console.error(`${LOG_TAG} skipping corrupt ledger line`);
      }
    }
    return rows;
  }
}
