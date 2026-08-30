/**
 * FORK: tinkerclaw-task-panel — diff-aware import from briefing manifests.
 *
 * The morning briefing emits a ctrl-panel-tasks JSON block at end-of-run.
 * This module reconciles that manifest against the current task table per the
 * rules in SPEC §4.2 (`tasks.import` diff semantics).
 */
import type { ControlPanelResolvedConfig } from "./paths.js";
import { upsertBriefingPass } from "./store/briefing-pass.js";
import { getDb } from "./store/db.js";
import {
  addTask,
  listTasks,
  updateTask,
  type DismissalKind,
  type TaskAxis,
  type Hands,
} from "./store/tasks.js";

export type TaskManifestEntry = {
  id: string;
  text: string;
  context_md?: string | null;
  priority_axis?: TaskAxis;
  priority_rank?: number;
  est_minutes?: number;
  hands?: Hands;
  source_ref?: string;
  due_date?: string;
  inferred_signal?: unknown;
  metadata?: unknown;
  recurrence_rule_text?: string;
  force_reopen?: boolean;
};

export type TaskManifest = {
  version: 1 | 2;
  pass_id: string;
  delivered_to_user_at?: number;
  prune_missing?: boolean;
  tasks: TaskManifestEntry[];
};

export type ImportResult = {
  pass_id: string;
  inserted: string[];
  updated: string[];
  skipped_dismissed: Array<{ id: string; dismissal_kind: DismissalKind | null }>;
  dropped_missing: string[];
};

export function importTaskManifest(
  cfg: ControlPanelResolvedConfig,
  manifest: TaskManifest,
): ImportResult {
  const date = manifest.pass_id.split(".")[0] ?? new Date().toISOString().slice(0, 10);
  const passNumber = parseInt(manifest.pass_id.split("pass-").pop() ?? "1", 10) || 1;

  upsertBriefingPass(cfg, {
    id: manifest.pass_id,
    date,
    pass_number: passNumber,
    delivered_to_user_at: manifest.delivered_to_user_at ?? null,
    initial_task_count: manifest.tasks.length,
  });

  const db = getDb(cfg);
  const existing = new Map<
    string,
    { id: string; status: string; source: string; dismissal_kind: DismissalKind | null }
  >();
  if (manifest.tasks.length > 0) {
    const placeholders = manifest.tasks.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, status, source, dismissal_kind FROM task WHERE id IN (${placeholders})`)
      .all(...manifest.tasks.map((t) => t.id)) as Array<{
      id: string;
      status: string;
      source: string;
      dismissal_kind: DismissalKind | null;
    }>;
    for (const r of rows) existing.set(r.id, r);
  }

  const result: ImportResult = {
    pass_id: manifest.pass_id,
    inserted: [],
    updated: [],
    skipped_dismissed: [],
    dropped_missing: [],
  };

  for (const entry of manifest.tasks) {
    const prior = existing.get(entry.id);

    if (!prior) {
      addTask(cfg, {
        id: entry.id,
        text: entry.text,
        context_md: entry.context_md ?? null,
        source: "briefing",
        source_ref: entry.source_ref ?? null,
        briefing_pass_id: manifest.pass_id,
        priority_axis: entry.priority_axis ?? null,
        priority_rank: entry.priority_rank ?? 50,
        due_date: entry.due_date ?? null,
        est_minutes: entry.est_minutes ?? null,
        hands: entry.hands ?? null,
        inferred_signal: entry.inferred_signal,
        metadata: entry.metadata,
        recurrence_rule_text: entry.recurrence_rule_text ?? null,
      });
      result.inserted.push(entry.id);
      continue;
    }

    if (prior.status === "resolved" && !entry.force_reopen) {
      continue;
    }

    if (prior.status === "dismissed") {
      result.skipped_dismissed.push({ id: entry.id, dismissal_kind: prior.dismissal_kind });
      continue;
    }

    addTask(cfg, {
      id: entry.id,
      text: entry.text,
      context_md: entry.context_md ?? null,
      source: prior.source,
      source_ref: entry.source_ref ?? null,
      briefing_pass_id: manifest.pass_id,
      priority_axis: entry.priority_axis ?? null,
      priority_rank: entry.priority_rank ?? 50,
      due_date: entry.due_date ?? null,
      est_minutes: entry.est_minutes ?? null,
      hands: entry.hands ?? null,
      inferred_signal: entry.inferred_signal,
      metadata: entry.metadata,
      recurrence_rule_text: entry.recurrence_rule_text ?? null,
    });
    result.updated.push(entry.id);
  }

  if (manifest.prune_missing) {
    const manifestIds = new Set(manifest.tasks.map((t) => t.id));
    const briefingOpenTasks = listTasks(cfg, {
      status: ["open", "in_progress"],
    }).filter((t) => t.source === "briefing" && !manifestIds.has(t.id));
    for (const orphan of briefingOpenTasks) {
      updateTask(cfg, { id: orphan.id, status: "dropped", note: "manifest_omission" });
      result.dropped_missing.push(orphan.id);
    }
  }

  return result;
}
