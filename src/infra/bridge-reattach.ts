/**
 * FORK 2026-09-30 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b) — cc-bridge turns a restart froze and
 * this boot can pick up again.
 *
 * The tinker-bridge extension adopts, at boot, the claude workers the last gateway froze mid-turn
 * (their stdio are files, so they outlive the gateway). It lists them here by canonical session key,
 * and core reads the list: boot recovery answers "continue" instead of "send a resume prompt", and
 * the runner lets a claude-code run continue from its transcript, where the bridge replays the
 * worker's output from the turn start and thaws it.
 *
 * A global key, like restart-drain.ts, because a bundled extension may not import core modules.
 * The contract, for the extension:
 *   globalThis[Symbol.for("openclaw.bridgeReattach")] = { pending: Map<sessionKey, BridgeReattachEntry>, scan?: () => Promise<unknown> }
 * `scan` runs the adoption at most once and returns the same promise on every call. Core calls it
 * rather than wait for a hook: measured 2026-09-30, `gateway_start` (after the channel sidecars)
 * came more than two minutes after boot recovery had already fallen back to a prompt.
 */
export type BridgeReattachEntry = {
  /** The worker's systemd unit (`tinkerclaw-worker-…`). */
  unit: string;
  /** "pending" until a run takes the turn; recovery leaves a claimed one alone. */
  state: "pending" | "claimed";
};

type ReattachState = {
  pending: Map<string, BridgeReattachEntry>;
  scan?: () => Promise<unknown>;
};

const KEY = Symbol.for("openclaw.bridgeReattach");

function state(): ReattachState {
  const g = globalThis as Record<symbol, ReattachState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { pending: new Map() };
    g[KEY] = s;
  }
  return s;
}

/** The entry for this session, if the bridge adopted a frozen turn for it. */
export function bridgeReattachFor(sessionKey: string | undefined): BridgeReattachEntry | undefined {
  return sessionKey ? state().pending.get(sessionKey) : undefined;
}

/**
 * Run the bridge's adoption scan (once per process; later calls share it) and wait for it, never
 * longer than `timeoutMs`: a scan that hangs costs a prompt, not the recovery.
 */
export async function awaitBridgeReattachScan(timeoutMs: number): Promise<void> {
  const scan = state().scan;
  if (!scan) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.resolve()
      .then(scan)
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}

export const __testing = {
  set(sessionKey: string, entry: BridgeReattachEntry): void {
    state().pending.set(sessionKey, entry);
  },
  setScan(scan: (() => Promise<unknown>) | undefined): void {
    state().scan = scan;
  },
  reset(): void {
    state().pending.clear();
    state().scan = undefined;
  },
};
