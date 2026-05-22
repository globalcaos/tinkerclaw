/**
 * FORK: tinkerclaw-control-panel — schema as a TypeScript constant.
 *
 * Bundlers (tsdown / esbuild) don't ship .sql assets alongside the dist JS,
 * so the schema lives inline in this module. Mirrors the convention in
 * extensions/tinkerclaw-whatsapp/src/history/db.ts.
 *
 * Keep schema.sql in sync as the human-readable canonical form; the runtime
 * uses the constant below. CREATE TABLE IF NOT EXISTS makes every statement
 * idempotent so subsequent boots are no-ops.
 */
export const CONTROL_PANEL_SCHEMA_SQL = `
------------------------------------------------------------------------------
-- METRICS (LIVE + SNAPSHOT)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS metric_definition (
  id TEXT PRIMARY KEY,
  class TEXT NOT NULL CHECK (class IN ('LIVE','SNAPSHOT')),
  source TEXT NOT NULL,
  cadence_seconds INTEGER,
  template TEXT NOT NULL,
  labels_schema TEXT,
  alert_rule_json TEXT,
  retention_days INTEGER NOT NULL DEFAULT 90,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS observation (
  metric_id TEXT NOT NULL REFERENCES metric_definition(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  value REAL NOT NULL,
  labels_json TEXT,
  PRIMARY KEY (metric_id, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS observation_metric_ts ON observation(metric_id, ts DESC);

CREATE TABLE IF NOT EXISTS alert_state (
  metric_id TEXT PRIMARY KEY REFERENCES metric_definition(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('green','yellow','red')),
  last_changed_ts INTEGER NOT NULL,
  last_routed_ts INTEGER,
  last_value REAL
);

------------------------------------------------------------------------------
-- BRIEFING PASS (v3.1 — for progress-anchor tracking)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS briefing_pass (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  pass_number INTEGER NOT NULL,
  delivered_to_user_at INTEGER,
  initial_task_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS briefing_pass_date ON briefing_pass(date);

------------------------------------------------------------------------------
-- TASKS (v3.1)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  context_md TEXT,
  -- v3.3 — 'back_burner' added: a task the user has snoozed indefinitely.
  -- Hidden from default filters; still belongs to its axis; restored by
  -- setting status back to 'open'. See migrateWidenStatusCheck() in db.ts
  -- for the migration that retrofits old DBs.
  status TEXT NOT NULL CHECK (status IN ('open','in_progress','resolved','dropped','dismissed','back_burner')),
  source TEXT NOT NULL,
  source_ref TEXT,
  briefing_pass_id TEXT REFERENCES briefing_pass(id),
  -- v3.1.1 — priority_axis CHECK dropped; v3.3 — values now sourced from the
  -- task_axis taxonomy table (rather than hardcoded EXEC_AXIS_ORDER in JS).
  priority_axis TEXT,
  priority_rank INTEGER NOT NULL DEFAULT 50,
  carry_days INTEGER NOT NULL DEFAULT 0,
  age_seconds INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  dismissal_kind TEXT CHECK (dismissal_kind IN ('not_a_task','not_relevant','wrong_priority','duplicate','out_of_scope','other')),
  dismissal_note TEXT,
  est_minutes INTEGER,
  hands TEXT CHECK (hands IN ('user','assistant','either')),
  inferred_signal_json TEXT,
  metadata_json TEXT,
  recurrence_rule_text TEXT,
  recurrence_parent_id TEXT REFERENCES task(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS task_open_priority ON task(status, priority_axis, priority_rank) WHERE status IN ('open','in_progress');
CREATE INDEX IF NOT EXISTS task_resolved_recent ON task(resolved_at DESC) WHERE status = 'resolved';
CREATE INDEX IF NOT EXISTS task_due_date ON task(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_briefing_pass ON task(briefing_pass_id);
CREATE INDEX IF NOT EXISTS task_dismissed ON task(status, dismissal_kind) WHERE status = 'dismissed';
CREATE INDEX IF NOT EXISTS task_recurring ON task(recurrence_parent_id) WHERE recurrence_parent_id IS NOT NULL;
-- v3.3 — back_burner pile lookup
CREATE INDEX IF NOT EXISTS task_back_burner ON task(priority_axis, priority_rank) WHERE status = 'back_burner';

------------------------------------------------------------------------------
-- TASK TAXONOMIES (v3.3 + v3.5 hierarchy)
-- task_axis     : user-managed categories (replaces hardcoded EXEC_AXIS_ORDER);
--                 v3.5 adds parent_id for two-level group → sub-group nesting.
-- task_est_preset : user-managed estimation presets (replaces free numeric input)
-- Both seeded with the prior hardcoded defaults on first migration; see
-- seedTaxonomyDefaults() in db.ts.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_axis (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 100,
  parent_id TEXT REFERENCES task_axis(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_axis_position ON task_axis(position);
CREATE INDEX IF NOT EXISTS task_axis_parent ON task_axis(parent_id);

CREATE TABLE IF NOT EXISTS task_est_preset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  minutes INTEGER NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_est_preset_position ON task_est_preset(position);

CREATE TABLE IF NOT EXISTS task_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS task_event_task_ts ON task_event(task_id, ts DESC);

------------------------------------------------------------------------------
-- CALENDAR EVENT CACHE (v3.1)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS calendar_event_cache (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  date TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  attendees_json TEXT,
  location TEXT,
  metadata_json TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (source, event_id)
);
CREATE INDEX IF NOT EXISTS calendar_event_date ON calendar_event_cache(date);
CREATE INDEX IF NOT EXISTS calendar_event_start ON calendar_event_cache(start_ts);

------------------------------------------------------------------------------
-- DASHBOARD LAYOUT (which panels are pinned to which surface)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS panel_pin (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_id TEXT NOT NULL REFERENCES metric_definition(id) ON DELETE CASCADE,
  surface TEXT NOT NULL CHECK (surface IN ('exec_graphs','exec_traffic_light','dev_tab','traffic_strip')),
  position INTEGER NOT NULL DEFAULT 100,
  size TEXT NOT NULL DEFAULT 'small' CHECK (size IN ('tiny','small','medium','large')),
  range TEXT NOT NULL DEFAULT '24h',
  template_override TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS panel_pin_surface ON panel_pin(surface, position);
`;
