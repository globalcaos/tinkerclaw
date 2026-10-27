/**
 * FORK 2026-10-09 — a background Fractal run starts as a COPY of the conversation it reflects on.
 *
 * The owner: "We need a fractal turn that works on the background without making me wait for its
 * response." Since 2026-10-08 the Tinker page sent the Fractal turn into the SAME session as the
 * prompt it reflects on, so the chat stayed busy for the whole reflection and his next prompt waited
 * behind it. The page now sends it into a session of its own (`agent:<id>:fractal:<P>`), which runs
 * beside the chat instead of after it.
 *
 * A fresh session would reflect blind: a new claude worker receives only the latest message
 * (stream.ts extractUserText), never the transcript. So the run's id carries its parent: chat.send
 * uses the idempotencyKey as the run id, and the page sends the Fractal turn as `fractal-<P>`, where
 * P is the run of the prompt it reflects on. When such a run lands on a session with no conversation
 * of its own, its worker starts as `claude --resume <P's CLI session> --fork-session`: every tool
 * call and result of turn P is in its context, and the chat's own CLI session is never written to.
 *
 * The index is in memory and bounded. A gateway restart between P's end and the Fractal's start
 * (the page waits 1.5 s) loses it; the run then starts fresh and its prompt names the parent chat, so
 * the model can still read it with sessions_history.
 */

export const FRACTAL_RUN_PREFIX = "fractal-";

/** Runs remembered. One Tinker owner sends a few hundred prompts a day at most. */
export const RUN_INDEX_CAP = 512;

const workerKeyByRun = new Map<string, string>();

/** Record that run `runId` was served by the pool worker `workerKey`. */
export function noteRunWorker(runId: string | undefined, workerKey: string): void {
  if (!runId || !workerKey) {
    return;
  }
  workerKeyByRun.delete(runId);
  workerKeyByRun.set(runId, workerKey);
  if (workerKeyByRun.size > RUN_INDEX_CAP) {
    const oldest = workerKeyByRun.keys().next().value;
    if (oldest !== undefined) {
      workerKeyByRun.delete(oldest);
    }
  }
}

/** The run a Fractal run reflects on (`fractal-<P>` → P), or null for any other run. */
export function forkParentRunId(runId: string | undefined): string | null {
  if (!runId || !runId.startsWith(FRACTAL_RUN_PREFIX)) {
    return null;
  }
  const parent = runId.slice(FRACTAL_RUN_PREFIX.length);
  return parent ? parent : null;
}

export type ForkSource = { parentRunId: string; parentWorkerKey: string; resumeSessionId: string };

/**
 * The CLI session a new worker for `runId` should fork from, or null when it should start as usual.
 *
 * Null unless the run is a Fractal run AND its session has no conversation of its own: a Fractal
 * turn sent into the chat's own session (a page still on the 2026-10-08 bundle) keeps resuming
 * that session, exactly as before.
 */
export function forkSourceFor(params: {
  runId: string | undefined;
  hasOwnConversation: boolean;
  claudeSessionOf: (workerKey: string) => string | undefined;
}): ForkSource | null {
  const parentRunId = forkParentRunId(params.runId);
  if (!parentRunId || params.hasOwnConversation) {
    return null;
  }
  const parentWorkerKey = workerKeyByRun.get(parentRunId);
  if (!parentWorkerKey) {
    return null;
  }
  const resumeSessionId = params.claudeSessionOf(parentWorkerKey);
  return resumeSessionId ? { parentRunId, parentWorkerKey, resumeSessionId } : null;
}

/** Test seam: forget every run. */
export function clearRunWorkerIndex(): void {
  workerKeyByRun.clear();
}
