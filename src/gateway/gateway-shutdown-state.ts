/**
 * FORK 2026-09-29 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b) — "is this gateway shutting down?"
 *
 * The close handler disposes the agent harnesses (the cc-bridge among them) BEFORE it unsubscribes
 * from agent events, so every run it cuts emits a lifecycle `end`, and session-lifecycle-state.ts
 * stored that as `status:"done"`. Boot recovery only resumes chats still `running`, so a plain
 * restart dropped every mid-turn chat without a trace (measured 2026-09-29 21:58: a chat cut in the
 * middle of a Bash call read `done`, `abortedLastRun:false`).
 *
 * Set at the very start of the close handler; cleared when the gateway starts again, because an
 * in-process (SIGUSR1) restart keeps this module and its state alive.
 */
let shuttingDownSince: number | null = null;

export function markGatewayShuttingDown(now: number = Date.now()): void {
  if (shuttingDownSince === null) {
    shuttingDownSince = now;
  }
}

export function clearGatewayShutdownState(): void {
  shuttingDownSince = null;
}

export function isGatewayShuttingDown(): boolean {
  return shuttingDownSince !== null;
}
