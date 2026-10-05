// src/infra/thalamus-cooling.ts
//
// THE COOLING STORE — which supplies hit a limit, and until when.
//
// FORK 2026-10-02 (the architect, full deploy): "Limits cool their supply until the reset time the error gives, or
// 30 minutes; the next turn goes to the best supply still open; the state survives a restart."
//
// WHY IT EXISTS. The planner has had a `cooling` veto since the v2 design (thalamus-feasibility.ts,
// `supply-cooling`), and the failover path recognises a limit and reads its reset time
// (failover-error.ts, rate-limit-reset.ts). Nothing connected them: the router never passed `cooling`, so a
// model that had just hit its limit was chosen again on the next turn unless the usage snapshot already said
// "spent". This file is the missing memory, one small JSON file under ~/.openclaw, so a gateway restart keeps it.
//
// WHAT COUNTS AS A LIMIT. A failed candidate whose failover reason is `rate_limit` or `billing`: a usage window,
// a rate limit, or credit. `overloaded` (a 529) is the vendor being busy, not the supply being spent, and does not
// cool. The unit is the SUPPLY (`supplyOfKey`: claude-code and anthropic are one pool), as the planner's veto is.
//
// RESET TIME. The provider's own text through `resolveRetryAfterSeconds` ("Try again in ~262 min", "resets 3:10pm
// (Europe/Madrid)", an ISO instant); none stated → 30 minutes. A later limit never SHORTENS an earlier, longer one.
//
// SAME CONTRACT AS orca-bias-store.ts: a file written through a temp file and a rename, read through an
// (mtimeMs, size) cache, never throws, a miss is "nothing cooling".
//
// TESTS NEVER TOUCH THE OPERATOR'S FILE. Under vitest the default path is not used: a write with no injected
// file (option or OPENCLAW_THALAMUS_COOLING_FILE) is skipped, and a read with none sees an empty store. In vitest
// workers `process.env.HOME` does not reach `os.homedir()`, so the path cannot be redirected by the home alone.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveRetryAfterSeconds } from "../agents/rate-limit-reset.js";
import { supplyOf, type SupplyId } from "../shared/thalamus-supply.js";

/** How long a supply cools when the error states no reset time (the architect: 30 minutes). */
export const DEFAULT_COOLING_MS = 30 * 60 * 1000;

/** The failover reasons that mean "this supply is spent for now". */
const LIMIT_REASONS: ReadonlySet<string> = new Set(["rate_limit", "billing"]);

/**
 * A supply that rejects THIS CLIENT (HTTP 426 Upgrade Required, 2026-10-02: xAI refused every call because our Grok
 * client reports an old version). Not a usage limit, but the supply cannot serve us until the client changes, so the
 * next plan must skip it exactly as it skips a spent one. No reset time is ever stated: it cools for the default and
 * is tried again after, so it comes back by itself once fixed. A plain auth failure (a 401) does NOT cool: tokens
 * are refreshed, the supply is not gone.
 */
function isClientRejected(status: number | undefined, error: string | undefined): boolean {
  return status === 426 || (typeof error === "string" && /^\s*426\b/.test(error));
}

export type CoolingEntry = {
  /** Epoch ms when the supply reopens. */
  until: number;
  /** Epoch ms of the limit that set it. */
  since: number;
  /** Why it cools: rate_limit | billing (a limit), or client_rejected (a 426: the supply refuses this client). */
  reason: string;
  /** The route that hit the limit, `provider/model`. */
  source?: string;
  /** The reset time came from the provider's own text (true) or the 30-minute default (false). */
  stated: boolean;
  /** A short clip of the error, for the log and the card. */
  detail?: string;
};

export type CoolingFile = Partial<Record<SupplyId, CoolingEntry>>;

export function thalamusCoolingFilePath(file?: string): string | undefined {
  if (file) {
    return file;
  }
  const fromEnv = process.env.OPENCLAW_THALAMUS_COOLING_FILE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (process.env.VITEST) {
    return undefined;
  }
  return join(homedir(), ".openclaw", "thalamus-cooling.json");
}

type CacheEntry = { mtimeMs: number; size: number; value: CoolingFile };
const cache = new Map<string, CacheEntry>();

export function clearThalamusCoolingCache(): void {
  cache.clear();
}

