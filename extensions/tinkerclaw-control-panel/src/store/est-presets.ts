/**
 * FORK: tinkerclaw-control-panel — task_est_preset CRUD (v3.3).
 *
 * The add-task wizard's free-numeric est_minutes input is replaced in the UI
 * by a dropdown of presets sourced from this table. Existing tasks keep
 * whatever est_minutes they have — presets are presentation only, not a FK.
 */
import type { ControlPanelResolvedConfig } from "../paths.js";
import { getDb } from "./db.js";

export type EstPresetRow = {
  id: number;
  minutes: number;
  label: string;
  position: number;
  created_at: number;
  updated_at: number;
};

export type EstPresetAddInput = {
  minutes: number;
  label: string;
  position?: number;
};

export type EstPresetUpdateInput = {
  id: number;
  minutes?: number;
  label?: string;
  position?: number;
};

const now = (): number => Date.now();

export function listEstPresets(cfg: ControlPanelResolvedConfig): EstPresetRow[] {
  const db = getDb(cfg);
  return db
    .prepare(
      "SELECT id, minutes, label, position, created_at, updated_at FROM task_est_preset ORDER BY position ASC, minutes ASC",
    )
    .all() as EstPresetRow[];
}

export function getEstPresetById(cfg: ControlPanelResolvedConfig, id: number): EstPresetRow | null {
  const db = getDb(cfg);
  const row = db
    .prepare(
      "SELECT id, minutes, label, position, created_at, updated_at FROM task_est_preset WHERE id = ?",
    )
    .get(id) as EstPresetRow | undefined;
  return row ?? null;
}

export function addEstPreset(
  cfg: ControlPanelResolvedConfig,
  input: EstPresetAddInput,
): EstPresetRow {
  const db = getDb(cfg);
  if (!Number.isFinite(input.minutes) || input.minutes <= 0) {
    throw new Error("[control-panel] addEstPreset: minutes must be > 0");
  }
  if (!input.label.trim()) throw new Error("[control-panel] addEstPreset: label required");

  let position = input.position;
  if (position === undefined) {
    const maxRow = db
      .prepare("SELECT COALESCE(MAX(position), 0) as m FROM task_est_preset")
      .get() as { m: number };
    position = (maxRow.m ?? 0) + 10;
  }

  const ts = now();
  const res = db
    .prepare(
      "INSERT INTO task_est_preset (minutes, label, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(input.minutes, input.label, position, ts, ts);
  return getEstPresetById(cfg, Number(res.lastInsertRowid))!;
}

export function updateEstPreset(
  cfg: ControlPanelResolvedConfig,
  input: EstPresetUpdateInput,
): EstPresetRow {
  const db = getDb(cfg);
  const existing = getEstPresetById(cfg, input.id);
  if (!existing) throw new Error(`[control-panel] updateEstPreset: no preset with id ${input.id}`);
  const fields: string[] = [];
  const params: Record<string, unknown> = { id: input.id, now: now() };
  if (input.minutes !== undefined) {
    if (!Number.isFinite(input.minutes) || input.minutes <= 0) {
      throw new Error("[control-panel] updateEstPreset: minutes must be > 0");
    }
    fields.push("minutes = @minutes");
    params.minutes = input.minutes;
  }
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
  db.prepare(`UPDATE task_est_preset SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getEstPresetById(cfg, input.id)!;
}

export type EstPresetDeleteResult = {
  removed: boolean;
};

// Presets are presentation only — deleting one does NOT touch existing task
// rows that happen to carry the same est_minutes value. The user just stops
// seeing this preset in the wizard dropdown.
export function deleteEstPreset(
  cfg: ControlPanelResolvedConfig,
  id: number,
): EstPresetDeleteResult {
  const db = getDb(cfg);
  const res = db.prepare("DELETE FROM task_est_preset WHERE id = ?").run(id);
  return { removed: res.changes > 0 };
}

export function reorderEstPresets(cfg: ControlPanelResolvedConfig, ids: number[]): EstPresetRow[] {
  const db = getDb(cfg);
  const ts = now();
  db.exec("BEGIN");
  try {
    const upd = db.prepare("UPDATE task_est_preset SET position = ?, updated_at = ? WHERE id = ?");
    ids.forEach((id, i) => upd.run((i + 1) * 10, ts, id));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return listEstPresets(cfg);
}
