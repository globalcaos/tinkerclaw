/**
 * FRACTAL WAITS FOR THE END OF THE TASK (the architect, 2026-10-25 00:32).
 *
 * Until today the page started the Fractal reflection when a TURN ended (fractal-turn.ts), even
 * while a long job or a background Workflow that turn had launched was still running. The
 * reflection then judged half a task: the job's result, the wake that reported it and whatever the
 * chat did with it all came later. Now:
 *
 *   - when an armed prompt's run ends and this chat has a running long job (the same list the
 *     progress rows draw, tinker-prod-ui `/api/longjob/list?session=…`), the Fractal is NOT sent:
 *     the run is remembered as deferred and the page logs `[fractal-turn] deferred: N jobs running`;
 *   - more armed runs that end meanwhile join the same deferral, and so do the turns in between
 *     (the longjob wakes), so the reflection covers the whole task;
 *   - when the chat has no running job AND the turn that handled the last wake has ended, ONE
 *     Fractal fires for all of it, not one per turn.
 *
 * The deferral lives in localStorage beside the arms (FRACTAL_ARMED_KEY): a long job outlasts page
 * reloads, and every tab of the origin sees the same record, so whichever tab takes it fires once
 * (two tabs taking it at once still send the same idempotencyKey, which the gateway dedupes).
 *
 * Fail open, like the gate: a job list that does not exist (an older tinker-prod-ui) or does not
 * answer at the moment the turn ends holds nothing, and a wake this page never sees (lost, sent on
 * another lane, the page was closed) is replaced by a grace period once the chat is idle. A missed
 * reflection costs more than a late one.
 *
 * 2026-10-25 (the architect, 02:43: "Fractal should only come at the end of the task"): a Claude Code
 * background task (Bash in the background, a Workflow, a Task, a Monitor) outlives its turn too, and
 * its end wakes the chat on its own (the bridge's `bg-turn-…` run). The gateway lists each chat's
 * live ones (`ccBridge.backgroundTasks`) and they hold the reflection exactly like long jobs: the
 * task is over with no long job, no background task and no turn running, the wake's turn included.
 * Each decision (deferred / fired / task-over) also goes to the gateway's journal (`report`).
 *
 * Pure apart from the injected deps: app.ts wires the job list, the run resolver and the send.
 */

import {
  FRACTAL_GATE_TEXT_MAX,
  type FractalTrail,
  isFractalRunId,
  trailDigestLines,
} from "./fractal-turn.js";
import { BACKGROUND_JOB_KIND, type LongjobJob } from "./longjob-rows.js";
import type { TerminalScope } from "./queued-sends.js";

export const FRACTAL_DEFERRED_KEY = "tinker.fractal.deferred";
/** The jobs are gone and the chat is idle, but no wake turn ended: fire after this long anyway. */
export const FRACTAL_WAKE_GRACE_MS = 5 * 60_000;
/** A deferral older than this fires whatever still runs: a stuck job must not eat the reflection. */
export const FRACTAL_DEFER_MAX_MS = 24 * 60 * 60_000;
/** A job whose worker wrote nothing for this long (or six of its intervals) is presumed dead. */
export const LONGJOB_DEAD_AFTER_MS = 10 * 60_000;
/** longjob.mjs deliverWake sends the wake with idempotencyKey `longjob-<ts>-<rand>`: the run id. */
export const LONGJOB_WAKE_RUN_PREFIX = "longjob-";
/** The bridge wakes a chat for a turn its CLI started on its own with idempotencyKey `bg-turn-<id>`. */
export const BACKGROUND_WAKE_RUN_PREFIX = "bg-turn-";
/** Turns remembered per deferral. Armed runs are never dropped; the oldest turn in between is. */
export const FRACTAL_DEFER_RUN_CAP = 12;

export type DeferredRunKind = "prompt" | "wake" | "turn";

