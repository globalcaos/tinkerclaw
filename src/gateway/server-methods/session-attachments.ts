/**
 * FORK 2026-08-18 — SESSION ATTACHMENTS: see what a session is still holding, and stop it.
 *
 *   sessions.attachments({sessionKey?, sessionId?})                              READ_SCOPE
 *     Pure read. Returns every live attachment the session owns — in-flight runs,
 *     queued turns and child processes — plus the `now` the ages were computed
 *     against, so a caller can render "running for 4m" without a second clock.
 *
 *   sessions.attachmentStop({sessionKey?, sessionId?, attachmentId, escalate?})   WRITE_SCOPE
 *     Stops ONE named attachment and reports what it took:
 *       "aborted"    — a run / queued turn, aborted through chat.abort
 *       "terminated" — a child process that exited on SIGTERM
 *       "killed"     — a child process that only exited on SIGKILL
 *       "gone"       — it had already finished. That is SUCCESS, not an error.
 *       "refused"    — not stoppable, not permitted, or it survived SIGKILL
 *
 * DESIGN NOTE (the architect, 2026-08-18) — escalation happens ONLY inside an explicit,
 * user-initiated Stop. We deliberately do NOT run an ambient watchdog/timer that reaps
 * long-running processes in the background: the product decision is that background
 * activity is made VISIBLE AND CONTROLLABLE rather than silently timed out. A process
 * therefore only ever receives SIGTERM — and, on escalation, SIGKILL — as the direct
 * consequence of somebody pressing Stop on a row they can see. There is no timer in this
 * file, and adding one would reverse that decision.
 *
 * SAFETY — we never signal a pid taken from params. The pid is re-read from the
 * `listSessionAttachments()` snapshot taken inside THIS call, and only when that snapshot
 * marks the attachment `stoppable`. A caller can name an attachmentId; it can never name a
 * pid. We additionally refuse pid <= 1 (init, and a NEGATIVE pid signals a whole process
 * GROUP) and the gateway's own pid.
 *
 * ABORT IS NOT REIMPLEMENTED HERE — "run"/"queued" attachments are delegated to the
 * existing `chat.abort` handler, which owns partial-transcript persistence, the `aborted`
 * broadcast and the per-requester ownership check. Forking any of that is how two subtly
 * different "stop" behaviours get shipped.
 */

import {
  listSessionAttachments,
  type SessionAttachment,
} from "../../sessions/session-attachments.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

/** Liveness poll cadence while waiting for a signalled process to exit. */
export const STOP_POLL_INTERVAL_MS = 200;
/** How long a process gets to honour SIGTERM before escalation is considered. */
export const SIGTERM_GRACE_MS = 5_000;
/** How long a process gets after SIGKILL before we call it unkillable. */
export const SIGKILL_GRACE_MS = 2_000;

export type AttachmentStopAction = "aborted" | "terminated" | "killed" | "gone" | "refused";

export type AttachmentStopResult = {
  stopped: boolean;
  action: AttachmentStopAction;
  detail?: string;
};

/** Outcome of a single signal delivery. `gone` == ESRCH == it already exited. */
export type SignalOutcome = "sent" | "gone" | "denied";

/**
 * The process-signalling seam. Injectable so the unit tests never touch a real pid.
 *
 * `isAlive` treats EPERM as ALIVE on purpose: `process.kill(pid, 0)` throwing EPERM means
 * the process exists and we merely may not signal it. Collapsing that into "dead" would
 * report a still-running process as `terminated`.
 */
export type AttachmentKiller = {
  send: (pid: number, signal: "SIGTERM" | "SIGKILL") => SignalOutcome;
  isAlive: (pid: number) => boolean;
};

export const defaultAttachmentKiller: AttachmentKiller = {
  send: (pid, signal) => {
    try {
      process.kill(pid, signal);
      return "sent";
    } catch (err) {
      return (err as NodeJS.ErrnoException | undefined)?.code === "ESRCH" ? "gone" : "denied";
    }
  },
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
    }
  },
};

