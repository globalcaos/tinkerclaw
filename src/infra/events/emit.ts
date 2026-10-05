/**
 * The events writer's main-thread half — TINKER_UI_DESIGN_BIBLE/logging.md §7.5 (§9 step 3).
 *
 * `emitEvent(name, record)` is synchronous and O(1): one catalog Map lookup (an unknown name is
 * counted and dropped, never thrown — L2), removal of undeclared field keys and of values that
 * are neither the declared type nor, for strings, enum/id-shaped (counted — L4), REFUSAL of the
 * WHOLE record when any string it carries reads as a RAW session key through the canonical parser
 * (dropped and counted under `session_key_in_column`; isRawSessionKey), conversion of a session
 * key into `session_hash` + `session_kind` (HMAC-SHA256 with the 32-byte salt at
 * `<state>/logs/events.salt`, so a raw session key never lands in any column), and one push onto
 * a bounded queue. It never throws, never awaits and never touches the disk or the database (L3).
 *
 * SQLite runs in ONE worker_threads worker (writer-worker.ts) that owns the connection; batches
 * leave this thread every EVENTS_FLUSH_INTERVAL_MS or at EVENTS_FLUSH_BATCH queued records, one
 * batch in flight at a time. On overflow the NEWEST record is dropped and counted (`queue_full`):
 * a burst loses its tail, never the history already queued. There is NO in-thread fallback —
 * writing SQLite on the main thread is the cost this design exists to avoid — so while the worker
 * is down (crash → respawn backoff, the FTS worker precedent in
 * src/memory/engram/fts-worker-client.ts) records queue up to the bound and are then dropped with
 * a counter.
 *
 * Self-watch (L9): declares instrument `logs:writer-flush` lazily at its first flush, notes it on
 * every batch, and writes `logs.writer.stats` every 60 s.
 *
 * Reads go to the worker too. Besides inserts it answers `stats`, `maintenance`, `ledger` — the
 * compaction ledger's restart seed (queryPriorBootLedger; context-window-panel.md §6.1 A4), sent
 * as session HASHES — and `query`: a SAVED events query by NAME (runSavedEventsQuery; logging.md
 * §8.2 `logs.query` / `logs.catalog`), which the worker runs on a read-only connection of its own
 * (query.ts). No SQL text crosses the wire. The process-wide writer lives on one globalThis slot,
 * so a plugin reaching this module through a separate bundle copy still writes to the one running
 * writer.
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../../sessions/session-key-utils.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { declareInstrument, noteInstrumentFired } from "../instrument-liveness.js";
import { type CatalogEvent, EVENT_CATALOG } from "./catalog.js";
import { resolveEventsDbBudgetBytes, resolveEventsDbPath } from "./paths.js";
import type { EventsQueryResult, SavedQueryBoundParams } from "./query.js";

// ─── §7.5 constants ─────────────────────────────────────────────────────────

/** The queue bound: a few MB of records. On overflow the NEWEST record is dropped and counted. */
export const EVENTS_QUEUE_MAX = 20_000;
export const EVENTS_FLUSH_INTERVAL_MS = 1_000;
/** Queue depth that triggers a flush before the timer does. */
export const EVENTS_FLUSH_BATCH = 500;
/** One postMessage per batch; a structured clone of the whole 20k queue would stall the loop. */
export const EVENTS_INSERT_BATCH_MAX = 5_000;
export const EVENTS_SHUTDOWN_FLUSH_DEADLINE_MS = 2_000;
/** After a crash or timeout no new worker is spawned for this long (the FTS precedent). */
export const WRITER_RESPAWN_BACKOFF_MS = 60_000;
/**
 * Generous on purpose: the worker answers serially, so an insert sent while the §7.4 maintenance
 * pass runs waits behind it. The timeout exists to detect a DEAD worker (exits are caught by the
 * `exit` event anyway); backpressure protection is the bounded queue, never this clock.
 */
export const WRITER_REQUEST_TIMEOUT_MS = 600_000;
/**
 * The compaction ledger's seed query waits at most this long, and SOFTLY (the stats probe's rule):
 * a query queued behind a maintenance pass is late, not evidence of a dead worker, so a timeout
 * fails only that query and the ledger asks again later (compaction-ledger.ts).
 */
export const WRITER_LEDGER_QUERY_TIMEOUT_MS = 30_000;
/**
 * A saved query waits on the main thread for its time budget plus this slack — the worker answers
 * serially, so the query may first sit behind an insert batch. SOFT, like the ledger's: a late
 * query fails its RPC and never tears the writer down (logging.md §8.2). A maintenance pass in
 * progress can outlast it; the caller then sees a timeout and asks again.
 */
export const WRITER_QUERY_TIMEOUT_SLACK_MS = 10_000;
/**
 * The worker holds one connection and one batch, so nothing like the FTS worker's 2 GB — but the
 * TypeScript source path also loads tsx's transform pipeline into the worker, so this stays
 * roomy rather than measured-tight.
 */
export const WRITER_MAX_OLD_GENERATION_MB = 512;
export const WRITER_STATS_INTERVAL_MS = 60_000;
/** Maintenance is daily (§7.4); the worker gates on meta.last_maintenance_ms, this only asks. */
export const WRITER_MAINTENANCE_CHECK_INTERVAL_MS = 3_600_000;
export const WRITER_FIRST_MAINTENANCE_DELAY_MS = 300_000;
export const SESSION_HASH_HEX_CHARS = 16;
export const MAX_FIELDS_JSON_CHARS = 8_192;
export const WRITER_FLUSH_INSTRUMENT_ID = "logs:writer-flush";

const log = createSubsystemLogger("events-writer");

// ─── wire protocol (writer-worker.ts type-imports these; no runtime cycle) ──

/** `role` gates the worker bootstrap: vitest itself runs tests in worker threads. */
export interface WriterWorkerInit {
  readonly role: "events-writer";
  readonly dbPath: string;
  /** A fingerprint of the salt, never the salt (schema §7.3 meta.salt_id). */
  readonly saltId: string;
  readonly bootId: string;
}

/**
 * One fully resolved `events` row; the keys are the insert statement's named parameters. A type
 * alias, not an interface: node:sqlite's `run(namedParameters)` takes a `Record<string, ...>`, and
 * only an object type alias is implicitly index-signature compatible.
 */
export type EventWireRow = {
  ts_ms: number;
  name: string;
  kind: string;
  boot_id: string;
  session_hash: string | null;
  session_kind: string | null;
  run_id: string | null;
  worker_id: string | null;
  label: string | null;
  dur_ms: number | null;
  n1: number | null;
  n2: number | null;
  n3: number | null;
  n4: number | null;
  fields: string | null;
};