export interface DeferredFractalRun {
  runId: string;
  /** prompt = an armed owner prompt; wake = a turn that handled a longjob wake; turn = any other. */
  kind: DeferredRunKind;
  endedAt: number;
  /** Armed runs: when the prompt was sent, what it said, and the prompts a follow-up run answered. */
  armedAt?: number;
  prompt?: string;
  aliases?: string[];
  reply?: string;
}

export interface DeferredFractal {
  sessionKey: string;
  since: number;
  runs: DeferredFractalRun[];
  /** The last time the lists showed a running job or background task, and how many of each. */
  jobsSeenAt: number;
  jobs: number;
  background?: number;
  /** When a turn that handled a longjob wake last ended. */
  wakeEndedAt?: number;
  /** A wake was folded into, or queued behind, a running turn: the next turn end handles it. */
  wakePending?: boolean;
}

type DeferredMap = Record<string, DeferredFractal>;

function readDeferred(storage: Storage): DeferredMap {
  try {
    const raw = storage.getItem(FRACTAL_DEFERRED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as DeferredMap) : {};
  } catch {
    return {};
  }
}

function writeDeferred(storage: Storage, map: DeferredMap): void {
  try {
    if (Object.keys(map).length === 0) {
      storage.removeItem(FRACTAL_DEFERRED_KEY);
    } else {
      storage.setItem(FRACTAL_DEFERRED_KEY, JSON.stringify(map));
    }
  } catch {
    /* a full or blocked storage loses the deferral: the next armed run fires on its own */
  }
}

function findKey(
  map: DeferredMap,
  sessionKey: string,
  matches: (a: string, b: string) => boolean,
): string | null {
  if (map[sessionKey]) {
    return sessionKey;
  }
  // The arm keeps the key the tab had (`tinker:abc`); chat events carry the canonical one.
  return Object.keys(map).find((k) => matches(k, sessionKey)) ?? null;
}

function isWakeRunKey(key: string): boolean {
  return key.startsWith(LONGJOB_WAKE_RUN_PREFIX) || key.startsWith(BACKGROUND_WAKE_RUN_PREFIX);
}

/** Running jobs that still hold the reflection: running, and a worker that wrote recently. */
export function liveLongjobCount(jobs: readonly LongjobJob[], now: number): number {
  let n = 0;
  for (const job of jobs) {
    if (!job || job.status !== "running" || job.kind === BACKGROUND_JOB_KIND) {
      continue;
    }
    const interval =
      typeof job.intervalMs === "number" && Number.isFinite(job.intervalMs) ? job.intervalMs : 5000;
    const dead = Math.max(LONGJOB_DEAD_AFTER_MS, 6 * interval);
    if (typeof job.updatedAt === "number" && now - job.updatedAt > dead) {
      continue; // its worker died without a verdict; no wake will come from it
    }
    n++;
  }
  return n;
}

/**
 * Live background tasks. The bridge lists only the ones its worker's CLI still reports, so there is
 * no staleness to judge: a worker that dies takes its tasks off the list with it.
 */
export function liveBackgroundCount(jobs: readonly LongjobJob[]): number {
  return jobs.filter((j) => j && j.status === "running" && j.kind === BACKGROUND_JOB_KIND).length;
}

function addRun(rec: DeferredFractal, run: DeferredFractalRun): void {
  const at = rec.runs.findIndex((r) => r.runId === run.runId);
  if (at >= 0) {
    // The terminal noted it as a turn first; the armed path then upgrades it to a prompt.
    const prev = rec.runs[at];
    rec.runs[at] = {
      ...prev,
      ...run,
      kind: prev.kind === "prompt" || run.kind === "prompt" ? "prompt" : run.kind,
      reply: run.reply || prev.reply,
    };
    return;
  }
  rec.runs.push(run);
  while (rec.runs.length > FRACTAL_DEFER_RUN_CAP) {
    const drop = rec.runs.findIndex((r) => r.kind !== "prompt");
    if (drop < 0) {
      break;
    }
    rec.runs.splice(drop, 1);
  }
}

export type FractalDeferVerdict =
  | { fire: false; why: "jobs" | "background" | "turn" | "wake" }
  | { fire: true; why: "wake-ended" | "no-wake" | "too-long" };

