/**
 * The `logs.ingest` gate — TINKER_UI_DESIGN_BIBLE/logging.md §8.2 (§9 step 7).
 *
 * Every other writer of the events database is the gateway writing about itself, and emit.ts is
 * permissive for those callers on purpose: it strips what the catalog does not declare and keeps the
 * rest, because an in-process caller cannot drift far from catalog.ts without a review noticing. A
 * browser tab is not that caller — it can drift for months with nobody looking — so this is the one
 * door where the catalog is ENFORCED rather than trusted. A record is accepted only when:
 *
 *  1. its name is a catalog row (`unknown_name` otherwise) flagged `uiIngestable`
 *     (`not_ingestable` otherwise: the UI can never forge a gateway event);
 *  2. its shape is exactly the one the row declares (`undeclared_field` otherwise): only the
 *     INGEST_RECORD_KEYS; a slot (durMs, n1..n4) only where the row gives it a meaning; the label
 *     present exactly when the row declares one; only declared `fields` keys; and every value of its
 *     declared kind — a finite number, a boolean, a member of the slot's CLOSED set, or an
 *     INGEST_ID_PATTERN id. There is no free-text path (L4). `json` fields are refused from this
 *     door outright: structure a browser composes can carry free text inside it;
 *  3. the batch holds at most INGEST_MAX_BATCH records (`oversize`) and the client is inside its
 *     budget (`rate_limited`).
 *
 * A record that breaks any rule is refused WHOLE — a row with the offending part removed would read
 * as a complete one — and the refusal is itself a `logs.ingest.rejected` row labelled with the
 * reason (§4.10). `undeclared_field` covers every shape refusal, value refusals included, because
 * §4.10 declares exactly five reasons and a label value it does not declare would break L2 (declare
 * before emit). A value outside its closed set IS undeclared: the sets below are part of the
 * declaration.
 *
 * WRITES ARE BOUNDED (L3). Every record — accepted or refused — and every batch refused whole spends
 * one unit of the client's INGEST_RATE_MAX_RECORDS per INGEST_RATE_WINDOW_MS, one unit per row this
 * door writes. Once the budget is spent the window writes ONE `rate_limited` row and nothing more,
 * so no client can make this door write more than budget + 1 rows per window, whatever it sends.
 * The counts the database does not carry are in the RPC reply.
 *
 * THE CLOSED SETS. A label's values come from its catalog row's own parenthetical — the rule
 * schema.ts's viewColumnName already documents, "a parenthetical lists a label's values" — so they
 * are never restated here, and a transition's `from` shares its label's set. Only what catalog.ts
 * does not enumerate is declared below; ingest.test.ts holds each set against its owner, and
 * ingestVocabularyGaps() reports any UI row whose set fails to resolve (such a row refuses every
 * record — fail closed, never open).
 */

import { type CatalogEvent, type CatalogFieldType, EVENT_CATALOG } from "./catalog.js";
import { type EmitEventRecord, emitEvent } from "./emit.js";

/** §8.2 "caps batch size": the most records one `logs.ingest` call may carry. */
export const INGEST_MAX_BATCH = 100;
/** §8.2 "caps ... rate": rows this door may write per client per window (10/s sustained). */
export const INGEST_RATE_MAX_RECORDS = 600;
export const INGEST_RATE_WINDOW_MS = 60_000;
/** Client windows tracked at once; beyond this the stalest window is forgotten (CWE-400). */
export const INGEST_RATE_MAX_CLIENTS = 512;
/** A client timestamp outside [now - PAST, now + FUTURE] is replaced by the receipt time. */
export const INGEST_CLOCK_PAST_MS = 24 * 60 * 60_000;
export const INGEST_CLOCK_FUTURE_MS = 60_000;
/** A session key is HMAC-hashed by the writer and never stored; this only bounds what is hashed. */
export const INGEST_SESSION_KEY_MAX_CHARS = 256;
/** The event every refusal is recorded as (§4.10). */
export const INGEST_REJECTED_EVENT = "logs.ingest.rejected";

/** §4.10's closed label set for `logs.ingest.rejected`; ingest.test.ts holds it equal to the catalog. */
export const INGEST_REJECT_REASONS = [
  "unknown_name",
  "undeclared_field",
  "not_ingestable",
  "rate_limited",
  "oversize",
] as const;
export type IngestRejectReason = (typeof INGEST_REJECT_REASONS)[number];