/**
 * The compaction ledger's restart-seed query (src/infra/compaction-ledger.ts;
 * context-window-panel.md §6.1 A4), as its caller states it: RAW session keys, hashed with the
 * writer's salt before anything leaves this thread (L4).
 */
export interface EventLedgerQuery {
  readonly name: string;
  readonly label: string;
  readonly sessionKeys: readonly string[];
  /** Rows written by these writers are left out: the caller counts them itself. */
  readonly excludeBootIds: readonly string[];
  readonly timeoutMs?: number;
}

/** The same query as it crosses to the worker: session hashes only. */
export type EventLedgerWireQuery = {
  readonly name: string;
  readonly label: string;
  readonly sessionHashes: readonly string[];
  readonly excludeBootIds: readonly string[];
};

/**
 * One `fields.trigger` group of one session's matching rows. `droppedTokens` sums n3 over the
 * group and is null when no row carried one; `droppedKnown` counts the rows that did.
 */
export type EventLedgerGroup = {
  readonly trigger: string | null;
  readonly rows: number;
  readonly droppedTokens: number | null;
  readonly droppedKnown: number;
  readonly lastTsMs: number | null;
};

/** An EventLedgerGroup as the worker answers it: keyed by session_hash, never by a raw key. */
export type EventLedgerWireGroup = EventLedgerGroup & { readonly sessionHash: string };

/**
 * A saved events query as it crosses to the worker (logging.md §8.2): the NAME of an entry of
 * saved-queries.ts and its bound parameters — never SQL text; the worker looks the SQL up itself.
 */
export type EventQueryWireRequest = {
  readonly name: string;
  readonly params: SavedQueryBoundParams;
  readonly rowCap: number;
  readonly timeBudgetMs: number;
};

/**
 * The writer thread's OWN isolate. Only that thread can read it — v8.getHeapStatistics() reports
 * the CALLING isolate — so it rides the existing `stats` response rather than a new request type
 * (the src/memory/engram/fts-worker.ts precedent, shape for shape).
 */
export interface EventWriterIsolateStats {
  readonly usedHeapBytes: number;
  readonly totalHeapBytes: number;
  readonly heapLimitBytes: number;
  readonly externalBytes: number;
  /** null on a Node without threadCpuUsage — never the PROCESS's CPU under the thread's name. */
  readonly cpuUsec: number | null;
  /** The THREAD's uptime (performance.now() inside the worker), not the process's. */
  readonly uptimeMs: number;
}

/** The running writer thread as the worker-resources sampler charts it (worker_type `events_writer`). */
export interface EventWriterThreadStats {
  /** `events-writer-<pid>-<spawn>`: a respawn is a NEW worker, with its own baseline and peak. */
  readonly workerId: string;
  /** null when the last probe got no answer — an honest gap (source=unavailable), never a zero. */
  readonly isolate: EventWriterIsolateStats | null;
  /** Committed heap plus external memory: the only memory that is the thread's own (it shares RSS). */
  readonly memBytes: number | null;
  /** The largest memBytes any probe of THIS thread has seen. */
  readonly peakBytes: number | null;
}

export type WriterWorkerRequest =
  | { readonly id: number; readonly type: "insert"; readonly rows: EventWireRow[] }
  | { readonly id: number; readonly type: "stats" }
  | {
      readonly id: number;
      readonly type: "maintenance";
      readonly nowMs: number;
      readonly budgetBytes: number;
      readonly force?: boolean;
    }
  | ({ readonly id: number; readonly type: "ledger" } & EventLedgerWireQuery)
  | ({ readonly id: number; readonly type: "query" } & EventQueryWireRequest);

export type WriterWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly type: "insert"; readonly inserted: number }
  | {
      readonly id: number;
      readonly ok: true;
      readonly type: "stats";
      readonly dbBytes: number;
      readonly walBytes: number;
      readonly schemaVersion: number;
      /** The ANSWERING isolate's heap: in production the writer thread's own (logging.md §4.9). */
      readonly isolate: EventWriterIsolateStats;
    }
  | {
      readonly id: number;
      readonly ok: true;
      readonly type: "maintenance";
      readonly ran: boolean;
      readonly rowsDeleted: number;
      readonly bytesBefore: number;
      readonly bytesAfter: number;
      readonly hotDays: number;
      readonly eventDays: number;
      readonly shortened: boolean;
    }
  | {
      readonly id: number;
      readonly ok: true;
      readonly type: "ledger";
      readonly groups: EventLedgerWireGroup[];
    }
  | {
      readonly id: number;
      readonly ok: true;
      readonly type: "query";
      readonly result: EventsQueryResult;
    }
  | { readonly id: number; readonly ok: false; readonly type: "error"; readonly message: string };

type OkWriterResponse = Extract<WriterWorkerResponse, { ok: true }>;

// ─── session hash and kind (§7.5) ───────────────────────────────────────────

