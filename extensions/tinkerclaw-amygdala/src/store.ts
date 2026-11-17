/**
 * SQLite store of the digital amygdala (design doc §3 M5, §7.3). One file, WAL. Append-only for situations,
 * verdicts, decisions, labels and question versions; only the pointer/state tables listed in the design mutate.
 * Timestamps are epoch milliseconds.
 */

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Explanation, ExplanationEvent, ExplanationRow } from "./explain.js";
import type { PassReview, Review, ReviewReportRow, ReviewRow } from "./review.js";
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

/**
 * FORK 2026-10-29: verdict sums of whole past days by day key, and the end of the latest day they cover. `conns` are
 * the connections of the stores open on the file; `versions` holds the PRAGMA data_version each of them read before
 * the first cached day was summed, or null while no day is cached (`forgetIfOutsideCommit`).
 */
interface ClosedDaySpend {
  days: Map<string, VerdictSpend>;
  until: number;
  conns: Set<Database.Database>;
  versions: Map<Database.Database, number> | null;
}

// FORK 2026-10-29: ".v2" since the entries carry `conns` and `versions`; one an older build left in this process has
// neither.
const CLOSED_DAY_SPEND = Symbol.for("tinkerclaw.amygdala.closedDaySpend.v2");

/**
 * FORK 2026-10-29: one closed-day cache per database file in this process. The gateway runs register() several times
 * in one process (four starts in 100 s on 2026-10-22), so several stores can be open on one file, and the write that
 * must drop the cache (a replay) can reach a different store than the feed that reads it. The key is the file's real
 * path: keyed by resolve(), a store opened through a symlink and one opened through the real path had a cache each,
 * and a backdated verdict written through one left the other summing the old days. Called once the store has opened
 * the file, so the file exists; resolve() stands in only if realpath fails. An in-memory database keeps its own.
 * Opening a store empties the cache of its file.
 */
function closedDaySpendFor(path: string, db: Database.Database): ClosedDaySpend {
  const fresh = (): ClosedDaySpend => ({
    days: new Map(),
    until: Number.NEGATIVE_INFINITY,
    conns: new Set(),
    versions: null,
  });
  if (path === ":memory:") {
    const own = fresh();
    own.conns.add(db);
    return own;
  }
  const g = globalThis as { [CLOSED_DAY_SPEND]?: Map<string, ClosedDaySpend> };
  const all = (g[CLOSED_DAY_SPEND] ??= new Map<string, ClosedDaySpend>());
  let key: string;
  try {
    key = realpathSync(path);
  } catch {
    key = resolve(path);
  }
  const c = all.get(key) ?? fresh();
  c.days.clear();
  c.until = Number.NEGATIVE_INFINITY;
  c.versions = null;
  c.conns.add(db);
  all.set(key, c);
  return c;
}

function json(v: unknown): string {
  return JSON.stringify(v);
}

function parse<T>(s: unknown): T {
  return JSON.parse(String(s)) as T;
}

/**
 * A session's last four typed orders in a day (2026-11-02). In the store and not the tracker because a restart empties the
 * tracker, and a job's wake-up often follows one. Four: the two jobs misread on 2026-11-02 sat 2 and 3 orders back, an
 * Allow code among them. CROSS JOIN keeps `d_ts` in front, so the walk is bounded by time and not by the session: 3 ms on
 * the live store, where leading with the session took 3.5 s on a 103k-row session.
 */
export const OWNER_ORDERS_SQL =
  "SELECT json_extract(s.record_json, '$.request.value') AS request " +
  "FROM decisions d CROSS JOIN situations s ON s.id = d.situation_id " +
  "WHERE d.ts >= ? AND d.ts < ? AND d.seam = 'prompt' AND s.session = ? " +
  "AND json_extract(s.record_json, '$.turnKind.value') = 'owner' " +
  "AND json_extract(s.record_json, '$.request.value') IS NOT NULL " +
  "ORDER BY d.ts DESC LIMIT 4";