/**
 * Is the task over? No running job, no background task, no turn running, and the turn that handled
 * the last wake has ended (a wake turn ended after the jobs were last seen). With no wake seen at
 * all, the grace period stands in for it once the chat is idle.
 */
export function fractalDeferVerdict(
  rec: DeferredFractal,
  live: { jobs: number; background?: number; turnLive: boolean; now: number },
): FractalDeferVerdict {
  if (live.now - rec.since > FRACTAL_DEFER_MAX_MS) {
    return { fire: true, why: "too-long" };
  }
  if (live.jobs > 0) {
    return { fire: false, why: "jobs" };
  }
  if ((live.background ?? 0) > 0) {
    return { fire: false, why: "background" };
  }
  if (live.turnLive) {
    return { fire: false, why: "turn" };
  }
  if (typeof rec.wakeEndedAt === "number" && rec.wakeEndedAt > rec.jobsSeenAt) {
    return { fire: true, why: "wake-ended" };
  }
  if (live.now - rec.jobsSeenAt >= FRACTAL_WAKE_GRACE_MS) {
    return { fire: true, why: "no-wake" };
  }
  return { fire: false, why: "wake" };
}

export interface CoveredRun {
  runId: string;
  kind: DeferredRunKind;
}

/** What the one Fractal of a finished task is sent with. */
export interface FractalFire {
  /** The newest armed prompt: its bubble carries the card, its worker's session is forked. */
  parentRunId: string;
  sessionKey: string;
  armedAt: number;
  prompt?: string;
  reply?: string;
  /** The other prompt runs it covers; their bubbles show the same card. */
  aliases: string[];
  /** Every run it covers, oldest first. Absent when the parent is the only one. */
  runs?: CoveredRun[];
}

/** The fire for a deferral, or null when it holds no armed run (nothing was owed a reflection). */
export function fractalFireFor(rec: DeferredFractal): FractalFire | null {
  const prompts = rec.runs.filter((r) => r.kind === "prompt");
  const parent = prompts.at(-1);
  if (!parent) {
    return null;
  }
  const aliases = new Set<string>();
  for (const r of prompts) {
    if (r.runId !== parent.runId) {
      aliases.add(r.runId);
    }
    for (const a of r.aliases ?? []) {
      if (a !== parent.runId) {
        aliases.add(a);
      }
    }
  }
  const armedAt = Math.min(
    ...prompts.map((r) => (typeof r.armedAt === "number" ? r.armedAt : r.endedAt)),
  );
  const prompt = prompts
    .map((r) => r.prompt ?? "")
    .filter((t) => t.trim() !== "")
    .join("\n\n")
    .slice(0, FRACTAL_GATE_TEXT_MAX);
  // Where the task says what it did: the last turn that ended, usually the one that read the wake.
  const reply = rec.runs.toReversed().find((r) => (r.reply ?? "").trim() !== "")?.reply;
  return {
    parentRunId: parent.runId,
    sessionKey: rec.sessionKey,
    armedAt,
    ...(prompt ? { prompt } : {}),
    ...(reply ? { reply } : {}),
    aliases: [...aliases],
    ...(rec.runs.length > 1
      ? { runs: rec.runs.map((r) => ({ runId: r.runId, kind: r.kind })) }
      : {}),
  };
}

/** The trails of the covered turns as one, for the gate (calls, tokens, tools and time summed). */
export function mergeTrails(trails: ReadonlyArray<FractalTrail | null>): FractalTrail | null {
  const seen = trails.filter((t): t is FractalTrail => t !== null);
  if (seen.length === 0) {
    return null;
  }
  const timed = seen.filter((t) => t.durationMs !== undefined);
  return {
    calls: seen.reduce((n, t) => n + t.calls, 0),
    tokensIn: seen.reduce((n, t) => n + t.tokensIn, 0),
    tokensOut: seen.reduce((n, t) => n + t.tokensOut, 0),
    ...(timed.length > 0 ? { durationMs: timed.reduce((n, t) => n + (t.durationMs ?? 0), 0) } : {}),
    tools: seen.flatMap((t) => t.tools),
  };
}