/**
 * An `id` from the UI: emit.ts's id shape without `+` or `/`, so neither a phone number nor a path
 * fits. Stricter than the writer's own pattern, never looser — a record this door accepts must reach
 * the database unstripped (logs.ingest.test.ts checks the writer's invalid-value counter stays 0).
 */
export const INGEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The only top-level keys a record may carry. `workerId` is absent on purpose: the UI is no worker. */
export const INGEST_RECORD_KEYS: ReadonlySet<string> = new Set([
  "name",
  "tsMs",
  "sessionKey",
  "runId",
  "label",
  "durMs",
  "n1",
  "n2",
  "n3",
  "n4",
  "fields",
]);

/**
 * prompt-queue.md §2's lifecycle states, lowercased like every stored label: the `to_state` of
 * `ui.prompt.state`, whose catalog parenthetical defers to that optic instead of listing them. The
 * code owner is tinker-ui/src/prompt-state.ts PROMPT_STATES; ingest.test.ts reads that file and
 * fails when the two part.
 */
export const UI_PROMPT_STATES = [
  "saved",
  "sending",
  "unsent",
  "accepted",
  "behind",
  "steered",
  "preparing",
  "running",
  "retrying",
  "answered",
  "failed",
  "cancelled",
  "lost",
] as const;

/** Label sets for UI rows whose catalog parenthetical is prose rather than a list. */
export const UI_LABEL_VALUES: Readonly<Partial<Record<string, readonly string[]>>> = {
  "ui.prompt.state": UI_PROMPT_STATES,
};

/**
 * Closed sets for the `enum` fields catalog.ts types but does not enumerate. A transition's `from`
 * is never listed here: it shares its label's set.
 *  - ui.outbox.state `proof`: how the entry left the outbox — a keyed transcript row, the legacy
 *    text match, or the owner's Dismiss (prompt-queue.md PQ-9; outbox.ts reconcileWithHistory).
 *  - ui.prompt.state `reason`: WHICH of prompt-queue.md §1's six facts changed (text_safe,
 *    transport, disposition, progress, retry, proof), `owner` for Resend / Dismiss / Stop retrying,
 *    and `snapshot` for a state re-derived from the gateway snapshot after a reload (PQ-11).
 *  - ui.context.action `result`: logging.md §4.7's (ok, error, noop).
 */
export const UI_FIELD_VALUES: Readonly<
  Partial<Record<string, Readonly<Partial<Record<string, readonly string[]>>>>>
> = {
  "ui.outbox.state": { proof: ["keyed", "text", "dismissed"] },
  "ui.prompt.state": {
    reason: [
      "text_safe",
      "transport",
      "disposition",
      "progress",
      "retry",
      "proof",
      "owner",
      "snapshot",
    ],
  },
  "ui.context.action": { result: ["ok", "error", "noop"] },
};

const MEANING_VALUE = /^[a-z][a-z0-9_]*$/;

/**
 * The closed set a catalog meaning lists in its trailing parenthetical — `to_state (queued, acked)`
 * gives ["queued", "acked"] — or null when the parenthetical is prose or a pattern family
 * (`killed.cause`), which declares no set.
 */
export function meaningValues(meaning: string | null): readonly string[] | null {
  if (meaning === null) {
    return null;
  }
  const match = /\(([^()]*)\)\s*$/.exec(meaning);
  if (match === null) {
    return null;
  }
  const values = match[1].split(",").map((value) => value.trim());
  return values.every((value) => MEANING_VALUE.test(value)) ? values : null;
}

/** One catalog row with its closed sets resolved. */
export interface IngestRule {
  readonly entry: CatalogEvent;
  /** The label's closed set; null when the row declares no label, or declares one no set resolves. */
  readonly labelValues: ReadonlySet<string> | null;
  /** Each `enum` field's closed set; a field with no entry refuses every value (fail closed). */
  readonly fieldValues: ReadonlyMap<string, ReadonlySet<string>>;
}

export type IngestRules = ReadonlyMap<string, IngestRule>;

