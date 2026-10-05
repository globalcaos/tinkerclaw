/**
 * The saved-query registry — TINKER_UI_DESIGN_BIBLE/logging.md §8.1–§8.2 (§9 step 10).
 *
 * The ONE place a named events-database question lives as SQL. `logs.query` (RPC), `logs.catalog`
 * (RPC) and `tinkerclaw logs query` / `logs catalog` (CLI) run these entries BY NAME; no client
 * ever sends SQL text over RPC (§8.2: a long ad-hoc query holds a read snapshot that blocks WAL
 * checkpoints, and SQL from a client is an injection surface). Ad-hoc SQL exists only on the local
 * `tinkerclaw logs sql` path (query.ts runIsolatedReadOnlySql).
 *
 * Rules every entry follows, pinned by query.test.ts (which runs every entry against a seeded
 * database):
 *  - ONE SELECT or WITH statement (query.ts assertReadOnlySelect passes it);
 *  - named parameters only, and only the ones `params` declares: `@since_ms` for `since`,
 *    `@label` for `label` (NULL = any). A query that does not take `since` has a fixed window and
 *    says so in its description;
 *  - it reads `events`, `catalog`, `rollup_1h` or a generated `v_*` view — never another file (no
 *    ATTACH: the J10 ledger query of §8.1 is NOT here, because the ledger holds private bodies and
 *    a different retention class, and has no business behind a READ-scope RPC);
 *  - it never selects a session column other than `session_hash` / `session_kind`, and today none
 *    selects either (the rows carry no raw session key anyway — L4 — and query.ts refuses a result
 *    column named like one).
 *
 * WORKER_MEMORY_TREND_7D_SQL is OWNED here (moved from samplers/worker-resources.ts, which wave 2d
 * wrote for this registry). Until worker-resources.ts re-exports it from this module, it carries a
 * byte-identical copy that query.test.ts holds equal to this one.
 */

/** A parameter a saved query may accept from its caller. */
export type SavedQueryParamName = "since" | "label";

export interface SavedQuery {
  /** kebab-case; what `logs.query({name})` and `tinkerclaw logs query <name>` take. */
  readonly name: string;
  /** One line: the question it answers (§8.1's heading). */
  readonly description: string;
  /** The catalog rows (or view/table) it reads — for `logs query --list` and the reader. */
  readonly reads: readonly string[];
  /** One SELECT/WITH statement with the named parameters `params` implies. */
  readonly sql: string;
  /** What the caller may pass. `since` binds `@since_ms`; `label` binds `@label` (NULL = any). */
  readonly params: readonly SavedQueryParamName[];
  /** The window when the caller gives no `since` (a duration such as "7d"); set iff `since` is taken. */
  readonly defaultSince?: string;
}

/** `logs.catalog` / `tinkerclaw logs catalog`: the catalog with row counts and last-seen times. */
export const CATALOG_QUERY_NAME = "catalog";

/**
 * Per-worker memory over the last 7 days, through the catalog view `v_worker_sample` (logging.md
 * §7.3): one row per worker with its sample count, span, mean and peak memory, and a least-squares
 * slope in MiB per hour — a leak is a worker whose slope stays positive day after day. Unavailable
 * rows carry no memory and are left out (a gap is not a zero). The window is fixed at 7 days.
 */
export const WORKER_MEMORY_TREND_7D_SQL = `WITH s AS (
  SELECT worker_type,
         worker_id,
         mem_bytes / 1048576.0 AS mem_mib,
         peak_bytes,
         (ts_ms - min(ts_ms) OVER (PARTITION BY worker_id)) / 3600000.0 AS hours
  FROM v_worker_sample
  WHERE ts_ms >= strftime('%s', 'now', '-7 days') * 1000
    AND mem_bytes IS NOT NULL
)
SELECT worker_type,
       worker_id,
       count(*) AS samples,
       round(max(hours), 1) AS span_hours,
       round(avg(mem_mib), 1) AS avg_mem_mib,
       round(max(peak_bytes) / 1048576.0, 1) AS peak_mem_mib,
       round((count(*) * sum(hours * mem_mib) - sum(hours) * sum(mem_mib))
             / nullif(count(*) * sum(hours * hours) - sum(hours) * sum(hours), 0), 3) AS mib_per_hour
FROM s
GROUP BY worker_type, worker_id
ORDER BY mib_per_hour DESC, worker_id;`;

