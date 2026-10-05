type Listener = (...args: unknown[]) => void;

type OffCapableEmitter = {
  on: (event: string, listener: Listener) => void;
  off?: (event: string, listener: Listener) => void;
  removeListener?: (event: string, listener: Listener) => void;
};

type ClosableSocket = {
  ws?: {
    /** May return a promise: the whatsmeow adapter's close is asynchronous. */
    close?: () => void | Promise<void>;
  };
};

/**
 * Errors that mean "the transport is already gone". Expected on the shutdown
 * path — the peer process is dying at the same moment we ask it to disconnect —
 * and safe to swallow with a single warn line. Anything else is a real defect
 * and is rethrown.
 *
 * ERR_TIMEOUT / "timed out" is in the list deliberately: whatsmeow-node's
 * GoProcess.send settles only on the Go subprocess's command ack, so a
 * disconnect whose write never landed rejects with TimeoutError after its 30s
 * budget. During shutdown that is a benign non-answer, not a bug.
 */
const BENIGN_CLOSE_ERROR = new RegExp(
  [
    "EPIPE",
    "ECONNRESET",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_WRITE_AFTER_END",
    "ERR_PROCESS_EXITED",
    "ERR_TIMEOUT",
    "process exited",
    "timed out",
    "already closed",
    "not open",
  ].join("|"),
  "i",
);

/**
 * whatsmeow-node's GoProcess.send resolves only when the Go subprocess acks the
 * command; when the write itself failed there is no ack and the promise stays
 * pending for the full 30s command timeout. Shutdown does not need the ack, so
 * bound the wait rather than let a dead subprocess stall SIGTERM for half a
 * minute.
 */
const CLOSE_SETTLE_TIMEOUT_MS = 2_000;

/** Sockets already closed once — makes closeInboundMonitorSocket idempotent. */
const closedSockets = new WeakSet<object>();

function isBenignCloseError(err: unknown): boolean {
  const candidate = err as { code?: unknown; name?: unknown } | null | undefined;
  for (const field of [candidate?.code, candidate?.name]) {
    if (typeof field === "string" && BENIGN_CLOSE_ERROR.test(field)) {
      return true;
    }
  }
  return BENIGN_CLOSE_ERROR.test(err instanceof Error ? err.message : String(err));
}

function formatCloseError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export function attachEmitterListener(
  emitter: OffCapableEmitter,
  event: string,
  listener: Listener,
): () => void {
  emitter.on(event, listener);
  return () => {
    if (typeof emitter.off === "function") {
      emitter.off(event, listener);
      return;
    }
    if (typeof emitter.removeListener === "function") {
      emitter.removeListener(event, listener);
    }
  };
}

/**
 * Close the inbound monitor socket exactly once, without letting a shutdown-time
 * transport error escape.
 *
 * FORK 2026-09-03: every gateway SIGTERM raced the dying whatsmeow Go
 * subprocess and took the gateway down with status=1/FAILURE, which also
 * skipped the remaining plugins' persist steps. Three defences here:
 *   1. a WeakSet guard so a second close is a no-op — the wm backend already
 *      issues two disconnects per stop (auto-reply/monitor-wm.ts awaits
 *      listener.close() and then disconnectWmClient()), and a third write into
 *      an already-dying pipe only widens the window;
 *   2. benign transport errors are logged once and swallowed, anything else is
 *      rethrown, so a real defect still surfaces;
 *   3. the close promise is ALWAYS given a handler BEFORE we race it against a
 *      timeout, so a rejection arriving after we stop waiting can never become
 *      an unhandled rejection.
 *
 * DELIBERATELY NOT SUFFICIENT ALONE for the `write EPIPE` in the journal.
 * Verified 2026-09-03 with a standalone repro: whatsmeow-node writes to the Go
 * child's stdin with no error callback (dist/index.js:84), so node builds the
 * EPIPE synchronously at the write and then raises it on a LATER TICK as an
 * 'error' event on the stdin socket. With no listener that is an uncaught
 * exception — a try/catch around this call and a .catch() on the returned
 * promise were both in place in the repro and neither fired. The cure is an
 * stdin 'error' listener attached where the child is spawned (session-wm.ts).
 */
export async function closeInboundMonitorSocket(
  sock: ClosableSocket,
  onWarn: (message: string) => void = () => {},
): Promise<void> {
  const ws = sock.ws;
  if (!ws || typeof ws.close !== "function") {
    return;
  }
  if (closedSockets.has(ws)) {
    return;
  }
  closedSockets.add(ws);

  let pending: void | Promise<void>;
  try {
    pending = ws.close();
  } catch (err) {
    if (!isBenignCloseError(err)) {
      throw err;
    }
    onWarn(`WhatsApp socket close: ignoring ${formatCloseError(err)}`);
    return;
  }

  if (!pending || typeof (pending as Promise<void>).then !== "function") {
    return;
  }

  // Attach the handlers NOW, not after the race below: a rejection that lands
  // once we have already given up would otherwise be unhandled, which is the
  // exact class of failure this function exists to prevent.
  let settled = false;
  let rejected = false;
  let closeError: unknown;
  const tracked = Promise.resolve(pending).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      rejected = true;
      closeError = error;
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      tracked,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_SETTLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  if (!settled) {
    onWarn(`WhatsApp socket close did not settle within ${CLOSE_SETTLE_TIMEOUT_MS}ms; continuing`);
    return;
  }
  if (rejected) {
    if (!isBenignCloseError(closeError)) {
      throw closeError;
    }
    onWarn(`WhatsApp socket close: ignoring ${formatCloseError(closeError)}`);
  }
}
