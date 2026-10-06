// The THALAMUS v4 store (design doc sections 8 and 13A.3): one SQLite file, WAL, its own schema version.
//
// WHAT THIS IS FOR. Shadow mode is only worth running if what it would have done is written down: every per-call
// decision with its options, vetoes, prices and ladder, what happened to it, and, for the enhancement short list,
// what was shown, what the agent actually used and how the task ended. The nightly loop (phase F) reads this file.
//
// TWO FILES, ONE LEDGER (charter ruling C1). This is Thalamus's own file. It is joined to the amygdala's by
// `situation_id`, never by writing into the amygdala's file, so the two plugins keep their own migrations.
//
// NO BODIES. Nothing here stores a request or a response: that is what made the LLM ledger 2.6 GB. Decisions keep
// numbers and route keys; the one place text is kept is `enh_cards` (the cards Jev reads), which is our own data.
//
// A FOLDER THAT MAY NOT EXIST. The data folder is created here, with mode 0700, on open; it is never assumed.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  CalibrationMap,
  CallDecision,
  EnhancementCard,
  Estimate,
  Ladder,
  LedgerRow,
  OutcomeFact,
  RungTimeStats,
  Shortlist,
  ShortlistEntry,
} from "openclaw/plugin-sdk/fork-thalamus";

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS decisions(
  id TEXT PRIMARY KEY, ts INT, session TEXT, run_id TEXT, call_index INT, lane TEXT, mode TEXT,
  task_read TEXT, step_read TEXT, situation_ref TEXT, dial_idx INT, private INT, degraded INT,
  incumbent TEXT, chosen TEXT, chosen_effort TEXT, chosen_feed TEXT, pick TEXT, pick_effort TEXT,
  switch_kind TEXT, switch_reason TEXT, n_star REAL, applied INT, would_change INT,
  price REAL, incumbent_price REAL, money_basis TEXT, reserved_reason TEXT,
  options_json TEXT, vetoes_json TEXT, ladder_json TEXT, compute_ms REAL);
CREATE INDEX IF NOT EXISTS decisions_run ON decisions(run_id, call_index);
CREATE INDEX IF NOT EXISTS decisions_ts ON decisions(ts);
CREATE TABLE IF NOT EXISTS outcomes(
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id), ts INT, actual_model TEXT,
  input INT, cache_read INT, cache_write INT, output INT, duration_ms INT, ttft_ms INT,
  stop_reason TEXT, outcome TEXT, refused INT, money_basis TEXT);
CREATE TABLE IF NOT EXISTS enh_cards(
  card_id TEXT, version INT, family TEXT, kind TEXT, name TEXT, path TEXT, purpose TEXT, structure TEXT,
  also_json TEXT, status TEXT, origin TEXT, parent INT, replay_json TEXT, created_at INT,
  PRIMARY KEY(card_id, version));
CREATE TABLE IF NOT EXISTS enh_active(card_id TEXT PRIMARY KEY, version INT, since INT);
CREATE TABLE IF NOT EXISTS enh_uses(
  task_id TEXT PRIMARY KEY, ts INT, session TEXT, source TEXT, private INT, shuffled INT,
  shown_json TEXT, none_fits REAL, list_shown INT, list_reason TEXT, list_source TEXT,
  used_json TEXT, outcome TEXT, card_versions_json TEXT, question_version INT, mode TEXT);
CREATE INDEX IF NOT EXISTS enh_uses_ts ON enh_uses(ts);
CREATE TABLE IF NOT EXISTS fresh_points(
  id TEXT PRIMARY KEY, ts INT, session TEXT, run_id TEXT, call_index INT, kind TEXT, mode TEXT,
  acted INT, reason TEXT, model TEXT, family TEXT, detail_json TEXT);
CREATE INDEX IF NOT EXISTS fresh_points_run ON fresh_points(run_id, kind);
CREATE INDEX IF NOT EXISTS fresh_points_ts ON fresh_points(ts);
CREATE TABLE IF NOT EXISTS raw_results(
  name TEXT PRIMARY KEY, ts INT, session TEXT, path TEXT, bytes INT, tokens INT, digest_tokens INT, tool TEXT,
  recalls INT DEFAULT 0, last_recall_ts INT);
CREATE TABLE IF NOT EXISTS subagent_calls(
  id TEXT PRIMARY KEY, ts INT, session TEXT, parent_tool_use_id TEXT, model TEXT,
  input INT, cache_read INT, cache_write INT, output INT);
CREATE INDEX IF NOT EXISTS subagent_calls_session ON subagent_calls(session, ts);
CREATE TABLE IF NOT EXISTS units(
  plan_id TEXT, unit_id TEXT, copy INT, ts INT, mode TEXT, deps_json TEXT, writes_json TEXT, model TEXT, effort TEXT,
  start_sec REAL, end_sec REAL, slack_sec REAL, on_critical INT, hedged INT, price REAL, status TEXT, detail_json TEXT,
  PRIMARY KEY(plan_id, unit_id, copy));
CREATE INDEX IF NOT EXISTS units_ts ON units(ts);
CREATE TABLE IF NOT EXISTS estimates(
  domain TEXT, step_kind TEXT, rung TEXT, n INT, wins INT, retries INT, refusals INT, cost_sum REAL, time_sum REAL,
  prior REAL, posterior REAL, updated_at INT, PRIMARY KEY(domain, step_kind, rung));
CREATE TABLE IF NOT EXISTS rung_time(
  rung TEXT PRIMARY KEY, n INT, duration_p50 REAL, duration_p95 REAL, ttft_warm_p50 REAL, ttft_cold_p50 REAL,
  ttft_p95 REAL, tps_p50 REAL, tps_p5 REAL, updated_at INT);