/**
 * Structural mirror of `listSessionAttachments`, narrowed to the fields THIS module passes.
 * Declared locally (rather than `typeof listSessionAttachments`) so a fake is trivial to
 * write in tests while the assignment below still fails the typecheck if the real module's
 * shape drifts. `readProcesses` is deliberately absent: it is the sessions module's own
 * injection seam (a `() => ProcessProbe[]` factory) and production must take its default,
 * the real /proc scan.
 */
export type ListSessionAttachmentsFn = (input: {
  sessionId?: string;
  sessionKey?: string;
  now?: number;
}) => SessionAttachment[];

export type SessionAttachmentsDeps = {
  listAttachments: ListSessionAttachmentsFn;
  killer: AttachmentKiller;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultDeps: SessionAttachmentsDeps = {
  listAttachments: listSessionAttachments,
  killer: defaultAttachmentKiller,
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  now: () => Date.now(),
};

type SessionTarget = { sessionKey?: string; sessionId?: string };

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readTarget(params: Record<string, unknown> | undefined): SessionTarget {
  const p = params ?? {};
  return {
    sessionKey: readText(p.sessionKey),
    sessionId: readText(p.sessionId),
  };
}

/**
 * Bounded liveness poll. Counts ITERATIONS rather than reading a clock so an injected
 * no-op `sleep` cannot spin forever against a frozen `now()` in tests.
 */
async function waitForExit(
  deps: SessionAttachmentsDeps,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  if (!deps.killer.isAlive(pid)) {
    return true;
  }
  const attempts = Math.max(1, Math.ceil(timeoutMs / STOP_POLL_INTERVAL_MS));
  for (let i = 0; i < attempts; i += 1) {
    await deps.sleep(STOP_POLL_INTERVAL_MS);
    if (!deps.killer.isAlive(pid)) {
      return true;
    }
  }
  return false;
}

/**
 * `chat.abort` is keyed by sessionKey. When the caller only gave us a sessionId, recover
 * the sessionKey from the live abort-controller registry — the same map chat.abort itself
 * reads — rather than inventing one.
 */
function resolveSessionKeyForAbort(
  context: GatewayRequestHandlerOptions["context"],
  target: SessionTarget,
): string | undefined {
  if (target.sessionKey) {
    return target.sessionKey;
  }
  if (!target.sessionId) {
    return undefined;
  }
  for (const entry of context.chatAbortControllers.values()) {
    if (entry.sessionId === target.sessionId) {
      return entry.sessionKey;
    }
  }
  return undefined;
}

async function delegateAbort(
  opts: GatewayRequestHandlerOptions,
  target: SessionTarget,
): Promise<AttachmentStopResult> {
  const sessionKey = resolveSessionKeyForAbort(opts.context, target);
  if (!sessionKey) {
    return {
      stopped: false,
      action: "refused",
      detail: "cannot resolve a sessionKey for this run; pass sessionKey explicitly",
    };
  }
  // NOT `chatHandlers["chat.abort"]?.(...)`: an optional call to a missing method is
  // indistinguishable from a working call with nothing to say. Miss it loudly instead.
  const abort = chatHandlers["chat.abort"];
  if (!abort) {
    return {
      stopped: false,
      action: "refused",
      detail: "chat.abort handler is not registered",
    };
  }
  let captured: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await abort({
    ...opts,
    params: { sessionKey },
    respond: (ok, payload, error) => {
      captured = { ok, payload, error };
    },
  });
  if (!captured?.ok) {
    const message = (captured?.error as { message?: string } | undefined)?.message;
    return { stopped: false, action: "refused", detail: message ?? "chat.abort refused the stop" };
  }
  // chat.abort reports aborted:false when nothing matched. Our snapshot said a run was
  // there, so it finished between the list and the abort — that is "gone", not a failure.
  const aborted = (captured.payload as { aborted?: unknown } | undefined)?.aborted;
  if (aborted === false) {
    return { stopped: true, action: "gone", detail: "run finished before the stop landed" };
  }
  return { stopped: true, action: "aborted" };
}

async function stopProcessAttachment(
  deps: SessionAttachmentsDeps,
  attachment: SessionAttachment,
  escalate: boolean,
): Promise<AttachmentStopResult> {
  const pid = attachment.pid;
  // The pid comes from the snapshot above, never from params — and a negative pid would
  // signal an entire process GROUP, so anything <= 1 is refused outright.
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    return { stopped: false, action: "refused", detail: "attachment has no signalable pid" };
  }
  if (pid === process.pid) {
    return {
      stopped: false,
      action: "refused",
      detail: "refusing to signal the gateway process itself",
    };
  }

  const term = deps.killer.send(pid, "SIGTERM");
  if (term === "gone") {
    return { stopped: true, action: "terminated" };
  }
  if (term === "denied") {
    return { stopped: false, action: "refused", detail: `not permitted to signal pid ${pid}` };
  }
  if (await waitForExit(deps, pid, SIGTERM_GRACE_MS)) {
    return { stopped: true, action: "terminated" };
  }
  if (!escalate) {
    return {
      stopped: false,
      action: "refused",
      detail: `pid ${pid} survived SIGTERM and escalate was false`,
    };
  }

  const kill = deps.killer.send(pid, "SIGKILL");
  if (kill === "gone") {
    return { stopped: true, action: "killed" };
  }
  if (kill === "denied") {
    return { stopped: false, action: "refused", detail: `not permitted to SIGKILL pid ${pid}` };
  }
  if (await waitForExit(deps, pid, SIGKILL_GRACE_MS)) {
    return { stopped: true, action: "killed" };
  }
  return { stopped: false, action: "refused", detail: "process survived SIGKILL" };
}

