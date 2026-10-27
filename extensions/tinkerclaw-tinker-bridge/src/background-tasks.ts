/**
 * FORK 2026-10-25 (the architect, 02:43: "while the job is being processed, there should always be a thinking
 * indicator below") — each chat's live Claude Code background tasks, for the Tinker page.
 *
 * A worker tracks the background tasks its CLI reports (worker.ts noteBackgroundLine: Bash in the
 * background, Workflow, Task, Monitor). They outlive the turn that started them, and the end of one
 * wakes the chat (unprompted-turn.ts), so the task is not over when the turn is. The page polls
 * `ccBridge.backgroundTasks` (a core method, see BRIDGE_BACKGROUND_TASKS_SLOT) for the chat it shows, beside the long-job list, and gets them in the
 * long-job row shape (tinker-ui longjob-rows.ts LongjobJob) with kind "background": a row for each
 * while no turn runs, and the Fractal reflection waits for them (tinker-ui fractal-defer.ts).
 *
 * Read-only: it lists what the pool's workers already hold and changes nothing.
 */
export const BACKGROUND_TASKS_METHOD = "ccBridge.backgroundTasks";

/** A background task a worker's CLI reported live. */
export type LiveBackgroundTask = { id: string; description: string; startedAt: number };

/** One task in the long-job list's shape, so the page draws and counts it with the long jobs. */
export type BackgroundJob = {
  id: string;
  label: string;
  kind: "background";
  session: string;
  status: "running";
  startedAt: number;
};

/** What the list needs of a pooled worker (ClaudeCodeWorker; a test fake). */
export type BackgroundTaskHolder = {
  readonly openclawSessionKey?: string;
  isAlive(): boolean;
  backgroundTasks?(): LiveBackgroundTask[];
};

/** The page's key and a worker's session key can differ by an `agent:main:` style prefix. */
export function sessionKeysMatch(workerSession: string | undefined, asked: string): boolean {
  if (!workerSession || !asked) {
    return false;
  }
  return (
    workerSession === asked ||
    workerSession.endsWith(`:${asked}`) ||
    asked.endsWith(`:${workerSession}`)
  );
}

/** The live background tasks of every worker serving this chat, oldest first. */
export function backgroundJobsFor(
  workers: Iterable<BackgroundTaskHolder>,
  sessionKey: string,
): BackgroundJob[] {
  const jobs: BackgroundJob[] = [];
  for (const w of workers) {
    const session = w.openclawSessionKey;
    if (!session || !sessionKeysMatch(session, sessionKey) || !w.isAlive()) {
      continue;
    }
    for (const t of w.backgroundTasks?.() ?? []) {
      jobs.push({
        id: t.id,
        label: t.description,
        kind: "background",
        session,
        status: "running",
        startedAt: t.startedAt,
      });
    }
  }
  return jobs.toSorted((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

/** The journal line a worker writes whenever its set of live tasks changes. */
export function bgTasksLogLine(session: string, live: number, workerKey: string): string {
  return `[bg-tasks] ${session} live=${live} [${workerKey}]`;
}

/**
 * Must equal `BRIDGE_BACKGROUND_TASKS_SLOT` in src/gateway/server-methods/fractal.ts; a test compares them.
 *
 * 2026-10-25: the list is served by core (`ccBridge.backgroundTasks` in fractal.ts), not by this plugin. This plugin
 * activates on the claude-code provider, after the gateway has built its method table, so a method it registers is
 * never served (live: "unknown method", while `openclaw plugins inspect` listed it). It publishes the lookup on this
 * slot instead, the way the Rewind seam does, and core answers an empty list when no bridge has published it.
 */
export const BRIDGE_BACKGROUND_TASKS_SLOT = "openclaw.bridgeBackgroundTasks";

export type BridgeBackgroundTasksSeam = (sessionKey: string) => BackgroundJob[];

export function publishBackgroundTasksSeam(getPool: () => { all(): BackgroundTaskHolder[] }): void {
  const seam: BridgeBackgroundTasksSeam = (sessionKey) =>
    backgroundJobsFor(getPool().all(), sessionKey);
  (globalThis as Record<symbol, unknown>)[Symbol.for(BRIDGE_BACKGROUND_TASKS_SLOT)] = seam;
}
