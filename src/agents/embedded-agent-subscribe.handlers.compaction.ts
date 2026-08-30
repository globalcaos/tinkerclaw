import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { logCompactionDecision } from "./compaction-diagnostics.js";
import type { EmbeddedPiSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { makeZeroUsageSnapshot } from "./usage.js";

export function handleCompactionStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.compactionInFlight = true;
  ctx.state.livenessState = "paused";
  ctx.ensureCompactionPromise();
  ctx.log.debug(`embedded run compaction start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "start" },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "start" },
  });

  // Run before_compaction plugin hook (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_compaction")) {
    void hookRunner
      .runBeforeCompaction(
        {
          messageCount: ctx.params.session.messages?.length ?? 0,
          messages: ctx.params.session.messages,
          sessionFile: ctx.params.session.sessionFile,
        },
        {
          sessionKey: ctx.params.sessionKey,
        },
      )
      .catch((err) => {
        ctx.log.warn(`before_compaction hook failed: ${String(err)}`);
      });
  }
}

/**
 * FORK 2026-08-29 — pull pi's reported context size either side of a compaction off the result
 * blob. Both are optional and independently so: pi reports what it knows, and a missing number
 * must stay missing rather than become a fabricated 0.
 */
function readCompactionTokens(evt: { result?: unknown }): {
  tokensBefore?: number;
  tokensAfter?: number;
} {
  const result =
    typeof evt.result === "object" && evt.result
      ? (evt.result as { tokensBefore?: unknown; tokensAfter?: unknown })
      : undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const before = num(result?.tokensBefore);
  const after = num(result?.tokensAfter);
  return {
    ...(before === undefined ? {} : { tokensBefore: before }),
    ...(after === undefined ? {} : { tokensAfter: after }),
  };
}

export function handleCompactionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & {
    willRetry?: unknown;
    result?: unknown;
    aborted?: unknown;
    /** FORK 2026-07-27: pi's own compaction reason — "overflow" | "threshold". */
    reason?: unknown;
    /** FORK 2026-07-28: set by pi when overflow recovery gives up. */
    errorMessage?: unknown;
  },
) {
  ctx.state.compactionInFlight = false;
  const willRetry = Boolean(evt.willRetry);
  // Increment counter whenever compaction actually produced a result,
  // regardless of willRetry.  Overflow-triggered compaction sets willRetry=true
  // (the framework retries the LLM request), but the compaction itself succeeded
  // and context was trimmed — the counter must reflect that.  (#38905)
  const hasResult = evt.result != null;
  const wasAborted = Boolean(evt.aborted);

  // FORK 2026-07-27 (the architect: "instrument the compaction predicate") — gate "pi-auto".
  //
  // This is the FOURTH compaction decider and the only one that actually fires on this path:
  // pi's own AgentSession._checkCompaction. It stays live because applyPiAutoCompactionGuard
  // (src/agents/pi-settings.ts) disables pi auto-compaction only when the context engine sets
  // ownsCompaction:true, and LegacyContextEngine does not. Our three instrumented gates are
  // honest and simply never fire — which is why no `[compaction-diag] fires=true` line ever
  // appeared in the journal.
  //
  // Take the numbers from `compaction_end` ONLY. At `compaction_start` pi has already popped
  // the triggering assistant message off agent.state.messages, and
  // clearStaleAssistantUsageOnSessionMessages (below) zeroes assistant usage in place — a
  // reconstruction there would print tokens=0 and read as REFUTING the hypothesis.
  //
  // willRetry is the load-bearing field for the 540s hangs. pi emits willRetry:true for
  // reason="overflow" and then schedules Agent.continue(). Its pre-retry cleanup strips the
  // trailing assistant message only when stopReason === "error"
  // (agent-session.js:1562-1567), but the message behind a FALSE overflow has
  // stopReason:"stop", so it survives; Agent.continue() then throws
  // `Cannot continue from message role: assistant` (pi-agent-core/agent.js:242) into a
  // swallowing `.catch(() => {})`. Nothing ever resolves pendingCompactionRetry, and the
  // runner extends the wait 180s at a time up to the 540s hard cap (attempt.ts). So a
  // `[compaction-diag] gate=pi-auto ... willRetry=true` line at a low fill% IS that hang,
  // captured at its origin.
  logPiAutoCompactionDecision(ctx, evt, { willRetry, wasAborted });

  if (hasResult && !wasAborted) {
    ctx.incrementCompactionCount();
    const tokensAfter =
      typeof evt.result === "object" && evt.result
        ? (evt.result as { tokensAfter?: unknown }).tokensAfter
        : undefined;
    // FORK 2026-04-28 chunk-21: noteCompactionTokensAfter dropped upstream;
    // telemetry path collapsed to compaction-retry signaling only.
    void tokensAfter;
    const observedCompactionCount = ctx.getCompactionCount();
    void reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey: ctx.params.sessionKey,
      agentId: ctx.params.agentId,
      configStore: ctx.params.config?.session?.store,
      observedCompactionCount,
    }).catch((err) => {
      ctx.log.warn(`late compaction count reconcile failed: ${String(err)}`);
    });
  }
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    if (!wasAborted) {
      ctx.state.livenessState = "working";
    }
    ctx.maybeResolveCompactionWait();
    clearStaleAssistantUsageOnSessionMessages(ctx);
  }
  // FORK 2026-08-29 (the architect: the CONTEXT WINDOW panel's "tokens saved by eviction"). pi hands us
  // the before/after context size on every successful compaction and BOTH numbers were being
  // dropped on the floor — tokensAfter was literally read and discarded with `void` above, and
  // the end event carried only three booleans. The saving is the one number that makes a
  // compaction legible as a WIN rather than as an unexplained pause, and it cannot be derived
  // client-side: the UI never sees the pre-compaction transcript.
  //
  // Reported as parts, never as a delta, so the consumer can check the subtraction — the same
  // rule cache-telemetry.ts follows for the cache hit rate ("parts only, never a ratio").
  // Omitted entirely when pi did not report them; an absent field is honest, a 0 is a lie.
  const compactionTokens = readCompactionTokens(evt);
  const endData = {
    phase: "end",
    willRetry,
    completed: hasResult && !wasAborted,
    ...compactionTokens,
  };
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: endData,
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: endData,
  });

  // Run after_compaction plugin hook (fire-and-forget)
  if (!willRetry) {
    const hookRunnerEnd = getGlobalHookRunner();
    if (hookRunnerEnd?.hasHooks("after_compaction")) {
      void hookRunnerEnd
        .runAfterCompaction(
          {
            messageCount: ctx.params.session.messages?.length ?? 0,
            compactedCount: ctx.getCompactionCount(),
            sessionFile: ctx.params.session.sessionFile,
          },
          { sessionKey: ctx.params.sessionKey },
        )
        .catch((err) => {
          ctx.log.warn(`after_compaction hook failed: ${String(err)}`);
        });
    }
  }
}

export async function reconcileSessionStoreCompactionCountAfterSuccess(params: {
  sessionKey?: string;
  agentId?: string;
  configStore?: string;
  observedCompactionCount: number;
  now?: number;
}): Promise<number | undefined> {
  const { reconcileSessionStoreCompactionCountAfterSuccess: reconcile } =
    await import("./embedded-agent-subscribe.handlers.compaction.runtime.js");
  return reconcile(params);
}

/**
 * FORK 2026-07-27: emit the one diagnostic line for pi's own compaction decision.
 *
 * Reads everything defensively off the loosely-typed event — this runs on the serving path
 * and must NEVER throw into the handler. `logCompactionDecision` already swallows, but the
 * property access has to be safe on its own.
 *
 * `threshold` mirrors pi's predicate `contextTokens > contextWindow - reserveTokens`
 * (pi-coding-agent compaction.ts `shouldCompact`). Both inputs are read off the live
 * AgentSession (`session.model.contextWindow`, `session.settingsManager.getCompactionSettings()`),
 * so there is no new plumbing; when either is unreachable the line degrades to threshold=0 /
 * window=unknown rather than lying.
 */
function logPiAutoCompactionDecision(
  ctx: EmbeddedPiSubscribeContext,
  evt: { reason?: unknown; result?: unknown },
  flags: { willRetry: boolean; wasAborted: boolean },
): void {
  const reason = typeof evt.reason === "string" && evt.reason ? evt.reason : "unknown";
  const result =
    typeof evt.result === "object" && evt.result
      ? (evt.result as { tokensBefore?: unknown })
      : undefined;
  const rawTokensBefore = result?.tokensBefore;
  const tokens =
    typeof rawTokensBefore === "number" && Number.isFinite(rawTokensBefore) ? rawTokensBefore : 0;

  let contextWindow: number | undefined;
  let threshold = 0;
  let model = ctx.params.modelId;
  try {
    const session = ctx.params.session as unknown as
      | {
          model?: { id?: unknown; contextWindow?: unknown };
          settingsManager?: { getCompactionSettings?: () => unknown };
        }
      | undefined;
    const piModel = session?.model;
    const rawWindow = piModel?.contextWindow;
    if (typeof rawWindow === "number" && rawWindow > 0) {
      contextWindow = rawWindow;
    }
    const settings = session?.settingsManager?.getCompactionSettings?.();
    const rawReserve =
      typeof settings === "object" && settings
        ? (settings as { reserveTokens?: unknown }).reserveTokens
        : undefined;
    if (contextWindow !== undefined && typeof rawReserve === "number" && rawReserve >= 0) {
      threshold = contextWindow - rawReserve;
    }
    if (!model && typeof piModel?.id === "string") {
      model = piModel.id;
    }
  } catch {
    /* pi internals are best-effort; reason + tokensBefore are the payload that matters */
  }

  // FORK 2026-07-28 — `result` absent does NOT mean "compacted at 0 tokens".
  // pi's _runAutoCompaction has THREE early returns that emit
  // {result: undefined, aborted: false, willRetry: false} without compacting anything:
  // no model, getApiKeyAndHeaders() failure, and prepareCompaction() returning null
  // ("nothing to compact"). Observed live 2026-07-28 04:37 on a subagent holding 2 local
  // messages: pi declared reason=overflow (the turn-aggregate false positive), entered
  // compaction, found nothing to prepare, and bailed. Reporting that as
  // `fires=true tokens=0 fill=0.0%` reads as a compaction that ran on an empty context —
  // the opposite of what happened. Report whether a result actually came back, so a
  // no-op bail is never mistaken for a real compaction.
  const producedResult = evt.result != null;
  const errorMessage =
    typeof (evt as { errorMessage?: unknown }).errorMessage === "string"
      ? (evt as { errorMessage: string }).errorMessage
      : undefined;

  logCompactionDecision({
    gate: "pi-auto",
    tokens,
    threshold,
    contextWindow,
    source:
      `pi compaction_end reason=${reason} willRetry=${flags.willRetry} ` +
      `aborted=${flags.wasAborted} result=${producedResult ? "ok" : "none"}` +
      (errorMessage ? ` errorMessage=${JSON.stringify(errorMessage)}` : ""),
    // A compaction only FIRED if pi actually produced a result; an early bail did not.
    fires: producedResult && !flags.wasAborted,
    sessionKey: ctx.params.sessionKey,
    model,
  });
}

function clearStaleAssistantUsageOnSessionMessages(ctx: EmbeddedPiSubscribeContext): void {
  const messages = ctx.params.session.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const candidate = message as { role?: unknown; usage?: unknown };
    if (candidate.role !== "assistant") {
      continue;
    }
    // pi-coding-agent expects assistant usage to exist when computing context usage.
    // Reset stale snapshots to zeros instead of deleting the field.
    candidate.usage = makeZeroUsageSnapshot();
  }
}