/**
 * Factory so the unit tests can drive the handlers with the process-signalling seam,
 * the clock and the attachment source all injected. Production uses the zero-arg call.
 */
export function createSessionAttachmentsHandlers(
  overrides: Partial<SessionAttachmentsDeps> = {},
): GatewayRequestHandlers {
  const deps: SessionAttachmentsDeps = { ...defaultDeps, ...overrides };

  return {
    "sessions.attachments": async ({ params, respond }) => {
      const target = readTarget(params);
      if (!target.sessionKey && !target.sessionId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "sessions.attachments requires sessionKey or sessionId",
          ),
        );
        return;
      }
      const now = deps.now();
      const attachments = deps.listAttachments({ ...target, now });
      respond(true, { attachments, now }, undefined);
    },

    "sessions.attachmentStop": async (opts) => {
      const { params, respond } = opts;
      const target = readTarget(params);
      const attachmentId = readText(params?.attachmentId);
      if (!target.sessionKey && !target.sessionId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "sessions.attachmentStop requires sessionKey or sessionId",
          ),
        );
        return;
      }
      if (!attachmentId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "sessions.attachmentStop requires attachmentId"),
        );
        return;
      }
      // Default is TO escalate: only an explicit `escalate:false` opts out.
      const escalate = params?.escalate !== false;

      const now = deps.now();
      const attachments = deps.listAttachments({ ...target, now });
      const attachment = attachments.find((candidate) => candidate.id === attachmentId);
      if (!attachment) {
        // Finishing on its own is exactly the outcome Stop was asking for.
        respond(true, { stopped: true, action: "gone" } satisfies AttachmentStopResult, undefined);
        return;
      }
      if (!attachment.stoppable) {
        respond(
          true,
          {
            stopped: false,
            action: "refused",
            detail: `attachment ${attachmentId} is not stoppable`,
          } satisfies AttachmentStopResult,
          undefined,
        );
        return;
      }

      if (attachment.kind === "run" || attachment.kind === "queued") {
        respond(true, await delegateAbort(opts, target), undefined);
        return;
      }
      respond(true, await stopProcessAttachment(deps, attachment, escalate), undefined);
    },
  };
}

export const sessionAttachmentsHandlers: GatewayRequestHandlers =
  createSessionAttachmentsHandlers();
