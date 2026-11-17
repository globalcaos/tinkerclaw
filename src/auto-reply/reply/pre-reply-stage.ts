import { log } from "../../agents/embedded-agent-runner/logger.js";
import { TURN_STAGE_STREAM } from "../../agents/embedded-agent-runner/run/turn-span.js";
import { type AgentEventPayload, onAgentEvent } from "../../infra/agent-events.js";
import { emitEvent } from "../../infra/events/emit.js";

/**
 * FORK 2026-10-15 (bug-log `pre-reply-stall-invisible`): the step a prompt is in between its dispatch and its reply
 * operation. A Pi-migration prompt sat over three minutes inside `getReplyFromConfig`; every stuck-session line read
 * `phase=none`, because no reply operation existed yet, and nothing else was logged, so the gateway restart that
 * followed erased the only evidence. The stuck-session probe (server.impl.ts createGatewayReplyPhaseProbe) reads this
 * when there is no reply operation, so the next stall names its step and how long it has been in it.
 */
const stages = new Map<string, { stage: string; since: number }>();

/**
 * FORK 2026-10-29: how LONG each of those steps took (TINKER_UI_DESIGN_BIBLE/turn-latency.md §9, the holder-C
 * window). The map above names the step a prompt is in and forgets it at the next one. On this install's events
 * (n=663, 2026-09-25 to 2026-10-29) chat.send's ack to the runner's first `sandbox` span ran p50 2.4 s and p90
 * 11.1 s, 27-41% of pre-model time, and no row split it. Every step now ends as one `[turn-span]` journal line
 * and one `turn.span` row, in the runner's own line shape (turn-span.ts), so one parser reads both:
 *   - `pre:ack`        chat.send's ack (notePreReplyAck) to the prompt's first step;
 *   - `pre:<step>`     one get-reply step, closed by the next, and the last one by the reply operation
 *                      (notePreReplyPlaced, called where agent-runner.ts creates it);
 *   - `pre:placement`  the reply operation to the START of its run's first runner span: the first
 *                      `turn-stage` event the runner emits for that run id (`sandbox` today).
 * Each boundary is one clock read that ends one span and starts the next, so the spans tile: ack to first runner
 * span is their sum, with no gap and no overlap.
 *
 * Keyed by the prompt's run id (GetReplyOptions.runId: for chat.send its idempotencyKey, which the runner then
 * uses as its run id) and its session key. A prompt with no run id writes no span: keyed by session alone, two
 * prompts of one session would close each other's steps, and a wrong row is worse than a missing one. Its step
 * still shows in the stuck-session line.
 *
 * clearPreReplyStage closes nothing. It runs after the whole reply, model run included, so a step it closed
 * would carry the model's seconds. A prompt that ends without a reply operation (steered, backlogged, answered
 * by a command) therefore writes no row for its last step, and a run that emits no runner span (a CLI-backend
 * run, a failure before the attempt) writes no `pre:placement`. Each logs one `[pre-reply-span] DROPPED`
 * line instead, so a missing row is never silent (design-principles #12).
 *
 * Unconditional like `[turn-span]` (turn-span.ts says why a threshold would hide the fast case), one line and
 * one row per step. Best-effort: the state moves before the write, so a failed write loses its own row and never
 * shifts the next one, and nothing here throws into the reply path.
 */
type PromptSpans = {
  sessionKey?: string;
  /** `steps`: in `stage` since `since`. `placing`: placed at `since`, no runner span yet. `done`: both closed. */
  phase: "steps" | "placing" | "done";
  stage: string;
  since: number;
};
/** One entry per prompt, by run id, from its ack (or first step) to its reply's end. */
const prompts = new Map<string, PromptSpans>();
let stopWatchingRunnerSpans: (() => void) | undefined;

/**
 * A ceiling against a leak, never a working bound (#19). An entry lives from a prompt's ack to its reply's end,
 * so the map holds the gateway's concurrent prompts, which the run set counts in single digits
 * (infra/agent-events.ts); only an ack whose dispatch never reaches the reply pipeline waits here for eviction.
 * 256 entries cost a few KB, and an eviction loses one prompt's remaining rows and logs it. Same value and reason
 * as turn-span.ts MAX_TRACKED_RUNS: a gateway that holds hundreds of prompts at once would raise both.
 */
const MAX_TRACKED_PROMPTS = 256;

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** Stores at the end (a Map keeps insertion order) and evicts the oldest past the ceiling. */
function remember(id: string, prompt: PromptSpans): void {
  prompts.delete(id);
  prompts.set(id, prompt);
  if (prompts.size <= MAX_TRACKED_PROMPTS) {
    return;
  }
  const oldest = prompts.entries().next().value;
  if (oldest) {
    const [oldestId, stale] = oldest;
    prompts.delete(oldestId);
    if (stale.phase !== "done") {
      logDropped(oldestId, `pre:${stale.stage}`, "evicted");
    }
  }
}

/**
 * One `[turn-span]` line and one `turn.span` row. The row is recordTurnSpan's record, field for field
 * (infra/events/turn-events.ts). That helper is not called because it reads the session from the run context,
 * which the run registers only after placement; pre-reply-stage.spans.test.ts holds this record to the catalog.
 */
