/**
 * The turn rows — TINKER_UI_DESIGN_BIBLE/logging.md §4.6, built in §9 step 8: `turn.span`,
 * `hook.span`, `run.done`, `tool.done`, `exec.done` and `chat.deliver`.
 *
 * ONE module owns the six row shapes, so every producer's call is one line and a shape can only
 * change here, beside the catalog row it must match (catalog.ts). turn-events.test.ts fails when a
 * shape leaves a declared slot empty, fills an undeclared one, or makes the writer drop a key or a
 * value.
 *
 * THE PRODUCERS CALL THESE DIRECTLY — there is no bus bridge for these rows. §4.6 names
 * `run.completed`, `tool.execution.*` and `exec.process.completed` as bus events, but a bridge
 * could not carry them faithfully:
 *  1. `run.completed` and `tool.execution.*` are emitted TRUSTED, and `onDiagnosticEvent` — the
 *     listener §7.5 specifies the bridge on — never delivers a trusted event. A bridge built to
 *     the letter would write zero `run.done` and `tool.done` rows while looking wired
 *     (turn-events.test.ts carries that control).
 *  2. The whole bus is switched off by `diagnostics.enabled: false`
 *     (setDiagnosticsEnabledForProcess), and `tool.execution.*` / `exec.process.completed` ride
 *     its async queue, which drops silently past 10,000 — the record would depend on an unrelated
 *     setting and on load.
 *  3. Every bus listener pays a structuredClone plus a deep freeze of EVERY bus event, the cost
 *     §9 step 4 must measure before more bus types are mapped. A direct emit is one bounded push
 *     (L3).
 * Each producer already holds every fact its row carries, so a bridge would add nothing.
 *
 * PII (L4) by construction: no helper accepts argument text. `exec.done` takes the command's
 * LENGTH and only the closed fields of the outcome (never the captured output or the failure
 * reason); `tool.done` takes the tool name and closed categories, never params, results or a
 * block reason; `chat.deliver` takes the final's text LENGTH, never the text; an error becomes its
 * closed class name (`diagnosticErrorCategory`), never its message. Session keys are hashed by the
 * writer (§7.5).
 *
 * L8 — run_id carries THE agent run id or nothing. `exec.done` and `chat.deliver` producers hold
 * only ids from other id spaces, so those rows leave it empty and join by session_hash and time.
 *
 * Best-effort, like the journal lines beside them: telemetry must never be able to fail a turn.
 */
import { getAgentRunContext } from "../agent-events.js";
import { diagnosticErrorCategory } from "../diagnostic-error-metadata.js";
import { emitEvent } from "./emit.js";

/** The §4.6 rows this module owns. */
export const TURN_EVENT_NAMES = [
  "turn.span",
  "hook.span",
  "run.done",
  "tool.done",
  "exec.done",
  "chat.deliver",
] as const;

