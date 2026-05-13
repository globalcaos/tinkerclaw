/**
 * FORK: tinkerclaw-control-panel — task_axis CRUD (v3.3).
 *
 * Replaces the prior hardcoded `EXEC_AXIS_ORDER` constant in tinker-ui by
 * promoting categories to a real DB-backed taxonomy. The store is owned by
 * the user — add/edit/delete/reorder via gateway RPCs (src/gateway.ts).
 */
import type { ControlPanelResolvedConfig } from "../paths.js";
import { getDb } from "./db.js";

export type TaskAxisRow = {
  id: string;
  label: string;
  position: number;
  created_at: number;
  updated_at: number;
};

export type AxisAddInput = {
  id: string;
  label: string;
  position?: number;
};

export type AxisUpdateInput = {
  id: string;
  label?: string;
  position?: number;
};

const now = (): number => Date.now();

export function listAxes(cfg: ControlPanelResolvedConfig): TaskAxisRow[] {
  const db = getDb(cfg);
  return db
    .prepare(
      "SELECT id, label, position, created_at, updated_at FROM task_axis ORDER BY position ASC, id ASC",
    )
    .all() as TaskAxisRow[];
}

export function getAxisById(cfg: ControlPanelResolvedConfig, id: string): TaskAxisRow | null {
  const db = getDb(cfg);
  const row = db
    .prepare("SELECT id, label, position, created_at, updated_at FROM task_axis WHERE id = ?")
    .get(id) as TaskAxisRow | undefined;
  return row ?? null;
}

export function addAxis(cfg: ControlPanelResolvedConfig, input: AxisAddInput): TaskAxisRow {
  const db = getDb(cfg);
  if (!input.id.trim()) throw new Error("[control-panel] addAxis: id required");
  if (!input.label.trim()) throw new Error("[control-panel] addAxis: label required");
  const existing = getAxisById(cfg, input.id);
  if (existing) throw new Error(`[control-panel] addAxis: axis ${input.id} already exists`);

  // If position omitted, append after current max (so new axes land at the bottom).
  let position = input.position;
  if (position === undefined) {
    const maxRow = db.prepare("SELECT COALESCE(MAX(position), 0) as m FROM task_axis").get() as {
      m: number;
    };
    position = (maxRow.m ?? 0) + 10;
  }

  const ts = now();
  db.prepare(
    "INSERT INTO task_axis (id, label, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(input.id, input.label, position, ts, ts);
  return getAxisById(cfg, input.id)!;
}

export function updateAxis(cfg: ControlPanelResolvedConfig, input: AxisUpdateInput): TaskAxisRow {
  const db = getDb(cfg);
  const existing = getAxisById(cfg, input.id);
  if (!existing) throw new Error(`[control-panel] updateAxis: no axis with id ${input.id}`);
  const fields: string[] = [];
  const params: Record<string, unknown> = { id: input.id, now: now() };
  if (input.label !== undefined) {
    fields.push("label = @label");
    params.label = input.label;
  }
  if (input.position !== undefined) {
    fields.push("position = @position");
    params.position = input.position;
  }
  if (fields.length === 0) return existing;
  fields.push("updated_at = @now");
  db.prepare(`UPDATE task_axis SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getAxisById(cfg, input.id)!;
}

export type AxisDeleteResult = {
  removed: boolean;
  reassigned: number;
};

// Deleting an axis with tasks attached needs a reassignment target — by default
// we reassign to `meta` (the bucket for "no specific category"), but the caller
// can override. If reassign_to is null AND there are tasks attached, refuse.
export function deleteAxis(
  cfg: ControlPanelResolvedConfig,
  id: string,
  reassignTo: string | null = "meta",
): AxisDeleteResult {
  const db = getDb(cfg);
  const existing = getAxisById(cfg, id);
  if (!existing) return { removed: false, reassigned: 0 };

  const attached = (
    db.prepare("SELECT COUNT(*) as n FROM task WHERE priority_axis = ?").get(id) as { n: number }
  ).n;
  if (attached > 0) {
    if (reassignTo === null) {
      throw new Error(
        `[control-panel] deleteAxis: ${id} has ${attached} tasks attached; pass reassign_to or set it to a string`,
      );
    }
    if (reassignTo !== id) {
      // Defensive: never accidentally re-point to the about-to-be-deleted axis.
      const target = getAxisById(cfg, reassignTo);
      if (!target)
        throw new Error(`[control-panel] deleteAxis: reassign target ${reassignTo} does not exist`);
    }
  }

  db.exec("BEGIN");
  try {
    let reassigned = 0;
    if (attached > 0) {
      const res = db
        .prepare("UPDATE task SET priority_axis = ?, updated_at = ? WHERE priority_axis = ?")
        .run(reassignTo, now(), id);
      reassigned = res.changes;
    }
    db.prepare("DELETE FROM task_axis WHERE id = ?").run(id);
    db.exec("COMMIT");
    return { removed: true, reassigned };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Bulk reorder: pass the list of axis IDs in the desired display order.
// Positions get rewritten as multiples of 10 so future insertions between
// entries can use midpoint arithmetic without renumbering.
export function reorderAxes(cfg: ControlPanelResolvedConfig, ids: string[]): TaskAxisRow[] {
  const db = getDb(cfg);
  const ts = now();
  db.exec("BEGIN");
  try {
    const upd = db.prepare("UPDATE task_axis SET position = ?, updated_at = ? WHERE id = ?");
    ids.forEach((id, i) => upd.run((i + 1) * 10, ts, id));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return listAxes(cfg);
}
