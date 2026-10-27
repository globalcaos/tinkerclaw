import { readEventWriterStats, runSavedEventsQuery } from "../../infra/events/emit.js";
import { createIngestRateLimiter, ingestUiEvents } from "../../infra/events/ingest.js";
import {
  EVENTS_QUERY_RPC_MAX_ROW_CAP,
  EVENTS_QUERY_RPC_TIME_BUDGET_MS,
  type EventsQueryRow,
  orderCatalogSilentFirst,
  type ResolvedSavedQuery,
  resolveSavedQuery,
} from "../../infra/events/query.js";
import { CATALOG_QUERY_NAME } from "../../infra/events/saved-queries.js";
import { readConfiguredLogTail } from "../../logging/log-tail.js";
import { resolveControlPlaneRateLimitKey } from "../control-plane-rate-limit.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateLogsTailParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

// FORK 2026-09-25 (logging.md §8.2): one ingest budget per client for the life of the process.
// Module scope, not per call: a limiter rebuilt on every request limits nothing.
const ingestRateLimiter = createIngestRateLimiter();

const LOGS_QUERY_KEYS = new Set(["name", "params", "limit"]);
const LOGS_CATALOG_KEYS = new Set(["silent", "since"]);

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A refused request names the first key it does not know: a typo is never silently ignored. */
function unknownKey(params: Record<string, unknown>, known: ReadonlySet<string>): string | null {
  return Object.keys(params).find((key) => !known.has(key)) ?? null;
}

/**
 * FORK 2026-09-25 (logging.md §8.2, §9 step 10): the validated saved query runs on the events
 * WRITER THREAD's read-only connection (emit.ts runSavedEventsQuery → writer-worker.ts →
 * query.ts runSavedQuery). This thread validates and awaits; it never opens the database.
 */
async function answerSavedQuery(
  resolved: ResolvedSavedQuery,
  respond: RespondFn,
  method: string,
  shape: (rows: EventsQueryRow[]) => EventsQueryRow[] = (rows) => rows,
): Promise<void> {
  try {
    const result = await runSavedEventsQuery({
      name: resolved.query.name,
      params: resolved.params,
      rowCap: resolved.rowCap,
      timeBudgetMs: EVENTS_QUERY_RPC_TIME_BUDGET_MS,
    });
    respond(
      true,
      {
        name: resolved.query.name,
        description: resolved.query.description,
        params: resolved.params,
        ...result,
        rows: shape(result.rows),
      },
      undefined,
    );
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `${method} failed: ${errorText(err)}`),
    );
  }
}

export const logsHandlers: GatewayRequestHandlers = {
  "logs.tail": async ({ params, respond }) => {
    if (!validateLogsTailParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid logs.tail params: ${formatValidationErrors(validateLogsTailParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as { cursor?: number; limit?: number; maxBytes?: number };
    try {
      const result = await readConfiguredLogTail({
        cursor: p.cursor,
        limit: p.limit,
        maxBytes: p.maxBytes,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `log read failed: ${String(err)}`),
      );
    }
  },

  // FORK 2026-09-24 (logging.md §9 step 3): the events writer's health snapshot — queue depth,
  // written/dropped counters by reason, db/wal bytes. READ scope (method-scopes.ts). The stats
  // probe inside the writer times out SOFT, so this RPC can never tear the worker down.
  "logs.writer.stats": async ({ respond }) => {
    try {
      respond(true, await readEventWriterStats(), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `events writer stats failed: ${String(err)}`),
      );
    }
  },

  // FORK 2026-09-25 (logging.md §8.2, §9 step 10): a SAVED events query by name —
  // `{name, params?: {since?, label?}, limit?}`. READ scope (method-scopes.ts). There is no raw SQL
  // over RPC: the name selects an entry of infra/events/saved-queries.ts, the SQL never crosses the
  // wire, and the query runs on the writer thread's read-only connection with a row cap and a time
  // budget. The answer carries session_hash / session_kind at most, never a raw session key.
  "logs.query": async ({ params, respond }) => {
    const stray = unknownKey(params, LOGS_QUERY_KEYS);
    let resolved: ResolvedSavedQuery;
    try {
      if (stray !== null) {
        throw new Error(
          `unknown key ${JSON.stringify(stray.slice(0, 32))}; use name, params, limit`,
        );
      }
      resolved = resolveSavedQuery(params.name, params.params, {
        nowMs: Date.now(),
        limit: params.limit,
        maxRowCap: EVENTS_QUERY_RPC_MAX_ROW_CAP,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `invalid logs.query params: ${errorText(err)}`),
      );
      return;
    }
    await answerSavedQuery(resolved, respond, "logs.query");
  },

  // FORK 2026-09-25 (logging.md §8.2, §9 step 10): the event catalog with each event's row count
  // in the window (`since`, default 7d) and its last-seen time; `silent: true` lists the declared
  // events with no row in the window first (L2's DECLARED-and-silent). READ scope. The saved query
  // `catalog` on the writer thread, like logs.query.
  "logs.catalog": async ({ params, respond }) => {
    const stray = unknownKey(params, LOGS_CATALOG_KEYS);
    let resolved: ResolvedSavedQuery;
    try {
      if (stray !== null) {
        throw new Error(`unknown key ${JSON.stringify(stray.slice(0, 32))}; use silent, since`);
      }
      if (params.silent !== undefined && typeof params.silent !== "boolean") {
        throw new Error("silent must be a boolean");
      }
      resolved = resolveSavedQuery(
        CATALOG_QUERY_NAME,
        params.since === undefined ? undefined : { since: params.since },
        {
          nowMs: Date.now(),
          limit: EVENTS_QUERY_RPC_MAX_ROW_CAP,
          maxRowCap: EVENTS_QUERY_RPC_MAX_ROW_CAP,
        },
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `invalid logs.catalog params: ${errorText(err)}`),
      );
      return;
    }
    await answerSavedQuery(
      resolved,
      respond,
      "logs.catalog",
      params.silent === true ? orderCatalogSilentFirst : undefined,
    );
  },

  // FORK 2026-09-25 (logging.md §8.2, §9 step 7): the one door a browser may write an events row
  // through. WRITE scope (method-scopes.ts). Every rule lives in infra/events/ingest.ts: a record
  // either satisfies the catalog exactly (a uiIngestable row, declared keys and slots, closed-set or
  // numeric values, no free text) or is refused whole and recorded as a `logs.ingest.rejected` row.
  //
  // A refused RECORD is not an RPC failure — telemetry that fails loudly gets switched off, and a
  // UI that retried refused rows would be retrying on purpose-made refusals — so a well-formed call
  // always answers ok with its counts. ok=false is only for a malformed envelope. The budget is
  // keyed on the control-plane identity (device|ip), not the connection id: a reconnect loop would
  // reset a per-connection budget and walk straight through it.
  "logs.ingest": ({ params, client, respond }) => {
    const events = params.events;
    if (!Array.isArray(events)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid logs.ingest params: events must be an array of event records",
        ),
      );
      return;
    }
    respond(
      true,
      ingestUiEvents(events, {
        clientKey: resolveControlPlaneRateLimitKey(client),
        limiter: ingestRateLimiter,
      }),
      undefined,
    );
  },
};
