/**
 * FORK: tinkerclaw-control-panel — metric definitions + observations.
 *
 * Writes to the metric_definition + observation tables. Used by both LIVE
 * (in-process record) and SNAPSHOT (cron-scheduled poll) ingest paths, and
 * by the query RPCs for the inline-graph + Exec graphs section.
 */
import type { ControlPanelResolvedConfig } from "../paths.js";
import { getDb } from "./db.js";

export type MetricClass = "LIVE" | "SNAPSHOT";

export type MetricTemplate = "sparkline" | "single-stat" | "traffic-light" | "streak" | "bar-trend";

export type MetricDefinition = {
  id: string;
  class: MetricClass;
  source: string;
  cadence_seconds: number | null;
  template: MetricTemplate;
  labels_schema: string | null;
  alert_rule_json: string | null;
  retention_days: number;
  created_at: number;
  updated_at: number;
};

export type ObservationInput = {
  metric_id: string;
  value: number;
  ts?: number;
  labels?: Record<string, unknown>;
};

export function addMetric(
  cfg: ControlPanelResolvedConfig,
  input: {
    id: string;
    class: MetricClass;
    source: string;
    cadence_seconds?: number | null;
    template?: MetricTemplate;
    labels_schema?: unknown;
    alert_rule?: unknown;
    retention_days?: number;
  },
): MetricDefinition {
  const db = getDb(cfg);
  const now = Date.now();
  db.prepare(
    `INSERT INTO metric_definition (id, class, source, cadence_seconds, template, labels_schema, alert_rule_json, retention_days, created_at, updated_at)
     VALUES (@id, @class, @source, @cadence_seconds, @template, @labels_schema, @alert_rule_json, @retention_days, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       class = excluded.class,
       source = excluded.source,
       cadence_seconds = excluded.cadence_seconds,
       template = excluded.template,
       labels_schema = excluded.labels_schema,
       alert_rule_json = excluded.alert_rule_json,
       retention_days = excluded.retention_days,
       updated_at = @now`,
  ).run({
    id: input.id,
    class: input.class,
    source: input.source,
    cadence_seconds: input.cadence_seconds ?? null,
    template: input.template ?? "sparkline",
    labels_schema: input.labels_schema === undefined ? null : JSON.stringify(input.labels_schema),
    alert_rule_json: input.alert_rule === undefined ? null : JSON.stringify(input.alert_rule),
    retention_days: input.retention_days ?? 90,
    now,
  });
  const row = db
    .prepare(`SELECT * FROM metric_definition WHERE id = ?`)
    .get(input.id) as MetricDefinition;
  return row;
}

export function listMetrics(cfg: ControlPanelResolvedConfig): MetricDefinition[] {
  const db = getDb(cfg);
  return db.prepare(`SELECT * FROM metric_definition ORDER BY id`).all() as MetricDefinition[];
}

export function recordObservation(cfg: ControlPanelResolvedConfig, input: ObservationInput): void {
  const db = getDb(cfg);
  const ts = input.ts ?? Date.now();
  db.prepare(
    `INSERT INTO observation (metric_id, ts, value, labels_json) VALUES (?, ?, ?, ?)
     ON CONFLICT (metric_id, ts) DO UPDATE SET value = excluded.value, labels_json = excluded.labels_json`,
  ).run(
    input.metric_id,
    ts,
    input.value,
    input.labels === undefined ? null : JSON.stringify(input.labels),
  );
}

export type ObservationRow = {
  metric_id: string;
  ts: number;
  value: number;
  labels_json: string | null;
};

export function queryObservations(
  cfg: ControlPanelResolvedConfig,
  params: { metric_id: string; from_ts?: number; to_ts?: number; limit?: number },
): ObservationRow[] {
  const db = getDb(cfg);
  const where: string[] = [`metric_id = @metric_id`];
  const qp: Record<string, unknown> = { metric_id: params.metric_id };
  if (params.from_ts !== undefined) {
    where.push(`ts >= @from_ts`);
    qp.from_ts = params.from_ts;
  }
  if (params.to_ts !== undefined) {
    where.push(`ts <= @to_ts`);
    qp.to_ts = params.to_ts;
  }
  const limit = params.limit ?? 1000;
  return db
    .prepare(
      `SELECT * FROM observation WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ${Number(limit)}`,
    )
    .all(qp) as ObservationRow[];
}
