/**
 * Where the events database lives — TINKER_UI_DESIGN_BIBLE/logging.md §7.1 (§9 step 3).
 *
 * `<state>/logs/events.sqlite`, never a hardcoded host path: the anatomy database, the algorithm
 * ledger and the ENGRAM collector each hardcode `$HOME/.openclaw`, and §7.1 names that as the
 * defect this module refuses to repeat. Overrides:
 *  - OPENCLAW_EVENTS_DB=0 turns the writer off entirely;
 *  - OPENCLAW_EVENTS_DB_PATH points the file (and its salt, kept beside it) somewhere explicit —
 *    also the ONLY way a test runner gets a database at all;
 *  - OPENCLAW_EVENTS_DB_MAX_BYTES is §7.4's size-budget ceiling (default 512 MiB).
 *
 * Under a test runner (isVitestRuntimeEnv — the canonical detector, never a second weaker one)
 * the production path is REFUSED outright — the `resolveLedgerPath` precedent
 * (src/infra/algorithm-metrics.ts): a test is sandboxed by CONSTRUCTION, not by remembering to
 * set an env var. A test that wants a real database opts in with an explicit
 * OPENCLAW_EVENTS_DB_PATH into its own temp directory.
 */
import { dirname, join } from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { isVitestRuntimeEnv } from "../env.js";

export const EVENTS_DB_ENV = "OPENCLAW_EVENTS_DB";
export const EVENTS_DB_PATH_ENV = "OPENCLAW_EVENTS_DB_PATH";
export const EVENTS_DB_MAX_BYTES_ENV = "OPENCLAW_EVENTS_DB_MAX_BYTES";
/** logging.md §7.4: the size-budget ceiling the maintenance pass derives its windows from. */
export const EVENTS_DB_DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
/** The salt lives beside the database, so a sandboxed database gets a sandboxed salt. */
export const EVENTS_SALT_BASENAME = "events.salt";

export type EventsDbResolution =
  | { readonly enabled: true; readonly dbPath: string; readonly saltPath: string }
  | { readonly enabled: false; readonly reason: "disabled" | "test_runner" };

/** OPENCLAW_EVENTS_DB=0|false|off|no turns the writer off (logging.md §7.1). */
export function eventsDbDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[EVENTS_DB_ENV]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

export function resolveEventsDbPath(env: NodeJS.ProcessEnv = process.env): EventsDbResolution {
  if (eventsDbDisabled(env)) {
    return { enabled: false, reason: "disabled" };
  }
  const override = env[EVENTS_DB_PATH_ENV]?.trim();
  if (override) {
    return {
      enabled: true,
      dbPath: override,
      saltPath: join(dirname(override), EVENTS_SALT_BASENAME),
    };
  }
  if (isVitestRuntimeEnv(env)) {
    // Refused, not silently sandboxed: a writer nobody asked for has no business existing in a
    // test run, and the explicit override above is the one opt-in. The canonical detector also
    // catches vitest pool workers whose env carries VITEST_WORKER_ID but not VITEST.
    return { enabled: false, reason: "test_runner" };
  }
  const dir = join(resolveStateDir(env), "logs");
  return {
    enabled: true,
    dbPath: join(dir, "events.sqlite"),
    saltPath: join(dir, EVENTS_SALT_BASENAME),
  };
}

/** §7.4's ceiling: OPENCLAW_EVENTS_DB_MAX_BYTES, default 512 MiB. Nonsense values fall back. */
export function resolveEventsDbBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[EVENTS_DB_MAX_BYTES_ENV]?.trim() || "");
  return Number.isFinite(raw) && raw >= 1024 * 1024 ? Math.floor(raw) : EVENTS_DB_DEFAULT_MAX_BYTES;
}
