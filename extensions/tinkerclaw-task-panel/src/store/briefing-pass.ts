/**
 * FORK: tinkerclaw-task-panel — briefing_pass CRUD.
 *
 * A briefing pass records the user-delivered moment of each /new pass and the
 * initial task count so the progress denominator stays anchored to the user
 * actually seeing the briefing (not the cron-only write).
 */
import type { ControlPanelResolvedConfig } from "../paths.js";
import { getDb } from "./db.js";

export type BriefingPassRow = {
  id: string;
  date: string;
  pass_number: number;
  delivered_to_user_at: number | null;
  initial_task_count: number;
  created_at: number;
};

export function upsertBriefingPass(
  cfg: ControlPanelResolvedConfig,
  input: {
    id: string;
    date: string;
    pass_number: number;
    delivered_to_user_at?: number | null;
    initial_task_count?: number;
  },
): BriefingPassRow {
  const db = getDb(cfg);
  const now = Date.now();
  db.prepare(
    `INSERT INTO briefing_pass (id, date, pass_number, delivered_to_user_at, initial_task_count, created_at)
     VALUES (@id, @date, @pass_number, @delivered_to_user_at, @initial_task_count, @now)
     ON CONFLICT(id) DO UPDATE SET
       delivered_to_user_at = COALESCE(excluded.delivered_to_user_at, briefing_pass.delivered_to_user_at),
       initial_task_count = excluded.initial_task_count`,
  ).run({
    id: input.id,
    date: input.date,
    pass_number: input.pass_number,
    delivered_to_user_at: input.delivered_to_user_at ?? null,
    initial_task_count: input.initial_task_count ?? 0,
    now,
  });
  const row = db
    .prepare(`SELECT * FROM briefing_pass WHERE id = ?`)
    .get(input.id) as BriefingPassRow;
  return row;
}

export function getLatestDeliveredPass(
  cfg: ControlPanelResolvedConfig,
  date: string,
): BriefingPassRow | null {
  const db = getDb(cfg);
  const row = db
    .prepare(
      `SELECT * FROM briefing_pass
       WHERE date = ? AND delivered_to_user_at IS NOT NULL
       ORDER BY pass_number DESC LIMIT 1`,
    )
    .get(date) as BriefingPassRow | undefined;
  return row ?? null;
}