function emitPreSpan(
  runId: string,
  sessionKey: string | undefined,
  stage: string,
  ms: number,
): void {
  if (!Number.isFinite(ms) || ms < 0) {
    // The wall clock stepped back between the two reads, so the duration is unknown, and a clamped 0 would be a
    // made-up sample (design-principles #20).
    logDropped(runId, stage, "unknown-duration");
    return;
  }
  const durMs = Math.round(ms);
  log.info(`[turn-span] runId=${runId} stage=${stage} ms=${durMs}`);
  emitEvent("turn.span", { runId, sessionKey, label: stage, durMs });
}

function logDropped(runId: string, stage: string, reason: string): void {
  log.info(`[pre-reply-span] DROPPED runId=${runId} stage=${stage} reason=${reason}`);
}

/** Closes `pre:placement` at the first span the runner emits for a placed prompt's run. */
function closePlacement(evt: AgentEventPayload): void {
  try {
    if (evt.stream !== TURN_STAGE_STREAM) {
      return;
    }
    const prompt = prompts.get(evt.runId);
    const stage = evt.data.stage;
    // A `before:<stage>` gap is the time before a span, and that span's own event follows at once.
    const isGap = typeof stage === "string" && stage.startsWith("before:");
    if (!prompt || prompt.phase !== "placing" || isGap) {
      return;
    }
    prompt.phase = "done";
    // The event fires when the runner span ENDS; the placement ends where that span began.
    const spanMs = evt.data.ms;
    const began = evt.ts - (typeof spanMs === "number" && Number.isFinite(spanMs) ? spanMs : 0);
    emitPreSpan(evt.runId, prompt.sessionKey, "pre:placement", began - prompt.since);
  } catch {
    // Telemetry never fails a run.
  }
}

/** FORK 2026-10-29: chat.send acked this prompt (chat.ts); its first step closes `pre:ack`. */
export function notePreReplyAck(
  promptKey: string | undefined,
  sessionKey: string | undefined,
  at = Date.now(),
): void {
  try {
    const id = trimmed(promptKey);
    if (id) {
      remember(id, { sessionKey: trimmed(sessionKey), phase: "steps", stage: "ack", since: at });
    }
  } catch {
    // Telemetry never fails a send.
  }
}

export function notePreReplyStage(
  sessionKey: string | undefined,
  stage: string,
  now = Date.now(),
  // FORK 2026-10-29: the prompt's run id keys its spans; with none, no span is written.
  runId?: string,
): void {
  const key = sessionKey?.trim();
  if (key) {
    stages.set(key, { stage, since: now });
  }
  try {
    const id = trimmed(runId);
    const previous = id ? prompts.get(id) : undefined;
    // Placed already: a later step call cannot be this prompt's, so it opens nothing.
    if (!id || (previous && previous.phase !== "steps")) {
      return;
    }
    const session = trimmed(sessionKey) ?? previous?.sessionKey;
    remember(id, { sessionKey: session, phase: "steps", stage, since: now });
    if (previous) {
      const ms = now - previous.since;
      emitPreSpan(id, previous.sessionKey ?? session, `pre:${previous.stage}`, ms);
    }
  } catch {
    // Telemetry never fails a reply.
  }
}

/**
 * FORK 2026-10-29: the prompt has its reply operation (agent-runner.ts, at createReplyOperation). Closes its last
 * step and opens `pre:placement`, which its run's first runner span closes. Once per prompt, and only for a
 * prompt whose steps were recorded: with none there is no window to close.
 */
export function notePreReplyPlaced(runId: string | undefined, now = Date.now()): void {
  try {
    const id = trimmed(runId);
    const prompt = id ? prompts.get(id) : undefined;
    if (!id || !prompt || prompt.phase !== "steps") {
      return;
    }
    remember(id, {
      sessionKey: prompt.sessionKey,
      phase: "placing",
      stage: "placement",
      since: now,
    });
    stopWatchingRunnerSpans ??= onAgentEvent(closePlacement);
    emitPreSpan(id, prompt.sessionKey, `pre:${prompt.stage}`, now - prompt.since);
  } catch {
    // Telemetry never fails a reply.
  }
}

export function clearPreReplyStage(
  sessionKey: string | undefined,
  // FORK 2026-10-29: the prompt whose span state ends with its reply. Nothing is closed here (see above).
  runId?: string,
): void {
  const key = sessionKey?.trim();
  if (key) {
    stages.delete(key);
  }
  try {
    const id = trimmed(runId);
    const prompt = id ? prompts.get(id) : undefined;
    if (!id || !prompt) {
      return;
    }
    prompts.delete(id);
    if (prompt.phase === "steps") {
      logDropped(id, `pre:${prompt.stage}`, "no-reply-operation");
    } else if (prompt.phase === "placing") {
      logDropped(id, "pre:placement", "no-runner-span");
    }
  } catch {
    // Telemetry never fails a reply.
  }
}

/** `pre:<step>:<seconds in it>s`, or undefined when the session is not before a reply. */
export function preReplyStageFor(
  sessionKey: string | undefined,
  now = Date.now(),
): string | undefined {
  const key = sessionKey?.trim();
  const entry = key ? stages.get(key) : undefined;
  if (!entry) {
    return undefined;
  }
  return `pre:${entry.stage}:${Math.max(0, Math.round((now - entry.since) / 1000))}s`;
}

/** Test-only: forget every step and prompt, and stop watching runner spans. */
export function resetPreReplyStagesForTest(): void {
  stages.clear();
  prompts.clear();
  stopWatchingRunnerSpans?.();
  stopWatchingRunnerSpans = undefined;
}