/**
 * §8.1's worked queries, parameterized, plus the two §8.2 names (`history-resets-by-reason`,
 * `outbox-proof-latency`), the owner's worker trend and the catalog. The §8.1 text stays the
 * human-readable form; where a §8.1 query had no window, the saved one takes `since` so every
 * query reads a bounded range of `events_name_ts`.
 */
export const SAVED_QUERIES: readonly SavedQuery[] = [
  {
    name: "worker-memory-daily",
    description: "Worker memory per worker type per day (mean and peak MiB, distinct workers)",
    reads: ["worker.sample"],
    params: ["since", "label"],
    defaultSince: "30d",
    sql: `SELECT date(ts_ms / 1000, 'unixepoch', 'localtime') AS day,
       label AS worker_type,
       count(DISTINCT worker_id) AS workers,
       round(avg(n1) / 1048576.0, 1) AS avg_mem_mib,
       round(max(n4) / 1048576.0, 1) AS peak_mem_mib
FROM events
WHERE name = 'worker.sample'
  AND ts_ms >= @since_ms
  AND (@label IS NULL OR label = @label)
GROUP BY day, worker_type
ORDER BY day, worker_type;`,
  },
  {
    name: "worker-memory-trend",
    description:
      "Per-worker memory trend over the last 7 days (fixed window): least-squares MiB/hour, a leak is a positive slope",
    reads: ["worker.sample", "v_worker_sample"],
    params: [],
    sql: WORKER_MEMORY_TREND_7D_SQL,
  },
  {
    name: "worker-growth",
    description:
      "Does a worker grow over its own lifetime? Slope in MiB/hour for workers alive at least an hour (top 20)",
    reads: ["worker.sample"],
    params: ["since", "label"],
    defaultSince: "14d",
    sql: `WITH s AS (
  SELECT worker_id, label AS worker_type,
         (ts_ms - min(ts_ms) OVER (PARTITION BY worker_id)) / 3600000.0 AS x,
         n1 / 1048576.0 AS y
  FROM events
  WHERE name = 'worker.sample' AND n1 IS NOT NULL
    AND ts_ms >= @since_ms
    AND (@label IS NULL OR label = @label)
)
SELECT worker_id, worker_type, count(*) AS samples, round(max(x), 1) AS hours,
       round((count(*) * sum(x * y) - sum(x) * sum(y))
             / nullif(count(*) * sum(x * x) - sum(x) * sum(x), 0), 2) AS mib_per_hour
FROM s
GROUP BY worker_id, worker_type
HAVING max(x) >= 1
ORDER BY mib_per_hour DESC
LIMIT 20;`,
  },
  {
    name: "lock-hold-p99",
    description:
      "Session-store lock hold p99 per day (nearest-rank); --label narrows to one call site",
    reads: ["store.lock.held"],
    params: ["since", "label"],
    defaultSince: "14d",
    sql: `WITH h AS (
  SELECT date(ts_ms / 1000, 'unixepoch', 'localtime') AS day, dur_ms,
         row_number() OVER (PARTITION BY date(ts_ms / 1000, 'unixepoch', 'localtime')
                            ORDER BY dur_ms, id) AS rn,
         count(*) OVER (PARTITION BY date(ts_ms / 1000, 'unixepoch', 'localtime')) AS n
  FROM events
  WHERE name = 'store.lock.held'
    AND ts_ms >= @since_ms
    AND (@label IS NULL OR label = @label)
)
SELECT day, max(n) AS holds,
       min(CASE WHEN rn >= 0.99 * n THEN dur_ms END) AS p99_hold_ms,
       max(dur_ms) AS max_hold_ms
FROM h
GROUP BY day
ORDER BY day;`,
  },
  {
    name: "loop-stalls-vs-rpc",
    description:
      "Event-loop stalled minutes (max delay >= 1000 ms) against RPC load, versus healthy minutes",
    reads: ["gw.health.sample", "rpc.minute"],
    params: ["since"],
    defaultSince: "7d",
    sql: `WITH loop AS (
  SELECT ts_ms / 60000 AS minute, max(n2) AS loop_max_ms
  FROM events WHERE name = 'gw.health.sample' AND ts_ms >= @since_ms
  GROUP BY minute
),
rpc AS (
  SELECT ts_ms / 60000 AS minute, sum(n1) AS calls, sum(n2) AS handler_ms
  FROM events WHERE name = 'rpc.minute' AND ts_ms >= @since_ms
  GROUP BY minute
)
SELECT CASE WHEN loop.loop_max_ms >= 1000 THEN 'stalled' ELSE 'ok' END AS loop_state,
       count(*) AS minutes,
       round(avg(coalesce(rpc.calls, 0)), 1) AS avg_calls_per_min,
       round(avg(coalesce(rpc.handler_ms, 0)), 0) AS avg_handler_ms_per_min
FROM loop LEFT JOIN rpc USING (minute)
GROUP BY loop_state;`,
  },
  {
    name: "stalled-minute-methods",
    description: "Which RPC methods dominate the stalled minutes (top 10 by handler time)",
    reads: ["gw.health.sample", "rpc.minute"],
    params: ["since"],
    defaultSince: "7d",
    sql: `WITH stalled AS (
  SELECT DISTINCT ts_ms / 60000 AS minute
  FROM events
  WHERE name = 'gw.health.sample' AND n2 >= 1000 AND ts_ms >= @since_ms
)
SELECT e.label AS method, sum(e.n1) AS calls, sum(e.n2) AS handler_ms, max(e.n3) AS worst_ms
FROM events e JOIN stalled s ON e.ts_ms / 60000 = s.minute
WHERE e.name = 'rpc.minute' AND e.ts_ms >= @since_ms
GROUP BY method
ORDER BY handler_ms DESC
LIMIT 10;`,
  },
  {
    name: "j-coverage",
    description:
      "J-series coverage: every paper metric with its row count in the window, silent first",
    reads: ["catalog"],
    params: ["since"],
    defaultSince: "7d",
    sql: `SELECT c.paper, c.name, count(e.id) AS rows_since,
       datetime(max(e.ts_ms) / 1000, 'unixepoch', 'localtime') AS last_seen
FROM catalog c
LEFT JOIN events e
  ON e.name = c.name AND e.ts_ms >= @since_ms
WHERE c.paper IS NOT NULL
GROUP BY c.paper, c.name
ORDER BY rows_since, c.paper, c.name;`,
  },
  {
    name: "j12-prompt-cache",
    description:
      "J12 prompt-cache parts per week and model (per-call-measured only; the share is the reader's)",
    reads: ["algo.outcome"],
    params: ["since"],
    defaultSince: "365d",
    sql: `SELECT strftime('%Y-W%W', ts_ms / 1000, 'unixepoch') AS week,
       json_extract(fields, '$.model') AS model,
       sum(json_extract(fields, '$.metrics.cacheReadTokens')) AS cache_read,
       sum(json_extract(fields, '$.metrics.inputTokens')) AS uncached_input,
       sum(json_extract(fields, '$.metrics.cacheWriteTokens')) AS cache_write
FROM events
WHERE name = 'algo.outcome' AND label LIKE 'prompt-cache/%'
  AND ts_ms >= @since_ms
  AND json_extract(fields, '$.provenance.cacheReadTokens') = 'per-call-measured'
GROUP BY week, model
ORDER BY week, model;`,
  },
  {
    name: "j1-compaction-by-variant",
    description: "J1 compaction outcomes and token totals by variant",
    reads: ["algo.outcome"],
    params: ["since"],
    defaultSince: "365d",
    sql: `SELECT label AS variant, json_extract(fields, '$.outcome') AS outcome, count(*) AS n,
       sum(json_extract(fields, '$.metrics.tokensBefore')) AS tokens_before,
       sum(json_extract(fields, '$.metrics.tokensAfter')) AS tokens_after
FROM events
WHERE name = 'algo.outcome' AND label LIKE 'compaction/%'
  AND ts_ms >= @since_ms
GROUP BY variant, outcome
ORDER BY variant, outcome;`,
  },
  {
    name: "history-resets-by-reason",
    description:
      "chat.history full-window resets per day by reason (history.minute reset.<reason>)",
    reads: ["history.minute"],
    params: ["since"],
    defaultSince: "7d",
    sql: `SELECT date(ts_ms / 1000, 'unixepoch', 'localtime') AS day,
       substr(label, 7) AS reason,
       sum(n1) AS calls
FROM events
WHERE name = 'history.minute' AND label LIKE 'reset.%'
  AND ts_ms >= @since_ms
GROUP BY day, reason
ORDER BY day, calls DESC, reason;`,
  },
  {
    name: "outbox-proof-latency",
    description:
      "Typed prompts per day: proven, replayed and given up, with proof latency p50/p95/max (nearest-rank)",
    reads: ["ui.outbox.state"],
    params: ["since"],
    defaultSince: "7d",
    sql: `WITH t AS (
  SELECT date(ts_ms / 1000, 'unixepoch', 'localtime') AS day,
         sum(label = 'proven') AS proven,
         sum(label = 'replayed') AS replayed,
         sum(label = 'gave_up') AS gave_up
  FROM events
  WHERE name = 'ui.outbox.state' AND ts_ms >= @since_ms
  GROUP BY day
),
p AS (
  SELECT date(ts_ms / 1000, 'unixepoch', 'localtime') AS day, n2 AS age_ms,
         row_number() OVER (PARTITION BY date(ts_ms / 1000, 'unixepoch', 'localtime')
                            ORDER BY n2, id) AS rn,
         count(*) OVER (PARTITION BY date(ts_ms / 1000, 'unixepoch', 'localtime')) AS n
  FROM events
  WHERE name = 'ui.outbox.state' AND label = 'proven' AND n2 IS NOT NULL
    AND ts_ms >= @since_ms
),
q AS (
  SELECT day,
         min(CASE WHEN rn >= 0.5 * n THEN age_ms END) AS p50_proof_ms,
         min(CASE WHEN rn >= 0.95 * n THEN age_ms END) AS p95_proof_ms,
         max(age_ms) AS max_proof_ms
  FROM p
  GROUP BY day
)
SELECT t.day, t.proven, t.replayed, t.gave_up, q.p50_proof_ms, q.p95_proof_ms, q.max_proof_ms
FROM t LEFT JOIN q USING (day)
ORDER BY t.day;`,
  },
  {
    name: CATALOG_QUERY_NAME,
    description:
      "The event catalog with each event's row count in the window and its last-seen time (all time)",
    reads: ["catalog"],
    params: ["since"],
    defaultSince: "7d",
    sql: `SELECT c.name, c.kind, c.retention, c.paper,
       (SELECT count(*) FROM events e WHERE e.name = c.name AND e.ts_ms >= @since_ms) AS rows_since,
       (SELECT max(e.ts_ms) FROM events e WHERE e.name = c.name) AS last_ts_ms,
       c.question
FROM catalog c
ORDER BY c.name;`,
  },
];

const SAVED_QUERIES_BY_NAME: ReadonlyMap<string, SavedQuery> = new Map(
  SAVED_QUERIES.map((query) => [query.name, query]),
);

/** The registry entry for `name`, or undefined — never a guess (no prefix or fuzzy matching). */
export function getSavedQuery(name: string): SavedQuery | undefined {
  return SAVED_QUERIES_BY_NAME.get(name);
}

export const SAVED_QUERY_NAMES: readonly string[] = SAVED_QUERIES.map((query) => query.name);
