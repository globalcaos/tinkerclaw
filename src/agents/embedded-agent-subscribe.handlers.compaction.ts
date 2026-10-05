import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
  type CompactionEmitTarget,
  type CompactionLane,
  type CompactionProvenance,
  compactionTokenCount,
  emitCompactionTelemetry,
} from "../infra/compaction-telemetry.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { logCompactionDecision } from "./compaction-diagnostics.js";
import type { EmbeddedPiSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { normalizeProviderId } from "./provider-id.js";
import { makeZeroUsageSnapshot } from "./usage.js";

/**
 * FORK 2026-09-24 (A1 ratchet retired) — pi-auto on the full A1 compaction contract, published by
 * src/infra/compaction-telemetry.ts, the one owner (context-window-panel.md §6.1). This subscriber
 * only ever hears pi's OWN decider: the manual RPC's pi compaction
 * (embedded-agent-runner/compact.ts, `session.compact()`) runs on a session no subscriber is
 * attached to. So the trigger is always "pi-auto".
 *
 * Provenance is "estimated", not "exact". pi's `result.tokensBefore` is its estimateContextTokens()
 * (pi-coding-agent core/compaction/compaction.js): the last assistant usage PLUS a chars/4
 * estimate of every message after it, and on the cc-bridge lane that usage is the CLI's turn
 * aggregate (handlers.messages.ts). It is never one provider-reported figure, so it may not claim
 * to be one.
 */
const PI_AUTO_PROVENANCE: CompactionProvenance = "estimated";

/**
 * The provider id the tinker-bridge registers for the claude-code lane
 * (extensions/tinkerclaw-tinker-bridge/src/defaults.ts `PROVIDER_ID`). Core does not import
 * extensions, so the id is named here, as src/gateway/session-eviction.ts and cli-runner.ts do.
 */
const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/** The one field of pi's live AgentSession the lane needs, read defensively. */
type PiSessionModelView = { model?: { provider?: unknown } } | undefined;

/**
 * FORK 2026-09-24 — the serving lane of the session pi compacted.
 *
 * claude-code is a provider-runtime plugin that routes through runEmbeddedPiAgent (cli-runner.ts),
 * so pi's decider runs on the cc-bridge lane too, and what it compacts there is the gateway's
 * mirror, not the CLI transcript the model reads (context-window-panel.md F1 / F2). The lane is
 * how a consumer tells that such a compaction did not shrink the next call.
 *
 * Read off pi's live session model first: it is the model pi's decider judged, and the run's
 * subscription params carry no modelProvider on the serving path (attempt.ts builds them without
 * it), so ctx.params.modelProvider is only the fallback. With neither, "embedded": this
 * subscriber IS the embedded pipe, and "cc-bridge" needs positive evidence.
 */
function resolvePiAutoCompactionLane(ctx: EmbeddedPiSubscribeContext): CompactionLane {
  let sessionProvider: string | undefined;
  try {
    const raw = (ctx.params.session as unknown as PiSessionModelView)?.model?.provider;
    sessionProvider = typeof raw === "string" && raw ? raw : undefined;
  } catch {
    /* pi internals are best-effort; this runs on the serving path and must never throw */
  }
  const provider = sessionProvider ?? ctx.params.modelProvider;
  return provider && normalizeProviderId(provider) === CLAUDE_CODE_PROVIDER_ID
    ? "cc-bridge"
    : "embedded";
}

/**
 * When this subscriber saw pi's compaction_start, keyed on the run's state object (stable for the
 * subscription's life, and collected with it). The end handler takes it to report durationMs. An
 * end with no start seen (pi's "overflow recovery failed" end in _checkCompaction has none)
 * reports no duration rather than a made-up one.
 */
const piAutoCompactionStartedAt = new WeakMap<object, number>();

function takePiAutoCompactionDurationMs(ctx: EmbeddedPiSubscribeContext): number | undefined {
  const startedAt = piAutoCompactionStartedAt.get(ctx.state);
  piAutoCompactionStartedAt.delete(ctx.state);
  // A negative span (a clock step) is dropped by the contract's absent-not-zero rule.
  return startedAt === undefined ? undefined : Date.now() - startedAt;
}

/**
 * FORK 2026-09-25 — where both pi-auto events go: the run's own listener, and the session the run
 * serves. The session key is load-bearing: the A1 owner writes the compaction LEDGER from the
 * target, keying the compaction.run row and that session's in-memory totals (the sessions.list
 * row's A7 figures) on it, and emitAgentEvent's fallback to the key registered for the run never
 * reaches that half (compaction-telemetry.ts, THE LEDGER). Without it every pi-auto row landed
 * with no session and counted for none.
 */
function piAutoCompactionTarget(ctx: EmbeddedPiSubscribeContext): CompactionEmitTarget {
  return {
    runId: ctx.params.runId,
    sessionKey: ctx.params.sessionKey,
    onAgentEvent: ctx.params.onAgentEvent,
  };
}

export function handleCompactionStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.compactionInFlight = true;
  ctx.state.livenessState = "paused";
  ctx.ensureCompactionPromise();
  ctx.log.debug(`embedded run compaction start: runId=${ctx.params.runId}`);
  // pi's compaction_start carries only its reason, so no token figure rides on the start event.
  piAutoCompactionStartedAt.set(ctx.state, Date.now());
  emitCompactionTelemetry(piAutoCompactionTarget(ctx), {
    phase: "start",
    trigger: "pi-auto",
    lane: resolvePiAutoCompactionLane(ctx),
    provenance: PI_AUTO_PROVENANCE,
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
 *
 * FORK 2026-09-24: pi-coding-agent 0.70.5's CompactionResult is {summary, firstKeptEntryId,
 * tokensBefore, details}, so tokensAfter is always absent from pi-auto today and the panel's
 * saving stays unknown for it. It is still read, so a pi that starts reporting it is heard with
 * no change here.
 */
function readCompactionTokens(evt: { result?: unknown }): {
  tokensBefore?: number;
  tokensAfter?: number;
} {
  const result =
    typeof evt.result === "object" && evt.result
      ? (evt.result as { tokensBefore?: unknown; tokensAfter?: unknown })
      : undefined;
  // FORK 2026-09-24 (A1): the absent-not-zero rule has one owner now, the contract module.
  const before = compactionTokenCount(result?.tokensBefore);
  const after = compactionTokenCount(result?.tokensAfter);
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
  // Taken first, so the wall time covers pi's compaction and none of this handler's own work.
  const durationMs = takePiAutoCompactionDurationMs(ctx);
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
    // FORK 2026-04-28 chunk-21: noteCompactionTokensAfter was dropped upstream, and the voided
    // tokensAfter read that fed it is gone too. pi's context size now leaves only on the
    // compaction event below (readCompactionTokens).
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
  // FORK 2026-08-29 (the architect: the CONTEXT WINDOW panel's "tokens saved by eviction"). The saving
  // is the one number that makes a compaction legible as a WIN rather than as an unexplained
  // pause, and it cannot be derived client-side: the UI never sees the pre-compaction transcript.
  // So the end event forwards the context size pi reports, as parts and never as a delta, so the
  // consumer can check the subtraction (the cache-telemetry.ts rule, "parts only, never a
  // ratio"). An absent field is honest, a 0 is a lie.
  //
  // FORK 2026-09-24 (A1 ratchet retired): the full A1 contract. trigger, lane and provenance on
  // both phases (PI_AUTO_PROVENANCE, resolvePiAutoCompactionLane); completed and pi's willRetry;
  // and each figure only when measured:
  //   - tokensBefore: pi's result.tokensBefore, when present;
  //   - tokensAfter: pi 0.70.5 never reports it (readCompactionTokens), so it is omitted today;
  //   - tokensDropped: never sent. pi does not measure it and the contract forbids deriving it;
  //   - durationMs: this subscriber's own start-to-end wall time, when it saw the start.
  // FORK 2026-09-25: the target names the run's session (piAutoCompactionTarget), so the
  // ledger row this end writes counts for it.
  emitCompactionTelemetry(piAutoCompactionTarget(ctx), {
    phase: "end",
    trigger: "pi-auto",
    lane: resolvePiAutoCompactionLane(ctx),
    provenance: PI_AUTO_PROVENANCE,
    completed: hasResult && !wasAborted,
    willRetry,
    ...readCompactionTokens(evt),
    ...(durationMs === undefined ? {} : { durationMs }),
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
