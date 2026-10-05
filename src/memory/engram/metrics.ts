/**
 * ENGRAM Phase 0A: Unified metrics collector.
 * Append-only JSONL log for all cognitive architecture metrics.
 *
 * FORK 2026-09-25 — DUAL-WRITE into the events database (TINKER_UI_DESIGN_BIBLE/logging.md
 * §4.11, §9 step 9): every record() is ALSO one `engram.metric` row — label `phase/metric_name`,
 * n1 = value, the entry's own timestamp. The per-day file is written exactly as before. `metadata`
 * is NOT carried: the catalog row declares no fields, and the events store holds no undeclared
 * key (L4). scripts/events-backfill.ts imports the per-day files that predate the bridge through
 * the same builder (engramMetricEvent).
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { emitEvent, type EmitEventRecord } from "../../infra/events/emit.js";

export interface MetricEntry {
  timestamp: string;
  phase: string;
  metric_name: string;
  value: number;
  metadata?: Record<string, unknown>;
}

/** The events-database name of a collector entry (logging.md §4.11). */
export const ENGRAM_METRIC_EVENT = "engram.metric";

/**
 * The `engram.metric` row for one collector entry: label `phase/metric_name`, n1 = value, the
 * entry's own timestamp. ONE builder for record() and for scripts/events-backfill.ts, so a line
 * yields the same row whichever path writes it. `metadata` is deliberately absent (see header).
 */
export function engramMetricEvent(entry: MetricEntry): EmitEventRecord {
  return {
    tsMs: Date.parse(entry.timestamp),
    label: `${entry.phase}/${entry.metric_name}`,
    n1: entry.value,
  };
}

export interface MetricsCollector {
  record(phase: string, name: string, value: number, meta?: Record<string, unknown>): void;
  readAll(options?: { phase?: string; since?: string; until?: string }): MetricEntry[];
  readonly filePath: string;
}

function metricsDir(baseDir?: string): string {
  return baseDir ?? join(homedir(), ".openclaw", "metrics");
}

function metricsFilePath(baseDir?: string, date?: string): string {
  const dateStr = date ?? new Date().toISOString().slice(0, 10);
  return join(metricsDir(baseDir), `${dateStr}.jsonl`);
}

export function createMetricsCollector(options?: {
  baseDir?: string;
  date?: string;
}): MetricsCollector {
  const filePath = metricsFilePath(options?.baseDir, options?.date);
  mkdirSync(dirname(filePath), { recursive: true });

  return {
    filePath,

    record(phase: string, name: string, value: number, meta?: Record<string, unknown>): void {
      const entry: MetricEntry = {
        timestamp: new Date().toISOString(),
        phase,
        metric_name: name,
        value,
        ...(meta ? { metadata: meta } : {}),
      };
      appendFileSync(filePath, JSON.stringify(entry) + "\n");
      // The events row (logging.md §4.11): O(1), never throws, never touches the disk (§7.5).
      // After the append, so a throwing append leaves neither store a record and the file stays
      // the reference set while parity is proved.
      emitEvent(ENGRAM_METRIC_EVENT, engramMetricEvent(entry));
    },

    readAll(options?: { phase?: string; since?: string; until?: string }): MetricEntry[] {
      if (!existsSync(filePath)) {
        return [];
      }
      const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
      let entries = lines.map((l) => JSON.parse(l) as MetricEntry);

      if (options?.phase) {
        entries = entries.filter((e) => e.phase === options.phase);
      }
      if (options?.since) {
        entries = entries.filter((e) => e.timestamp >= options.since!);
      }
      if (options?.until) {
        entries = entries.filter((e) => e.timestamp <= options.until!);
      }

      return entries;
    },
  };
}

/**
 * Read metrics across multiple date files in a directory.
 */
export function readMetricsRange(
  baseDir: string,
  options?: { phase?: string; since?: string; until?: string },
): MetricEntry[] {
  const dir = metricsDir(baseDir);
  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir)
    .filter((f: string) => f.endsWith(".jsonl"))
    .toSorted();

  const all: MetricEntry[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      all.push(JSON.parse(line) as MetricEntry);
    }
  }

  let entries = all;
  if (options?.phase) {
    entries = entries.filter((e) => e.phase === options.phase);
  }
  if (options?.since) {
    entries = entries.filter((e) => e.timestamp >= options.since!);
  }
  if (options?.until) {
    entries = entries.filter((e) => e.timestamp <= options.until!);
  }

  return entries;
}
