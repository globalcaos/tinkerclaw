// FORK 2026-10-19: the fixed systemd-run flags every cc-bridge worker unit starts with.
//
// worker.ts runs each `claude` worker as a transient systemd user service. This builds the fixed
// head of that systemd-run command line for both transports; worker.ts appends the
// `--setenv=K=V` list, the file transport's shell and the claude command after it. Kept apart
// and pure so a test can pin the exact flags without spawning anything.
//
// FORK 2026-10-29: this file also owns the one-shot session rule (isOneShotSessionKey,
// isOneShotWorker), moved here from worker-pool.ts, which re-exports isOneShotSessionKey. It still
// imports nothing, so worker.ts can apply the rule at spawn without importing worker-pool.ts:
// worker-pool.ts imports worker.ts, and an edge back would close an import cycle.

// FORK 2026-10-19 (JarvisPi OOM kill): the kernel must take a worker before the gateway. That day
// the kernel OOM killer on the 16 GB JarvisPi (Raspberry Pi 5) killed the TinkerClaw gateway while
// 26 idle cc-bridge worker units survived. Every user unit had oom_score_adj 200, the systemd user
// manager's default, so nothing separated them but size, and the gateway was the largest single
// process (~2 GB RSS). A worker can be lost: its Claude session is on disk and the next turn
// respawns it with --resume. The gateway carries every chat and channel.
// 500 needs no root: an unprivileged user manager may RAISE a unit's oom_score_adj (200 -> 500)
// but not lower it. The worker's children (its Bash tools) inherit the value, on purpose: a
// runaway build inside a worker dies before the gateway does.
export const WORKER_OOM_SCORE_ADJUST = 500;

// FORK 2026-10-29 (background CPU weight): a one-shot worker (isOneShotWorker: a `temp:*` run
// such as the Jev explainer, or a Fractal turn) starts its unit with CPUWeight=10. Every other
// worker, a chat's included, keeps systemd's default of 100.
// Objective: when a chat worker and one background worker both want the CPU, the chat gets 10/11
// of it instead of half. A weight only splits contended time, so on an idle host the background
// turn runs at full speed, and nothing is ever frozen.
// Measured on the 4-core reference Pi over 10.75 h to 2026-10-29, from cgroup files and systemd's
// per-unit consumed-CPU lines: the cpu controller reaches the user manager's app.slice, the
// gateway unit runs at weight 1000 and every worker at 100, CPU pressure (PSI some) read 58-63%,
// and one-shot workers used at least 975 CPU-s (the Fractal turns; about 7,100 if the single-turn
// Sonnet sessions are temp:* too). A throwaway unit started with either transport's flags read
// cpu.weight 10 from inside; one without the flag read 100.
// Break-even: the chat's share is 100/(100+w). From 10 down to 1 it rises from 91% to 99%, about 8
// points, while the background worker's falls from 9% to 1%: under contention it gets about 9
// times less CPU, so its local work runs slower and it holds its memory longer. Below 10 the chat
// gains little and the background loses a lot; 20 would leave the chat 83%. The reference host's
// background timers run at 10 as well.
// Rejected: a governor slice (`--slice=pigov-*`), because the governor freezes those slices and a
// worker streaming a model answer must never be frozen; `--nice`, because with the cpu controller
// delegated each unit is its own cgroup and nice orders tasks only inside one; a weight of 1, for
// the break-even above.
// What would change it: chat first-output latency at matched PSI that does not improve; more
// memory-pressure evictions of slowed one-shot workers (worker-pool.ts); chat workers moved off
// 100; a host whose user manager does not delegate the cpu controller, where the property does
// nothing and the unit still starts.
// UNVERIFIED: how much chat latency this buys. The measurement did not cover it.
export const WORKER_BACKGROUND_CPU_WEIGHT = 10;

/**
 * FORK 2026-10-19: a session that runs once and is never asked for again: the
 * internal `temp:*` one-shots (the Jev explainer, the tab namer, the slug
 * generator) and a Fractal reflection (`agent:<id>:fractal:<P>`).
 * FORK 2026-10-29: moved here from worker-pool.ts, which re-exports it; body unchanged.
 */
export function isOneShotSessionKey(key: string): boolean {
  return key.startsWith("temp:") || key.includes(":fractal:");
}

/**
 * FORK 2026-10-29: a one-shot worker, named by its pool key or by the canonical session key it
 * carries. One rule for the pool (worker-pool.ts isOneShot: the idle TTL, memory relief) and for
 * worker.ts at spawn (the background CPU weight). In production the pool key is the stream's
 * `tinker-sp-<hash>` (stream.ts deriveSessionKey), which never matches, so the canonical key
 * (`temp:jev-explain:<runId>`, `agent:main:fractal:<P>`) decides; an adopted worker carries its
 * key from the unit's meta.
 */
export function isOneShotWorker(keys: {
  sessionKey: string;
  openclawSessionKey?: string;
}): boolean {
  return isOneShotSessionKey(keys.sessionKey) || isOneShotSessionKey(keys.openclawSessionKey ?? "");
}

/**
 * The fixed systemd-run flags for one worker unit.
 *
 * FILE transport (`workerDir` set): the unit owns its stdio (a FIFO and two files in the worker
 * dir, see worker-transport.ts), and `TC_WORKER_DIR` tells the unit's shell where they are.
 * PIPE transport (`workerDir` null): `--pipe` forwards the unit's stdio to the caller.
 * Both end with `--property=OOMScoreAdjust=<WORKER_OOM_SCORE_ADJUST>`, followed, for a
 * `background` worker (a one-shot; FORK 2026-10-29), by
 * `--property=CPUWeight=<WORKER_BACKGROUND_CPU_WEIGHT>`.
 */
export function workerUnitBaseArgs(params: {
  unitId: string;
  workerDir: string | null;
  /** FORK 2026-10-29: a one-shot worker (isOneShotWorker) gets the background CPU weight. */
  background?: boolean;
}): string[] {
  const unitProperties = [`--property=OOMScoreAdjust=${WORKER_OOM_SCORE_ADJUST}`];
  if (params.background) {
    unitProperties.push(`--property=CPUWeight=${WORKER_BACKGROUND_CPU_WEIGHT}`);
  }
  return params.workerDir
    ? [
        "--user",
        "--quiet",
        "--collect",
        "--same-dir",
        `--unit=${params.unitId}`,
        `--setenv=TC_WORKER_DIR=${params.workerDir}`,
        ...unitProperties,
      ]
    : ["--user", "--pipe", "--quiet", "--same-dir", `--unit=${params.unitId}`, ...unitProperties];
}
