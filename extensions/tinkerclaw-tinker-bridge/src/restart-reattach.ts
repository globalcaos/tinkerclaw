/**
 * FORK 2026-09-30 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b) — the cc-bridge's part in a gateway
 * restart, on the FILE transport (worker-transport.ts):
 *
 *   stop   the restart drain asks every worker to hold at the end of the API call now streaming
 *          (worker.holdAtBoundary: `systemctl --user freeze`); the process exit lets go of them
 *          (pool.killAll → worker.detach). The units stay, frozen, with their stdio in files.
 *   boot   the adoption scan (adoptLeftoverWorkers, once per process) takes in every unit still
 *          alive. A unit frozen mid-turn is listed for core (src/infra/bridge-reattach.ts): boot
 *          recovery then dispatches a promptless continue, and the first run of that session takes
 *          the turn (worker.resumeTurn): its output is replayed from the turn's start and the unit
 *          thawed. That run has a NEW id, so it names the turn it takes on its events
 *          (resumedTurnFields), and the webchat anchors the replay to that turn's prompt.
 *
 * The scan runs on FIRST NEED, not on a hook: boot recovery calls it through core's registry, the
 * first bridge turn awaits it, and `gateway_start` is only the backstop. Live test 2026-09-30:
 * `gateway_start` fires after the channel sidecars, which took more than two minutes, while boot
 * recovery had already timed out waiting and resumed the chat by prompt in a second worker.
 *
 * Core's registries are reached by their global keys: a bundled extension may not import core.
 */
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { SessionWorkerPool } from "./worker-pool.js";
import {
  ownedUnits,
  readUnitState,
  readWorkerMeta,
  removeWorkerDir,
  systemctlUser,
  type UnitCommand,
  type WorkerMeta,
  workersRoot,
} from "./worker-transport.js";
import { ClaudeCodeWorker } from "./worker.js";

const log = createSubsystemLogger("tinkerclaw-tinker-bridge");

// ── core's reattach registry (src/infra/bridge-reattach.ts) ──────────────────────────────────────

type ReattachEntry = { unit: string; state: "pending" | "claimed" };
type ReattachState = { pending: Map<string, ReattachEntry>; scan?: () => Promise<unknown> };

function reattachState(): ReattachState {
  const g = globalThis as Record<symbol, ReattachState | undefined>;
  const key = Symbol.for("openclaw.bridgeReattach");
  let s = g[key];
  if (!s) {
    s = { pending: new Map() };
    g[key] = s;
  }
  return s;
}

/** A run took this session's adopted turn: recovery must not dispatch another. */
export function markReattachClaimed(openclawSessionKey: string | undefined): void {
  const entry = openclawSessionKey ? reattachState().pending.get(openclawSessionKey) : undefined;
  if (entry) {
    entry.state = "claimed";
  }
}

// ── the run that takes a frozen turn names it ────────────────────────────────────────────────────

/**
 * FORK 2026-10-01 (TINKER_UI_DESIGN_BIBLE/bug-log.md [chat-divergence], cause 4: "the seamless
 * restart repeats an answer") — what the run that takes a frozen turn adds to its lifecycle start
 * and its later events (stream.ts): `resumesRunId`, the frozen turn's own run when the last gateway
 * recorded it (worker.ts WorkerTurnMetaWithRun), and `resumesTurnStartedAt`, when that turn started
 * (ms). The run has a NEW id and the worker replays the turn from its first byte, so the webchat,
 * which keys a turn by the run that opened it, could not tell which prompt the replay continues: it
 * wrote the replay again below no prompt or a later one, and a history fill then wrote the turn's
 * rows a second time above it. The page now anchors the replay to the turn named here (tinker-ui
 * live-continuation.ts ResumedTurn). No frozen turn, no fields: every other run is unchanged.
 */
export function resumedTurnFields(turn: { runId?: string; startedAt?: number } | null): {
  resumesRunId?: string;
  resumesTurnStartedAt?: number;
} {
  if (!turn) {
    return {};
  }
  return {
    ...(typeof turn.runId === "string" && turn.runId ? { resumesRunId: turn.runId } : {}),
    ...(typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt)
      ? { resumesTurnStartedAt: turn.startedAt }
      : {}),
  };
}

// ── boot: adopt what the last gateway left ───────────────────────────────────────────────────────

export type AdoptReport = { adopted: number; pendingTurns: number; removed: number };

const NO_ADOPTION: AdoptReport = { adopted: 0, pendingTurns: 0, removed: 0 };
let scanPool: (() => SessionWorkerPool) | null = null;
let scanOnce: Promise<AdoptReport> | null = null;

/**
 * Plugin register: arm the scan and hand core the function that runs it. Nothing runs yet; a
 * process that never needs it (a CLI loading the plugin) never scans.
 */
export function armAdoptionScan(pool: () => SessionWorkerPool): void {
  scanPool = pool;
  reattachState().scan = ensureAdoptionScan;
}

/** Run the adoption once per process; every caller shares the same result. */
export function ensureAdoptionScan(): Promise<AdoptReport> {
  if (!scanPool) {
    return Promise.resolve(NO_ADOPTION);
  }
  const pool = scanPool;
  scanOnce ??= adoptLeftoverWorkers(pool()).catch((err) => {
    log.warn(`[reattach] adoption scan failed: ${String(err)}`);
    return NO_ADOPTION;
  });
  return scanOnce;
}

/** A dir with no meta is either a stray or a spawn of THIS process between mkdir and meta. */
const STRAY_DIR_MIN_AGE_MS = 5 * 60_000;

