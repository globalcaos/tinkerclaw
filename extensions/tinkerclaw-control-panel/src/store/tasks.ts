/**
 * FORK: tinkerclaw-control-panel — task CRUD + diff-aware import.
 *
 * All task operations live here. The RPC layer (src/rpcs/tasks.ts) is a thin
 * shell that validates params and calls these functions; the auto-resolver
 * watcher and the briefing-import path both consume this module too.
 */
import type Database from "better-sqlite3";
import type { ControlPanelResolvedConfig } from "../paths.js";
import { getDb } from "./db.js";

export type TaskStatus =
  | "open"
  | "in_progress"
  | "resolved"
  | "dropped"
  | "dismissed"
  // v3.3 — user-snoozed indefinitely. Hidden from default filters; still
  // belongs to its axis; restored by setting status back to 'open'.
  | "back_burner";

export type TaskAxis = "online" | "family" | "me" | "serra" | "meta";

export type DismissalKind =
  | "not_a_task"
  | "not_relevant"
  | "wrong_priority"
  | "duplicate"
  | "out_of_scope"
  | "other";

export type Hands = "user" | "assistant" | "either";

export type TaskRow = {
  id: string;
  text: string;
  context_md: string | null;
  status: TaskStatus;
  source: string;
  source_ref: string | null;
  briefing_pass_id: string | null;
  priority_axis: TaskAxis | null;
  priority_rank: number;
  carry_days: number;
  age_seconds: number;
  due_date: string | null;
  dismissal_kind: DismissalKind | null;
  dismissal_note: string | null;
  est_minutes: number | null;
  hands: Hands | null;
  inferred_signal_json: string | null;
  metadata_json: string | null;
  recurrence_rule_text: string | null;
  recurrence_parent_id: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  // v3.6 (FORK 2026-05-26) — when the task was moved to a deletion state
  // ('dropped' / 'dismissed'). Null on live entries.
  deleted_at: number | null;
};

export type TaskListFilter = {
  status?: TaskStatus | TaskStatus[];
  axis?: TaskAxis | TaskAxis[];
  briefing_pass_id?: string;
  due_date_filter?: "today" | "upcoming" | "all" | "overdue";
  since_ts?: number;
  limit?: number;
  // FORK 2026-05-26 (task-mpkw1a0b adjacent): default-hidden filter for the
  // post-/clear era. When `false` (or omitted), the default behaviour is:
  //   - hide deleted entries (deleted_at IS NOT NULL)
  //   - hide resolved entries older than 24h (resolved_at < now - 86400000)
  // When `true`, ALL rows return regardless. Use this when restoring a
  // deleted task or auditing the history.
  includeHidden?: boolean;
};

const RESOLVED_VISIBILITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type TaskAddInput = {
  id?: string;
  text: string;
  context_md?: string | null;
  source?: string;
  source_ref?: string | null;
  briefing_pass_id?: string | null;
  priority_axis?: TaskAxis | null;
  priority_rank?: number;
  due_date?: string | null;
  est_minutes?: number | null;
  hands?: Hands | null;
  inferred_signal?: unknown;
  metadata?: unknown;
  recurrence_rule_text?: string | null;
  recurrence_parent_id?: string | null;
};

export type TaskUpdateInput = {
  id: string;
  status?: TaskStatus;
  text?: string;
  context_md?: string | null;
  priority_axis?: TaskAxis | null;
  priority_rank?: number;
  due_date?: string | null;
  est_minutes?: number | null;
  hands?: Hands | null;
  inferred_signal?: unknown;
  metadata?: unknown;
  note?: string;
};

export type TaskEventKind =
  | "created"
  | "status_changed"
  | "note"
  | "auto_resolved"
  | "dismissed"
  | "rescheduled"
  | "context_added"
  | "imported";

function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function ensureUnixMs(): number {
  return Date.now();
}

function recordEvent(
  db: Database.Database,
  taskId: string,
  kind: TaskEventKind,
  payload?: unknown,
) {
  db.prepare(`INSERT INTO task_event (task_id, ts, kind, payload_json) VALUES (?, ?, ?, ?)`).run(
    taskId,
    ensureUnixMs(),
    kind,
    payload === undefined ? null : JSON.stringify(payload),
  );
}

