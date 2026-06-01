/**
 * FORK — Bi-temporal memory-search RPC (Upgrade 3, J14 read-path surface).
 *
 * The bi-temporal READ path is fully implemented below the gateway:
 *   - manager-search.ts.temporalPredicate builds the validity-interval SQL,
 *   - MemoryIndexManager.search(query, { temporalMode, asOfTime, ... }) threads it
 *     ('current' (default) | 'valid-at' | 'all').
 * What was MISSING is an RPC that lets a frontend (Tinker UI / Jarvis) drive a
 * point-in-time recall — "what did memory say was true at T?" This handler exposes
 * exactly that, threading the caller's temporalMode/asOfTime into the manager search.
 *
 * Styled like src/fork/prefrontal-state-rpc.ts (which already resolves the gateway's
 * default agent + memorySearch config for its embed RPC): same GatewayRequestHandlers
 * shape, same readStr/readNum guards, same errorShape responses. Fork-only — no
 * upstream path is patched.
 *
 * Handlers:
 *   fork.memory.search(query, temporalMode?, asOfTime?, maxResults?, minScore?, sessionKey?)
 *     — recall against the chosen temporal slice; returns the manager's results plus the
 *       resolved temporalMode echoed back so the UI can label the slice it rendered.
 *   fork.engram.consolidate.run(baseDir?, sessionFilter?)
 *     — invoke the ENGRAM nightly sleep-consolidation job (Upgrade 4) on demand. The fork's
 *       crons are PROMPT-driven (no coded scheduler registry exists — see self-evolution-cron.ts),
 *       so the engramConsolidateJob descriptor is exposed as an RPC the prompt-cron / Jarvis
 *       calls on its schedule rather than registered into the upstream stored-CronJob registry.
 *
 * Manager resolution is injected via a module-level hook (default = getMemorySearchManager
 * for the gateway's default agent) so the param-threading is unit-testable without a real
 * embedding backend.
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrades 3 + 4).
 */

import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/io.js";
import { runEngramConsolidate } from "../cron/jobs/engram-consolidate.js";
import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/shared-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getMemorySearchManager } from "../memory/search-manager.js";
import type { MemorySearchManager } from "../memory/types.js";

const log = createSubsystemLogger("fork-memory");

export type TemporalMode = "current" | "valid-at" | "all";
const VALID_TEMPORAL_MODES: ReadonlySet<string> = new Set(["current", "valid-at", "all"]);

/** Manager resolution result: either a live manager or a human-readable reason it's absent. */
type ManagerResolution = { manager: MemorySearchManager } | { error: string | undefined };

/**
 * Resolve the memory-search manager for the gateway's default agent. Factored behind a
 * settable hook so tests can inject a stub (the only NEW logic worth testing is the
 * temporal param-threading + response shape, not the embedding backend).
 */
type ManagerResolver = () => Promise<ManagerResolution>;

async function defaultManagerResolver(): Promise<ManagerResolution> {
  const cfg = getRuntimeConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const { manager, error } = await getMemorySearchManager({ cfg, agentId });
  return manager ? { manager } : { error };
}

let managerResolver: ManagerResolver = defaultManagerResolver;

/** TEST-ONLY: override the manager resolver (pass undefined to restore the default). */
export function __setMemoryManagerResolverForTest(resolver: ManagerResolver | undefined): void {
  managerResolver = resolver ?? defaultManagerResolver;
}

function readStr(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function readNum(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export const forkMemoryHandlers: GatewayRequestHandlers = {
  // U3 — point-in-time recall against the bi-temporal index.
  "fork.memory.search": async ({ params, respond }) => {
    const p = params ?? {};
    const query = readStr(p, "query");
    if (!query) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "fork.memory.search: 'query' required."),
      );
      return;
    }
    // Default + sanitize the temporal slice: an unknown value falls back to 'current'
    // (the backward-compatible default), never errors.
    const rawMode = readStr(p, "temporalMode");
    const temporalMode: TemporalMode = (
      rawMode && VALID_TEMPORAL_MODES.has(rawMode) ? rawMode : "current"
    ) as TemporalMode;
    const asOfTime = readNum(p, "asOfTime");
    const maxResults = readNum(p, "maxResults");
    const minScore = readNum(p, "minScore");
    const sessionKey = readStr(p, "sessionKey") ?? readStr(p, "parentSessionKey");

    let resolution: ManagerResolution;
    try {
      resolution = await managerResolver();
    } catch (err) {
      console.error("[fork.memory.search] manager resolution failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.memory.search: failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    if (!("manager" in resolution)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.memory.search: memory search unavailable${resolution.error ? ` (${resolution.error})` : ""}.`,
        ),
      );
      return;
    }

    try {
      // The concrete MemoryIndexManager honours temporalMode/asOfTime (manager.ts);
      // the public MemorySearchManager interface omits them, so widen the opts type
      // for the call (same shape MemoryIndexManager.search accepts).
      const results = await resolution.manager.search(query, {
        ...(maxResults !== undefined ? { maxResults } : {}),
        ...(minScore !== undefined ? { minScore } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        temporalMode,
        ...(asOfTime !== undefined ? { asOfTime } : {}),
      } as Parameters<MemorySearchManager["search"]>[1]);
      log.info(
        `fork.memory.search query="${query}" mode=${temporalMode}${asOfTime !== undefined ? ` asOf=${asOfTime}` : ""} returned=${results.length}`,
      );
      respond(
        true,
        {
          ok: true,
          results,
          temporalMode,
          ...(asOfTime !== undefined ? { asOfTime } : {}),
        },
        undefined,
      );
    } catch (err) {
      console.error("[fork.memory.search] search failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.memory.search: search failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  // U4 — on-demand trigger for the ENGRAM nightly sleep-consolidation job. The fork has
  // no coded cron registry (its crons are prompt-driven), so the engramConsolidateJob
  // descriptor is reachable at runtime through this RPC — the prompt-cron calls it on the
  // job's schedule. Idempotent; a `baseDir` param redirects the ENGRAM root for tests.
  "fork.engram.consolidate.run": async ({ params, respond }) => {
    const p = params ?? {};
    const baseDir = readStr(p, "baseDir");
    const sessionFilter = readStr(p, "sessionFilter");
    try {
      const result = await runEngramConsolidate({
        ...(baseDir ? { baseDir } : {}),
        ...(sessionFilter ? { sessionFilter } : {}),
        log: (msg) => log.info(msg),
      });
      log.info(
        `fork.engram.consolidate.run sessions=${result.sessionsProcessed} episodes=${result.episodes} switches=${result.strategySwitchesProposed}`,
      );
      respond(true, { ok: true, ...result }, undefined);
    } catch (err) {
      console.error("[fork.engram.consolidate.run] failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.engram.consolidate.run: failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};