const RUN_KIND_LABEL: Record<DeferredRunKind, string> = {
  prompt: "owner prompt",
  wake: "wake: a long job or background task ended",
  turn: "turn",
};

/**
 * The digest of a reflection that waited for its task: one block per covered turn, oldest first,
 * each the usual digest lines. A single turn gets exactly the old digest.
 */
export function coveredDigestLines(
  runs: ReadonlyArray<{ kind: DeferredRunKind; trail: FractalTrail | null }>,
  opts: { seenFrom?: number } = {},
): string[] {
  if (runs.length <= 1) {
    return trailDigestLines(runs[0]?.trail ?? null, opts);
  }
  const out = [
    `- This reflection waited for the task's long jobs and background tasks to end, so it covers ${runs.length} turns of one task, oldest first.`,
  ];
  runs.forEach((r, i) => {
    out.push(`- Turn ${i + 1} (${RUN_KIND_LABEL[r.kind]}):`);
    // The page-loaded note is about the page, not a turn: said once, with the first turn.
    for (const line of trailDigestLines(r.trail, i === 0 ? opts : {})) {
      out.push(`  ${line}`);
    }
  });
  return out;
}

export interface FractalDeferDeps {
  storage: Storage;
  now: () => number;
  /** This chat's long jobs. [] when the server has no list (older build); null when it did not answer. */
  listJobs: (sessionKey: string) => Promise<LongjobJob[] | null>;
  /**
   * This chat's live Claude Code background tasks (kind "background"), from the gateway. [] when the
   * gateway has no such method; null when it did not answer. Absent: none are counted.
   */
  listBackground?: (sessionKey: string) => Promise<LongjobJob[] | null>;
  /** Whether a turn of that session is running now (the page's one run resolver). */
  turnLive: (sessionKey: string) => boolean;
  /** Session keys equal up to the `agent:<id>:` prefix. */
  matches: (a: string, b: string) => boolean;
  fire: (f: FractalFire) => void;
  log?: (line: string) => void;
  /** Each decision, for the gateway's journal (app.ts sends it to `fractal.clientLog`). */
  report?: (r: FractalDecisionReport) => void;
}

export interface ArmedRunEnd {
  runId: string;
  sessionKey: string;
  armedAt: number;
  prompt?: string;
  reply?: string;
  /** The prompts a linked follow-up run answered (fractal-turn.ts takeFractalArmForTerminal). */
  aliases?: string[];
}