export function addTask(cfg: ControlPanelResolvedConfig, input: TaskAddInput): TaskRow {
  const db = getDb(cfg);
  const now = ensureUnixMs();
  const id =
    input.id?.trim() || `task-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  db.prepare(
    `INSERT INTO task (
      id, text, context_md, status, source, source_ref, briefing_pass_id,
      priority_axis, priority_rank, carry_days, age_seconds, due_date,
      est_minutes, hands, inferred_signal_json, metadata_json,
      recurrence_rule_text, recurrence_parent_id, created_at, updated_at
    ) VALUES (
      @id, @text, @context_md, 'open', @source, @source_ref, @briefing_pass_id,
      @priority_axis, @priority_rank, 0, 0, @due_date,
      @est_minutes, @hands, @inferred_signal_json, @metadata_json,
      @recurrence_rule_text, @recurrence_parent_id, @now, @now
    )
    ON CONFLICT(id) DO UPDATE SET
      text = excluded.text,
      context_md = excluded.context_md,
      source_ref = excluded.source_ref,
      briefing_pass_id = COALESCE(excluded.briefing_pass_id, task.briefing_pass_id),
      priority_axis = excluded.priority_axis,
      priority_rank = excluded.priority_rank,
      due_date = excluded.due_date,
      est_minutes = excluded.est_minutes,
      hands = excluded.hands,
      inferred_signal_json = excluded.inferred_signal_json,
      metadata_json = excluded.metadata_json,
      recurrence_rule_text = excluded.recurrence_rule_text,
      recurrence_parent_id = excluded.recurrence_parent_id,
      updated_at = @now
    `,
  ).run({
    id,
    text: input.text,
    context_md: input.context_md ?? null,
    source: input.source ?? "manual",
    source_ref: input.source_ref ?? null,
    briefing_pass_id: input.briefing_pass_id ?? null,
    priority_axis: input.priority_axis ?? null,
    priority_rank: input.priority_rank ?? 50,
    due_date: input.due_date ?? null,
    est_minutes: input.est_minutes ?? null,
    hands: input.hands ?? null,
    inferred_signal_json:
      input.inferred_signal === undefined ? null : JSON.stringify(input.inferred_signal),
    metadata_json: input.metadata === undefined ? null : JSON.stringify(input.metadata),
    recurrence_rule_text: input.recurrence_rule_text ?? null,
    recurrence_parent_id: input.recurrence_parent_id ?? null,
    now,
  });

  recordEvent(db, id, "created", { source: input.source ?? "manual" });
  const row = getTaskById(cfg, id);
  if (!row) throw new Error(`[control-panel] addTask: failed to read back inserted row ${id}`);
  return row;
}

export function getTaskById(cfg: ControlPanelResolvedConfig, id: string): TaskRow | null {
  const db = getDb(cfg);
  const row = db.prepare(`SELECT * FROM task WHERE id = ?`).get(id) as TaskRow | undefined;
  if (!row) return null;
  return withComputedAge(row);
}

export function listTasks(cfg: ControlPanelResolvedConfig, filter: TaskListFilter = {}): TaskRow[] {
  const db = getDb(cfg);
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    where.push(`status IN (${statuses.map((_, i) => `@status${i}`).join(",")})`);
    statuses.forEach((s, i) => {
      params[`status${i}`] = s;
    });
  }
  if (filter.axis) {
    const axes = Array.isArray(filter.axis) ? filter.axis : [filter.axis];
    where.push(`priority_axis IN (${axes.map((_, i) => `@axis${i}`).join(",")})`);
    axes.forEach((a, i) => {
      params[`axis${i}`] = a;
    });
  }
  if (filter.briefing_pass_id) {
    where.push(`briefing_pass_id = @briefing_pass_id`);
    params.briefing_pass_id = filter.briefing_pass_id;
  }
  if (filter.since_ts !== undefined) {
    where.push(`updated_at >= @since_ts`);
    params.since_ts = filter.since_ts;
  }
  if (filter.due_date_filter) {
    const today = todayISO();
    switch (filter.due_date_filter) {
      case "today":
        where.push(`(due_date IS NULL OR due_date <= @today)`);
        params.today = today;
        break;
      case "upcoming":
        where.push(`due_date > @today`);
        params.today = today;
        break;
      case "overdue":
        where.push(
          `due_date IS NOT NULL AND due_date < @today AND status IN ('open','in_progress')`,
        );
        params.today = today;
        break;
      case "all":
      default:
        break;
    }
  }

  // FORK 2026-05-26 (task-mpkw1a0b-9jsfy follow-on, user instruction:
  // "I don't want to see [deleted tasks] anywhere. At the same time,
  // the completed tasks should disappear the day after they have been
  // completed.")
  //
  // Default-hide:
  //   - deleted (deleted_at IS NOT NULL — anything moved to 'dropped' /
  //     'dismissed' since the deleted_at backfill at boot)
  //   - resolved entries whose resolved_at is older than 24h
  //
  // Override via filter.includeHidden = true (Jarvis recovery paths,
  // history audits). Override via explicit filter.status (the caller
  // is asking for a specific status; we respect their selection rather
  // than apply the cover filter on top — the user knows what they're
  // looking for).
  if (!filter.includeHidden && !filter.status) {
    where.push(`deleted_at IS NULL`);
    where.push(
      `(status != 'resolved' OR resolved_at IS NULL OR resolved_at >= @resolved_visibility_floor)`,
    );
    params.resolved_visibility_floor = Date.now() - RESOLVED_VISIBILITY_WINDOW_MS;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT * FROM task ${whereSql} ORDER BY
         CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'resolved' THEN 2 WHEN 'dropped' THEN 3 ELSE 4 END,
         priority_axis,
         priority_rank,
         updated_at DESC
       LIMIT ${Number(limit)}`,
    )
    .all(params) as TaskRow[];

  return rows.map(withComputedAge);
}

