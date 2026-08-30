/**
 * FORK (P4) — bridge the core steer dispatch to the LIVE claude-cli worker.
 *
 * A mid-answer message for a tinker-bridge session should fold into the in-flight
 * turn (claude-cli drains additional stdin user messages between its tool rounds
 * — verified). To do that, we track which worker is running each session's
 * CURRENT turn, and register a hook the core steer dispatch (runs.ts
 * flushSteerBuffer → tryInflightSteer) calls: it writes the text to that worker's
 * live stdin via worker.steer(). If no live worker is registered for the session
 * (non-tinker-bridge provider, or between turns), the hook returns false and the
 * dispatch falls back to the pi-agent-core steeringQueue (next-round delivery).
 *
 * The coupling to core is real — tinker-bridge IS the provider the steer targets —
 * and it is kept to a single narrow typed hook. It crosses through a DECLARED
 * plugin-sdk subpath, not a relative reach into `src/`: this extension is
 * `publishToClawHub: true`, so under FOUNDATION #9 its tarball must be able to
 * resolve every import it makes, and `../../../src/**` cannot resolve on a user's
 * disk. See `src/plugin-sdk/fork-inflight-steer.ts` for why a BIDIRECTIONAL
 * core <-> plugin seam still has to be DECLARED rather than hidden.
 */
import { registerInflightSteerHook } from "openclaw/plugin-sdk/fork-inflight-steer";
import type { ClaudeCodeWorker } from "./worker.js";

// openclawSessionId -> the worker running its CURRENT turn (live only during
// worker.send). Module-level is fine: the tinker-bridge worker pool + this map live
// in the same extension bundle/process.
const liveWorkers = new Map<string, ClaudeCodeWorker>();

/** Mark `worker` as the live turn for `sessionId` (call right before worker.send). */
export function registerInflightWorker(sessionId: string, worker: ClaudeCodeWorker): void {
  liveWorkers.set(sessionId, worker);
}

/** Clear the live-turn worker for `sessionId` (call right after worker.send settles). */
export function unregisterInflightWorker(sessionId: string, worker: ClaudeCodeWorker): void {
  // Only clear if it is still THIS worker — a newer turn may have re-registered.
  if (liveWorkers.get(sessionId) === worker) {
    liveWorkers.delete(sessionId);
  }
}

// Install the steer hook ONCE when this module loads (it loads when stream.ts,
// which imports it, is loaded — i.e. when the tinker-bridge provider is active).
registerInflightSteerHook((sessionId, text) => {
  const worker = liveWorkers.get(sessionId);
  if (!worker) {
    return false; // no live tinker-bridge turn → caller falls back to pi steer
  }
  return worker.steer(text);
});
