/**
 * SQLite schema of the digital amygdala (design doc §3 M5). Applied once, guarded by PRAGMA user_version.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE situations(id TEXT PRIMARY KEY, ts INT, session TEXT, turn_id TEXT, seam TEXT, tool TEXT, effect_class TEXT,
  origin_kind TEXT, hash TEXT, record_json TEXT, redacted_json TEXT);
CREATE TABLE verdicts(id TEXT PRIMARY KEY, situation_id TEXT REFERENCES situations, question_id TEXT, question_version INT,
  type TEXT, answer_json TEXT, prob REAL, confidence REAL, cache_hit INT, latency_ms INT, tokens_in INT, tokens_out INT,
  cost_usd REAL, skipped TEXT, ts INT);
CREATE TABLE decisions(id TEXT PRIMARY KEY, situation_id TEXT REFERENCES situations, seam TEXT, family TEXT, kind TEXT,
  reason_code TEXT, verdict_ids TEXT, mode TEXT, enforced INT, degraded INT, response_json TEXT, ts INT);
CREATE TABLE interventions(id TEXT PRIMARY KEY, decision_id TEXT REFERENCES decisions, kind TEXT, state TEXT, ts INT, closed_ts INT);
CREATE TABLE holds(id TEXT PRIMARY KEY, decision_id TEXT, step_sig TEXT, goal_fp TEXT, needs_json TEXT, state TEXT, released_by TEXT, ts INT);
CREATE TABLE labels(id TEXT PRIMARY KEY, target_id TEXT, target_kind TEXT, kind TEXT, value INT, source TEXT, weight INT, ts INT);
CREATE TABLE precedents(id TEXT PRIMARY KEY, feature_key TEXT, tokens_json TEXT, incident_ref TEXT, label TEXT, ts INT, hits INT DEFAULT 0);
CREATE TABLE context_counts(context_key TEXT, question_id TEXT, alarms INT, false_alarms INT, confirms INT, last_ts INT,
  PRIMARY KEY(context_key, question_id));
CREATE TABLE question_versions(id TEXT, version INT, family TEXT, body_json TEXT, origin TEXT, parent INT, created_by TEXT, ts INT,
  retired_ts INT, PRIMARY KEY(id, version));
CREATE TABLE question_active(id TEXT PRIMARY KEY, version INT, since INT, change_id TEXT);
CREATE TABLE context_overrides(question_id TEXT, context_key TEXT, cutoff_json TEXT, change_id TEXT, PRIMARY KEY(question_id, context_key));
CREATE TABLE changes(id TEXT PRIMARY KEY, ts INT, question_id TEXT, from_version INT, to_version INT, kind TEXT, exceptional INT,
  status TEXT, replay_json TEXT, proposed_by TEXT, blocked_until INT);
CREATE TABLE send_backs(session TEXT, turn_id TEXT, attempts INT, PRIMARY KEY(session, turn_id));
CREATE INDEX v_q ON verdicts(question_id, question_version, ts); CREATE INDEX d_ts ON decisions(ts);
CREATE INDEX l_t ON labels(target_id); CREATE INDEX s_sess ON situations(session, turn_id);
`;