/** The closed set (§7.5); derived through the canonical session-key parser family, never a new regex. */
export const SESSION_KINDS = ["main", "tinker", "whatsapp", "cron", "subagent", "other"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export function classifySessionKind(sessionKey: string): SessionKind {
  if (isSubagentSessionKey(sessionKey)) {
    return "subagent";
  }
  if (isCronSessionKey(sessionKey)) {
    return "cron";
  }
  const rest = parseAgentSessionKey(sessionKey)?.rest ?? sessionKey.trim().toLowerCase();
  if (rest === "main") {
    return "main";
  }
  const head = rest.split(":", 1)[0];
  if (head === "tinker") {
    return "tinker";
  }
  if (head === "whatsapp") {
    return "whatsapp";
  }
  return "other";
}

/**
 * Loads the 32-byte random salt, creating it (0600, directory 0700) on first use. `wx` makes the
 * create race safe: the loser reads the winner's salt. Never stored in the database (§7.5).
 */
export function loadOrCreateSessionSalt(saltPath: string): Buffer {
  try {
    const existing = readFileSync(saltPath);
    if (existing.length >= 16) {
      return existing;
    }
  } catch {
    // fall through: create it
  }
  mkdirSync(dirname(saltPath), { recursive: true, mode: 0o700 });
  const salt = randomBytes(32);
  try {
    writeFileSync(saltPath, salt, { mode: 0o600, flag: "wx" });
    return salt;
  } catch {
    return readFileSync(saltPath);
  }
}

/** HMAC-SHA256, truncated to 16 hex chars: keyed, so a phone-number-bearing key cannot be enumerated. */
export function hashSessionKey(salt: Buffer, sessionKey: string): string {
  return createHmac("sha256", salt)
    .update(sessionKey)
    .digest("hex")
    .slice(0, SESSION_HASH_HEX_CHARS);
}

function saltFingerprint(salt: Buffer): string {
  return createHash("sha256").update(salt).digest("hex").slice(0, 16);
}

// ─── the worker entry (the FTS worker's dist/spawn shape) ───────────────────

/** How many directories above a bundled module are searched for the worker entry. */
const DIST_SEARCH_ANCESTORS = 3;

/**
 * The worker entry for a module at `moduleUrl` — the resolveFtsWorkerEntry pattern: TypeScript
 * source gets the sibling `writer-worker.ts` (booted through tsx); the bundled dist/ gets the
 * stable entry `infra/events/writer-worker.js`, looked for beside this module and up to
 * DIST_SEARCH_ANCESTORS above it. Throws when there is none (reported as a spawn failure).
 */
export function resolveWriterWorkerEntry(moduleUrl: string): { url: URL; typescript: boolean } {
  const self = new URL(moduleUrl);
  if (self.pathname.endsWith(".ts")) {
    return { url: new URL("./writer-worker.ts", self), typescript: true };
  }
  const candidates = [new URL("./writer-worker.js", self)];
  let dir = new URL("./", self);
  for (let i = 0; i <= DIST_SEARCH_ANCESTORS; i++) {
    candidates.push(new URL("infra/events/writer-worker.js", dir));
    dir = new URL("../", dir);
  }
  const found = candidates.find((url) => existsSync(url));
  if (!found) {
    throw new Error(`events writer worker entry not found beside ${moduleUrl}`);
  }
  return { url: found, typescript: false };
}

type ConstructWorker = (entry: URL | string, options: WorkerOptions) => Worker;
const constructWorker: ConstructWorker = (entry, options) => new Worker(entry, options);

/** Start the writer-worker entry with its resource limits. `construct` is the test seam. */
export function spawnWriterWorker(
  init: WriterWorkerInit,
  construct: ConstructWorker = constructWorker,
): Worker {
  const entry = resolveWriterWorkerEntry(import.meta.url);
  const resourceLimits = { maxOldGenerationSizeMb: WRITER_MAX_OLD_GENERATION_MB };
  if (!entry.typescript) {
    return construct(entry.url, { workerData: init, resourceLimits });
  }
  // Node's own type stripping neither maps `./x.js` onto `./x.ts` nor handles parameter
  // properties, so a source worker registers tsx before importing its entry (the FTS precedent).
  const tsxApi = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
  const boot =
    `import(${JSON.stringify(tsxApi)})` +
    `.then((tsx) => { tsx.register(); return import(${JSON.stringify(entry.url.href)}); });`;
  return construct(boot, { eval: true, workerData: init, resourceLimits });
}

// ─── the writer ─────────────────────────────────────────────────────────────

export interface EmitEventRecord {
  /** Event time; defaults to now. */
  readonly tsMs?: number;
  /** RAW session key; hashed to session_hash + session_kind here, never stored (L4). */
  readonly sessionKey?: string | null;
  readonly runId?: string | null;
  readonly workerId?: string | null;
  readonly label?: string | null;
  readonly durMs?: number | null;
  readonly n1?: number | null;
  readonly n2?: number | null;
  readonly n3?: number | null;
  readonly n4?: number | null;
  readonly fields?: Readonly<Record<string, unknown>> | null;
}

export interface EventWriterStats {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly dbPath: string | null;
  readonly bootId: string;
  readonly saltId: string | null;
  readonly queueDepth: number;
  readonly written: number;
  readonly batches: number;
  readonly maxBatchMs: number;
  readonly dropped: number;
  readonly droppedByReason: Readonly<Record<string, number>>;
  readonly unknownNames: Readonly<Record<string, number>>;
  readonly undeclaredKeys: number;
  readonly invalidValues: number;
  readonly respawns: number;
  readonly dbBytes: number | null;
  readonly walBytes: number | null;
  /** The writer thread itself as a sampled worker (logging.md §4.9); null when no thread runs. */
  readonly writerThread: EventWriterThreadStats | null;
  readonly lastFlushAtMs: number | null;
  readonly lastError: string | null;
}

export interface EventWriter {
  /** §7.5: synchronous, O(1), never throws, never awaits. */
  emit(name: string, record?: EmitEventRecord): void;
  /** Drains the queue through the worker; resolves (never rejects) when it cannot proceed. */
  flush(): Promise<void>;
  /** A synchronous snapshot of the counters. */
  stats(): EventWriterStats;
  /** The snapshot with db/wal bytes refreshed from the worker when one is running. */
  refreshDbStats(timeoutMs?: number): Promise<EventWriterStats>;
  /**
   * The compaction ledger's restart seed (src/infra/compaction-ledger.ts): per asked session key,
   * the per-`trigger` groups of its `name` rows labelled `label`, minus the rows of
   * `excludeBootIds`. Every asked key is in the answer (an empty list: no rows). The WORKER runs
   * the query; this thread only hashes the keys (L3, L4). Resolves null, never rejects, when there
   * is no answer: disabled, stopped, salt unavailable, worker down, error or soft timeout.
   */
  queryLedger(query: EventLedgerQuery): Promise<Map<string, EventLedgerGroup[]> | null>;
  /**
   * `logs.query` / `logs.catalog` (logging.md §8.2): a SAVED query by name, run by the WORKER on
   * its read-only connection. Rejects with the reason when there is no answer — disabled,
   * stopping, worker down, a query error, or the soft timeout (budget + WRITER_QUERY_TIMEOUT_SLACK_MS).
   */
  querySaved(query: EventQueryWireRequest): Promise<EventsQueryResult>;
  /** Final flush (EVENTS_SHUTDOWN_FLUSH_DEADLINE_MS), then terminates the worker. Idempotent. */
  stop(): Promise<void>;
}

export interface EventWriterOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: how the worker is started. Defaults to spawnWriterWorker. */
  readonly spawn?: (init: WriterWorkerInit) => Worker;
  /** Test seam: a doctored catalog. Production never passes one. */
  readonly catalog?: readonly CatalogEvent[];
  readonly queueMax?: number;
  readonly flushIntervalMs?: number;
  readonly flushBatchSize?: number;
  readonly respawnBackoffMs?: number;
  readonly requestTimeoutMs?: number;
  /** 0 disables the periodic `logs.writer.stats` sample (tests). */
  readonly statsIntervalMs?: number;
  /** 0 disables the maintenance schedule (tests). */
  readonly maintenanceIntervalMs?: number;
  readonly shutdownFlushDeadlineMs?: number;
  readonly now?: () => number;
  /** Drops that happened before this writer existed, folded into its counters (§7.5: counted). */
  readonly carryDropped?: { readonly reason: string; readonly count: number };
}

class WriterRequestError extends Error {
  /** true when the worker was torn down (crash, timeout, stop) — the batch in flight is lost. */
  readonly teardown: boolean;

  constructor(message: string, teardown: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WriterRequestError";
    this.teardown = teardown;
  }
}