function resolveRule(entry: CatalogEvent): IngestRule {
  const labelList =
    entry.label === null ? null : (UI_LABEL_VALUES[entry.name] ?? meaningValues(entry.label));
  const declared = UI_FIELD_VALUES[entry.name] ?? {};
  const fieldValues = new Map<string, ReadonlySet<string>>();
  for (const [key, type] of Object.entries(entry.fields)) {
    if (type !== "enum") {
      continue;
    }
    const list = key === "from" && entry.kind === "transition" ? labelList : declared[key];
    if (list !== null && list !== undefined) {
      fieldValues.set(key, new Set(list));
    }
  }
  return { entry, labelValues: labelList === null ? null : new Set(labelList), fieldValues };
}

/** Every catalog row by name, with its closed sets resolved. `catalog` is the test seam. */
export function buildIngestRules(catalog: readonly CatalogEvent[] = EVENT_CATALOG): IngestRules {
  return new Map(catalog.map((entry): [string, IngestRule] => [entry.name, resolveRule(entry)]));
}

let defaultRules: IngestRules | null = null;

function defaultIngestRules(): IngestRules {
  defaultRules ??= buildIngestRules();
  return defaultRules;
}

/**
 * What would make this door refuse EVERY record of a UI row, or what is declared here for nothing:
 * an unresolved label or enum set, a `json` field, or a set naming a row or key the catalog does not
 * make ingestable. Empty for the shipped catalog (ingest.test.ts).
 */
export function ingestVocabularyGaps(catalog: readonly CatalogEvent[] = EVENT_CATALOG): string[] {
  const gaps: string[] = [];
  const byName = new Map(catalog.map((entry): [string, CatalogEvent] => [entry.name, entry]));
  for (const entry of catalog) {
    if (!entry.uiIngestable) {
      continue;
    }
    const rule = resolveRule(entry);
    if (entry.label !== null && rule.labelValues === null) {
      gaps.push(`${entry.name}: label has no closed set`);
    }
    for (const [key, type] of Object.entries(entry.fields)) {
      if (type === "enum" && !rule.fieldValues.has(key)) {
        gaps.push(`${entry.name}: fields.${key} has no closed set`);
      }
      if (type === "json") {
        gaps.push(`${entry.name}: fields.${key} is json, which this door refuses`);
      }
    }
  }
  for (const name of Object.keys(UI_LABEL_VALUES)) {
    const entry = byName.get(name);
    if (entry === undefined || !entry.uiIngestable || entry.label === null) {
      gaps.push(`UI_LABEL_VALUES.${name}: not a UI-ingestable row with a label`);
    } else if (meaningValues(entry.label) !== null) {
      gaps.push(`UI_LABEL_VALUES.${name}: restates the set the catalog already lists`);
    }
  }
  for (const [name, fields] of Object.entries(UI_FIELD_VALUES)) {
    const entry = byName.get(name);
    for (const key of Object.keys(fields ?? {})) {
      const derived = key === "from" && entry?.kind === "transition";
      if (entry === undefined || !entry.uiIngestable || entry.fields[key] !== "enum" || derived) {
        gaps.push(`UI_FIELD_VALUES.${name}.${key}: not an enum field this door resolves from here`);
      }
    }
  }
  return gaps;
}

// ─── one record ─────────────────────────────────────────────────────────────

export type IngestRecordCheck =
  | { readonly ok: true; readonly name: string; readonly record: EmitEventRecord }
  | { readonly ok: false; readonly reason: IngestRejectReason };

type MutableRecord = { -readonly [K in keyof EmitEventRecord]: EmitEventRecord[K] };