export function updateTask(cfg: ControlPanelResolvedConfig, input: TaskUpdateInput): TaskRow {
  const db = getDb(cfg);
  const existing = getTaskById(cfg, input.id);
  if (!existing) throw new Error(`[control-panel] updateTask: no task with id ${input.id}`);

  const now = ensureUnixMs();
  const fields: string[] = [];
  const params: Record<string, unknown> = { id: input.id, now };

  const statusChanged = input.status !== undefined && input.status !== existing.status;

  for (const [key, value] of Object.entries(input)) {
    if (key === "id" || key === "note" || value === undefined) continue;
    if (key === "inferred_signal") {
      fields.push(`inferred_signal_json = @inferred_signal_json`);
      params.inferred_signal_json = value === null ? null : JSON.stringify(value);
      continue;
    }
    if (key === "metadata") {
      fields.push(`metadata_json = @metadata_json`);
      params.metadata_json = value === null ? null : JSON.stringify(value);
      continue;
    }
    fields.push(`${key} = @${key}`);
    params[key] = value;
  }
  fields.push(`updated_at = @now`);
  if (statusChanged && input.status === "resolved") {
    fields.push(`resolved_at = @now`);
  } else if (statusChanged && input.status !== "resolved" && existing.status === "resolved") {
    fields.push(`resolved_at = NULL`);
  }
  // FORK 2026-05-26 — stamp deleted_at on transition INTO 'dropped' /
  // 'dismissed'; clear it on transition OUT. Used by listTasks' default
  // hidden filter to keep deleted tasks invisible across all views while
  // the row stays recoverable on disk.
  const DELETED_STATUSES = new Set(["dropped", "dismissed"]);
  const wasDeleted = DELETED_STATUSES.has(existing.status);
  const willBeDeleted = input.status !== undefined && DELETED_STATUSES.has(input.status);
  if (statusChanged && willBeDeleted && !wasDeleted) {
    fields.push(`deleted_at = @now`);
  } else if (statusChanged && wasDeleted && !willBeDeleted) {
    fields.push(`deleted_at = NULL`);
  }

  if (fields.length === 1) {
    return existing;
  }

  db.prepare(`UPDATE task SET ${fields.join(", ")} WHERE id = @id`).run(params);

  if (statusChanged) {
    recordEvent(db, input.id, "status_changed", {
      from: existing.status,
      to: input.status,
      note: input.note,
    });
  } else if (input.note) {
    recordEvent(db, input.id, "note", { note: input.note });
  }

  const row = getTaskById(cfg, input.id);
  if (!row) throw new Error(`[control-panel] updateTask: failed to read back ${input.id}`);
  return row;
}

