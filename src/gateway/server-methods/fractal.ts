/**
 * FORK 2026-10-09: `fractal.gate` and `fractal.ledger` (Fractal v2 charter, contracts C1 and C3).
 *
 * `fractal.gate`: should a background Fractal fire for this turn? Rules always, Jev when a token exists. It never fails
 * the call: any internal error answers `fire: true` (a missed reflection costs more than a spare one).
 * `fractal.ledger`: the rows the bridge wrote for finished Fractal runs, newest last, for the card's ✓/✗.
 *
 * Both are core methods, not plugin ones, so the page and the bridge reach them with no plugin opt-in, and both are READ
 * scope: the gate asks Jev a question but changes nothing, and the ledger is a file read. The plugin keeps its own
 * `fractal.byRunId/stats/feed/status/suspend/resume` names; these two do not collide with them.
 *
 * 2026-10-25: the served gate also logs every decision to `data/fractal/gate.jsonl` and offers a few skipped turns to
 * its tutor (`infra/fractal/gate-tutor.ts`), after the answer is sent. Only the production handlers carry the log;
 * `createFractalHandlers()` with no `gateLog` writes nothing, so a test never touches the real state folder.
 *
 * 2026-10-25: `fractal.clientLog`. The page decides when a reflection fires (tinker-ui fractal-defer.ts: it waits for
 * the task's long jobs and background tasks), and that decision only reached the browser console. The page now reports
 * each one (deferred / fired / task-over) and this writes it to the journal as one `[fractal-client]` line. WRITE scope,
 * like `logs.ingest`: it is the client writing into the gateway's log.
 *
 * 2026-10-25: `ccBridge.backgroundTasks`, the chat's live Claude Code background tasks the page waits for and draws
 * as rows. The tinker-bridge plugin first registered it itself, but it activates on the claude-code provider after the
 * gateway built its method table, so the method was never served ("unknown method" live). The bridge now publishes
 * the lookup on BRIDGE_BACKGROUND_TASKS_SLOT and this READ handler calls it; no bridge = an empty list.
 */

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createFractalGateAsk,
  runFractalGate,
  type FractalGateDecision,
  type FractalGateDeps,
} from "../../infra/fractal/gate-jev.js";
import {
  appendFractalJsonl,
  fractalGateRow,
  resolveFractalGateLogPath,
  resolveFractalGateReviewsPath,
} from "../../infra/fractal/gate-log.js";
import {
  createFractalGateTutor,
  FRACTAL_GATE_REVIEW_TIMEOUT_MS,
  type FractalGateReviewRun,
  type FractalGateTutor,
} from "../../infra/fractal/gate-tutor.js";
import { normalizeFractalLedgerParams, readFractalLedger } from "../../infra/fractal/ledger.js";
import { jevOn } from "../../infra/jev/availability.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { fractalGateReviewRun } from "./fractal-review-run.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Where the gate's decisions go, and the tutor that judges a few skipped ones (2026-10-25). */
export type FractalGateLogDeps = {
  file: () => string;
  tutor?: FractalGateTutor;
  /** The tutor's model call for this config; absent = the gateway's embedded runner. */
  run?: (cfg: OpenClawConfig) => FractalGateReviewRun;
  now?: () => number;
};

export const FRACTAL_CLIENT_DECISIONS = ["deferred", "fired", "task-over"] as const;
export type FractalClientDecision = (typeof FRACTAL_CLIENT_DECISIONS)[number];

/** A value the page sent, as one journal-safe token; "?" when it sent none or the wrong type. */
function logToken(v: unknown, max = 120): string {
  return typeof v === "string" && v.trim() !== ""
    ? v
        .trim()
        .replace(/[^\w:.@/-]/g, "_")
        .slice(0, max)
    : "?";
}

function logCount(v: unknown): string {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? String(v) : "?";
}

/**
 * The journal line for one page decision (the logger adds the `[fractal-client]` prefix), or null when the decision is
 * not one of FRACTAL_CLIENT_DECISIONS.
 */