/** One decision about a reflection: held for the task, sent at once, or sent because the task ended. */
export interface FractalDecisionReport {
  decision: "deferred" | "fired" | "task-over";
  sessionKey: string;
  parentRunId: string;
  longjobs: number;
  background: number;
  why?: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function jobsText(jobs: number, background: number): string {
  const parts = [
    ...(jobs > 0 || background === 0 ? [plural(jobs, "job")] : []),
    ...(background > 0 ? [plural(background, "background task")] : []),
  ];
  return `${parts.join(" and ")} running`;
}

/** The newest armed prompt of a deferral: the run its reflection will be the parent of. */
function parentRunOf(rec: DeferredFractal): string {
  return rec.runs.filter((r) => r.kind === "prompt").at(-1)?.runId ?? "";
}

/**
 * The deferral, wired: app.ts calls `armedRunEnded` where it used to send the Fractal, `turnEnded`
 * on every chat terminal, and `check` on a timer while anything is deferred.
 */
export function createFractalDeferrer(deps: FractalDeferDeps) {
  const log = deps.log ?? (() => {});
  const report = deps.report ?? (() => {});
  let checking: Promise<void> | null = null;
  let checkAgain = false;

  function mutate<T>(
    sessionKey: string,
    fn: (rec: DeferredFractal | null, map: DeferredMap, key: string) => T,
  ): T {
    const map = readDeferred(deps.storage);
    const key = findKey(map, sessionKey, deps.matches) ?? sessionKey;
    const out = fn(map[key] ?? null, map, key);
    writeDeferred(deps.storage, map);
    return out;
  }

  function take(sessionKey: string): DeferredFractal | null {
    return mutate(sessionKey, (rec, map, key) => {
      delete map[key];
      return rec;
    });
  }

  /** What still runs for this chat; a list that did not answer is null (unknown, not finished). */
  async function liveCounts(
    sessionKey: string,
    now: () => number,
  ): Promise<{ jobs: number | null; background: number | null }> {
    const [jobs, background] = await Promise.all([
      deps.listJobs(sessionKey),
      deps.listBackground ? deps.listBackground(sessionKey) : Promise.resolve([]),
    ]);
    return {
      jobs: jobs === null ? null : liveLongjobCount(jobs, now()),
      background: background === null ? null : liveBackgroundCount(background),
    };
  }

  async function checkOnce(): Promise<void> {
    for (const rec of Object.values(readDeferred(deps.storage))) {
      if (!rec || typeof rec.sessionKey !== "string" || !Array.isArray(rec.runs)) {
        continue;
      }
      const counts = await liveCounts(rec.sessionKey, deps.now);
      const now = deps.now();
      if (counts.jobs === null || counts.background === null) {
        // A list did not answer: a hiccup is not a finished job. Only the age cap fires now.
        if (now - rec.since <= FRACTAL_DEFER_MAX_MS) {
          continue;
        }
      }
      const liveJobs = counts.jobs ?? 0;
      const liveBg = counts.background ?? 0;
      const turnLive = deps.turnLive(rec.sessionKey);
      const cur = mutate(rec.sessionKey, (r) => {
        if (!r) {
          return r;
        }
        const changed = r.jobs !== liveJobs || (r.background ?? 0) !== liveBg;
        if (liveJobs + liveBg > 0) {
          if (changed) {
            log(`[fractal-turn] deferred: ${jobsText(liveJobs, liveBg)} (${r.sessionKey})`);
            report({
              decision: "deferred",
              sessionKey: r.sessionKey,
              parentRunId: parentRunOf(r),
              longjobs: liveJobs,
              background: liveBg,
            });
          }
          r.jobsSeenAt = now;
        } else if ((r.background ?? 0) > 0 && turnLive) {
          // A background task that ends while a turn of ours is open is told to THAT turn (the CLI
          // starts no turn of its own for it): that turn is the wake.
          r.wakePending = true;
        }
        r.jobs = liveJobs;
        r.background = liveBg;
        return r;
      });
      if (!cur) {
        continue; // another tab fired it meanwhile
      }
      const verdict = fractalDeferVerdict(cur, {
        jobs: liveJobs,
        background: liveBg,
        turnLive,
        now,
      });
      if (!verdict.fire) {
        continue;
      }
      const taken = take(cur.sessionKey);
      const fire = taken ? fractalFireFor(taken) : null;
      if (!fire) {
        continue;
      }
      log(
        `[fractal-turn] task over (${verdict.why}): one reflection for ${taken?.runs.length ?? 0} turn(s), parent ${fire.parentRunId}`,
      );
      report({
        decision: "task-over",
        sessionKey: fire.sessionKey,
        parentRunId: fire.parentRunId,
        longjobs: liveJobs,
        background: liveBg,
        why: verdict.why,
      });
      deps.fire(fire);
    }
  }

  /** Fire every deferral whose task is over. Calls that overlap run once more, not in parallel. */
  function check(): Promise<void> {
    if (checking) {
      checkAgain = true;
      return checking;
    }
    checking = (async () => {
      try {
        do {
          checkAgain = false;
          await checkOnce();
        } while (checkAgain);
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  return {
    /** Whether any chat has a deferred reflection (the timer runs `check` only then). */
    pending(): boolean {
      return Object.keys(readDeferred(deps.storage)).length > 0;
    },

    /**
     * An armed prompt's run ended. Fires its Fractal at once (as before) unless the chat has a
     * running job or background task, or already holds a deferral, in which case the run joins it.
     */
    async armedRunEnded(run: ArmedRunEnd): Promise<"fired" | "deferred"> {
      const counts = await liveCounts(run.sessionKey, deps.now);
      const now = deps.now();
      // A list that does not answer holds nothing here: the turn's end fires (fail open).
      const liveJobs = counts.jobs ?? 0;
      const liveBg = counts.background ?? 0;
      const held = findKey(readDeferred(deps.storage), run.sessionKey, deps.matches) !== null;
      if (liveJobs === 0 && liveBg === 0 && !held) {
        report({
          decision: "fired",
          sessionKey: run.sessionKey,
          parentRunId: run.runId,
          longjobs: 0,
          background: 0,
        });
        deps.fire({
          parentRunId: run.runId,
          sessionKey: run.sessionKey,
          armedAt: run.armedAt,
          ...(run.prompt ? { prompt: run.prompt } : {}),
          ...(run.reply ? { reply: run.reply } : {}),
          aliases: [],
        });
        return "fired";
      }
      mutate(run.sessionKey, (rec, map, key) => {
        const r: DeferredFractal = rec ?? {
          sessionKey: run.sessionKey,
          since: now,
          runs: [],
          jobsSeenAt: now,
          jobs: liveJobs,
          background: liveBg,
        };
        addRun(r, {
          runId: run.runId,
          kind: "prompt",
          endedAt: now,
          armedAt: run.armedAt,
          ...(run.prompt ? { prompt: run.prompt } : {}),
          ...(run.reply ? { reply: run.reply } : {}),
          ...(run.aliases && run.aliases.length > 0 ? { aliases: [...run.aliases] } : {}),
        });
        if (liveJobs + liveBg > 0) {
          r.jobsSeenAt = now;
          r.jobs = liveJobs;
          r.background = liveBg;
        }
        map[key] = r;
      });
      if (liveJobs + liveBg > 0) {
        log(`[fractal-turn] deferred: ${jobsText(liveJobs, liveBg)} (prompt run ${run.runId})`);
      }
      report({
        decision: "deferred",
        sessionKey: run.sessionKey,
        parentRunId: run.runId,
        longjobs: liveJobs,
        background: liveBg,
      });
      // Held with no job left: this prompt's turn may be the one that handled the last wake.
      await check();
      return "deferred";
    },

    /**
     * Any chat terminal. A deferral of that session records the turn and whether it handled a
     * wake (a long job's, or a background task's). Returns true when a deferral exists for it (the
     * caller then schedules a check).
     */
    turnEnded(t: {
      sessionKey: string;
      runId: string;
      scope: TerminalScope | null;
      reply?: string;
    }): boolean {
      if (!t.runId || !t.scope || isFractalRunId(t.runId)) {
        return false;
      }
      // Every terminal of every chat lands here; only a deferred chat's touches the storage.
      if (findKey(readDeferred(deps.storage), t.sessionKey, deps.matches) === null) {
        return false;
      }
      const now = deps.now();
      return mutate(t.sessionKey, (rec) => {
        if (!rec) {
          return false;
        }
        const scope = t.scope as TerminalScope;
        if (scope.kind === "prompt") {
          // A prompt placed into (steered) or behind (backlogged) a running turn: no turn ended.
          if (isWakeRunKey(scope.key)) {
            rec.wakePending = true;
          }
          return true;
        }
        const wake =
          isWakeRunKey(t.runId) ||
          (scope.kind === "linked" && scope.keys.some(isWakeRunKey)) ||
          rec.wakePending === true;
        if (wake) {
          rec.wakeEndedAt = now;
          rec.wakePending = false;
        }
        addRun(rec, {
          runId: t.runId,
          kind: wake ? "wake" : "turn",
          endedAt: now,
          ...(t.reply ? { reply: t.reply } : {}),
        });
        return true;
      });
    },

    check,
  };
}

export type FractalDeferrer = ReturnType<typeof createFractalDeferrer>;