function parseFile(raw: unknown): CoolingFile {
  const out: CoolingFile = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [supply, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    if (typeof e.until !== "number" || !Number.isFinite(e.until)) continue;
    out[supply as SupplyId] = {
      until: e.until,
      since: typeof e.since === "number" ? e.since : e.until,
      reason: typeof e.reason === "string" ? e.reason : "rate_limit",
      ...(typeof e.source === "string" ? { source: e.source } : {}),
      stated: e.stated === true,
      ...(typeof e.detail === "string" ? { detail: e.detail } : {}),
    };
  }
  return out;
}

function readFileCached(file: string): CoolingFile {
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(file);
  } catch {
    cache.delete(file);
    return {};
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.value;
  }
  let value: CoolingFile = {};
  try {
    value = parseFile(JSON.parse(readFileSync(file, "utf-8")));
  } catch {
    /* corrupt file = nothing cooling */
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

export type ThalamusCooling = {
  /** The supplies cooling right now: what `thalamusPlan({cooling})` takes. */
  set: Set<SupplyId>;
  /** When each reopens (epoch ms): what `thalamusPlan({coolingUntil})` takes. */
  until: Map<SupplyId, number>;
  entries: CoolingFile;
};

/** The supplies cooling at `nowMs`. Expired entries are ignored, never returned. */
export function readThalamusCooling(opts?: { file?: string; nowMs?: number }): ThalamusCooling {
  const file = thalamusCoolingFilePath(opts?.file);
  const nowMs = opts?.nowMs ?? Date.now();
  const empty: ThalamusCooling = { set: new Set(), until: new Map(), entries: {} };
  if (!file) {
    return empty;
  }
  const all = readFileCached(file);
  for (const [supply, e] of Object.entries(all) as [SupplyId, CoolingEntry][]) {
    if (e.until > nowMs) {
      empty.set.add(supply);
      empty.until.set(supply, e.until);
      empty.entries[supply] = e;
    }
  }
  return empty;
}

export type SupplyLimitInput = {
  provider: string;
  model?: string;
  /** The failover reason of the failed candidate. */
  reason: string | null | undefined;
  /** The provider's raw error text; the reset time is read from it. */
  error?: string;
  /** The HTTP status of the failure, when known (a 426 cools the supply whatever the reason). */
  status?: number;
  nowMs?: number;
  file?: string;
};

/**
 * Note a failed candidate. Cools the candidate's supply when the failure is a limit and the supply is a known
 * one; anything else returns undefined and writes nothing. Never throws: the failover path must not be
 * broken by the memory of it.
 */
export function recordSupplyLimit(
  input: SupplyLimitInput,
): { supply: SupplyId; entry: CoolingEntry } | undefined {
  try {
    const rejected = isClientRejected(input.status, input.error);
    if (!rejected && (!input.reason || !LIMIT_REASONS.has(input.reason))) {
      return undefined;
    }
    const supply = supplyOf(input.provider);
    if (supply === "unknown") {
      return undefined;
    }
    const file = thalamusCoolingFilePath(input.file);
    if (!file) {
      return undefined;
    }
    const nowMs = input.nowMs ?? Date.now();
    const seconds = resolveRetryAfterSeconds(input.error, nowMs);
    const until = nowMs + (seconds !== undefined ? seconds * 1000 : DEFAULT_COOLING_MS);
    const current = readFileCached(file);
    const prior = current[supply];
    // A later limit never shortens an earlier, longer one.
    const entry: CoolingEntry =
      prior && prior.until > until
        ? prior
        : {
            until,
            since: nowMs,
            reason: rejected ? "client_rejected" : (input.reason as string),
            ...(input.model ? { source: `${input.provider}/${input.model}` } : {}),
            stated: seconds !== undefined,
            ...(input.error
              ? { detail: input.error.replace(/\s+/g, " ").trim().slice(0, 160) }
              : {}),
          };
    const next: CoolingFile = {};
    for (const [s, e] of Object.entries(current) as [SupplyId, CoolingEntry][]) {
      if (e.until > nowMs) next[s] = e; // expired entries are dropped on every write
    }
    next[supply] = entry;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, file);
    cache.delete(file);
    return { supply, entry };
  } catch {
    return undefined;
  }
}
