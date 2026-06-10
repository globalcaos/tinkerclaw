/**
 * In-flight steer hook (FORK — P4).
 *
 * Lets a provider that owns a long-lived subprocess (today: cc-bridge's
 * persistent `claude` worker) inject a mid-answer message INTO the live turn,
 * so it folds into the current answer — the way Claude Code drains its own
 * message queue between tool rounds. Without this, a steered message waits for
 * the entire current turn to finish and then runs as a separate next turn.
 *
 * Wiring: the cc-bridge plugin registers a hook that writes the text to the live
 * claude-cli stdin (`worker.steer`). The steer dispatch (runs.ts `flushSteerBuffer`)
 * calls `tryInflightSteer` FIRST and only falls back to the pi-agent-core
 * steeringQueue (next-round delivery) when it returns false — i.e. when there is
 * no live provider worker for that session (non-cc-bridge providers, or between
 * turns). The two delivery paths stay mutually exclusive (no double-send).
 *
 * The hook is stored on `globalThis[Symbol.for(...)]` — NOT a module-level var —
 * because the registrar (cc-bridge) and the caller (core runs.ts) may live in
 * SEPARATE runtime bundles; a plain module variable would not be shared between
 * them. This is the cross-chunk pattern global-singleton.ts explicitly prescribes
 * for live mutable state. Default: no hook → returns false → behavior unchanged.
 */
export type InflightSteerHook = (sessionId: string, text: string) => boolean;

const STORE_KEY = Symbol.for("tinkerclaw.embedded.inflightSteerHook");

interface SteerHookStore {
  hook: InflightSteerHook | null;
}

function store(): SteerHookStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  let s = g[STORE_KEY] as SteerHookStore | undefined;
  if (!s) {
    s = { hook: null };
    g[STORE_KEY] = s;
  }
  return s;
}

export function registerInflightSteerHook(fn: InflightSteerHook | null): void {
  store().hook = fn;
}

/**
 * Try to fold `text` into the live turn for `sessionId`. Returns true only if a
 * registered provider hook accepted it (a live worker exists and the write
 * succeeded). A throwing hook is contained and treated as "not handled" so the
 * steer dispatch can always fall back to the queue.
 */
export function tryInflightSteer(sessionId: string, text: string): boolean {
  const fn = store().hook;
  if (!fn) {
    return false;
  }
  try {
    return fn(sessionId, text) === true;
  } catch {
    return false;
  }
}