/** L4: an id is pattern-limited, at most 64 chars, and cannot start with `+` (a phone shape). */
const ID_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/;
/** A label is one categorical dimension: printable ASCII, no whitespace, at most 128 chars. */
const LABEL_VALUE = /^[\x21-\x7e]{1,128}$/;
/**
 * A cheap NECESSARY condition for parseAgentSessionKey to match, tested before the parse is paid
 * for. The parser trims, lowercases, splits on `:` and DROPS EMPTY SEGMENTS, so a key always has
 * `agent:` after leading whitespace and colons — `::agent:main:x` parses, which is why this is NOT
 * a `startsWith("agent:")`: that guard would miss it.
 */
const SESSION_KEY_PREFIX = /^[\s:]*agent:/i;
/** The shortest string that can parse is `agent:a:b`; anything shorter is rejected without a test. */
const SESSION_KEY_MIN_CHARS = 9;
/** The drop reason for a record refused because a string it carried read as a raw session key. */
const SESSION_KEY_DROP_REASON = "session_key_in_column";

/**
 * L4, enforced on the way IN. `sessionKey` is hashed into `session_hash` — but a label, a run_id,
 * a worker_id or an id/enum field only has to be printable ASCII, and BOTH patterns above accept
 * `agent:<id>:<rest>`, so a producer that passed a RAW key into one of those slots stored it
 * verbatim and query.ts had to redact it on every read forever (redactRawSessionKeys).
 *
 * ONE OWNER for what a session key IS: the canonical parser, the same call query.ts redacts with —
 * never a second regex, which is how the two would drift. The prefix test in front of it keeps the
 * common case (a value that is not a key) to a length compare and one anchored match, so emit
 * stays O(1)-ish.
 */
function isRawSessionKey(value: string): boolean {
  return (
    value.length >= SESSION_KEY_MIN_CHARS &&
    SESSION_KEY_PREFIX.test(value) &&
    parseAgentSessionKey(value) !== null
  );
}
/** Distinct unknown names tracked before the rest fold into one bucket. */
const UNKNOWN_NAMES_CAP = 100;
/** An unknown name is caller-supplied text: its counter key is truncated, so the map is bounded. */
const UNKNOWN_NAME_KEY_MAX_CHARS = 64;
/** How many unknown names the 60 s stats row carries — bounded so the fields JSON never oversizes. */
const STATS_UNKNOWN_NAMES_TOP = 50;

const ignore = (): void => {};

interface PendingRequest {
  resolve: (response: OkWriterResponse) => void;
  reject: (err: WriterRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

type TimerHandle = ReturnType<typeof setInterval> & { unref?: () => void };

export function createEventWriter(options: EventWriterOptions = {}): EventWriter {
  const env = options.env ?? process.env;
  const resolution = resolveEventsDbPath(env);
  const budgetBytes = resolveEventsDbBudgetBytes(env);
  const catalogByName = new Map<string, CatalogEvent>(
    (options.catalog ?? EVENT_CATALOG).map((event) => [event.name, event]),
  );
  const now = options.now ?? Date.now;
  const queueMax = options.queueMax ?? EVENTS_QUEUE_MAX;
  const flushBatch = options.flushBatchSize ?? EVENTS_FLUSH_BATCH;
  const flushIntervalMs = options.flushIntervalMs ?? EVENTS_FLUSH_INTERVAL_MS;
  const respawnBackoffMs = options.respawnBackoffMs ?? WRITER_RESPAWN_BACKOFF_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? WRITER_REQUEST_TIMEOUT_MS;
  const statsIntervalMs = options.statsIntervalMs ?? WRITER_STATS_INTERVAL_MS;
  const maintenanceIntervalMs =
    options.maintenanceIntervalMs ?? WRITER_MAINTENANCE_CHECK_INTERVAL_MS;
  const shutdownDeadlineMs = options.shutdownFlushDeadlineMs ?? EVENTS_SHUTDOWN_FLUSH_DEADLINE_MS;

  const bootId = randomUUID();
  let state: "running" | "stopping" | "stopped" | "disabled" = resolution.enabled
    ? "running"
    : "disabled";

  // The salt is loaded eagerly so emitting never touches the disk (L3).
  let salt: Buffer | null = null;
  let saltId: string | null = null;
  if (resolution.enabled) {
    try {
      salt = loadOrCreateSessionSalt(resolution.saltPath);
      saltId = saltFingerprint(salt);
    } catch (err) {
      // Better an absent join key than a raw one: rows carry no session columns until it heals.
      log.warn(`events salt unavailable, session columns will be empty: ${String(err)}`);
    }
  }

  const queue: EventWireRow[] = [];
  const pending = new Map<number, PendingRequest>();
  let worker: Worker | undefined;
  let detach: () => void = ignore;
  let respawnNotBefore = 0;
  let nextRequestId = 1;
  let flushing: Promise<void> | null = null;
  let instrumentDeclared = false;

  let written = 0;
  let batches = 0;
  /** Window max: reset after every `logs.writer.stats` sample so the hourly rollup means something. */
  let maxBatchMs = 0;
  let dropped = 0;
  const droppedByReason: Record<string, number> = {};
  if (options.carryDropped !== undefined && options.carryDropped.count > 0) {
    dropped = options.carryDropped.count;
    droppedByReason[options.carryDropped.reason] = options.carryDropped.count;
  }
  const unknownNames: Record<string, number> = {};
  let undeclaredKeys = 0;
  let invalidValues = 0;
  /**
   * Set by the sanitizers while ONE record is built, read by emit() straight after: a raw session
   * key was found in some slot, so the record is refused whole. A flag rather than a throw, because
   * §7.5 forbids emit from ever unwinding.
   */
  let sessionKeyLeak = false;
  let spawns = 0;
  let dbBytes: number | null = null;
  let walBytes: number | null = null;
  /** The live thread's id, last isolate reading and peak. A respawn starts all three over. */
  let writerWorkerId: string | null = null;
  let writerIsolate: EventWriterIsolateStats | null = null;
  let writerPeakBytes: number | null = null;
  let lastFlushAtMs: number | null = null;
  let lastError: string | null = null;

  function drop(reason: string, count: number): void {
    dropped += count;
    droppedByReason[reason] = (droppedByReason[reason] ?? 0) + count;
  }

  function noteUnknownName(name: string): void {
    const truncated = name.slice(0, UNKNOWN_NAME_KEY_MAX_CHARS);
    const key =
      truncated in unknownNames || Object.keys(unknownNames).length < UNKNOWN_NAMES_CAP
        ? truncated
        : "(other)";
    unknownNames[key] = (unknownNames[key] ?? 0) + 1;
    drop("unknown_name", 1);
  }

  /** The stats row's bounded view of unknownNames: the top entries by count, never the whole map. */
  function topUnknownNames(): Record<string, number> {
    const entries = Object.entries(unknownNames);
    entries.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, STATS_UNKNOWN_NAMES_TOP));
  }