const NUMERIC_SLOTS = ["durMs", "n1", "n2", "n3", "n4"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function refuse(reason: IngestRejectReason): IngestRecordCheck {
  return { ok: false, reason };
}

function fieldValueDeclared(
  type: CatalogFieldType,
  closedSet: ReadonlySet<string> | undefined,
  value: unknown,
): boolean {
  switch (type) {
    case "number":
      return isFiniteNumber(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && closedSet !== undefined && closedSet.has(value);
    case "id":
      return typeof value === "string" && INGEST_ID_PATTERN.test(value);
    case "json":
      return false;
  }
}

/**
 * One record against its catalog row. Pure: it decides, it neither emits nor counts. The returned
 * record carries only what the client sent and the row declares; the writer hashes `sessionKey`.
 */
export function validateIngestRecord(
  input: unknown,
  rules: IngestRules,
  nowMs: number,
): IngestRecordCheck {
  if (!isPlainObject(input)) {
    return refuse("unknown_name");
  }
  const name = input.name;
  const rule = typeof name === "string" ? rules.get(name) : undefined;
  if (rule === undefined) {
    return refuse("unknown_name");
  }
  const entry = rule.entry;
  if (!entry.uiIngestable) {
    // The catalog's one-way valve: a client may never write a row the gateway owns.
    return refuse("not_ingestable");
  }
  for (const key of Object.keys(input)) {
    if (!INGEST_RECORD_KEYS.has(key)) {
      return refuse("undeclared_field");
    }
  }
  const record: MutableRecord = {};

  const label = input.label;
  if (entry.label === null) {
    if (!isAbsent(label)) {
      return refuse("undeclared_field");
    }
  } else {
    // Required: a ui.* row's label is its whole point (a transition without its to_state).
    if (typeof label !== "string" || rule.labelValues === null || !rule.labelValues.has(label)) {
      return refuse("undeclared_field");
    }
    record.label = label;
  }

  for (const slot of NUMERIC_SLOTS) {
    const value = input[slot];
    if (isAbsent(value)) {
      continue;
    }
    if (entry[slot] === null || !isFiniteNumber(value)) {
      return refuse("undeclared_field");
    }
    record[slot] = value;
  }

  const fields = input.fields;
  if (!isAbsent(fields)) {
    if (!isPlainObject(fields)) {
      return refuse("undeclared_field");
    }
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!Object.hasOwn(entry.fields, key)) {
        return refuse("undeclared_field");
      }
      if (isAbsent(value)) {
        continue;
      }
      if (!fieldValueDeclared(entry.fields[key], rule.fieldValues.get(key), value)) {
        return refuse("undeclared_field");
      }
      clean[key] = value;
    }
    if (Object.keys(clean).length > 0) {
      record.fields = clean;
    }
  }

  const runId = input.runId;
  if (!isAbsent(runId)) {
    if (typeof runId !== "string" || !INGEST_ID_PATTERN.test(runId)) {
      return refuse("undeclared_field");
    }
    record.runId = runId;
  }

  const sessionKey = input.sessionKey;
  if (!isAbsent(sessionKey)) {
    if (
      typeof sessionKey !== "string" ||
      sessionKey.length === 0 ||
      sessionKey.length > INGEST_SESSION_KEY_MAX_CHARS
    ) {
      return refuse("undeclared_field");
    }
    // Not pattern-checked on purpose: emit.ts HMACs it into session_hash and classifies it into
    // session_kind (§7.5), so the raw key reaches no column. Only its size is this door's business.
    record.sessionKey = sessionKey;
  }

  const tsMs = input.tsMs;
  if (!isAbsent(tsMs)) {
    if (!isFiniteNumber(tsMs)) {
      return refuse("undeclared_field");
    }
    // A client clock is not trusted to place a row, but a skewed clock says nothing about the
    // transition itself, so the row takes the receipt time instead of being refused. Durations
    // live in n1..n4 and are unaffected; order within a batch is kept by `id`.
    record.tsMs =
      tsMs >= nowMs - INGEST_CLOCK_PAST_MS && tsMs <= nowMs + INGEST_CLOCK_FUTURE_MS ? tsMs : nowMs;
  }

  return { ok: true, name: entry.name, record };
}

// ─── the per-client budget ──────────────────────────────────────────────────

/** "ok": inside the budget. "exhausted": the window's first refusal. "silent": refused again. */
export type IngestSpend = "ok" | "exhausted" | "silent";

export interface IngestRateLimiter {
  /** Spends one unit of `key`'s current window — one unit per row this door would write. */
  spend(key: string, nowMs: number): IngestSpend;
}

