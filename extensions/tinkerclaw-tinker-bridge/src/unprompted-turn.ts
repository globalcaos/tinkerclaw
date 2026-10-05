/**
 * FORK 2026-10-01 (TINKER_UI_DESIGN_BIBLE/bug-log.md [monitor-notify-idle-session-lost]) — a turn
 * the claude CLI starts ON ITS OWN, and the wake that brings it to the chat.
 *
 * When a background task (Bash `run_in_background`, a Workflow, a Task) ends, or a Monitor reports,
 * while no turn is open, the CLI (2.1.286, stream-json in and out) starts a turn by itself: a fresh
 * `init`, the model's answer, its own `result`. Nothing in the bridge listened between turns, so
 * that turn was dropped and a worker waiting on a job could not end its turn and be woken.
 *
 * Now the worker keeps such a turn (worker.ts, unpromptedTurn) and asks the owning chat for a run
 * with `chat.send`, the lane every working wake uses (longjob, wake-on-finish). The message carries
 * `[bg-turn <id>]`; the run that sees it takes the kept turn (worker.takeUnpromptedTurn) and the
 * CLI is sent nothing, because it has already answered. The run is pinned to the worker's own
 * model, so a chat on Auto routing cannot hand the wake to a model outside the bridge.
 */
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const log = createSubsystemLogger("tinkerclaw-tinker-bridge");

/** A background task the CLI said had ended (its `task_notification`). */
export type TaskNotice = { taskId: string; status?: string; description?: string };

export type UnpromptedTurnInfo = {
  id: string;
  /** Tasks whose end the CLI announced just before the turn (a Monitor event announces none). */
  notices: TaskNotice[];
  /** Descriptions of the background tasks still running when the turn started. */
  liveTasks: string[];
};

export type UnpromptedWakeRequest = {
  sessionKey: string;
  message: string;
  model?: string;
  idempotencyKey: string;
};

export type UnpromptedWakeSender = (req: UnpromptedWakeRequest) => Promise<void>;

const MARKER_RE = /\[bg-turn (bgt-[a-z0-9-]+)\]/;

/**
 * The answer of a wake run that found nothing to take: a prompt already joined that turn (its
 * answer is in the turn above), or the worker stopped. Never empty: an empty answer would start
 * the runner's empty-response retry, which writes a prompt to the CLI.
 */
export const UNPROMPTED_TURN_GONE_TEXT =
  "No background answer to add: it is already in the turn above, or the worker that held it stopped.";

export function newUnpromptedTurnId(): string {
  return `bgt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The id of the kept turn a wake run is for, or null for any other prompt. */
export function parseUnpromptedWakeMarker(text: string): string | null {
  return MARKER_RE.exec(text)?.[1] ?? null;
}

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The visible row of the wake: an agent bubble (`⟦AGENT:…⟧`, as wake-on-finish writes them) that
 * says what woke the chat. The answer that follows is the CLI's own turn, replayed.
 */
export function buildUnpromptedWakeMessage(info: UnpromptedTurnInfo): string {
  let what: string;
  if (info.notices.length > 0) {
    what = info.notices
      .map((n) => `“${clip(n.description ?? n.taskId)}” ${n.status ?? "ended"}`)
      .join("; ");
    what = `Background task: ${what}.`;
  } else if (info.liveTasks.length > 0) {
    what = `A background watch reported: ${info.liveTasks.map((d) => `“${clip(d)}”`).join(", ")}.`;
  } else {
    what = "The worker went on by itself after its turn ended.";
  }
  return `⟦AGENT:⏱ Background⟧ ${what} The answer below is the one the worker gave on its own. [bg-turn ${info.id}]`;
}

async function sendThroughGateway(req: UnpromptedWakeRequest): Promise<void> {
  // Loopback call into this same gateway, like prefrontal's embed RPC. Imported on use: the
  // gateway client is heavy and most workers never wake on their own.
  const { callGateway } = await import("openclaw/plugin-sdk/testing");
  await callGateway({
    method: "chat.send",
    params: {
      sessionKey: req.sessionKey,
      message: req.message,
      ...(req.model ? { model: req.model } : {}),
      idempotencyKey: req.idempotencyKey,
    },
    timeoutMs: 30_000,
  });
}

let sender: UnpromptedWakeSender = sendThroughGateway;

/** Tests replace the gateway call; null restores it. */
export function setUnpromptedWakeSender(fn: UnpromptedWakeSender | null): void {
  sender = fn ?? sendThroughGateway;
}

const WAKE_ATTEMPTS = 4;
const WAKE_RETRY_MS = 15_000;

/**
 * Ask the owning chat for the run that takes this turn. A failed call is retried a few times (a
 * busy or restarting gateway); the idempotency key keeps a retry from starting a second run.
 */
export async function requestUnpromptedWake(params: {
  info: UnpromptedTurnInfo;
  openclawSessionKey: string | undefined;
  model: string | undefined;
  workerKey: string;
}): Promise<boolean> {
  const { info, openclawSessionKey, workerKey } = params;
  if (!openclawSessionKey) {
    log.warn(
      `[unprompted-turn] ${info.id} on ${workerKey}: no chat session to wake; the turn stays with the worker`,
    );
    return false;
  }
  const model = params.model
    ? params.model.includes("/")
      ? params.model
      : `claude-code/${params.model}`
    : undefined;
  const req: UnpromptedWakeRequest = {
    sessionKey: openclawSessionKey,
    message: buildUnpromptedWakeMessage(info),
    ...(model ? { model } : {}),
    idempotencyKey: `bg-turn-${info.id}`,
  };
  for (let attempt = 1; attempt <= WAKE_ATTEMPTS; attempt++) {
    try {
      await sender(req);
      log.info(
        `[unprompted-turn] ${info.id} wake sent to ${openclawSessionKey} (attempt ${attempt}, model=${model ?? "session"})`,
      );
      return true;
    } catch (err) {
      log.warn(
        `[unprompted-turn] ${info.id} wake to ${openclawSessionKey} failed (attempt ${attempt}/${WAKE_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt < WAKE_ATTEMPTS) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, WAKE_RETRY_MS);
          t.unref?.();
        });
      }
    }
  }
  return false;
}