  function finiteOrNull(value: number | null | undefined): number | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    invalidValues += 1;
    return null;
  }

  function idOrNull(value: string | null | undefined): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    // L4 first: a session key passes ID_VALUE, so the pattern can never be the thing that stops it.
    if (typeof value === "string" && isRawSessionKey(value)) {
      sessionKeyLeak = true;
      return null;
    }
    if (typeof value === "string" && ID_VALUE.test(value)) {
      return value;
    }
    invalidValues += 1;
    return null;
  }

  function cleanFields(entry: CatalogEvent, fields: EmitEventRecord["fields"]): string | null {
    if (fields === undefined || fields === null) {
      return null;
    }
    const clean: Record<string, unknown> = {};
    let kept = 0;
    for (const [key, value] of Object.entries(fields)) {
      const declared = entry.fields[key];
      if (declared === undefined) {
        undeclaredKeys += 1;
        continue;
      }
      if (value === undefined || value === null) {
        continue;
      }
      // L4 ahead of the type switch, so `enum`, `id` AND a string-valued `json` field are covered
      // by ONE check. A key nested inside a json OBJECT is deliberately not reached: walking an
      // arbitrary object on every emit is not O(1) (§7.5), and no declared json field carries
      // caller text today — query.ts's read-side redaction stays the backstop for that residue.
      if (typeof value === "string" && isRawSessionKey(value)) {
        sessionKeyLeak = true;
        continue;
      }
      switch (declared) {
        case "number":
          if (typeof value === "number" && Number.isFinite(value)) {
            clean[key] = value;
            kept += 1;
          } else {
            invalidValues += 1;
          }
          break;
        case "boolean":
          if (typeof value === "boolean") {
            clean[key] = value;
            kept += 1;
          } else {
            invalidValues += 1;
          }
          break;
        case "enum":
        case "id":
          // L4: the catalog has no free-text type, so anything else is dropped mechanically.
          if (typeof value === "string" && ID_VALUE.test(value)) {
            clean[key] = value;
            kept += 1;
          } else {
            invalidValues += 1;
          }
          break;
        case "json":
          clean[key] = value;
          kept += 1;
          break;
      }
    }
    if (kept === 0) {
      return null;
    }
    try {
      const json = JSON.stringify(clean);
      if (json.length > MAX_FIELDS_JSON_CHARS) {
        invalidValues += 1;
        return null;
      }
      return json;
    } catch {
      invalidValues += 1;
      return null;
    }
  }

  function labelOrNull(entry: CatalogEvent, value: string | null | undefined): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    // L4 first: a session key passes LABEL_VALUE, so the pattern can never be what stops it.
    if (typeof value === "string" && isRawSessionKey(value)) {
      sessionKeyLeak = true;
      return null;
    }
    // A label the catalog declares unused stays NULL whatever the caller passed (L1).
    if (entry.label !== null && typeof value === "string" && LABEL_VALUE.test(value)) {
      return value;
    }
    invalidValues += 1;
    return null;
  }

  function buildWireRow(entry: CatalogEvent, record: EmitEventRecord): EventWireRow {
    let sessionHash: string | null = null;
    let sessionKind: string | null = null;
    if (typeof record.sessionKey === "string" && record.sessionKey.length > 0) {
      if (salt !== null) {
        sessionHash = hashSessionKey(salt, record.sessionKey);
        sessionKind = classifySessionKind(record.sessionKey);
      } else {
        invalidValues += 1;
      }
    }
    const label = labelOrNull(entry, record.label);
    let tsMs: number;
    if (typeof record.tsMs === "number" && Number.isFinite(record.tsMs)) {
      tsMs = Math.floor(record.tsMs);
    } else {
      if (record.tsMs !== undefined) {
        invalidValues += 1;
      }
      tsMs = now();
    }
    return {
      ts_ms: tsMs,
      name: entry.name,
      kind: entry.kind,
      boot_id: bootId,
      session_hash: sessionHash,
      session_kind: sessionKind,
      run_id: idOrNull(record.runId),
      worker_id: idOrNull(record.workerId),
      label,
      // A slot the catalog declares unused stays NULL whatever the caller passed (L1).
      dur_ms: entry.durMs === null ? null : finiteOrNull(record.durMs),
      n1: entry.n1 === null ? null : finiteOrNull(record.n1),
      n2: entry.n2 === null ? null : finiteOrNull(record.n2),
      n3: entry.n3 === null ? null : finiteOrNull(record.n3),
      n4: entry.n4 === null ? null : finiteOrNull(record.n4),
      fields: cleanFields(entry, record.fields),
    };
  }

  function discard(w: Worker, err: WriterRequestError, backoff: boolean): Promise<void> {
    if (worker !== w) {
      return Promise.resolve();
    }
    worker = undefined;
    // A torn-down thread is gone, not idle: a stale heap number under its name would be a lie, and
    // the next thread is a NEW worker with its own id, baseline and peak.
    writerWorkerId = null;
    writerIsolate = null;
    writerPeakBytes = null;
    if (backoff) {
      respawnNotBefore = now() + respawnBackoffMs;
    }
    detach();
    detach = ignore;
    w.on("error", ignore);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
    return w.terminate().then(ignore, ignore);
  }

  function onResponse(response: WriterWorkerResponse): void {
    const p = pending.get(response.id);
    if (!p) {
      return;
    }
    pending.delete(response.id);
    clearTimeout(p.timer);
    if (pending.size === 0) {
      worker?.unref();
    }
    if (response.ok) {
      p.resolve(response);
    } else {
      p.reject(new WriterRequestError(response.message, false));
    }
  }

  function ensureWorker(): Worker | null {
    if (worker) {
      return worker;
    }
    if (now() < respawnNotBefore) {
      return null;
    }
    if (!resolution.enabled) {
      return null;
    }
    const init: WriterWorkerInit = {
      role: "events-writer",
      dbPath: resolution.dbPath,
      saltId: saltId ?? "unavailable",
      bootId,
    };
    let w: Worker;
    try {
      w = options.spawn ? options.spawn(init) : spawnWriterWorker(init);
    } catch (err) {
      respawnNotBefore = now() + respawnBackoffMs;
      lastError = `spawn: ${String(err)}`;
      log.warn(
        `events writer worker failed to start (next attempt in ${respawnBackoffMs} ms): ${String(err)}`,
      );
      return null;
    }
    spawns += 1;
    // The worker-resources sampler charts this thread under this id (logging.md §4.9): the spawn
    // ordinal is part of it, because a respawned thread's uptime and CPU restart at zero and
    // charting them under the old id would draw an age that goes backwards.
    writerWorkerId = `events-writer-${process.pid}-${spawns}`;
    const onError = (err: unknown): void => {
      void discard(
        w,
        new WriterRequestError(`events writer worker error: ${String(err)}`, true, { cause: err }),
        true,
      );
    };
    const onExit = (code: number): void => {
      void discard(
        w,
        new WriterRequestError(`events writer worker exited with code ${code}`, true),
        true,
      );
    };
    w.on("message", onResponse);
    w.on("error", onError);
    w.on("exit", onExit);
    w.unref();
    worker = w;
    detach = () => {
      w.off("message", onResponse);
      w.off("error", onError);
      w.off("exit", onExit);
    };
    return w;
  }

  function request(
    w: Worker,
    message:
      | { type: "insert"; rows: EventWireRow[] }
      | { type: "stats" }
      | {
          type: "maintenance";
          nowMs: number;
          budgetBytes: number;
          force?: boolean;
        }
      | ({ type: "ledger" } & EventLedgerWireQuery)
      | ({ type: "query" } & EventQueryWireRequest),
    opts: { timeoutMs?: number; teardownOnTimeout?: boolean } = {},
  ): Promise<OkWriterResponse> {
    const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
    const teardownOnTimeout = opts.teardownOnTimeout ?? true;
    const id = nextRequestId++;
    return new Promise<OkWriterResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!teardownOnTimeout) {
          // A soft timeout fails only this request. The worker answers serially, so a stats
          // probe sent during the §7.4 maintenance pass is merely LATE — tearing the worker
          // down for it would kill the pass and lose the in-flight batch. A late answer is
          // ignored by onResponse (its pending entry is gone).
          const p = pending.get(id);
          if (p === undefined) {
            return;
          }
          pending.delete(id);
          if (pending.size === 0) {
            w.unref();
          }
          p.reject(
            new WriterRequestError(
              `events writer answer still pending after ${timeoutMs} ms`,
              false,
            ),
          );
          return;
        }
        void discard(
          w,
          new WriterRequestError(`events writer gave no answer within ${timeoutMs} ms`, true),
          true,
        );
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      pending.set(id, { resolve, reject, timer });
      if (pending.size === 1) {
        w.ref();
      }
      const payload: WriterWorkerRequest = { ...message, id };
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads Worker, not a Window: its postMessage takes no targetOrigin.
        w.postMessage(payload);
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        if (pending.size === 0) {
          w.unref();
        }
        reject(new WriterRequestError(`events writer request not sendable: ${String(err)}`, false));
      }
    });
  }

  function noteFlush(rows: number): void {
    if (!instrumentDeclared) {
      instrumentDeclared = true;
      declareInstrument({
        id: WRITER_FLUSH_INSTRUMENT_ID,
        kind: "producer",
        description: "structured-events writer batch flushes (logging.md §7.5)",
        expectFireWithinMs: 10 * 60_000,
      });
    }
    noteInstrumentFired(WRITER_FLUSH_INSTRUMENT_ID, `rows=${rows} queue=${queue.length}`);
  }

  /** Read fresh on every pass: stop() moves `state` while a batch is awaited. */
  function flushable(): boolean {
    return state !== "stopped" && state !== "disabled" && queue.length > 0;
  }

  async function flushLoop(): Promise<void> {
    while (flushable()) {
      const w = ensureWorker();
      if (!w) {
        return; // backoff or spawn failure: records stay queued for a later tick
      }
      const batch = queue.splice(0, EVENTS_INSERT_BATCH_MAX);
      const started = now();
      try {
        const response = await request(w, { type: "insert", rows: batch });
        written += response.type === "insert" ? response.inserted : batch.length;
        batches += 1;
        maxBatchMs = Math.max(maxBatchMs, now() - started);
        lastFlushAtMs = now();
        noteFlush(batch.length);
      } catch (err) {
        // The batch in flight is lost, and counted: retrying it against a transaction that may
        // or may not have committed would risk double rows (§7.5: drop, never block or guess).
        const teardown = !(err instanceof WriterRequestError) || err.teardown;
        drop(teardown ? "worker_crash" : "insert_error", batch.length);
        lastError = String(err);
        return;
      }
    }
  }

  function flush(): Promise<void> {
    if (state === "stopped" || state === "disabled") {
      return Promise.resolve();
    }
    if (queue.length === 0) {
      return flushing ?? Promise.resolve();
    }
    flushing ??= flushLoop()
      .catch(ignore)
      .finally(() => {
        flushing = null;
      });
    return flushing;
  }

  function stats(): EventWriterStats {
    return {
      enabled: resolution.enabled,
      running: state === "running" && worker !== undefined,
      dbPath: resolution.enabled ? resolution.dbPath : null,
      bootId,
      saltId,
      queueDepth: queue.length,
      written,
      batches,
      maxBatchMs,
      dropped,
      droppedByReason: { ...droppedByReason },
      unknownNames: { ...unknownNames },
      undeclaredKeys,
      invalidValues,
      respawns: Math.max(0, spawns - 1),
      dbBytes,
      walBytes,
      writerThread:
        writerWorkerId === null
          ? null
          : {
              workerId: writerWorkerId,
              isolate: writerIsolate,
              // The fts-worker-client formula: committed heap + external is the thread's own
              // memory. The thread shares the process RSS, so RSS would count the gateway twice.
              memBytes:
                writerIsolate === null
                  ? null
                  : writerIsolate.totalHeapBytes + writerIsolate.externalBytes,
              peakBytes: writerPeakBytes,
            },
      lastFlushAtMs,
      lastError,
    };
  }

  async function refreshDbStats(timeoutMs = 5_000): Promise<EventWriterStats> {
    const w = worker;
    if (w && state === "running") {
      try {
        // Soft timeout: a probe must never be able to terminate the thing it inspects (a stats
        // request queued behind a long maintenance pass is late, not evidence of a dead worker).
        const response = await request(
          w,
          { type: "stats" },
          { timeoutMs, teardownOnTimeout: false },
        );
        if (response.type === "stats") {
          dbBytes = response.dbBytes;
          walBytes = response.walBytes;
          writerIsolate = response.isolate;
          writerPeakBytes = Math.max(
            writerPeakBytes ?? 0,
            response.isolate.totalHeapBytes + response.isolate.externalBytes,
          );
        }
      } catch (err) {
        lastError = String(err);
        // The thread may well still be running (a stats probe queued behind a maintenance pass
        // times out SOFT), but the last heap reading is no longer current: the next sampled row
        // says unavailable rather than repeating a stale number.
        writerIsolate = null;
      }
    }
    return stats();
  }

  async function queryLedger(
    query: EventLedgerQuery,
  ): Promise<Map<string, EventLedgerGroup[]> | null> {
    // No salt, no join key: the rows carry none either, so there is nothing to ask for (§7.5).
    const keySalt = salt;
    if (state !== "running" || keySalt === null) {
      return null;
    }
    const answer = new Map<string, EventLedgerGroup[]>();
    const keyByHash = new Map<string, string>();
    for (const key of query.sessionKeys) {
      if (typeof key === "string" && key.length > 0 && !answer.has(key)) {
        answer.set(key, []);
        keyByHash.set(hashSessionKey(keySalt, key), key);
      }
    }
    if (keyByHash.size === 0) {
      return answer;
    }
    const w = ensureWorker();
    if (!w) {
      return null;
    }
    try {
      const response = await request(
        w,
        {
          type: "ledger",
          name: query.name,
          label: query.label,
          sessionHashes: [...keyByHash.keys()],
          excludeBootIds: [...query.excludeBootIds],
        },
        // Soft, as for the stats probe: a query must never be able to tear the writer down.
        { timeoutMs: query.timeoutMs ?? WRITER_LEDGER_QUERY_TIMEOUT_MS, teardownOnTimeout: false },
      );
      if (response.type !== "ledger") {
        return null;
      }
      for (const { sessionHash, ...group } of response.groups) {
        const key = keyByHash.get(sessionHash);
        if (key !== undefined) {
          answer.get(key)?.push(group);
        }
      }
      return answer;
    } catch (err) {
      lastError = String(err);
      return null;
    }
  }

  async function querySaved(query: EventQueryWireRequest): Promise<EventsQueryResult> {
    if (state !== "running") {
      throw new Error(
        state === "disabled"
          ? "the events database is off (OPENCLAW_EVENTS_DB=0, or a test runner without OPENCLAW_EVENTS_DB_PATH)"
          : "the events writer is stopping",
      );
    }
    const w = ensureWorker();
    if (!w) {
      throw new Error("the events writer thread is not running (respawn backoff after a failure)");
    }
    // Soft, as for the stats probe and the ledger: a query must never tear the writer down. A
    // query error is the caller's to report; it is not the writer's lastError.
    const response = await request(
      w,
      { type: "query", ...query },
      { timeoutMs: query.timeBudgetMs + WRITER_QUERY_TIMEOUT_SLACK_MS, teardownOnTimeout: false },
    );
    if (response.type !== "query") {
      throw new Error(`the events writer answered a query with a ${response.type} response`);
    }
    return response.result;
  }

  function emit(name: string, record: EmitEventRecord = {}): void {
    try {
      if (!resolution.enabled) {
        drop(resolution.reason, 1);
        return;
      }
      if (state !== "running") {
        drop("stopped", 1);
        return;
      }
      const entry = catalogByName.get(name);
      if (entry === undefined) {
        noteUnknownName(name);
        return;
      }
      if (queue.length >= queueMax) {
        drop("queue_full", 1);
        return;
      }
      sessionKeyLeak = false;
      const row = buildWireRow(entry, record);
      if (sessionKeyLeak) {
        // L4 is a boundary, not a preference: the record is refused WHOLE rather than stored with
        // the offending slot blanked, so the leak is loud in `dropped_by_reason` instead of
        // shaping a half-row nobody reads. Rejected alternative: null the value and keep the row —
        // that writes a `worker.sample` with no worker_type, a lie the §7.3 view would chart. Every
        // reason in this map is one whole RECORD, so n2 of `logs.writer.stats` keeps its meaning.
        drop(SESSION_KEY_DROP_REASON, 1);
        return;
      }
      queue.push(row);
      if (queue.length >= flushBatch) {
        void flush();
      }
    } catch (err) {
      // emitEvent never throws (§7.5).
      dropped += 1;
      lastError = String(err);
    }
  }

  function emitWriterStats(): void {
    void refreshDbStats().then(() => {
      const fields: Record<string, unknown> = {
        dropped_by_reason: { ...droppedByReason },
        unknown_names: topUnknownNames(),
      };
      if (dbBytes !== null) {
        fields.db_bytes = dbBytes;
      }
      if (walBytes !== null) {
        fields.wal_bytes = walBytes;
      }
      emit("logs.writer.stats", {
        n1: written,
        n2: dropped,
        n3: queue.length,
        n4: maxBatchMs,
        fields,
      });
      // n4 is the max WITHIN the sample window; an all-time max would make the rollup a step
      // function that can never show a batch getting slower or recovering.
      maxBatchMs = 0;
    }, ignore);
  }

  async function requestMaintenance(): Promise<void> {
    if (state !== "running") {
      return;
    }
    const w = ensureWorker();
    if (!w) {
      return;
    }
    try {
      const response = await request(w, { type: "maintenance", nowMs: now(), budgetBytes });
      if (response.type === "maintenance" && response.ran && response.shortened) {
        // §7.4: when a window shrinks, the journal says why.
        log.warn(
          `events retention shortened its windows to stay inside the ${budgetBytes}-byte ` +
            `budget: hot=${response.hotDays}d event=${response.eventDays}d (logging.md §7.4)`,
        );
      }
    } catch (err) {
      lastError = String(err);
    }
  }

  const timers: TimerHandle[] = [];
  if (resolution.enabled) {
    const flushTimer = setInterval(() => {
      if (queue.length > 0) {
        void flush();
      }
    }, flushIntervalMs) as TimerHandle;
    flushTimer.unref?.();
    timers.push(flushTimer);
    if (statsIntervalMs > 0) {
      const statsTimer = setInterval(emitWriterStats, statsIntervalMs) as TimerHandle;
      statsTimer.unref?.();
      timers.push(statsTimer);
    }
    if (maintenanceIntervalMs > 0) {
      const maintenanceTimer = setInterval(() => {
        void requestMaintenance();
      }, maintenanceIntervalMs) as TimerHandle;
      maintenanceTimer.unref?.();
      timers.push(maintenanceTimer);
      const firstMaintenance = setTimeout(
        () => {
          void requestMaintenance();
        },
        Math.min(WRITER_FIRST_MAINTENANCE_DELAY_MS, maintenanceIntervalMs),
      ) as unknown as TimerHandle;
      firstMaintenance.unref?.();
      timers.push(firstMaintenance);
    }
    log.info(`events writer started: db=${resolution.dbPath}`);
  }

  async function stop(): Promise<void> {
    if (state === "stopped") {
      return;
    }
    if (state === "disabled") {
      state = "stopped";
      return;
    }
    state = "stopping";
    for (const timer of timers.splice(0)) {
      clearInterval(timer);
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    }
    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, shutdownDeadlineMs);
      (timer as { unref?: () => void }).unref?.();
    });
    await Promise.race([flush(), deadline]);
    const leftover = queue.length;
    if (leftover > 0) {
      drop("stopped", leftover);
      queue.length = 0;
    }
    const w = worker;
    if (w) {
      await discard(w, new WriterRequestError("events writer stopped", true), false);
    }
    state = "stopped";
    // §7.5 Shutdown: records still queued are counted in the final journal line.
    log.info(
      `events writer stopped: written=${written} batches=${batches} dropped=${dropped} ` +
        `leftover_at_stop=${leftover}`,
    );
  }

  return { emit, flush, stats, refreshDbStats, queryLedger, querySaved, stop };
}