/** A fixed window per client key, bounded in how many keys it remembers. */
export function createIngestRateLimiter(
  options: {
    readonly windowMs?: number;
    readonly maxRecords?: number;
    readonly maxClients?: number;
  } = {},
): IngestRateLimiter {
  const windowMs = options.windowMs ?? INGEST_RATE_WINDOW_MS;
  const maxRecords = options.maxRecords ?? INGEST_RATE_MAX_RECORDS;
  const maxClients = Math.max(1, options.maxClients ?? INGEST_RATE_MAX_CLIENTS);
  const windows = new Map<string, { startMs: number; used: number; reported: boolean }>();
  return {
    spend(key: string, nowMs: number): IngestSpend {
      let window = windows.get(key);
      if (window === undefined || nowMs - window.startMs >= windowMs) {
        // Re-inserted at the end, so the Map's first key is always the stalest window.
        windows.delete(key);
        window = { startMs: nowMs, used: 0, reported: false };
        windows.set(key, window);
        if (windows.size > maxClients) {
          const stalest = windows.keys().next();
          if (stalest.done !== true) {
            windows.delete(stalest.value);
          }
        }
      }
      if (window.used < maxRecords) {
        window.used += 1;
        return "ok";
      }
      if (!window.reported) {
        window.reported = true;
        return "exhausted";
      }
      return "silent";
    },
  };
}

// ─── the batch ──────────────────────────────────────────────────────────────

export interface IngestRejection {
  /** The record's position in the request. */
  readonly index: number;
  readonly reason: IngestRejectReason;
}

/** The `logs.ingest` reply. `accepted` means handed to the writer, not yet durably written. */
export interface IngestResult {
  readonly accepted: number;
  readonly rejected: number;
  readonly rejectedByReason: Readonly<Partial<Record<IngestRejectReason, number>>>;
  /** Each refused record by index; empty when the batch was refused whole (`oversize`). */
  readonly rejections: readonly IngestRejection[];
}

export interface IngestOptions {
  /** The budget identity: the RPC passes resolveControlPlaneRateLimitKey(client) (device|ip). */
  readonly clientKey: string;
  /**
   * REQUIRED, never defaulted: an optional limiter would be a silent "no limit". The RPC holds the
   * process-lifetime one; tests pass their own.
   */
  readonly limiter: IngestRateLimiter;
  /** Test seam: where rows go. Production uses the shared writer's emitEvent. */
  readonly emit?: (name: string, record: EmitEventRecord) => void;
  readonly now?: () => number;
  readonly rules?: IngestRules;
}

/** Validates one `logs.ingest` batch, emits what passes, records what does not. Never throws. */
export function ingestUiEvents(events: readonly unknown[], options: IngestOptions): IngestResult {
  const emit = options.emit ?? emitEvent;
  const nowMs = (options.now ?? Date.now)();
  const rules = options.rules ?? defaultIngestRules();
  const rejectedByReason: Partial<Record<IngestRejectReason, number>> = {};
  const rejections: IngestRejection[] = [];
  let accepted = 0;
  let rejected = 0;

  const count = (reason: IngestRejectReason, records: number): void => {
    rejected += records;
    rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + records;
  };
  /** The refusal's own row when the budget allows; the window's single `rate_limited` row once. */
  const writeRefusal = (reason: IngestRejectReason, spend: IngestSpend): void => {
    if (spend === "ok") {
      emit(INGEST_REJECTED_EVENT, { tsMs: nowMs, label: reason });
    } else if (spend === "exhausted") {
      emit(INGEST_REJECTED_EVENT, { tsMs: nowMs, label: "rate_limited" });
    }
  };

  if (events.length > INGEST_MAX_BATCH) {
    // Refused whole as ONE row: a row per record would turn the batch cap into an amplifier.
    count("oversize", events.length);
    writeRefusal("oversize", options.limiter.spend(options.clientKey, nowMs));
    return { accepted, rejected, rejectedByReason, rejections };
  }

  for (let index = 0; index < events.length; index += 1) {
    const spend = options.limiter.spend(options.clientKey, nowMs);
    if (spend !== "ok") {
      count("rate_limited", 1);
      rejections.push({ index, reason: "rate_limited" });
      writeRefusal("rate_limited", spend);
      continue;
    }
    const check = validateIngestRecord(events[index], rules, nowMs);
    if (check.ok) {
      emit(check.name, check.record);
      accepted += 1;
      continue;
    }
    count(check.reason, 1);
    rejections.push({ index, reason: check.reason });
    writeRefusal(check.reason, spend);
  }
  return { accepted, rejected, rejectedByReason, rejections };
}
