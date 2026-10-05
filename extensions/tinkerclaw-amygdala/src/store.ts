/**
 * SQLite store of the digital amygdala (design doc §3 M5, §7.3). One file, WAL. Append-only for situations,
 * verdicts, decisions, labels and question versions; only the pointer/state tables listed in the design mutate.
 * Timestamps are epoch milliseconds.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import type {
  Change,
  ContextCount,
  Cutoff,
  Decision,
  Intervention,
  Label,
  Precedent,
  Question,
  Seam,
  Situation,
  Verdict,
} from "./types.js";

type Row = Record<string, unknown>;
type DecisionRow = Decision & { id: string; seam: Seam; ts: number };

export interface HoldRecord {
  id: string;
  decisionId: string;
  stepSig: string;
  goalFp: string;
  needs: string[];
  state: string;
}

export interface VerdictSpend {
  usd: number;
  tokensIn: number;
  tokensOut: number;
  calls: number;
  skipped: number;
}

function json(v: unknown): string {
  return JSON.stringify(v);
}

function parse<T>(s: unknown): T {
  return JSON.parse(String(s)) as T;
}

export class AmygdalaStore {
  private readonly db: Database.Database;

  constructor(path: string | ":memory:") {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path);
    if (path !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version < SCHEMA_VERSION) {
      this.db.transaction(() => {
        this.db.exec(SCHEMA_SQL);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    }
    // Added 2026-10-03 for personality's novelty, outside the versioned schema so an existing store gains it in place.
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS seen_counts(key TEXT PRIMARY KEY, n INTEGER NOT NULL, last_ts INTEGER NOT NULL)",
    );
  }

  /** How many times `key` was seen before this call, then counts this sighting. */
  seenBefore(key: string, ts: number): number {
    const r = this.db.prepare("SELECT n FROM seen_counts WHERE key = ?").get(key) as
      | { n: number }
      | undefined;
    this.db
      .prepare(
        "INSERT INTO seen_counts(key, n, last_ts) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET n = n + 1, last_ts = excluded.last_ts",
      )
      .run(key, ts);
    return r?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }

  /** PRAGMA user_version of the open database. */
  schemaVersion(): number {
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  // ---- record ----------------------------------------------------------------

  saveSituation(s: Situation, redacted: unknown | null = null): void {
    const record = json(s);
    this.db
      .prepare(
        `INSERT INTO situations(id, ts, session, turn_id, seam, tool, effect_class, origin_kind, hash, record_json, redacted_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id,
        s.ts,
        s.sessionKey,
        s.turnId,
        s.seam,
        s.tool.value,
        s.effectClass.value,
        s.originKind,
        createHash("sha256").update(record).digest("hex"),
        record,
        redacted === null || redacted === undefined ? null : json(redacted),
      );
  }

  saveVerdicts(vs: Verdict[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO verdicts(id, situation_id, question_id, question_version, type, answer_json, prob, confidence, cache_hit,
         latency_ms, tokens_in, tokens_out, cost_usd, skipped, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.transaction(() => {
      for (const v of vs) {
        stmt.run(
          v.id,
          v.situationId,
          v.questionId,
          v.questionVersion,
          v.type,
          // probs has no column of its own; it rides along with the answer.
          json({ answer: v.answer, probs: v.probs }),
          v.prob,
          v.confidence,
          v.cacheHit ? 1 : 0,
          v.latencyMs,
          v.tokensIn,
          v.tokensOut,
          v.costUsd,
          v.skipped ?? null,
          v.ts,
        );
      }
    })();
  }

  saveDecision(d: Decision, meta: { id: string; seam: Seam; ts: number }): void {
    this.db
      .prepare(
        `INSERT INTO decisions(id, situation_id, seam, family, kind, reason_code, verdict_ids, mode, enforced, degraded, response_json, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        meta.id,
        d.situationId,
        meta.seam,
        d.family,
        d.response.kind,
        d.reasonCode,
        json(d.verdictIds),
        d.mode,
        d.enforced ? 1 : 0,
        d.degraded ? 1 : 0,
        json(d.response),
        meta.ts,
      );
  }

  private decisionFromRow(r: Row): DecisionRow {
    return {
      id: r.id as string,
      seam: r.seam as Seam,
      ts: r.ts as number,
      situationId: r.situation_id as string,
      response: parse(r.response_json),
      family: r.family as Decision["family"],
      reasonCode: r.reason_code as string,
      verdictIds: parse(r.verdict_ids),
      mode: r.mode as Decision["mode"],
      enforced: r.enforced === 1,
      degraded: r.degraded === 1,
    };
  }

  getDecision(id: string): DecisionRow | undefined {
    const r = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Row | undefined;
    return r ? this.decisionFromRow(r) : undefined;
  }

  openIntervention(i: Intervention): void {
    this.db
      .prepare(
        "INSERT INTO interventions(id, decision_id, kind, state, ts, closed_ts) VALUES (?,?,?,?,?,?)",
      )
      .run(i.id, i.decisionId, i.kind, i.state, i.ts, i.closedTs ?? null);
  }

  /** `_releasedBy` is accepted for the caller's convenience; the interventions table has no column for it (holds carry it). */
  closeIntervention(
    id: string,
    state: Intervention["state"],
    ts: number,
    _releasedBy?: string,
  ): void {
    this.db
      .prepare("UPDATE interventions SET state = ?, closed_ts = ? WHERE id = ?")
      .run(state, ts, id);
  }

  listInterventions(
    o: { sinceTs?: number; state?: Intervention["state"]; limit?: number } = {},
  ): Intervention[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.sinceTs !== undefined) {
      where.push("ts >= ?");
      args.push(o.sinceTs);
    }
    if (o.state !== undefined) {
      where.push("state = ?");
      args.push(o.state);
    }
    let sql = "SELECT * FROM interventions";
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY ts DESC, rowid DESC";
    if (o.limit !== undefined) {
      sql += " LIMIT ?";
      args.push(o.limit);
    }
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => {
      const i: Intervention = {
        id: r.id as string,
        decisionId: r.decision_id as string,
        kind: r.kind as Intervention["kind"],
        state: r.state as Intervention["state"],
        ts: r.ts as number,
      };
      if (r.closed_ts !== null) i.closedTs = r.closed_ts as number;
      return i;
    });
  }

  // ---- holds -----------------------------------------------------------------

  saveHold(h: {
    id: string;
    decisionId: string;
    stepSig: string;
    goalFp: string;
    needs: string[];
    ts: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO holds(id, decision_id, step_sig, goal_fp, needs_json, state, released_by, ts) VALUES (?,?,?,?,?,'open',NULL,?)",
      )
      .run(h.id, h.decisionId, h.stepSig, h.goalFp, json(h.needs), h.ts);
  }

  getOpenHold(stepSig: string): HoldRecord | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM holds WHERE step_sig = ? AND state = 'open' ORDER BY ts DESC, rowid DESC LIMIT 1",
      )
      .get(stepSig) as Row | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      decisionId: r.decision_id as string,
      stepSig: r.step_sig as string,
      goalFp: r.goal_fp as string,
      needs: parse(r.needs_json),
      state: r.state as string,
    };
  }

  updateHold(id: string, patch: { state?: string; releasedBy?: string }): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.state !== undefined) {
      sets.push("state = ?");
      args.push(patch.state);
    }
    if (patch.releasedBy !== undefined) {
      sets.push("released_by = ?");
      args.push(patch.releasedBy);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE holds SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  // ---- labels, precedents, contexts -----------------------------------------

  addLabel(l: Label): void {
    this.db
      .prepare(
        "INSERT INTO labels(id, target_id, target_kind, kind, value, source, weight, ts) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(l.id, l.targetId, l.targetKind, l.kind, l.value, l.source, l.weight, l.ts);
  }

  labelsFor(targetId: string): Label[] {
    return (
      this.db
        .prepare("SELECT * FROM labels WHERE target_id = ? ORDER BY ts, rowid")
        .all(targetId) as Row[]
    ).map((r) => ({
      id: r.id as string,
      targetId: r.target_id as string,
      targetKind: r.target_kind as Label["targetKind"],
      kind: r.kind as Label["kind"],
      value: r.value as Label["value"],
      source: r.source as Label["source"],
      weight: r.weight as Label["weight"],
      ts: r.ts as number,
    }));
  }

  addPrecedent(p: Precedent): void {
    this.db
      .prepare(
        "INSERT INTO precedents(id, feature_key, tokens_json, incident_ref, label, ts, hits) VALUES (?,?,?,?,?,?,?)",
      )
      .run(p.id, p.featureKey, json(p.tokens), p.incidentRef, p.label, p.ts, p.hits);
  }

  bumpPrecedent(id: string): void {
    this.db.prepare("UPDATE precedents SET hits = hits + 1 WHERE id = ?").run(id);
  }

  allPrecedents(): Precedent[] {
    return (this.db.prepare("SELECT * FROM precedents ORDER BY ts, rowid").all() as Row[]).map(
      (r) => ({
        id: r.id as string,
        featureKey: r.feature_key as string,
        tokens: parse(r.tokens_json),
        incidentRef: r.incident_ref as string,
        label: r.label as Precedent["label"],
        ts: r.ts as number,
        hits: r.hits as number,
      }),
    );
  }

  bumpContext(
    contextKey: string,
    questionId: string,
    d: { alarms?: number; falseAlarms?: number; confirms?: number },
    ts: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO context_counts(context_key, question_id, alarms, false_alarms, confirms, last_ts) VALUES (?,?,?,?,?,?)
         ON CONFLICT(context_key, question_id) DO UPDATE SET
           alarms = alarms + excluded.alarms,
           false_alarms = false_alarms + excluded.false_alarms,
           confirms = confirms + excluded.confirms,
           last_ts = excluded.last_ts`,
      )
      .run(contextKey, questionId, d.alarms ?? 0, d.falseAlarms ?? 0, d.confirms ?? 0, ts);
  }

  getContext(contextKey: string, questionId: string): ContextCount | undefined {
    const r = this.db
      .prepare("SELECT * FROM context_counts WHERE context_key = ? AND question_id = ?")
      .get(contextKey, questionId) as Row | undefined;
    if (!r) return undefined;
    return {
      contextKey: r.context_key as string,
      questionId: r.question_id as string,
      alarms: r.alarms as number,
      falseAlarms: r.false_alarms as number,
      confirms: r.confirms as number,
      lastTs: r.last_ts as number,
    };
  }

  /** Context counts, optionally for one question and/or touched since a time (learning reads these nightly). */
  listContextCounts(o: { questionId?: string; sinceTs?: number } = {}): ContextCount[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.questionId !== undefined) {
      where.push("question_id = ?");
      args.push(o.questionId);
    }
    if (o.sinceTs !== undefined) {
      where.push("last_ts >= ?");
      args.push(o.sinceTs);
    }
    const sql = `SELECT * FROM context_counts${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY question_id, context_key`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => ({
      contextKey: r.context_key as string,
      questionId: r.question_id as string,
      alarms: r.alarms as number,
      falseAlarms: r.false_alarms as number,
      confirms: r.confirms as number,
      lastTs: r.last_ts as number,
    }));
  }

  /** Labels, optionally filtered by kind and/or time, oldest first. */
  listLabels(o: { kind?: Label["kind"]; sinceTs?: number; limit?: number } = {}): Label[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.kind !== undefined) {
      where.push("kind = ?");
      args.push(o.kind);
    }
    if (o.sinceTs !== undefined) {
      where.push("ts >= ?");
      args.push(o.sinceTs);
    }
    const sql = `SELECT * FROM labels${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ts, rowid LIMIT ?`;
    return (this.db.prepare(sql).all(...args, o.limit ?? 5000) as Row[]).map((r) => ({
      id: r.id as string,
      targetId: r.target_id as string,
      targetKind: r.target_kind as Label["targetKind"],
      kind: r.kind as Label["kind"],
      value: r.value as Label["value"],
      source: r.source as Label["source"],
      weight: r.weight as Label["weight"],
      ts: r.ts as number,
    }));
  }

  // ---- questions and changes -------------------------------------------------

  /** Immutable: the (id, version) primary key makes a second insert throw. */
  saveQuestionVersion(q: Question, createdBy: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO question_versions(id, version, family, body_json, origin, parent, created_by, ts, retired_ts)
         VALUES (?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(q.id, q.version, q.family, json(q), q.origin, q.parent ?? null, createdBy, ts);
  }

  getQuestionVersion(id: string, version: number): Question | undefined {
    const r = this.db
      .prepare("SELECT body_json FROM question_versions WHERE id = ? AND version = ?")
      .get(id, version) as Row | undefined;
    return r ? parse<Question>(r.body_json) : undefined;
  }

  activeVersion(id: string): number | undefined {
    const r = this.db.prepare("SELECT version FROM question_active WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r ? (r.version as number) : undefined;
  }

  setActive(id: string, version: number, changeId: string | null, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO question_active(id, version, since, change_id) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, since = excluded.since, change_id = excluded.change_id`,
      )
      .run(id, version, ts, changeId);
  }

  saveContextOverride(o: {
    questionId: string;
    contextKey: string;
    cutoff: Cutoff;
    changeId: string;
  }): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO context_overrides(question_id, context_key, cutoff_json, change_id) VALUES (?,?,?,?)",
      )
      .run(o.questionId, o.contextKey, json(o.cutoff), o.changeId);
  }

  getContextOverride(questionId: string, contextKey: string): Cutoff | undefined {
    const r = this.db
      .prepare(
        "SELECT cutoff_json FROM context_overrides WHERE question_id = ? AND context_key = ?",
      )
      .get(questionId, contextKey) as Row | undefined;
    return r ? parse<Cutoff>(r.cutoff_json) : undefined;
  }

  removeContextOverride(questionId: string, contextKey: string): void {
    this.db
      .prepare("DELETE FROM context_overrides WHERE question_id = ? AND context_key = ?")
      .run(questionId, contextKey);
  }

  saveChange(c: Change, blockedUntil: number | null = null): void {
    this.db
      .prepare(
        `INSERT INTO changes(id, ts, question_id, from_version, to_version, kind, exceptional, status, replay_json, proposed_by, blocked_until)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.id,
        c.ts,
        c.questionId,
        c.fromVersion,
        c.toVersion,
        c.kind,
        c.exceptional ? 1 : 0,
        c.status,
        json(c.replay),
        c.proposedBy,
        blockedUntil,
      );
  }

  private changeFromRow(r: Row): Change & { blockedUntil: number | null } {
    return {
      id: r.id as string,
      ts: r.ts as number,
      questionId: r.question_id as string,
      fromVersion: r.from_version as number,
      toVersion: r.to_version as number | null,
      kind: r.kind as Change["kind"],
      exceptional: r.exceptional === 1,
      status: r.status as Change["status"],
      replay: parse(r.replay_json),
      proposedBy: r.proposed_by as Change["proposedBy"],
      blockedUntil: r.blocked_until as number | null,
    };
  }

  getChange(id: string): (Change & { blockedUntil: number | null }) | undefined {
    const r = this.db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as Row | undefined;
    return r ? this.changeFromRow(r) : undefined;
  }

  /** `blockedUntil` undefined leaves the column as it was; null clears it. */
  updateChangeStatus(id: string, status: Change["status"], blockedUntil?: number | null): void {
    if (blockedUntil === undefined) {
      this.db.prepare("UPDATE changes SET status = ? WHERE id = ?").run(status, id);
    } else {
      this.db
        .prepare("UPDATE changes SET status = ?, blocked_until = ? WHERE id = ?")
        .run(status, blockedUntil, id);
    }
  }

  /** Newest first. */
  listChanges(
    o: { status?: Change["status"]; sinceTs?: number; questionId?: string } = {},
  ): Change[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.status !== undefined) {
      where.push("status = ?");
      args.push(o.status);
    }
    if (o.sinceTs !== undefined) {
      where.push("ts >= ?");
      args.push(o.sinceTs);
    }
    if (o.questionId !== undefined) {
      where.push("question_id = ?");
      args.push(o.questionId);
    }
    let sql = "SELECT * FROM changes";
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY ts DESC, rowid DESC";
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => {
      const { blockedUntil: _b, ...change } = this.changeFromRow(r);
      return change;
    });
  }

  // ---- turn state ------------------------------------------------------------

  sendBackAttempts(session: string, turnId: string): number {
    const r = this.db
      .prepare("SELECT attempts FROM send_backs WHERE session = ? AND turn_id = ?")
      .get(session, turnId) as Row | undefined;
    return r ? (r.attempts as number) : 0;
  }

  bumpSendBack(session: string, turnId: string): number {
    this.db
      .prepare(
        `INSERT INTO send_backs(session, turn_id, attempts) VALUES (?,?,1)
         ON CONFLICT(session, turn_id) DO UPDATE SET attempts = attempts + 1`,
      )
      .run(session, turnId);
    return this.sendBackAttempts(session, turnId);
  }

  // ---- queries ---------------------------------------------------------------

  queryVerdicts(
    o: { questionId?: string; version?: number; sinceTs?: number; situationId?: string } = {},
  ): Verdict[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.questionId !== undefined) {
      where.push("question_id = ?");
      args.push(o.questionId);
    }
    if (o.version !== undefined) {
      where.push("question_version = ?");
      args.push(o.version);
    }
    if (o.sinceTs !== undefined) {
      where.push("ts >= ?");
      args.push(o.sinceTs);
    }
    if (o.situationId !== undefined) {
      where.push("situation_id = ?");
      args.push(o.situationId);
    }
    let sql = "SELECT * FROM verdicts";
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY ts, rowid";
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => {
      const stored = parse<{ answer: Verdict["answer"]; probs?: Record<string, number> }>(
        r.answer_json,
      );
      const v: Verdict = {
        id: r.id as string,
        situationId: r.situation_id as string,
        questionId: r.question_id as string,
        questionVersion: r.question_version as number,
        type: r.type as Verdict["type"],
        answer: stored.answer,
        prob: r.prob as number,
        confidence: r.confidence as number,
        cacheHit: r.cache_hit === 1,
        latencyMs: r.latency_ms as number,
        tokensIn: r.tokens_in as number,
        tokensOut: r.tokens_out as number,
        costUsd: r.cost_usd as number,
        ts: r.ts as number,
      };
      if (stored.probs) v.probs = stored.probs;
      if (r.skipped !== null) v.skipped = r.skipped as NonNullable<Verdict["skipped"]>;
      return v;
    });
  }

  /** Sums over verdicts with ts in [fromTs, toTs). `calls` = reached Jev (not skipped, not a cache hit). */
  verdictSpend(fromTs: number, toTs: number): VerdictSpend {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS usd,
                COALESCE(SUM(tokens_in), 0) AS tin,
                COALESCE(SUM(tokens_out), 0) AS tout,
                COALESCE(SUM(CASE WHEN skipped IS NULL AND cache_hit = 0 THEN 1 ELSE 0 END), 0) AS calls,
                COALESCE(SUM(CASE WHEN skipped IS NOT NULL THEN 1 ELSE 0 END), 0) AS skipped
         FROM verdicts WHERE ts >= ? AND ts < ?`,
      )
      .get(fromTs, toTs) as Row;
    return {
      usd: r.usd as number,
      tokensIn: r.tin as number,
      tokensOut: r.tout as number,
      calls: r.calls as number,
      skipped: r.skipped as number,
    };
  }

  decisionsSince(ts: number): DecisionRow[] {
    return (
      this.db.prepare("SELECT * FROM decisions WHERE ts >= ? ORDER BY ts, rowid").all(ts) as Row[]
    ).map((r) => this.decisionFromRow(r));
  }

  /**
   * Remove everything a REPLAY turn recorded (situations, verdicts, decisions, interventions), so replaying the same
   * exchange again replaces its judgement instead of stacking a second one. Refuses any other turn id: live turns are
   * never deleted. Returns the number of decisions removed.
   */
  deleteReplayTurn(turnId: string): number {
    if (!turnId.includes("#replay-")) throw new Error("only replay turns can be deleted");
    const del = this.db.transaction((id: string) => {
      const sids = (
        this.db.prepare("SELECT id FROM situations WHERE turn_id = ?").all(id) as Row[]
      ).map((r) => r.id as string);
      let n = 0;
      for (const sid of sids) {
        const dids = (
          this.db.prepare("SELECT id FROM decisions WHERE situation_id = ?").all(sid) as Row[]
        ).map((r) => r.id as string);
        for (const did of dids)
          this.db.prepare("DELETE FROM interventions WHERE decision_id = ?").run(did);
        n += this.db.prepare("DELETE FROM decisions WHERE situation_id = ?").run(sid).changes;
        this.db.prepare("DELETE FROM verdicts WHERE situation_id = ?").run(sid);
        this.db.prepare("DELETE FROM situations WHERE id = ?").run(sid);
      }
      return n;
    });
    return del(turnId) as number;
  }

  /** One tab's decisions since `ts`, oldest first. Filter BEFORE any limit: a quiet tab's old rows must survive. */
  decisionsSinceForSession(ts: number, sessionKey: string): DecisionRow[] {
    return (
      this.db
        .prepare(
          "SELECT d.* FROM decisions d JOIN situations s ON s.id = d.situation_id WHERE d.ts >= ? AND s.session = ? ORDER BY d.ts, d.rowid",
        )
        .all(ts, sessionKey) as Row[]
    ).map((r) => this.decisionFromRow(r));
  }

  /** This tab's turn ids, newest first (by the latest step seen in each turn). */
  turnIdsNewestFirst(sessionKey: string, limit = 50): string[] {
    return (
      this.db
        .prepare(
          "SELECT turn_id FROM situations WHERE session = ? AND turn_id IS NOT NULL GROUP BY turn_id ORDER BY MAX(ts) DESC, MAX(rowid) DESC LIMIT ?",
        )
        .all(sessionKey, limit) as Row[]
    ).map((r) => r.turn_id as string);
  }

  situationRecord(id: string): Situation | undefined {
    const r = this.db.prepare("SELECT record_json FROM situations WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!r || r.record_json === null) return undefined;
    return parse<Situation>(r.record_json);
  }

  /** Retention: nulls record_json only; redacted_json, verdicts and decisions stay. Returns rows changed. */
  pruneRecords(olderThanTs: number): number {
    return this.db
      .prepare("UPDATE situations SET record_json = NULL WHERE ts < ? AND record_json IS NOT NULL")
      .run(olderThanTs).changes;
  }
}