export async function adoptLeftoverWorkers(
  pool: SessionWorkerPool,
  opts: { run?: UnitCommand; root?: string } = {},
): Promise<AdoptReport> {
  const run = opts.run ?? systemctlUser;
  const root = opts.root ?? workersRoot();
  const report: AdoptReport = { adopted: 0, pendingTurns: 0, removed: 0 };
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return report;
  }
  const found: Array<{ dir: string; meta: WorkerMeta }> = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const meta = readWorkerMeta(dir);
    if (meta) {
      found.push({ dir, meta });
    } else if (ageMs(dir) > STRAY_DIR_MIN_AGE_MS) {
      removeWorkerDir(dir);
      report.removed += 1;
    }
  }
  // A worker holding a frozen turn is adopted BEFORE any idle one. One session can leave two
  // workers (the pool key drifts between turns, and the old idle worker lingers until its reap),
  // and the dedup below keeps whichever comes first. Live 2026-09-30 05:50: in directory order the
  // idle duplicate came first and the worker holding the chat's turn was stopped as a leftover.
  found.sort((a, b) => Number(!a.meta.turn) - Number(!b.meta.turn));
  for (const { dir, meta } of found) {
    if (ownedUnits().has(meta.unit)) {
      continue; // a worker of this very process (an in-process restart): it never stopped
    }
    const state = await readUnitState(meta.unit, run);
    if (!state.active) {
      removeWorkerDir(dir);
      report.removed += 1;
      continue;
    }
    // A turn reached this session before the scan did and spawned its own worker (the UI resends
    // what it held while the gateway was down). Two claudes on one CLI session is the one outcome
    // worse than a prompted resume, so the leftover goes; recovery then prompts, as before. Matched
    // by session as well as by pool key: the key is a hash of the system prompt's stable prefix,
    // and the live test of 2026-09-30 saw it change across the restart.
    if (pool.get(meta.sessionKey)?.isAlive() || pool.liveWorkerFor(meta.openclawSessionKey)) {
      log.warn(
        `[reattach] ${meta.unit}: its session already has a live worker; stopping the leftover`,
      );
      if (state.frozen) {
        await run(["thaw", meta.unit]);
      }
      await run(["stop", "--no-block", meta.unit]);
      removeWorkerDir(dir);
      report.removed += 1;
      continue;
    }
    let worker: ClaudeCodeWorker;
    try {
      worker = ClaudeCodeWorker.adopt(meta, dir, state.frozen, run);
    } catch (err) {
      log.warn(`[reattach] could not adopt ${meta.unit}: ${String(err)}`);
      continue;
    }
    pool.adopt(worker, { model: meta.model, thinkLevel: meta.thinkLevel });
    report.adopted += 1;
    if (meta.turn) {
      report.pendingTurns += 1;
      if (meta.openclawSessionKey) {
        reattachState().pending.set(meta.openclawSessionKey, { unit: meta.unit, state: "pending" });
      }
      log.info(
        `[reattach] adopted ${meta.unit} with a turn in flight (session ${meta.openclawSessionKey ?? "?"}, frozen=${state.frozen})`,
      );
    } else {
      if (state.frozen) {
        await worker.releaseHold(); // frozen between turns: nothing to replay
      }
      log.info(`[reattach] adopted idle ${meta.unit} (session ${meta.openclawSessionKey ?? "?"})`);
    }
  }
  if (report.adopted > 0 || report.removed > 0) {
    log.info(
      `[reattach] adopted=${report.adopted} pendingTurns=${report.pendingTurns} removedDead=${report.removed}`,
    );
  }
  return report;
}

function ageMs(dir: string): number {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

// ── stop: the restart drain (src/infra/restart-drain.ts) ─────────────────────────────────────────

type DrainReport = { held: string[]; ended: string[]; unfinished: string[] };
type DrainParticipant = {
  drain(budgetMs: number): Promise<DrainReport>;
  release(): void | Promise<void>;
};
type DrainState = { participants: Map<string, DrainParticipant>; active: boolean };

function drainState(): DrainState {
  const g = globalThis as Record<symbol, DrainState | undefined>;
  const key = Symbol.for("openclaw.restartDrain");
  let s = g[key];
  if (!s) {
    s = { participants: new Map(), active: false };
    g[key] = s;
  }
  return s;
}

export function createBridgeDrainParticipant(pool: () => SessionWorkerPool): DrainParticipant {
  return {
    async drain(budgetMs) {
      const report: DrainReport = { held: [], ended: [], unfinished: [] };
      await Promise.all(
        pool()
          .all()
          .map(async (worker) => {
            const verdict = await worker.holdAtBoundary(budgetMs);
            const id = worker.openclawSessionKey ?? worker.sessionKey;
            if (verdict === "held") {
              report.held.push(id);
            } else if (verdict === "ended") {
              report.ended.push(id);
            } else if (verdict === "unfinished" || verdict === "pipe") {
              // "pipe": a pipe-transport turn cannot be held; the stop cuts it (resumed by prompt).
              report.unfinished.push(id);
            }
          }),
      );
      log.info(
        `[restart-hold] held=${report.held.length} ended=${report.ended.length} unfinished=${report.unfinished.length}`,
      );
      return report;
    },
    async release() {
      await Promise.all(
        pool()
          .fileWorkers()
          .map((w) => w.releaseHold()),
      );
    },
  };
}

export function registerBridgeDrainParticipant(pool: () => SessionWorkerPool): void {
  drainState().participants.set("cc-bridge", createBridgeDrainParticipant(pool));
}