/**
 * The typed orders of every session in a day, newest first (2026-11-17), for a turn whose own session never holds one:
 * the relay, where each fan-out unit started with no parent reports its end. The caller keeps the newest four of his
 * own chats. Bounded by time like OWNER_ORDERS_SQL: 11 ms and 59 rows on the live store for the day before 11-17 00:39.
 */
export const OWNER_CHAT_ORDERS_SQL =
  "SELECT s.session AS session, json_extract(s.record_json, '$.request.value') AS request " +
  "FROM decisions d CROSS JOIN situations s ON s.id = d.situation_id " +
  "WHERE d.ts >= ? AND d.ts < ? AND d.seam = 'prompt' AND s.session NOT LIKE 'temp:%' " +
  "AND json_extract(s.record_json, '$.turnKind.value') = 'owner' " +
  "AND json_extract(s.record_json, '$.request.value') IS NOT NULL " +
  "ORDER BY d.ts DESC";

export class AmygdalaStore {
  private readonly db: Database.Database;
  /** FORK 2026-10-29: shared with every store open on the same file (`closedDaySpendFor`). */
  private readonly closedDays: ClosedDaySpend;

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
    // Added 2026-10-05 for the WOULD HAVE explainer, the same way. `agreed` records whether the owner's vote matched the
    // explainer's suggestion, so its pull on his labels can be measured.
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS explanations(decision_id TEXT PRIMARY KEY, session TEXT NOT NULL, turn_id TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, body_json TEXT, error TEXT, vote INTEGER, agreed INTEGER, vote_ts INTEGER)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS explanations_ts ON explanations(ts)");
    // Added 2026-10-06: Grok's after-the-fact verdict on whether a flag would have helped (see review.ts).
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS reviews(decision_id TEXT PRIMARY KEY, session TEXT NOT NULL, turn_id TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, verdict TEXT, body_json TEXT, error TEXT)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS reviews_ts ON reviews(ts)");
    // Added 2026-10-15: pass reviews (review.ts) share the table; `kind` tells a judged flag ('flag') from a judged
    // pass ('pass'). Rows from before read as flags.
    const reviewCols = (this.db.prepare("PRAGMA table_info(reviews)").all() as Row[]).map(
      (r) => r.name as string,
    );
    if (!reviewCols.includes("kind"))
      this.db.exec("ALTER TABLE reviews ADD COLUMN kind TEXT NOT NULL DEFAULT 'flag'");
    // Added 2026-10-06, the same way. The feed (feed.ts) reads a decision's verdicts by situation, up
    // to 400 times per call, and the spend sums read verdicts by time; neither had an index, so each
    // lookup scanned the whole table (live store, 166,865 rows: 20.4 ms a lookup, ~7 s a feed, two
    // feeds per Tinker page load, on the gateway's one event loop). With v_sit the 400 lookups took
    // 2.6 ms on a copy of the live columns. Built once, on the first open after the upgrade.
    this.db.exec("CREATE INDEX IF NOT EXISTS v_sit ON verdicts(situation_id, ts)");
    this.db.exec("CREATE INDEX IF NOT EXISTS v_ts ON verdicts(ts)");
    // FORK 2026-10-29: the stop seam's turn queries (flaggedDecisionsForTurn, unjudgedPassesForTurn, turnStartTs)
    // run on the gateway's main thread before the hook gets its answer, and they were full-history scans: no index
    // led with situations.turn_id and decisions had none on situation_id, so each walked every stored decision
    // through d_ts (live store, 273k decisions: 1.5-2.2 s warm per stop, a third of stop hooks at the 5 s fail-open).
    // With these two they are seeks returning the same rows in the same order, under 1 ms each on a copy of the live
    // key columns; s_turn carries ts so turnStartTs reads MIN(ts) from the index alone. The first open of a large
    // existing store builds both once, on this thread (0.65 s on that copy; the live file is unmeasured). d_sit
    // would also re-plan decisionsSinceForSession, so that query pins its old plan (see there).
    this.db.exec("CREATE INDEX IF NOT EXISTS s_turn ON situations(turn_id, ts)");
    this.db.exec("CREATE INDEX IF NOT EXISTS d_sit ON decisions(situation_id)");
    // FORK 2026-10-29: last, so the file exists for realpath and a failed open joins no cache (closedDaySpendFor).
    this.closedDays = closedDaySpendFor(path, this.db);
  }

  saveReview(r: ReviewRow): void {
    this.db
      .prepare(
        "INSERT INTO reviews(decision_id, session, turn_id, ts, status, model, verdict, body_json, error, kind) VALUES (?,?,?,?,?,?,?,?,?,?) " +
          "ON CONFLICT(decision_id) DO UPDATE SET status = excluded.status, model = excluded.model, verdict = excluded.verdict, body_json = excluded.body_json, error = excluded.error, kind = excluded.kind",
      )
      .run(
        r.decisionId,
        r.sessionKey,
        r.turnId,
        r.ts,
        r.status,
        r.model ?? null,
        r.review?.verdict ?? null,
        r.review ? json(r.review) : null,
        r.error ?? null,
        r.kind ?? "flag",
      );
  }

  hasReview(decisionId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM reviews WHERE decision_id = ? AND status = 'done'")
      .get(decisionId);
  }

  /** Reviews since `since` (newest first), for the report. */
  reviewsSince(since: number, limit = 200): ReviewRow[] {
    return (
      this.db
        .prepare("SELECT * FROM reviews WHERE ts >= ? ORDER BY ts DESC LIMIT ?")
        .all(since, limit) as Row[]
    ).map((r) => ({
      decisionId: r.decision_id as string,
      sessionKey: r.session as string,
      turnId: r.turn_id as string,
      ts: r.ts as number,
      status: r.status as ReviewRow["status"],
      kind: r.kind === "pass" ? ("pass" as const) : ("flag" as const),
      ...(r.model ? { model: r.model as string } : {}),
      ...(r.body_json ? { review: parse<Review | PassReview>(r.body_json) } : {}),
      ...(r.error ? { error: r.error as string } : {}),
    }));
  }

  /** The decisions of one turn that changed (or would have changed) something, oldest first. */
  flaggedDecisionsForTurn(turnId: string): DecisionRow[] {
    return (
      this.db
        .prepare(
          "SELECT d.* FROM decisions d JOIN situations s ON s.id = d.situation_id WHERE s.turn_id = ? AND d.kind != 'proceed' ORDER BY d.ts, d.rowid",
        )
        .all(turnId) as Row[]
    ).map((r) => this.decisionFromRow(r));
  }

  /**
   * The checks Jev let pass in one turn that no done review covers yet (2026-10-15): the `proceed` decisions of its
   * pre-tool seam (one per tool call) where Jev was asked (not the fallback family: not consulted, unavailable,
   * dormant). Oldest first, at most `limit`. The "not yet judged" test sits in the query so the limit never hides an
   * unjudged pass behind judged ones.
   */
  unjudgedPassesForTurn(turnId: string, limit = 30): DecisionRow[] {
    return (
      this.db
        .prepare(
          "SELECT d.* FROM decisions d JOIN situations s ON s.id = d.situation_id WHERE s.turn_id = ? AND d.seam = 'pre-tool' AND d.kind = 'proceed' AND d.family != 'fallback' " +
            "AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.decision_id = d.id AND r.status = 'done') ORDER BY d.ts, d.rowid LIMIT ?",
        )
        .all(turnId, limit) as Row[]
    ).map((r) => this.decisionFromRow(r));
  }

  /**
   * The done reviews since `since`, with the decision each judged (2026-10-25, for the retune): flags and passes alike,
   * oldest first. `confidence` is the reviewer's own, read from the review body.
   */
  reviewEvidence(since: number): {
    decisionId: string;
    situationId: string;
    reasonCode: string;
    kind: "flag" | "pass";
    verdict: string;
    confidence: "low" | "medium" | "high";
  }[] {
    return (
      this.db
        .prepare(
          `SELECT r.decision_id AS decisionId, d.situation_id AS situationId, d.reason_code AS reasonCode,
                  r.kind AS kind, r.verdict AS verdict, r.body_json AS body
           FROM reviews r JOIN decisions d ON d.id = r.decision_id
           WHERE r.status = 'done' AND r.ts >= ? ORDER BY r.ts, r.rowid`,
        )
        .all(since) as Row[]
    ).map((r) => {
      let confidence: "low" | "medium" | "high" = "medium";
      try {
        const c = (JSON.parse(String(r.body)) as { confidence?: unknown }).confidence;
        if (c === "low" || c === "high") confidence = c;
      } catch {
        /* a body that does not parse reads as medium */
      }
      return {
        decisionId: r.decisionId as string,
        situationId: r.situationId as string,
        reasonCode: r.reasonCode as string,
        kind: r.kind === "pass" ? "pass" : "flag",
        verdict: r.verdict as string,
        confidence,
      };
    });
  }

  /** When a turn began: its earliest situation (the prompt seam fires before the first step). Null for an unknown turn. */
  turnStartTs(turnId: string): number | null {
    const r = this.db
      .prepare("SELECT MIN(ts) AS ts FROM situations WHERE turn_id = ?")
      .get(turnId) as Row | undefined;
    return typeof r?.ts === "number" ? r.ts : null;
  }

  /** The owner's last typed orders in a session, oldest first: see OWNER_ORDERS_SQL. */
  ownerOrders(sessionKey: string, before: number): string[] {
    const rows = this.db
      .prepare(OWNER_ORDERS_SQL)
      .all(before - 86_400_000, before, sessionKey) as Row[];
    return rows.map((r) => String(r.request)).reverse();
  }

  /** The owner's last four typed orders in his own chats, oldest first: see OWNER_CHAT_ORDERS_SQL. */
  ownerChatOrders(before: number, ownChat: (sessionKey: string) => boolean): string[] {
    const rows = this.db.prepare(OWNER_CHAT_ORDERS_SQL).all(before - 86_400_000, before) as Row[];
    return rows
      .filter((r) => ownChat(String(r.session)))
      .slice(0, 4)
      .map((r) => String(r.request))
      .reverse();
  }

  /**
   * What the reviews say, per rule: how many flags each family/response/rule raised since `since`, how Grok judged
   * them, and how the owner voted on them. The evidence for tightening a question or dropping an injection.
   */
  /** Per rule (family, kind, full reason code), the flag reviews by one judge since `since` (earned.ts, 2026-10-15). */
  earnedStats(
    since: number,
    judgePrefix: string,
  ): {
    family: string;
    kind: string;
    reasonCode: string;
    n: number;
    useful: number;
    harmful: number;
  }[] {
    return (
      this.db
        .prepare(
          `SELECT d.family AS family, d.kind AS kind, d.reason_code AS reasonCode, COUNT(*) AS n,
                  SUM(r.verdict = 'useful') AS useful, SUM(r.verdict = 'harmful') AS harmful
           FROM reviews r JOIN decisions d ON d.id = r.decision_id
           WHERE r.status = 'done' AND r.kind = 'flag' AND r.ts >= ? AND substr(r.model, 1, ?) = ?
           GROUP BY d.family, d.kind, d.reason_code`,
        )
        .all(since, judgePrefix.length, judgePrefix) as Row[]
    ).map((r) => ({
      family: r.family as string,
      kind: r.kind as string,
      reasonCode: r.reasonCode as string,
      n: r.n as number,
      useful: (r.useful as number) ?? 0,
      harmful: (r.harmful as number) ?? 0,
    }));
  }

  reviewReport(since: number): ReviewReportRow[] {
    return (
      this.db
        .prepare(
          `SELECT d.family AS family, d.kind AS kind,
                  CASE WHEN instr(d.reason_code, '[') > 0 THEN substr(d.reason_code, 1, instr(d.reason_code, '[') - 1) ELSE d.reason_code END AS rule,
                  COUNT(*) AS n,
                  SUM(r.verdict = 'useful') AS useful, SUM(r.verdict = 'harmless') AS harmless,
                  SUM(r.verdict = 'noise') AS noise, SUM(r.verdict = 'harmful') AS harmful,
                  SUM(r.kind = 'pass') AS passes, SUM(r.verdict = 'fine') AS fine, SUM(r.verdict = 'missed') AS missed,
                  SUM(EXISTS(SELECT 1 FROM labels l WHERE l.target_id = d.id AND l.kind = 'useful' AND l.value = 1)) AS up,
                  SUM(EXISTS(SELECT 1 FROM labels l WHERE l.target_id = d.id AND l.kind = 'useful' AND l.value = -1)) AS down
           FROM reviews r JOIN decisions d ON d.id = r.decision_id
           WHERE r.status = 'done' AND r.ts >= ?
           GROUP BY d.family, d.kind, rule ORDER BY n DESC`,
        )
        .all(since) as Row[]
    ).map((r) => ({
      family: r.family as string,
      kind: r.kind as string,
      rule: r.rule as string,
      n: r.n as number,
      useful: (r.useful as number) ?? 0,
      harmless: (r.harmless as number) ?? 0,
      noise: (r.noise as number) ?? 0,
      harmful: (r.harmful as number) ?? 0,
      ownerUp: (r.up as number) ?? 0,
      ownerDown: (r.down as number) ?? 0,
      // Pass reviews (2026-10-15) count as fine / missed; a rule with none keeps the flag-only shape.
      ...((r.passes as number) > 0
        ? { fine: (r.fine as number) ?? 0, missed: (r.missed as number) ?? 0 }
        : {}),
    }));
  }

  /** Insert or replace an explanation's state; a vote already given is kept. */
  saveExplanation(e: ExplanationEvent): void {
    this.db
      .prepare(
        "INSERT INTO explanations(decision_id, session, turn_id, ts, status, model, body_json, error) VALUES (?,?,?,?,?,?,?,?) " +
          "ON CONFLICT(decision_id) DO UPDATE SET status = excluded.status, model = excluded.model, body_json = excluded.body_json, error = excluded.error",
      )
      .run(
        e.decisionId,
        e.sessionKey,
        e.turnId,
        e.ts,
        e.status,
        e.model ?? null,
        e.explanation ? json(e.explanation) : null,
        e.error ?? null,
      );
  }

  private explanationRow(r: Row, staleBefore?: number): ExplanationRow {
    const stale =
      r.status === "pending" && staleBefore !== undefined && (r.ts as number) < staleBefore;
    return {
      decisionId: r.decision_id as string,
      sessionKey: r.session as string,
      turnId: r.turn_id as string,
      ts: r.ts as number,
      status: stale ? "failed" : (r.status as ExplanationEvent["status"]),
      ...(r.model ? { model: r.model as string } : {}),
      ...(r.body_json ? { explanation: parse<Explanation>(r.body_json) } : {}),
      ...(stale
        ? { error: "never finished (the gateway restarted?)" }
        : r.error
          ? { error: r.error as string }
          : {}),
      ...(r.vote === 1 || r.vote === -1 ? { vote: r.vote as 1 | -1, agreed: r.agreed === 1 } : {}),
    };
  }

  getExplanation(decisionId: string): ExplanationRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM explanations WHERE decision_id = ?")
      .get(decisionId) as Row | undefined;
    return r ? this.explanationRow(r) : undefined;
  }

  /** Explanations since `since`; a row still pending before `staleBefore` reads as failed. */
  explanationsSince(
    since: number,
    o: { sessionKey?: string; staleBefore?: number } = {},
  ): ExplanationRow[] {
    const rows = (
      o.sessionKey
        ? this.db
            .prepare("SELECT * FROM explanations WHERE ts >= ? AND session = ? ORDER BY ts")
            .all(since, o.sessionKey)
        : this.db.prepare("SELECT * FROM explanations WHERE ts >= ? ORDER BY ts").all(since)
    ) as Row[];
    return rows.map((r) => this.explanationRow(r, o.staleBefore));
  }

  /** The owner voted on an explained decision: keep the vote and whether it matched the suggestion. */
  noteExplanationVote(decisionId: string, vote: 1 | -1, ts: number): ExplanationRow | undefined {
    const e = this.getExplanation(decisionId);
    if (!e) return undefined;
    const agreed = e.explanation ? e.explanation.suggest === vote : null;
    this.db
      .prepare("UPDATE explanations SET vote = ?, agreed = ?, vote_ts = ? WHERE decision_id = ?")
      .run(vote, agreed === null ? null : agreed ? 1 : 0, ts, decisionId);
    return this.getExplanation(decisionId);
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
    // FORK 2026-10-29: a closed connection has no data_version to read, and forgetIfOutsideCommit reads every one left.
    this.closedDays.conns.delete(this.db);
    this.closedDays.versions?.delete(this.db);
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
    // FORK 2026-10-29: a verdict stamped inside a cached closed day changes that day's sum. A replay stamps its
    // verdicts with the exchange's own time, and a judge call can straddle midnight; a live verdict lands after `until`.
    if (vs.some((v) => v.ts < this.closedDays.until)) {
      this.forgetClosedDays();
    }
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

  /**
   * FORK 2026-10-29: the verdict sums of whole local days that are over, added up (the 30-day spend, spend.ts
   * `spendLast30Days`). Each day is summed once, by `verdictSpend` over its [start, end), and kept under its day key
   * until a write could change it: `saveVerdicts` with a verdict stamped before the end of the latest cached day,
   * `deleteReplayTurn` removing verdicts, `pruneRecords`, or a commit by a connection that is none of this process's
   * stores on the file (`forgetIfOutsideCommit`). A day not asked for is dropped, so the cache holds one window. Pass
   * only days that are over: a day still running would keep the sum it had when it was asked.
   */
  closedDaysSpend(days: readonly { start: number; end: number }[]): VerdictSpend {
    this.forgetIfOutsideCommit();
    const kept = new Map<string, VerdictSpend>();
    const total: VerdictSpend = { usd: 0, tokensIn: 0, tokensOut: 0, calls: 0, skipped: 0 };
    let until = Number.NEGATIVE_INFINITY;
    for (const d of days) {
      const key = `${d.start}-${d.end}`;
      const s = this.closedDays.days.get(key) ?? this.verdictSpend(d.start, d.end);
      kept.set(key, s);
      until = Math.max(until, d.end);
      total.usd += s.usd;
      total.tokensIn += s.tokensIn;
      total.tokensOut += s.tokensOut;
      total.calls += s.calls;
      total.skipped += s.skipped;
    }
    this.closedDays.days = kept;
    this.closedDays.until = until;
    return total;
  }

  /** FORK 2026-10-29: forget every cached closed-day sum; the next 30-day spend sums those days again. */
  private forgetClosedDays(): void {
    this.closedDays.days.clear();
    this.closedDays.until = Number.NEGATIVE_INFINITY;
    this.closedDays.versions = null;
  }

  /**
   * FORK 2026-10-29: forget the cached days when a connection that is none of this process's stores on the file (a
   * script, another process) committed after the first of them was summed: no store's write path saw that commit. A
   * connection's PRAGMA data_version moves on every commit by another connection, a sibling store's included, and
   * never on its own. A sibling's commit leaves that sibling's version alone, and its write path already dropped what
   * the commit changed; an outside commit moves every version. So the days stay while one open store still reads the
   * version it read when they began. Two stores that both committed meanwhile look like an outside commit: one
   * recount, never a stale sum. The versions are read before any day is summed, so no cached day is older than them.
   */
  private forgetIfOutsideCommit(): void {
    const c = this.closedDays;
    const seen = new Map<Database.Database, number>();
    for (const db of c.conns) {
      seen.set(db, db.pragma("data_version", { simple: true }) as number);
    }
    const before = c.versions;
    if (before && ![...seen].some(([db, v]) => before.get(db) === v)) {
      this.forgetClosedDays();
    }
    c.versions ??= seen;
  }

  decisionsSince(ts: number): DecisionRow[] {
    return (
      this.db.prepare("SELECT * FROM decisions WHERE ts >= ? ORDER BY ts, rowid").all(ts) as Row[]
    ).map((r) => this.decisionFromRow(r));
  }

  /**
   * FORK 2026-10-29: the decisions since `ts` (no upper bound, as `decisionsSince`), counted per response kind in SQL.
   * The `kind` column holds `response.kind`: saveDecision writes both from the same value and no path updates them.
   */
  decisionKindCountsSince(ts: number): Map<string, number> {
    const rows = this.db
      .prepare("SELECT kind, COUNT(*) AS n FROM decisions WHERE ts >= ? GROUP BY kind")
      .all(ts) as Row[];
    return new Map(rows.map((r): [string, number] => [String(r.kind), r.n as number]));
  }

  /**
   * Remove everything a REPLAY turn recorded (situations, verdicts, decisions, interventions), so replaying the same
   * exchange again replaces its judgement instead of stacking a second one. Refuses any other turn id: live turns are
   * never deleted. Returns the number of decisions removed.
   */
  deleteReplayTurn(turnId: string): number {
    if (!turnId.includes("#replay-")) throw new Error("only replay turns can be deleted");
    let verdictsGone = 0;
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
        verdictsGone += this.db
          .prepare("DELETE FROM verdicts WHERE situation_id = ?")
          .run(sid).changes;
        this.db.prepare("DELETE FROM situations WHERE id = ?").run(sid);
      }
      return n;
    });
    const removed = del(turnId) as number;
    // FORK 2026-10-29: a replay's verdicts carry the exchange's own time, so the rows deleted can sit in a cached
    // closed day.
    if (verdictsGone > 0) {
      this.forgetClosedDays();
    }
    return removed;
  }

  /** One tab's decisions since `ts`, oldest first. Filter BEFORE any limit: a quiet tab's old rows must survive. */
  decisionsSinceForSession(ts: number, sessionKey: string): DecisionRow[] {
    // FORK 2026-10-29: CROSS JOIN only fixes the join order, never the rows: decisions are the outer loop, read
    // through d_ts, so the cost follows the time window. With a plain JOIN, d_sit (see the constructor) lets the
    // planner, which has no table statistics here, start from s_sess and walk every situation the tab ever had. On
    // a copy of the live key columns, a tab with 103k situations went from 25 ms to 220 ms per call that way.
    return (
      this.db
        .prepare(
          "SELECT d.* FROM decisions d CROSS JOIN situations s ON s.id = d.situation_id WHERE d.ts >= ? AND s.session = ? ORDER BY d.ts, d.rowid",
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
    const n = this.db
      .prepare("UPDATE situations SET record_json = NULL WHERE ts < ? AND record_json IS NOT NULL")
      .run(olderThanTs).changes;
    // FORK 2026-10-29: no verdict moves here, so no day's sum changes. The cached days are dropped all the same, so
    // that a retention which one day deletes verdicts cannot leave a stale 30-day total.
    if (n > 0) {
      this.forgetClosedDays();
    }
    return n;
  }
}
