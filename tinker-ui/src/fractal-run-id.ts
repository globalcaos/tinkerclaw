/**
 * The Fractal turn's run id (2026-10-08). The page sends the reflection with idempotencyKey
 * `fractal-<parent runId>`, and chat.send uses that key AS the run id, so the prefix alone tells a
 * Fractal run from the turn it reflects on. Its own module because the call timeline needs it and
 * fractal-turn.ts needs the timeline: both import from here, neither from the other.
 */
export const FRACTAL_RUN_PREFIX = "fractal-";

/** The run id (= idempotencyKey) of the Fractal turn that reflects on `parentRunId`. */
export function fractalRunIdFor(parentRunId: string): string {
  return `${FRACTAL_RUN_PREFIX}${parentRunId}`;
}

export function isFractalRunId(runId: string | undefined | null): boolean {
  return typeof runId === "string" && runId.startsWith(FRACTAL_RUN_PREFIX);
}

/** The run a Fractal turn reflects on, or null when `runId` is not a Fractal turn. */
export function fractalParentOf(runId: string | undefined | null): string | null {
  return isFractalRunId(runId) ? (runId as string).slice(FRACTAL_RUN_PREFIX.length) : null;
}