export function dismissTask(
  cfg: ControlPanelResolvedConfig,
  id: string,
  dismissal_kind: DismissalKind,
  dismissal_note?: string,
): TaskRow {
  const db = getDb(cfg);
  const existing = getTaskById(cfg, id);
  if (!existing) throw new Error(`[control-panel] dismissTask: no task with id ${id}`);

  const now = ensureUnixMs();
  db.prepare(
    `UPDATE task SET status = 'dismissed', dismissal_kind = @kind, dismissal_note = @note, updated_at = @now WHERE id = @id`,
  ).run({ id, kind: dismissal_kind, note: dismissal_note ?? null, now });

  recordEvent(db, id, "dismissed", { dismissal_kind, dismissal_note });
  const row = getTaskById(cfg, id);
  if (!row) throw new Error(`[control-panel] dismissTask: failed to read back ${id}`);
  return row;
}

export function rescheduleTask(
  cfg: ControlPanelResolvedConfig,
  id: string,
  due_date: string,
): TaskRow {
  const db = getDb(cfg);
  const existing = getTaskById(cfg, id);
  if (!existing) throw new Error(`[control-panel] rescheduleTask: no task with id ${id}`);

  const now = ensureUnixMs();
  db.prepare(`UPDATE task SET due_date = @due_date, updated_at = @now WHERE id = @id`).run({
    id,
    due_date,
    now,
  });

  recordEvent(db, id, "rescheduled", { from: existing.due_date, to: due_date });
  const row = getTaskById(cfg, id);
  if (!row) throw new Error(`[control-panel] rescheduleTask: failed to read back ${id}`);
  return row;
}

export function removeTask(cfg: ControlPanelResolvedConfig, id: string): boolean {
  const db = getDb(cfg);
  const result = db.prepare(`DELETE FROM task WHERE id = ?`).run(id);
  return result.changes > 0;
}

export type TaskProgress = {
  pass_id: string | null;
  denominator: number;
  numerator: number;
  by_axis: Array<{ axis: TaskAxis | "unknown"; denominator: number; numerator: number }>;
};

export function getProgress(cfg: ControlPanelResolvedConfig, passId?: string | null): TaskProgress {
  const db = getDb(cfg);
  let resolvedPassId = passId ?? null;
  if (!resolvedPassId) {
    // Latest delivered-to-user pass for today.
    const today = todayISO();
    const row = db
      .prepare(
        `SELECT id FROM briefing_pass
         WHERE date = ? AND delivered_to_user_at IS NOT NULL
         ORDER BY pass_number ASC LIMIT 1`,
      )
      .get(today) as { id: string } | undefined;
    resolvedPassId = row?.id ?? null;
  }

  if (!resolvedPassId) {
    return { pass_id: null, denominator: 0, numerator: 0, by_axis: [] };
  }

  // FORK 2026-05-13 — dismiss/drop merged into a single "deleted" affordance
  // in the UI. Progress math collapses with it: deleted tasks (both legacy
  // 'dismissed' and new 'dropped') leave the pass entirely (denom -1, num
  // unchanged). 'resolved' is the only numerator contributor. Honest reading
  // of "how many of today's tasks did I actually complete" — deleted ≠ done.
  const overall = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('dropped','dismissed')) AS denom,
         COUNT(*) FILTER (WHERE status = 'resolved') AS num
       FROM task WHERE briefing_pass_id = ?`,
    )
    .get(resolvedPassId) as { denom: number; num: number };

  const byAxisRows = db
    .prepare(
      `SELECT COALESCE(priority_axis, 'unknown') AS axis,
         COUNT(*) FILTER (WHERE status NOT IN ('dropped','dismissed')) AS denom,
         COUNT(*) FILTER (WHERE status = 'resolved') AS num
       FROM task WHERE briefing_pass_id = ?
       GROUP BY priority_axis`,
    )
    .all(resolvedPassId) as Array<{ axis: TaskAxis | "unknown"; denom: number; num: number }>;

  return {
    pass_id: resolvedPassId,
    denominator: overall.denom,
    numerator: overall.num,
    by_axis: byAxisRows.map((r) => ({
      axis: r.axis,
      denominator: r.denom,
      numerator: r.num,
    })),
  };
}

function withComputedAge(row: TaskRow): TaskRow {
  const ageMs = Date.now() - row.created_at;
  return { ...row, age_seconds: Math.max(0, Math.floor(ageMs / 1000)) };
}
