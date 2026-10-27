// FORK 2026-10-22 (Rewind): what the amygdala's `amygdala2.rewind` needs from the bridge. Rewind writes a truncated copy
// of the claude-cli transcript under a new session id. Pointing `session-map.json` at it is not enough: this process
// reads that file once into a cache and keeps the warm `claude` worker, which holds the whole conversation in memory,
// so the next turn would still see the rewound exchange (and the next map write would put the old id back on disk).
//
// The slot is read by its `Symbol.for` key (extensions cannot import each other); the amygdala falls back to rewriting
// the file when no bridge published it.
import { rebindResumeSessionId } from "./session-map.js";
import { getPool } from "./worker-pool.js";

/** Must equal `BRIDGE_REWIND_SLOT` in extensions/tinkerclaw-amygdala/src/bridge-session-map.ts; a test compares them. */
export const BRIDGE_REWIND_SLOT = "openclaw.bridgeRewind";

export interface BridgeRewindSeam {
  busy(claudeSessionId: string): boolean;
  rebind(from: string, to: string): { ok: boolean; reason?: string };
}

export function createRewindSeam(
  pool: () => ReturnType<typeof getPool> = getPool,
): BridgeRewindSeam {
  return {
    busy: (id) => pool().isBusyOnSession(id),
    rebind: (from, to) => {
      const p = pool();
      if (p.isBusyOnSession(from)) {
        return { ok: false, reason: "a reply is still running in this tab" };
      }
      const moved = rebindResumeSessionId(from, to);
      const retired = p.retireIdleOnSession(from);
      return moved > 0 || retired > 0
        ? { ok: true }
        : { ok: false, reason: "the bridge has no session bound to this tab" };
    },
  };
}

export function publishRewindSeam(): void {
  (globalThis as Record<symbol, unknown>)[Symbol.for(BRIDGE_REWIND_SLOT)] = createRewindSeam();
}