function bestEffort(write: () => void): void {
  try {
    write();
  } catch {
    // emitEvent never throws; this guards the argument plumbing around it. A lost row is
    // cheaper than a failed turn.
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `turn.span` — one row per `[turn-span]` journal line
 * (src/agents/embedded-agent-runner/run/turn-span.ts). A positive `gapBeforeMs` — the unnamed
 * interval since the previous span of the same run finished (turn-latency.md §7.8's tiling) — is
 * its own row labelled `before:<stage>`, exactly as the UI's turn-stage stream draws it, so the
 * database keeps "every millisecond is a named stage or a named gap".
 *
 * Unlike the UI stream (`emitStage`), a span whose run has no registered session is still
 * written: the stream drops it because it cannot pick a tab to paint, while a row only needs its
 * run_id, and leaves session_hash empty.
 */
export function recordTurnSpan(
  runId: string | undefined,
  stage: string,
  ms: number,
  gapBeforeMs?: number,
): void {
  bestEffort(() => {
    const sessionKey = runId ? getAgentRunContext(runId)?.sessionKey : undefined;
    if (gapBeforeMs !== undefined && gapBeforeMs > 0) {
      emitEvent("turn.span", { runId, sessionKey, label: `before:${stage}`, durMs: gapBeforeMs });
    }
    emitEvent("turn.span", { runId, sessionKey, label: stage, durMs: ms });
  });
}

/**
 * `hook.span` — one row per narrated hook handler, beside the `[hook-span]` journal line
 * (src/plugins/turn-phase-emit.ts, which applies the narration allow-list first). `ctx` is the
 * hook context; its runId and sessionKey key the row (L8).
 */
export function recordHookSpan(
  hookName: string,
  pluginId: string,
  ms: number,
  ctx?: unknown,
): void {
  bestEffort(() => {
    const c = ctx as { runId?: unknown; sessionKey?: unknown } | null | undefined;
    emitEvent("hook.span", {
      runId: nonEmptyString(c?.runId),
      sessionKey: nonEmptyString(c?.sessionKey),
      label: `${hookName}:${pluginId}`,
      durMs: ms,
    });
  });
}

export type RunDoneOutcome = "completed" | "aborted" | "error";

/** The run facts attempt.ts already holds in `diagnosticRunBase`. */
export interface RunDoneFacts {
  readonly runId: string;
  readonly sessionKey?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly trigger?: string;
  readonly channel?: string;
}

/**
 * `run.done` — from the closure in attempt.ts that emits the trusted `run.completed` (a tier-1
 * file: its whole change is one import and this one call), so it is one row per ATTEMPT: an
 * overflow-compaction or failover retry writes a second row under the same run_id. `err` becomes
 * its closed class name, never its message; it is only read when truthy, because attempt.ts passes
 * `promptError`, which starts as `null`, on healthy completions too.
 *
 * Known gap, inherited from the bus: the closure is assigned after skill resolution, so a run that
 * throws before it writes `turn.span` rows and no `run.done`.
 */
export function recordRunDone(
  run: RunDoneFacts,
  startedAtMs: number,
  outcome: RunDoneOutcome,
  err?: unknown,
): void {
  bestEffort(() => {
    emitEvent("run.done", {
      runId: run.runId,
      sessionKey: run.sessionKey,
      label: outcome,
      durMs: Date.now() - startedAtMs,
      fields: {
        provider: run.provider,
        model: run.model,
        trigger: run.trigger,
        channel: run.channel,
        error_category: err ? diagnosticErrorCategory(err) : undefined,
      },
    });
  });
}

/** The ids a tool call's hook context carries (pi-tools.before-tool-call.ts `HookContext`). */
export interface TurnRunKeys {
  readonly runId?: string;
  readonly sessionKey?: string;
}

/**
 * `tool.done` for a tool that RAN — beside the trusted `tool.execution.completed` / `.error`
 * emits in the before-tool-call wrapper (src/agents/pi-tools.before-tool-call.ts). The outcome
 * mirrors the bus: a tool that RETURNS an error result is `ok`, only a throw is `error`. `durMs`
 * is the execution the wrapper times; a human approval granted before it is not included.
 */
export function recordToolDone(
  ctx: TurnRunKeys | undefined,
  toolName: string,
  outcome: "ok" | "error",
  durMs: number,
  err?: unknown,
): void {
  bestEffort(() => {
    emitEvent("tool.done", {
      runId: ctx?.runId,
      sessionKey: ctx?.sessionKey,
      label: toolName,
      durMs,
      fields: {
        outcome,
        error_category: outcome === "error" ? diagnosticErrorCategory(err) : undefined,
      },
    });
  });
}

/** The closed parts of a before-tool-call block; its free-text `reason` is never read. */
export interface ToolBlock {
  readonly kind?: string;
  readonly deniedReason?: string;
}

/**
 * `tool.done` for a tool that was BLOCKED and never ran — a veto (trusted policy, plugin hook) or a
 * fail-closed block (a failed hook, a denied, timed-out or cancelled approval, the critical
 * tool-loop breaker), the last kind throwing before any bus event exists. `error_category` is the
 * closed cause `<veto|failure>:<deniedReason>`, so a plugin that starts failing every call closed
 * is told apart from users declining approvals. `durMs` is the decision the call waited on, from
 * `decisionStartedAtMs` — hooks, policies and any human approval wait.
 */
export function recordToolBlocked(
  ctx: TurnRunKeys | undefined,
  toolName: string,
  block: ToolBlock,
  decisionStartedAtMs: number,
): void {
  bestEffort(() => {
    const kind = block.kind === "veto" ? "veto" : "failure";
    emitEvent("tool.done", {
      runId: ctx?.runId,
      sessionKey: ctx?.sessionKey,
      label: toolName,
      durMs: Date.now() - decisionStartedAtMs,
      fields: {
        outcome: "blocked",
        error_category: `${kind}:${block.deniedReason ?? "plugin-before-tool-call"}`,
      },
    });
  });
}

/** The closed fields of an exec outcome (bash-tools.exec-runtime.ts `ExecProcessOutcome`). */
export interface ExecDoneOutcome {
  readonly status: "completed" | "failed";
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly failureKind?: string;
}

/**
 * `exec.done` — one row per shell execution, beside `exec.process.completed`
 * (src/agents/bash-tools.exec-runtime.ts). Takes the command's LENGTH, never the command, and
 * reads only the outcome's closed fields: the captured output and the failure reason it also
 * carries are never touched, and neither is the exit signal (the row has no slot for it; a
 * signal death is labelled `signal`). A non-zero exit is still `completed`, with its code in n1.
 * No run_id: the exec runtime holds only its process-session id, a different id space.
 */
export function recordExecDone(
  outcome: ExecDoneOutcome,
  commandLength: number,
  target: "host" | "sandbox",
  mode: "child" | "pty",
  sessionKey?: string,
): void {
  bestEffort(() => {
    emitEvent("exec.done", {
      sessionKey: sessionKey?.trim() || undefined,
      label: outcome.status === "completed" ? "completed" : outcome.failureKind,
      durMs: outcome.durationMs,
      n1: outcome.exitCode,
      n2: commandLength,
      fields: { target, mode, timed_out: outcome.timedOut },
    });
  });
}

/** The broadcaster's per-final counters (gateway/server-broadcast-types.ts). */
export interface ChatDeliverCounts {
  readonly attempted: number;
  readonly sent: number;
  readonly scopeSkipped: number;
  readonly droppedSlow: number;
  readonly sendThrew: number;
}

/**
 * `chat.deliver` — one row per chat FINAL the gateway broadcaster fans out, beside the
 * `[chat-deliver]` journal line (src/gateway/server-broadcast.ts). A final that reached zero
 * sockets is a row of zeros, never a missing row: that is the incident the line exists to catch.
 * Carries the final's text LENGTH, never the text. No run_id: the final carries the CLIENT run
 * id, which server-chat.ts remaps away from the agent run id for a chat-linked run
 * (`chatLink?.clientRunId ?? evt.runId`), so writing it would plant a second id space in run_id.
 */
export function recordChatDeliver(
  sessionKey: unknown,
  counts: ChatDeliverCounts,
  textLen: number,
): void {
  bestEffort(() => {
    emitEvent("chat.deliver", {
      sessionKey: nonEmptyString(sessionKey),
      n1: counts.attempted,
      n2: counts.sent,
      n3: counts.droppedSlow,
      n4: counts.sendThrew,
      fields: { scope_skipped: counts.scopeSkipped, text_len: textLen },
    });
  });
}