// ─── the process-wide writer (gateway startup wires these) ──────────────────

/**
 * The process-wide writer, on ONE globalThis slot resolved per call: the agent-events precedent
 * (`Symbol.for("openclaw.agentEvents.state")`). The tinker-bridge reaches the compaction owner, and
 * through it emitEvent, via a plugin-sdk subpath that dist may bundle as a separate copy of this
 * module; with a module-level `let` that copy would hold a writer that never started, and every
 * row it was handed would be dropped as `not_started` in a counter nobody reads.
 */
type SharedWriterState = {
  writer: EventWriter | null;
  preStartDropped: number;
  /**
   * The boot id of every writer this PROCESS started. The compaction ledger counts this process's
   * rows in memory, so its restart seed leaves these out (queryPriorBootLedger). A stop does not
   * clear it: a later start in the same process must still leave out the rows memory holds.
   */
  bootIds: string[];
};

const SHARED_WRITER_STATE_KEY = Symbol.for("openclaw.eventsWriter.state");

function sharedWriterState(): SharedWriterState {
  return resolveGlobalSingleton<SharedWriterState>(SHARED_WRITER_STATE_KEY, () => ({
    writer: null,
    preStartDropped: 0,
    bootIds: [],
  }));
}

/**
 * Starts the process-wide writer (idempotent). A no-op shell when OPENCLAW_EVENTS_DB=0 or when
 * paths.ts refuses the production path under a test runner.
 */