export function fractalClientLogLine(params: unknown): string | null {
  const p = (params ?? {}) as Record<string, unknown>;
  const decision = p.decision;
  if (!FRACTAL_CLIENT_DECISIONS.includes(decision as FractalClientDecision)) {
    return null;
  }
  const why = typeof p.why === "string" && p.why ? ` why=${logToken(p.why, 40)}` : "";
  return (
    `${decision as string} session=${logToken(p.sessionKey)} run=${logToken(p.parentRunId)}` +
    ` longjobs=${logCount(p.longjobs)} background=${logCount(p.background)}` +
    ` page=${logToken(p.pageId, 40)}${why}`
  );
}

const fractalClientLog = createSubsystemLogger("fractal-client");

/** Must equal `BRIDGE_BACKGROUND_TASKS_SLOT` in extensions/tinkerclaw-tinker-bridge/src/background-tasks.ts. */
export const BRIDGE_BACKGROUND_TASKS_SLOT = "openclaw.bridgeBackgroundTasks";

type BackgroundTasksLookup = (sessionKey: string) => unknown[];

function bridgeBackgroundTasks(): BackgroundTasksLookup | undefined {
  const seam = (globalThis as Record<symbol, unknown>)[Symbol.for(BRIDGE_BACKGROUND_TASKS_SLOT)];
  return typeof seam === "function" ? (seam as BackgroundTasksLookup) : undefined;
}

/** The tutor is on unless `fork.cognitive.fractalGateReview` is "disabled". */
export function fractalGateReviewOn(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.fork?.cognitive?.fractalGateReview !== "disabled";
}

export function createFractalHandlers(
  deps: {
    gate?: FractalGateDeps;
    ledgerFile?: () => string | undefined;
    gateLog?: FractalGateLogDeps;
    /** Where `fractal.clientLog` writes; the gateway's journal by default. */
    clientLog?: (line: string) => void;
    /** The bridge's background-task lookup; the published slot by default. */
    backgroundTasks?: () => BackgroundTasksLookup | undefined;
  } = {},
): GatewayRequestHandlers {
  let gateDeps = deps.gate;
  const log = deps.gateLog;
  return {
    "fractal.gate": async ({ params, respond, context }) => {
      gateDeps ??= { ask: createFractalGateAsk(), jevOn };
      // Read after the decision; the answer goes out first and the log and the tutor follow it.
      let decided: FractalGateDecision | undefined;
      const result = await runFractalGate(
        params,
        log ? { ...gateDeps, onDecision: (d) => (decided = d) } : gateDeps,
      );
      respond(true, result);
      if (!log || !decided) {
        return;
      }
      const row = fractalGateRow(decided, (log.now ?? Date.now)());
      void appendFractalJsonl(log.file(), row);
      if (row.fire || !log.tutor) {
        return;
      }
      const cfg = context?.getRuntimeConfig?.();
      if (cfg && fractalGateReviewOn(cfg)) {
        log.tutor.observe(
          row,
          (log.run ?? ((c) => fractalGateReviewRun(c, FRACTAL_GATE_REVIEW_TIMEOUT_MS)))(cfg),
        );
      }
    },
    "fractal.ledger": async ({ params, respond }) => {
      const p = normalizeFractalLedgerParams(params);
      try {
        const file = deps.ledgerFile?.();
        respond(true, await readFractalLedger({ ...p, ...(file ? { file } : {}) }));
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `fractal ledger unreadable: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    },
    "fractal.clientLog": ({ params, respond }) => {
      const line = fractalClientLogLine(params);
      if (!line) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `decision must be one of ${FRACTAL_CLIENT_DECISIONS.join(", ")}`,
          ),
        );
        return;
      }
      (deps.clientLog ?? ((l) => fractalClientLog.info(l)))(line);
      respond(true, { ok: true });
    },
    "ccBridge.backgroundTasks": ({ params, respond }) => {
      const sessionKey = (params as { sessionKey?: unknown } | undefined)?.sessionKey;
      if (typeof sessionKey !== "string" || !sessionKey.trim()) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
        return;
      }
      const lookup = (deps.backgroundTasks ?? bridgeBackgroundTasks)();
      respond(true, { jobs: lookup ? lookup(sessionKey.trim()) : [] });
    },
  };
}

export const fractalHandlers: GatewayRequestHandlers = createFractalHandlers({
  gateLog: {
    file: () => resolveFractalGateLogPath(),
    tutor: createFractalGateTutor({
      save: (row) => appendFractalJsonl(resolveFractalGateReviewsPath(), row),
    }),
  },
});
