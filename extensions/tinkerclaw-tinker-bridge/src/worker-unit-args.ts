// FORK 2026-10-19: the fixed systemd-run flags every cc-bridge worker unit starts with.
//
// worker.ts runs each `claude` worker as a transient systemd user service. This builds the fixed
// head of that systemd-run command line for both transports; worker.ts appends the
// `--setenv=K=V` list, the file transport's shell and the claude command after it. Kept apart
// and pure so a test can pin the exact flags without spawning anything.

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

/**
 * The fixed systemd-run flags for one worker unit.
 *
 * FILE transport (`workerDir` set): the unit owns its stdio (a FIFO and two files in the worker
 * dir, see worker-transport.ts), and `TC_WORKER_DIR` tells the unit's shell where they are.
 * PIPE transport (`workerDir` null): `--pipe` forwards the unit's stdio to the caller.
 * Both end with `--property=OOMScoreAdjust=<WORKER_OOM_SCORE_ADJUST>`.
 */
export function workerUnitBaseArgs(params: { unitId: string; workerDir: string | null }): string[] {
  const oomScoreAdjust = `--property=OOMScoreAdjust=${WORKER_OOM_SCORE_ADJUST}`;
  return params.workerDir
    ? [
        "--user",
        "--quiet",
        "--collect",
        "--same-dir",
        `--unit=${params.unitId}`,
        `--setenv=TC_WORKER_DIR=${params.workerDir}`,
        oomScoreAdjust,
      ]
    : ["--user", "--pipe", "--quiet", "--same-dir", `--unit=${params.unitId}`, oomScoreAdjust];
}