CREATE TABLE IF NOT EXISTS learning_runs(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, mode TEXT, dry INT, report_json TEXT);
CREATE TABLE IF NOT EXISTS enh_rates(rank INT PRIMARY KEY, tasks INT, picked INT, pi REAL, source TEXT, updated_at INT);
CREATE TABLE IF NOT EXISTS enh_calibration(idx INT PRIMARY KEY, p REAL, mapped REAL, n INT, from_shuffled INT, updated_at INT);
CREATE TABLE IF NOT EXISTS enh_replay_set(task_id TEXT PRIMARY KEY, ts INT, text_redacted TEXT);
CREATE TABLE IF NOT EXISTS enh_pins(id TEXT PRIMARY KEY, task_id TEXT, card_id TEXT, by TEXT, created_at INT);
CREATE TABLE IF NOT EXISTS enh_proposals(id TEXT PRIMARY KEY, kind TEXT, payload_json TEXT, status TEXT, created_at INT);
`;

/** Columns added after the first release of a table. A file made before them gains them in place. */
const ADDED_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ["decisions", "domain", "TEXT"],
  ["decisions", "topic", "TEXT"],
  ["decisions", "step_kind", "TEXT"],
  ["enh_uses", "task_kind", "TEXT"],
  // Broca retrieval v2 (phase C): why the list was local, the gate's reason, and the Jev call's own wall time.
  ["enh_uses", "skip_reason", "TEXT"],
  ["enh_uses", "skip_detail", "TEXT"],
  ["enh_uses", "jev_ms", "INT"],
  // Broca retrieval v2 (phase F): the mode (USE / INSPIRE) and source (jev / local) of each shown entry, in list order and
  // comma-joined, so the daily review can split the hit rate in SQL. Derived from `shown_json` when the row is written;
  // an entry from a list made without a ranking has `?` in both.
  ["enh_uses", "shown_modes", "TEXT"],
  ["enh_uses", "shown_sources", "TEXT"],
];

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: unknown, d: T): T => {
  try {
    return s === null || s === undefined ? d : (JSON.parse(String(s)) as T);
  } catch {
    return d;
  }
};

/** Infinity does not survive JSON; a break-even that never arrives is stored as null. */
const finite = (n: number | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

export type DecisionExtras = {
  ladder?: Ladder;
  computeMs?: number;
  situationRef?: string;
  sessionKey?: string;
  privateTask?: boolean;
  /** What the task read and the step read said, so learning can group outcomes by kind of work and kind of step. */
  domain?: string;
  topic?: string;
  stepKind?: string;
};

export type DecisionRow = {
  id: string;
  ts: number;
  session: string | null;
  runId: string;
  callIndex: number;
  lane: string;
  mode: string;
  dialIdx: number;
  private: boolean;
  degraded: boolean;
  incumbent: string;
  chosen: string;
  chosenEffort: string;
  chosenFeed: string;
  pick: string;
  switchKind: string;
  switchReason: string;
  nStar: number | null;
  applied: boolean;
  wouldChange: boolean;
  price: number;
  incumbentPrice: number | null;
  moneyBasis: string;
  reservedReason: string | null;
  computeMs: number | null;
  options: unknown[];
  vetoes: unknown[];
  ladder: unknown;
  /** What the task read and the step read said (phase F); absent on a decision written before they were recorded. */
  domain?: string;
  topic?: string;
  stepKind?: string;
};

/** A decision at a fresh point: a digest, a check, a finish, or a stuck escalation. `acted` is false in shadow. */
export type FreshPointRow = {
  id: string;
  ts: number;
  session?: string;
  runId: string;
  callIndex?: number;
  kind: "digest" | "check" | "finish" | "stuck" | "leaf";
  mode: string;
  acted: boolean;
  reason: string;
  model?: string;
  family?: string;
  detail: Record<string, unknown>;
};

/** One placed unit of a plan, or the hedge copy of one (design doc section 8, table `units`). */
export type PlanUnitRow = {
  planId: string;
  unitId: string;
  /** 0 the unit, 1 its hedge copy. */
  copy: 0 | 1;
  ts: number;
  mode: string;
  deps: string[];
  writes: string[];
  model?: string;
  effort?: string;
  startSec?: number;
  endSec?: number;
  slackSec?: number;
  onCritical: boolean;
  hedged: boolean;
  price?: number;
  status: string;
  detail: Record<string, unknown>;
};

export type RawRow = {
  name: string;
  ts: number;
  session: string;
  path: string;
  bytes: number;
  tokens: number;
  digestTokens?: number;
  tool: string;
  recalls: number;
  lastRecallTs?: number;
};

export type SubagentCallRow = {
  id: string;
  ts: number;
  session: string;
  parentToolUseId: string;
  model?: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
};

export type UseRow = {
  taskId: string;
  ts: number;
  session: string;
  source: string;
  private: boolean;
  shuffled: boolean;
  shown: ShortlistEntry[];
  noneFits: number;
  listShown: boolean;
  listReason: Shortlist["reason"];
  listSource: Shortlist["source"];
  used: Array<{ cardId: string; onList: boolean; rank?: number; via: string; how: string }>;
  outcome: "done" | "retried" | "corrected";
  cardVersions: Record<string, number>;
  questionVersion: number;
  mode: string;
  /** The task's kind of work, from the local read, so the loop can tell what kind of task a pattern repeats in. */
  taskKind?: string;
  /** Why the list is not Jev's: timeout, breaker-open, not-allowed, error, or invalid (an answer that could not be used). */
  skipReason?: string;
  /** The gate's reason behind `not-allowed`: private-source, real-not-allowed, jev-off, no-key. */
  skipDetail?: string;
  /** How long the Jev call itself took, counted even when the prompt did not wait for it. */
  jevMs?: number;
};

export class ThalamusStore {
  private readonly db: Database.Database;

  constructor(path: string | ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    for (const [table, column, type] of ADDED_COLUMNS) {
      const have = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!have.some((c) => c.name === column))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value?: string }
      | undefined;
    if (!row)
      this.db
        .prepare("INSERT INTO meta(key,value) VALUES('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
    else if (Number(row.value) > SCHEMA_VERSION) {
      throw new Error(`thalamus store is schema ${row.value}, this build knows ${SCHEMA_VERSION}`);
    } else if (Number(row.value) < SCHEMA_VERSION) {
      // The tables added since are CREATE IF NOT EXISTS above, so an older file is upgraded in place.
      this.db
        .prepare("UPDATE meta SET value=? WHERE key='schema_version'")
        .run(String(SCHEMA_VERSION));
    }
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return Number(
      (
        this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as {
          value: string;
        }
      ).value,
    );
  }

  // ─── decisions ──────────────────────────────────────────────────────────────────────────────

  insertDecision(d: CallDecision, x: DecisionExtras = {}): void {
    const incumbentOption = d.options.find(
      (o) => o.rung.key === d.incumbent && o.feed === "thread",
    );
    this.db
      .prepare(
        `INSERT OR REPLACE INTO decisions(id,ts,session,run_id,call_index,lane,mode,task_read,step_read,situation_ref,
          dial_idx,private,degraded,incumbent,chosen,chosen_effort,chosen_feed,pick,pick_effort,switch_kind,switch_reason,
          n_star,applied,would_change,price,incumbent_price,money_basis,reserved_reason,options_json,vetoes_json,ladder_json,compute_ms,
          domain,topic,step_kind)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        d.id,
        d.ts,
        x.sessionKey ?? null,
        d.runId,
        d.callIndex,
        d.lane,
        d.mode,
        d.taskReadId ?? null,
        d.stepReadId ?? null,
        x.situationRef ?? null,
        d.dialIdx,
        x.privateTask ? 1 : 0,
        d.degraded ? 1 : 0,
        d.incumbent,
        d.chosen.rung.key,
        d.chosen.rung.effort,
        d.chosen.feed,
        d.pick.rung.key,
        d.pick.rung.effort,
        d.switch.kind,
        d.switch.reason,
        finite(d.switch.nStar),
        d.applied ? 1 : 0,
        d.wouldChange ? 1 : 0,
        d.chosen.price,
        incumbentOption?.price ?? null,
        d.moneyBasis,
        d.reservedReason ?? null,
        json(
          d.options.map((o) => ({
            key: o.rung.key,
            effort: o.rung.effort,
            feed: o.feed,
            price: o.price,
            runPrice: o.runPrice,
            quality: o.quality,
            money: o.parts.money,
            moneyKnown: o.parts.moneyKnown,
            unanchored: o.parts.unanchored,
            basis: o.moneyBasis,
          })),
        ),
        json(d.vetoes),
        json(x.ladder ?? null),
        x.computeMs ?? null,
        x.domain ?? null,
        x.topic ?? null,
        x.stepKind ?? null,
      );
  }

  private static decisionRow(r: Record<string, unknown>): DecisionRow {
    return {
      id: r.id as string,
      ts: r.ts as number,
      session: (r.session as string | null) ?? null,
      runId: r.run_id as string,
      callIndex: r.call_index as number,
      lane: r.lane as string,
      mode: r.mode as string,
      dialIdx: r.dial_idx as number,
      private: r.private === 1,
      degraded: r.degraded === 1,
      incumbent: r.incumbent as string,
      chosen: r.chosen as string,
      chosenEffort: r.chosen_effort as string,
      chosenFeed: r.chosen_feed as string,
      pick: r.pick as string,
      switchKind: r.switch_kind as string,
      switchReason: r.switch_reason as string,
      nStar: (r.n_star as number | null) ?? null,
      applied: r.applied === 1,
      wouldChange: r.would_change === 1,
      price: r.price as number,
      incumbentPrice: (r.incumbent_price as number | null) ?? null,
      moneyBasis: r.money_basis as string,
      reservedReason: (r.reserved_reason as string | null) ?? null,
      computeMs: (r.compute_ms as number | null) ?? null,
      options: parse(r.options_json, []),
      vetoes: parse(r.vetoes_json, []),
      ladder: parse(r.ladder_json, null),
      ...(typeof r.domain === "string" && r.domain ? { domain: r.domain } : {}),
      ...(typeof r.topic === "string" && r.topic ? { topic: r.topic } : {}),
      ...(typeof r.step_kind === "string" && r.step_kind ? { stepKind: r.step_kind } : {}),
    };
  }

  /** Calls recorded since `sinceTs`, and how many of them would have changed the model (for the panel's one line). */
  decisionTally(sinceTs: number): { calls: number; wouldChange: number } {
    const r = this.db
      .prepare("SELECT COUNT(*) n, COALESCE(SUM(would_change),0) w FROM decisions WHERE ts >= ?")
      .get(sinceTs) as { n: number; w: number };
    return { calls: Number(r.n), wouldChange: Number(r.w) };
  }

  /** The newest uses first, for the panel. */
  recentUses(limit: number): UseRow[] {
    const rows = this.db
      .prepare("SELECT * FROM enh_uses ORDER BY ts DESC LIMIT ?")
      .all(Math.min(100, Math.max(1, limit))) as Array<Record<string, unknown>>;
    return rows.map((r) => ThalamusStore.useRow(r));
  }

  /** The newest plans, each with its placed units, for the panel. */
  listPlans(
    limit: number,
  ): Array<{ planId: string; ts: number; mode: string; units: PlanUnitRow[] }> {
    const ids = this.db
      .prepare(
        "SELECT plan_id, MAX(ts) ts, MAX(mode) mode FROM units GROUP BY plan_id ORDER BY ts DESC LIMIT ?",
      )
      .all(Math.min(20, Math.max(1, limit))) as Array<{
      plan_id: string;
      ts: number;
      mode: string;
    }>;
    return ids.map((p) => ({
      planId: p.plan_id,
      ts: Number(p.ts),
      mode: String(p.mode),
      units: this.listPlanUnits(p.plan_id),
    }));
  }

  getDecision(id: string): DecisionRow | undefined {
    const r = this.db.prepare("SELECT * FROM decisions WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? ThalamusStore.decisionRow(r) : undefined;
  }

  listDecisions(o: { sinceTs?: number; sessionKey?: string; limit?: number } = {}): DecisionRow[] {
    const limit = Math.min(200, Math.max(1, o.limit ?? 50));
    const rows = this.db
      .prepare(
        `SELECT * FROM decisions WHERE ts >= ? AND (? IS NULL OR session = ?) ORDER BY ts DESC, call_index DESC LIMIT ?`,
      )
      .all(o.sinceTs ?? 0, o.sessionKey ?? null, o.sessionKey ?? null, limit) as Record<
      string,
      unknown
    >[];
    return rows.map(ThalamusStore.decisionRow);
  }

  insertOutcome(o: LedgerRow & { ts: number }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO outcomes(decision_id,ts,actual_model,input,cache_read,cache_write,output,duration_ms,ttft_ms,stop_reason,outcome,refused,money_basis)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        o.decisionId,
        o.ts,
        o.actualModel,
        o.input,
        o.cacheRead,
        o.cacheWrite,
        o.output,
        o.durationMs,
        o.ttftMs ?? null,
        o.stopReason ?? null,
        o.outcome,
        o.refused ? 1 : 0,
        o.moneyBasis,
      );
  }

  getOutcome(decisionId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM outcomes WHERE decision_id=?").get(decisionId) as
      | Record<string, unknown>
      | undefined;
  }

  // ─── cards ──────────────────────────────────────────────────────────────────────────────────

  /** Add a version of a card and, unless told not to, make it the active one. A version is never edited. */
  addCardVersion(
    c: EnhancementCard,
    o: { createdAt: number; parent?: number; replay?: unknown; activate?: boolean },
  ): void {
    this.db
      .prepare(
        `INSERT INTO enh_cards(card_id,version,family,kind,name,path,purpose,structure,also_json,status,origin,parent,replay_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.id,
        c.version,
        c.family,
        c.kind,
        c.name,
        c.path ?? null,
        c.purpose,
        c.structure,
        json(c.alsoServed),
        c.status,
        c.origin,
        o.parent ?? null,
        o.replay === undefined ? null : json(o.replay),
        o.createdAt,
      );
    if (o.activate !== false) {
      this.db
        .prepare(
          `INSERT INTO enh_active(card_id,version,since) VALUES(?,?,?) ON CONFLICT(card_id) DO UPDATE SET version=excluded.version, since=excluded.since`,
        )
        .run(c.id, c.version, o.createdAt);
    }
  }

  private static card(r: Record<string, unknown>): EnhancementCard {
    return {
      id: r.card_id as string,
      kind: r.kind as EnhancementCard["kind"],
      name: r.name as string,
      ...(r.path ? { path: r.path as string } : {}),
      family: r.family as string,
      purpose: r.purpose as string,
      structure: r.structure as string,
      alsoServed: parse<string[]>(r.also_json, []),
      version: r.version as number,
      status: r.status as EnhancementCard["status"],
      origin: r.origin as EnhancementCard["origin"],
    };
  }

  /** Seed the cards that have no version yet; a card that already has one is left exactly as it is. */
  seedCards(cards: readonly EnhancementCard[], createdAt: number): number {
    let added = 0;
    const has = this.db.prepare("SELECT 1 FROM enh_cards WHERE card_id=? LIMIT 1");
    const tx = this.db.transaction((list: readonly EnhancementCard[]) => {
      for (const c of list) {
        if (has.get(c.id)) continue;
        this.addCardVersion({ ...c, version: 1, origin: "seed" }, { createdAt });
        added += 1;
      }
    });
    tx(cards);
    return added;
  }

  activeCards(): EnhancementCard[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM enh_cards c JOIN enh_active a ON a.card_id=c.card_id AND a.version=c.version ORDER BY c.card_id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(ThalamusStore.card);
  }

  /**
   * Point a card at one of its stored versions: a step back, or forward again. Nothing is deleted, every version stays.
   * Returns false, changing nothing, when that version does not exist.
   */
  setActiveVersion(cardId: string, version: number, ts: number): boolean {
    const has = this.db
      .prepare("SELECT 1 FROM enh_cards WHERE card_id=? AND version=? LIMIT 1")
      .get(cardId, version);
    if (!has) return false;
    this.db
      .prepare(
        `INSERT INTO enh_active(card_id,version,since) VALUES(?,?,?) ON CONFLICT(card_id) DO UPDATE SET version=excluded.version, since=excluded.since`,
      )
      .run(cardId, version, ts);
    return true;
  }

  cardVersions(cardId: string): EnhancementCard[] {
    return (
      this.db
        .prepare("SELECT * FROM enh_cards WHERE card_id=? ORDER BY version")
        .all(cardId) as Record<string, unknown>[]
    ).map(ThalamusStore.card);
  }

  // ─── enhancement uses ───────────────────────────────────────────────────────────────────────

  upsertUse(u: UseRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO enh_uses(task_id,ts,session,source,private,shuffled,shown_json,none_fits,list_shown,list_reason,list_source,used_json,outcome,card_versions_json,question_version,mode,task_kind,skip_reason,skip_detail,jev_ms,shown_modes,shown_sources)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        u.taskId,
        u.ts,
        u.session,
        u.source,
        u.private ? 1 : 0,
        u.shuffled ? 1 : 0,
        json(u.shown),
        u.noneFits,
        u.listShown ? 1 : 0,
        u.listReason,
        u.listSource,
        json(u.used),
        u.outcome,
        json(u.cardVersions),
        u.questionVersion,
        u.mode,
        u.taskKind ?? null,
        u.skipReason ?? null,
        u.skipDetail ?? null,
        u.jevMs ?? null,
        u.shown.map((e) => e.mode ?? "?").join(","),
        u.shown.map((e) => e.source ?? "?").join(","),
      );
  }

  private static useRow(r: Record<string, unknown>): UseRow {
    return {
      taskId: r.task_id as string,
      ts: r.ts as number,
      session: r.session as string,
      source: r.source as string,
      private: r.private === 1,
      shuffled: r.shuffled === 1,
      shown: parse(r.shown_json, []),
      noneFits: r.none_fits as number,
      listShown: r.list_shown === 1,
      listReason: r.list_reason as Shortlist["reason"],
      listSource: r.list_source as Shortlist["source"],
      used: parse(r.used_json, []),
      outcome: r.outcome as UseRow["outcome"],
      cardVersions: parse(r.card_versions_json, {}),
      questionVersion: r.question_version as number,
      mode: r.mode as string,
      ...(typeof r.task_kind === "string" && r.task_kind ? { taskKind: r.task_kind } : {}),
      ...(typeof r.skip_reason === "string" && r.skip_reason ? { skipReason: r.skip_reason } : {}),
      ...(typeof r.skip_detail === "string" && r.skip_detail ? { skipDetail: r.skip_detail } : {}),
      ...(typeof r.jev_ms === "number" ? { jevMs: r.jev_ms } : {}),
    };
  }

  getUse(taskId: string): UseRow | undefined {
    const r = this.db.prepare("SELECT * FROM enh_uses WHERE task_id=?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    return r ? ThalamusStore.useRow(r) : undefined;
  }

  listUses(o: { sinceTs?: number; limit?: number } = {}): UseRow[] {
    const rows = this.db
      .prepare("SELECT * FROM enh_uses WHERE ts >= ? ORDER BY ts LIMIT ?")
      .all(o.sinceTs ?? 0, o.limit ?? 100_000) as Array<Record<string, unknown>>;
    return rows.map((r) => ThalamusStore.useRow(r));
  }

  // ─── learning: outcomes, estimates, time, runs (phase F) ──────────────────────────────────

  /**
   * Every recorded call that has an outcome, joined to the decision it answered, as the learning run reads it. The model
   * is the one that ANSWERED (`outcomes.actual_model`), never the pick. A decision written before the read columns existed
   * has no domain, topic or step kind and is left out: nothing honest can be said about its kind of work.
   */
  outcomeFacts(o: { sinceTs?: number } = {}): OutcomeFact[] {
    const rows = this.db
      .prepare(
        `SELECT o.ts ts, d.domain domain, d.topic topic, d.step_kind step_kind, o.actual_model rung, o.outcome outcome,
                o.refused refused, o.input input, o.cache_read cache_read, o.cache_write cache_write, o.output output,
                o.duration_ms duration_ms, o.ttft_ms ttft_ms
         FROM outcomes o JOIN decisions d ON d.id = o.decision_id
         WHERE o.ts >= ? AND d.domain IS NOT NULL AND d.step_kind IS NOT NULL AND o.actual_model IS NOT NULL
         ORDER BY o.ts`,
      )
      .all(o.sinceTs ?? 0) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ts: Number(r.ts),
      domain: String(r.domain) as OutcomeFact["domain"],
      topic: (typeof r.topic === "string" && r.topic ? r.topic : "none") as OutcomeFact["topic"],
      stepKind: String(r.step_kind) as OutcomeFact["stepKind"],
      rungKey: String(r.rung),
      outcome: (typeof r.outcome === "string" && r.outcome
        ? r.outcome
        : "done") as OutcomeFact["outcome"],
      refused: Number(r.refused) === 1,
      input: Number(r.input ?? 0),
      cacheRead: Number(r.cache_read ?? 0),
      cacheWrite: Number(r.cache_write ?? 0),
      output: Number(r.output ?? 0),
      durationMs: Number(r.duration_ms ?? 0),
      ...(r.ttft_ms != null ? { ttftMs: Number(r.ttft_ms) } : {}),
    }));
  }

  /** Replace the estimates with the latest aggregate of the retained outcomes. */
  putEstimates(rows: readonly Estimate[], ts: number): void {
    const tx = this.db.transaction((list: readonly Estimate[]) => {
      this.db.prepare("DELETE FROM estimates").run();
      const ins = this.db.prepare(
        `INSERT INTO estimates(domain,step_kind,rung,n,wins,retries,refusals,cost_sum,time_sum,prior,posterior,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const e of list)
        ins.run(
          e.domain,
          e.stepKind,
          e.rung,
          e.n,
          e.wins,
          e.retries,
          e.refusals,
          e.costSum,
          e.timeSum,
          e.prior,
          e.posterior,
          ts,
        );
    });
    tx(rows);
  }

  getEstimates(): Estimate[] {
    const rows = this.db
      .prepare("SELECT * FROM estimates ORDER BY domain, step_kind, rung")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      domain: String(r.domain) as Estimate["domain"],
      stepKind: String(r.step_kind) as Estimate["stepKind"],
      rung: String(r.rung),
      n: Number(r.n),
      wins: Number(r.wins),
      retries: Number(r.retries),
      refusals: Number(r.refusals),
      costSum: Number(r.cost_sum),
      timeSum: Number(r.time_sum),
      prior: Number(r.prior),
      posterior: Number(r.posterior),
    }));
  }

  putRungTimes(rows: readonly RungTimeStats[], ts: number): void {
    const tx = this.db.transaction((list: readonly RungTimeStats[]) => {
      this.db.prepare("DELETE FROM rung_time").run();
      const ins = this.db.prepare(
        `INSERT INTO rung_time(rung,n,duration_p50,duration_p95,ttft_warm_p50,ttft_cold_p50,ttft_p95,tps_p50,tps_p5,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const r of list)
        ins.run(
          r.rung,
          r.n,
          r.durationP50Sec,
          r.durationP95Sec,
          r.ttftWarmP50Sec ?? null,
          r.ttftColdP50Sec ?? null,
          r.ttftP95Sec ?? null,
          r.tokensPerSecP50 ?? null,
          r.tokensPerSecP5 ?? null,
          ts,
        );
    });
    tx(rows);
  }

  getRungTimes(): RungTimeStats[] {
    const rows = this.db.prepare("SELECT * FROM rung_time ORDER BY rung").all() as Array<
      Record<string, unknown>
    >;
    const opt = (v: unknown): number | undefined => (v == null ? undefined : Number(v));
    return rows.map((r) => ({
      rung: String(r.rung),
      n: Number(r.n),
      durationP50Sec: Number(r.duration_p50),
      durationP95Sec: Number(r.duration_p95),
      ...(opt(r.ttft_warm_p50) !== undefined ? { ttftWarmP50Sec: opt(r.ttft_warm_p50) } : {}),
      ...(opt(r.ttft_cold_p50) !== undefined ? { ttftColdP50Sec: opt(r.ttft_cold_p50) } : {}),
      ...(opt(r.ttft_p95) !== undefined ? { ttftP95Sec: opt(r.ttft_p95) } : {}),
      ...(opt(r.tps_p50) !== undefined ? { tokensPerSecP50: opt(r.tps_p50) } : {}),
      ...(opt(r.tps_p5) !== undefined ? { tokensPerSecP5: opt(r.tps_p5) } : {}),
    }));
  }

  /** One row per run of the nightly job, kept so the report of the last run can be shown again. */
  recordLearningRun(r: { ts: number; mode: string; dry: boolean; report: unknown }): number {
    const info = this.db
      .prepare("INSERT INTO learning_runs(ts,mode,dry,report_json) VALUES(?,?,?,?)")
      .run(r.ts, r.mode, r.dry ? 1 : 0, json(r.report));
    return Number(info.lastInsertRowid);
  }

  lastLearningRun(
    o: { dry?: boolean } = {},
  ): { id: number; ts: number; mode: string; dry: boolean; report: unknown } | undefined {
    const row = (
      o.dry === undefined
        ? this.db.prepare("SELECT * FROM learning_runs ORDER BY id DESC LIMIT 1").get()
        : this.db
            .prepare("SELECT * FROM learning_runs WHERE dry=? ORDER BY id DESC LIMIT 1")
            .get(o.dry ? 1 : 0)
    ) as Record<string, unknown> | undefined;
    return row
      ? {
          id: Number(row.id),
          ts: Number(row.ts),
          mode: String(row.mode),
          dry: Number(row.dry) === 1,
          report: parse(row.report_json, null),
        }
      : undefined;
  }

  // ─── the card loop's own tables (phase F) ─────────────────────────────────────────────────

  putRates(
    r: { pi: readonly number[]; picked: readonly number[]; tasks: number; source: string },
    ts: number,
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM enh_rates").run();
      const ins = this.db.prepare(
        "INSERT INTO enh_rates(rank,tasks,picked,pi,source,updated_at) VALUES(?,?,?,?,?,?)",
      );
      r.pi.forEach((pi, i) => ins.run(i + 1, r.tasks, r.picked[i] ?? 0, pi, r.source, ts));
    });
    tx();
  }

  getRates(): { pi: number[]; tasks: number; source: string } | undefined {
    const rows = this.db.prepare("SELECT * FROM enh_rates ORDER BY rank").all() as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) return undefined;
    return {
      pi: rows.map((r) => Number(r.pi)),
      tasks: Number(rows[0].tasks),
      source: String(rows[0].source),
    };
  }

  putCalibration(
    map: CalibrationMap,
    meta: { n: number; fromShuffled: boolean },
    ts: number,
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM enh_calibration").run();
      const ins = this.db.prepare(
        "INSERT INTO enh_calibration(idx,p,mapped,n,from_shuffled,updated_at) VALUES(?,?,?,?,?,?)",
      );
      map.forEach((m, i) => ins.run(i, m.p, m.mapped, meta.n, meta.fromShuffled ? 1 : 0, ts));
    });
    tx();
  }

  getCalibration(): CalibrationMap {
    const rows = this.db
      .prepare("SELECT p, mapped FROM enh_calibration ORDER BY idx")
      .all() as Array<{ p: number; mapped: number }>;
    return rows.map((r) => ({ p: Number(r.p), mapped: Number(r.mapped) }));
  }

  /** The redacted text of a task from a source Jev may read: the one place this store keeps content (13A.3). */
  putReplayText(taskId: string, text: string, ts: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO enh_replay_set(task_id,ts,text_redacted) VALUES(?,?,?)")
      .run(taskId, ts, text);
  }

  listReplayTexts(
    o: { sinceTs?: number; limit?: number } = {},
  ): Array<{ taskId: string; ts: number; text: string }> {
    const rows = this.db
      .prepare(
        "SELECT task_id, ts, text_redacted FROM enh_replay_set WHERE ts >= ? ORDER BY ts DESC LIMIT ?",
      )
      .all(o.sinceTs ?? 0, o.limit ?? 500) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      taskId: String(r.task_id),
      ts: Number(r.ts),
      text: String(r.text_redacted),
    }));
  }

  /** The owner's correction: this task should have used this enhancement. The strongest label there is. */
  addPin(p: { id: string; taskId: string; cardId: string; by: string; createdAt: number }): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO enh_pins(id,task_id,card_id,by,created_at) VALUES(?,?,?,?,?)",
      )
      .run(p.id, p.taskId, p.cardId, p.by, p.createdAt);
  }

  listPins(): Array<{ id: string; taskId: string; cardId: string; by: string; createdAt: number }> {
    const rows = this.db.prepare("SELECT * FROM enh_pins ORDER BY created_at, id").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      cardId: String(r.card_id),
      by: String(r.by),
      createdAt: Number(r.created_at),
    }));
  }

  /** A proposal for a person. Seen again on another night it stays one row, and its status is kept. */
  addProposal(p: { id: string; kind: string; payload: unknown; createdAt: number }): boolean {
    const info = this.db
      .prepare(
        "INSERT OR IGNORE INTO enh_proposals(id,kind,payload_json,status,created_at) VALUES(?,?,?,?,?)",
      )
      .run(p.id, p.kind, json(p.payload), "open", p.createdAt);
    return info.changes > 0;
  }

  listProposals(
    o: { status?: string } = {},
  ): Array<{ id: string; kind: string; payload: unknown; status: string; createdAt: number }> {
    const rows = (
      o.status
        ? this.db
            .prepare("SELECT * FROM enh_proposals WHERE status=? ORDER BY created_at, id")
            .all(o.status)
        : this.db.prepare("SELECT * FROM enh_proposals ORDER BY created_at, id").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      payload: parse(r.payload_json, {}),
      status: String(r.status),
      createdAt: Number(r.created_at),
    }));
  }

  // ─── fresh points (D3, D4) ──────────────────────────────────────────────────────────────────

  insertFreshPoint(r: FreshPointRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO fresh_points(id,ts,session,run_id,call_index,kind,mode,acted,reason,model,family,detail_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.ts,
        r.session ?? null,
        r.runId,
        r.callIndex ?? null,
        r.kind,
        r.mode,
        r.acted ? 1 : 0,
        r.reason,
        r.model ?? null,
        r.family ?? null,
        json(r.detail),
      );
  }

  listFreshPoints(
    o: { runId?: string; kind?: FreshPointRow["kind"]; sinceTs?: number; limit?: number } = {},
  ): FreshPointRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.runId) (where.push("run_id=?"), args.push(o.runId));
    if (o.kind) (where.push("kind=?"), args.push(o.kind));
    if (typeof o.sinceTs === "number") (where.push("ts>=?"), args.push(o.sinceTs));
    const sql = `SELECT * FROM fresh_points ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT ?`;
    const rows = this.db
      .prepare(sql)
      .all(...args, Math.min(500, Math.max(1, o.limit ?? 100))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      ts: r.ts as number,
      ...(r.session ? { session: r.session as string } : {}),
      runId: r.run_id as string,
      ...(r.call_index !== null ? { callIndex: r.call_index as number } : {}),
      kind: r.kind as FreshPointRow["kind"],
      mode: r.mode as string,
      acted: r.acted === 1,
      reason: r.reason as string,
      ...(r.model ? { model: r.model as string } : {}),
      ...(r.family ? { family: r.family as string } : {}),
      detail: parse<Record<string, unknown>>(r.detail_json, {}),
    }));
  }

  // ─── raw results kept for recall (D3) ───────────────────────────────────────────────────────

  putRaw(r: Omit<RawRow, "recalls" | "lastRecallTs">): void {
    this.db
      .prepare(
        `INSERT INTO raw_results(name,ts,session,path,bytes,tokens,digest_tokens,tool) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET ts=excluded.ts, path=excluded.path, digest_tokens=excluded.digest_tokens`,
      )
      .run(r.name, r.ts, r.session, r.path, r.bytes, r.tokens, r.digestTokens ?? null, r.tool);
  }

  getRaw(name: string): RawRow | undefined {
    const r = this.db.prepare("SELECT * FROM raw_results WHERE name=?").get(name) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      name: r.name as string,
      ts: r.ts as number,
      session: r.session as string,
      path: r.path as string,
      bytes: r.bytes as number,
      tokens: r.tokens as number,
      ...(r.digest_tokens !== null ? { digestTokens: r.digest_tokens as number } : {}),
      tool: r.tool as string,
      recalls: (r.recalls as number) ?? 0,
      ...(r.last_recall_ts !== null ? { lastRecallTs: r.last_recall_ts as number } : {}),
    };
  }

  noteRecall(name: string, ts: number): void {
    this.db
      .prepare("UPDATE raw_results SET recalls=recalls+1, last_recall_ts=? WHERE name=?")
      .run(ts, name);
  }

  rawOlderThan(ts: number): RawRow[] {
    const names = this.db.prepare("SELECT name FROM raw_results WHERE ts < ?").all(ts) as Array<{
      name: string;
    }>;
    return names.map((n) => this.getRaw(n.name)!).filter(Boolean);
  }

  deleteRaw(name: string): void {
    this.db.prepare("DELETE FROM raw_results WHERE name=?").run(name);
  }

  // ─── the scheduler's plans (phase E) ───────────────────────────────────────────────────────

  insertPlanUnit(r: PlanUnitRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO units(plan_id,unit_id,copy,ts,mode,deps_json,writes_json,model,effort,start_sec,end_sec,
           slack_sec,on_critical,hedged,price,status,detail_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.planId,
        r.unitId,
        r.copy,
        r.ts,
        r.mode,
        JSON.stringify(r.deps),
        JSON.stringify(r.writes),
        r.model ?? null,
        r.effort ?? null,
        r.startSec ?? null,
        r.endSec ?? null,
        r.slackSec ?? null,
        r.onCritical ? 1 : 0,
        r.hedged ? 1 : 0,
        r.price ?? null,
        r.status,
        JSON.stringify(r.detail),
      );
  }

  listPlanUnits(planId: string): PlanUnitRow[] {
    const rows = this.db
      .prepare("SELECT * FROM units WHERE plan_id=? ORDER BY start_sec, unit_id, copy")
      .all(planId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      planId: String(r.plan_id),
      unitId: String(r.unit_id),
      copy: Number(r.copy) === 1 ? 1 : 0,
      ts: Number(r.ts),
      mode: String(r.mode),
      deps: JSON.parse(String(r.deps_json ?? "[]")) as string[],
      writes: JSON.parse(String(r.writes_json ?? "[]")) as string[],
      ...(r.model != null ? { model: String(r.model) } : {}),
      ...(r.effort != null ? { effort: String(r.effort) } : {}),
      ...(r.start_sec != null ? { startSec: Number(r.start_sec) } : {}),
      ...(r.end_sec != null ? { endSec: Number(r.end_sec) } : {}),
      ...(r.slack_sec != null ? { slackSec: Number(r.slack_sec) } : {}),
      onCritical: Number(r.on_critical) === 1,
      hedged: Number(r.hedged) === 1,
      ...(r.price != null ? { price: Number(r.price) } : {}),
      status: String(r.status),
      detail: JSON.parse(String(r.detail_json ?? "{}")) as Record<string, unknown>,
    }));
  }

  // ─── calls a Claude Code sub-agent made inside a turn (D5) ──────────────────────────────────

  insertSubagentCall(r: SubagentCallRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO subagent_calls(id,ts,session,parent_tool_use_id,model,input,cache_read,cache_write,output)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.ts,
        r.session,
        r.parentToolUseId,
        r.model ?? null,
        r.input ?? null,
        r.cacheRead ?? null,
        r.cacheWrite ?? null,
        r.output ?? null,
      );
  }

  listSubagentCalls(o: { session?: string; limit?: number } = {}): SubagentCallRow[] {
    const rows = (
      o.session
        ? this.db
            .prepare("SELECT * FROM subagent_calls WHERE session=? ORDER BY ts DESC LIMIT ?")
            .all(o.session, Math.min(500, o.limit ?? 100))
        : this.db
            .prepare("SELECT * FROM subagent_calls ORDER BY ts DESC LIMIT ?")
            .all(Math.min(500, o.limit ?? 100))
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      ts: r.ts as number,
      session: r.session as string,
      parentToolUseId: r.parent_tool_use_id as string,
      ...(r.model ? { model: r.model as string } : {}),
      ...(r.input !== null ? { input: r.input as number } : {}),
      ...(r.cache_read !== null ? { cacheRead: r.cache_read as number } : {}),
      ...(r.cache_write !== null ? { cacheWrite: r.cache_write as number } : {}),
      ...(r.output !== null ? { output: r.output as number } : {}),
    }));
  }

  // ─── housekeeping ───────────────────────────────────────────────────────────────────────────

  counts(): {
    decisions: number;
    wouldChange: number;
    outcomes: number;
    cards: number;
    uses: number;
    freshPoints: number;
    rawResults: number;
    subagentCalls: number;
    planUnits: number;
  } {
    const n = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      decisions: n("SELECT COUNT(*) n FROM decisions"),
      wouldChange: n("SELECT COUNT(*) n FROM decisions WHERE would_change=1"),
      outcomes: n("SELECT COUNT(*) n FROM outcomes"),
      cards: n("SELECT COUNT(*) n FROM enh_active"),
      uses: n("SELECT COUNT(*) n FROM enh_uses"),
      freshPoints: n("SELECT COUNT(*) n FROM fresh_points"),
      rawResults: n("SELECT COUNT(*) n FROM raw_results"),
      subagentCalls: n("SELECT COUNT(*) n FROM subagent_calls"),
      planUnits: n("SELECT COUNT(*) n FROM units"),
    };
  }

  /** Drop decisions, fresh-point records and sub-agent counts (and outcomes) older than the cutoff. Cards and uses are the loop's history and stay; raw results are pruned by the raw store, which owns the files. */
  pruneDecisions(olderThanTs: number): number {
    const tx = this.db.transaction((ts: number) => {
      this.db
        .prepare(
          "DELETE FROM outcomes WHERE decision_id IN (SELECT id FROM decisions WHERE ts < ?)",
        )
        .run(ts);
      this.db.prepare("DELETE FROM fresh_points WHERE ts < ?").run(ts);
      this.db.prepare("DELETE FROM subagent_calls WHERE ts < ?").run(ts);
      this.db.prepare("DELETE FROM units WHERE ts < ?").run(ts);
      return this.db.prepare("DELETE FROM decisions WHERE ts < ?").run(ts).changes;
    });
    return tx(olderThanTs);
  }
}