export function startEventWriter(options: EventWriterOptions = {}): EventWriter {
  const shared = sharedWriterState();
  let writer = shared.writer;
  if (writer === null) {
    // Emits from before this point were dropped; fold their count into the live writer so the
    // §7.5 rule holds — a dropped record is always COUNTED somewhere readable.
    writer = createEventWriter({
      ...options,
      ...(shared.preStartDropped > 0
        ? { carryDropped: { reason: "not_started", count: shared.preStartDropped } }
        : {}),
    });
    shared.writer = writer;
    shared.preStartDropped = 0;
    shared.bootIds.push(writer.stats().bootId);
  }
  return writer;
}

/** §7.5: THE emit. Synchronous, O(1), never throws. Before start, records are counted and dropped. */
export function emitEvent(name: string, record: EmitEventRecord = {}): void {
  const shared = sharedWriterState();
  if (shared.writer === null) {
    shared.preStartDropped += 1;
    return;
  }
  shared.writer.emit(name, record);
}

export function getEventWriterStats(): EventWriterStats {
  const shared = sharedWriterState();
  if (shared.writer !== null) {
    return shared.writer.stats();
  }
  const preStartDropped = shared.preStartDropped;
  return {
    enabled: false,
    running: false,
    dbPath: null,
    bootId: "",
    saltId: null,
    queueDepth: 0,
    written: 0,
    batches: 0,
    maxBatchMs: 0,
    dropped: preStartDropped,
    droppedByReason: preStartDropped > 0 ? { not_started: preStartDropped } : {},
    unknownNames: {},
    undeclaredKeys: 0,
    invalidValues: 0,
    respawns: 0,
    dbBytes: null,
    walBytes: null,
    writerThread: null,
    lastFlushAtMs: null,
    lastError: null,
  };
}

