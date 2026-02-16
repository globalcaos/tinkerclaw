/**
 * ENGRAM Phase 0A: Unified metrics collector.
 * Append-only JSONL log for all cognitive architecture metrics.
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface MetricEntry {
	timestamp: string;
	phase: string;
	metric_name: string;
	value: number;
	metadata?: Record<string, unknown>;
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
	const d = date ?? new Date().toISOString().slice(0, 10);
	return join(metricsDir(baseDir), `${d}.jsonl`);
}

export function createMetricsCollector(options?: { baseDir?: string; date?: string }): MetricsCollector {
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
		},

		readAll(options?: { phase?: string; since?: string; until?: string }): MetricEntry[] {
			if (!existsSync(filePath)) {return [];}
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
	if (!existsSync(dir)) {return [];}

	const { readdirSync } = require("node:fs") as typeof import("node:fs");
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
	if (options?.phase) {entries = entries.filter((e) => e.phase === options.phase);}
	if (options?.since) {entries = entries.filter((e) => e.timestamp >= options.since!);}
	if (options?.until) {entries = entries.filter((e) => e.timestamp <= options.until!);}

	return entries;
}