/** The `logs.writer.stats` RPC's answer: the snapshot with db/wal bytes refreshed when possible. */
export function readEventWriterStats(): Promise<EventWriterStats> {
  const writer = sharedWriterState().writer;
  return writer === null ? Promise.resolve(getEventWriterStats()) : writer.refreshDbStats();
}

/**
 * The writer thread for the worker-resources sampler (worker_type `events_writer`; logging.md
 * §4.9): null when no thread runs. The probe rides the existing `stats` request — refreshDbStats
 * swallows its own errors, so this never rejects — and it never SPAWNS a thread: a sampler must
 * not create the thing it measures.
 */
export function readEventWriterThreadStats(): Promise<EventWriterThreadStats | null> {
  const writer = sharedWriterState().writer;
  return writer === null
    ? Promise.resolve(null)
    : writer.refreshDbStats().then((stats) => stats.writerThread);
}

export function flushEventWriter(): Promise<void> {
  const writer = sharedWriterState().writer;
  return writer === null ? Promise.resolve() : writer.flush();
}

/**
 * The compaction ledger's restart seed (src/infra/compaction-ledger.ts; context-window-panel.md
 * §6.1 A4): per session key, the per-`trigger` groups of its `name` rows labelled `label` that
 * EARLIER processes wrote. The rows of every writer this process started are left out, because the
 * ledger already counts them in memory: a row is counted by exactly one of the two halves, whatever
 * the flush timing. Asks the worker; resolves null, never rejects, when nobody can answer.
 */
export function queryPriorBootLedger(query: {
  readonly name: string;
  readonly label: string;
  readonly sessionKeys: readonly string[];
}): Promise<Map<string, EventLedgerGroup[]> | null> {
  const shared = sharedWriterState();
  if (shared.writer === null) {
    return Promise.resolve(null);
  }
  return shared.writer.queryLedger({ ...query, excludeBootIds: [...shared.bootIds] });
}

/**
 * `logs.query` / `logs.catalog` (logging.md §8.2, §9 step 10): a SAVED query by name, answered by
 * the writer thread on its read-only connection — the gateway's main thread never opens the file.
 * Rejects with the reason when nobody can answer.
 */
export function runSavedEventsQuery(query: EventQueryWireRequest): Promise<EventsQueryResult> {
  const writer = sharedWriterState().writer;
  if (writer === null) {
    return Promise.reject(new Error("the events writer is not started"));
  }
  return writer.querySaved(query);
}

/** Gateway shutdown (§7.5): final flush with a 2 s deadline, then terminate. Idempotent. */
export async function stopEventWriter(): Promise<void> {
  const shared = sharedWriterState();
  const writer = shared.writer;
  shared.writer = null;
  if (writer !== null) {
    await writer.stop();
  }
}

/** A fresh process, as far as this module knows: no writer, no pre-start drops, no boot ids. */
export async function resetEventWriterForTest(): Promise<void> {
  await stopEventWriter();
  const shared = sharedWriterState();
  shared.preStartDropped = 0;
  shared.bootIds.length = 0;
}
