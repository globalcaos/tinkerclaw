import { emitAgentEvent } from "../infra/agent-events.js";
import { emitEffortTelemetry } from "../infra/effort-telemetry.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { getRateLimitSnapshot } from "./anthropic-ratelimit-store.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
  sanitizeForConsole,
} from "./embedded-agent-error-observation.js";
import { classifyFailoverReason, formatAssistantErrorText } from "./embedded-agent-helpers.js";
import { isIncompleteTerminalAssistantTurn } from "./embedded-agent-runner/run/incomplete-turn.js";
import {
  consumePendingToolMediaReply,
  hasAssistantVisibleReply,
} from "./embedded-agent-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { isPromiseLike } from "./embedded-agent-subscribe.promise.js";
import { isAssistantMessage } from "./embedded-agent-utils.js";

export {
  handleCompactionEnd,
  handleCompactionStart,
} from "./embedded-agent-subscribe.handlers.compaction.js";

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: Date.now(),
      authProfileId: ctx.params.authProfileId,
      model: ctx.params.modelId,
      modelProvider: ctx.params.modelProvider,
      sessionKey: ctx.params.sessionKey,
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: { phase: "start" },
  });
  // FORK 2026-07-24 (the architect, EEG deep-layer feed): the embedded pipe's effort
  // telemetry — see src/infra/effort-telemetry.ts for the layering doctrine.
  // Without this the EEG only ever saw the claude-CLI bridge's events and was
  // blind to every non-anthropic provider (bug [eeg-blind-to-non-anthropic-providers]).
  emitEffortTelemetry({
    runId: ctx.params.runId,
    sessionKey: ctx.params.sessionKey,
    model: ctx.params.modelId ?? "",
    provider: ctx.params.modelProvider,
    phase: "live",
    thinkLevel: ctx.params.thinkingLevel,
  });
}

export function handleAgentEnd(ctx: EmbeddedPiSubscribeContext): void | Promise<void> {
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
  let lifecycleErrorText: string | undefined;
  const hasAssistantVisibleText =
    Array.isArray(ctx.state.assistantTexts) &&
    ctx.state.assistantTexts.some((text) => hasAssistantVisibleReply({ text }));
  const hadDeterministicSideEffect =
    ctx.state.hadDeterministicSideEffect === true ||
    (ctx.state.messagingToolSentTexts?.length ?? 0) > 0 ||
    (ctx.state.messagingToolSentMediaUrls?.length ?? 0) > 0 ||
    (ctx.state.successfulCronAdds ?? 0) > 0;
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText,
    lastAssistant: isAssistantMessage(lastAssistant) ? lastAssistant : null,
  });
  const replayInvalid =
    ctx.state.replayState.replayInvalid || incompleteTerminalAssistant ? true : undefined;
  const derivedWorkingTerminalState = isError
    ? "blocked"
    : replayInvalid && !hasAssistantVisibleText && !hadDeterministicSideEffect
      ? "abandoned"
      : ctx.state.livenessState;
  const livenessState =
    ctx.state.livenessState === "working" ? derivedWorkingTerminalState : ctx.state.livenessState;

  if (isError && lastAssistant) {
    const friendlyError = formatAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
      provider: lastAssistant.provider,
      model: lastAssistant.model,
    });
    const rawError = lastAssistant.errorMessage?.trim();
    const failoverReason = classifyFailoverReason(rawError ?? "", {
      provider: lastAssistant.provider,
    });
    const errorText = (friendlyError || lastAssistant.errorMessage || "LLM request failed.").trim();
    const observedError = buildApiErrorObservationFields(rawError, {
      provider: lastAssistant.provider,
    });
    const safeErrorText =
      buildTextObservationFields(errorText, {
        provider: lastAssistant.provider,
      }).textPreview ?? "LLM request failed.";
    lifecycleErrorText = safeErrorText;
    const safeRunId = sanitizeForConsole(ctx.params.runId) ?? "-";
    const safeModel = sanitizeForConsole(lastAssistant.model) ?? "unknown";
    const safeProvider = sanitizeForConsole(lastAssistant.provider) ?? "unknown";
    const safeRawErrorPreview = sanitizeForConsole(observedError.rawErrorPreview);
    const shouldSuppressRawErrorConsoleSuffix =
      observedError.providerRuntimeFailureKind === "auth_html_403" ||
      observedError.providerRuntimeFailureKind === "auth_scope" ||
      observedError.providerRuntimeFailureKind === "auth_refresh";
    const rawErrorConsoleSuffix =
      safeRawErrorPreview && !shouldSuppressRawErrorConsoleSuffix
        ? ` rawError=${safeRawErrorPreview}`
        : "";
    ctx.log.warn("embedded run agent end", {
      event: "embedded_run_agent_end",
      tags: ["error_handling", "lifecycle", "agent_end", "assistant_error"],
      runId: ctx.params.runId,
      isError: true,
      error: safeErrorText,
      failoverReason,
      model: lastAssistant.model,
      provider: lastAssistant.provider,
      ...observedError,
      consoleMessage: `embedded run agent end: runId=${safeRunId} isError=true model=${safeModel} provider=${safeProvider} error=${safeErrorText}${rawErrorConsoleSuffix}`,
    });
  } else {
    ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);
  }

  // FORK 2026-07-24 (the architect, EEG deep-layer feed): final effort sample for the
  // embedded pipe — model/provider/usage from the run's own last assistant
  // message when present (truth of what executed), params as fallback. Errors
  // still emit (isError) so the EEG shows the attempt. Doctrine in
  // src/infra/effort-telemetry.ts.
  emitEffortTelemetry({
    runId: ctx.params.runId,
    sessionKey: ctx.params.sessionKey,
    model:
      (isAssistantMessage(lastAssistant) ? lastAssistant.model : undefined) ??
      ctx.params.modelId ??
      "",
    provider:
      (isAssistantMessage(lastAssistant) ? lastAssistant.provider : undefined) ??
      ctx.params.modelProvider,
    phase: "final",
    thinkLevel: ctx.params.thinkingLevel,
    outputTokens: isAssistantMessage(lastAssistant) ? (lastAssistant.usage?.output ?? 0) : 0,
    isError,
  });

  const rateLimit = ctx.params.modelProvider === "anthropic" ? getRateLimitSnapshot() : undefined;
  const emitLifecycleTerminal = () => {
    const terminalMeta = {
      ...(ctx.state.terminalStopReason ? { stopReason: ctx.state.terminalStopReason } : {}),
      ...(ctx.state.yielded === true ? { yielded: true } : {}),
    };
    if (isError) {
      // FORK 2026-06-04: the terminal phase:"error" gateway event must carry the
      // same identity fields the clean phase:"end" branch sends. The Tinker UI gates
      // its lifecycle start/end/error handler behind `p.data?.model`, so an error
      // event without model/sessionKey is DROPPED → the run is never scheduled for
      // deletion → its thinking indicator sticks forever (and stacks with the next
      // run = "multiple at once"). Mirror the phase:"end" identity fields exactly.
      emitAgentEvent({
        runId: ctx.params.runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          error: lifecycleErrorText ?? "LLM request failed.",
          ...terminalMeta,
          ...(livenessState ? { livenessState } : {}),
          ...(replayInvalid ? { replayInvalid } : {}),
          endedAt: Date.now(),
          authProfileId: ctx.params.authProfileId,
          model: ctx.params.modelId,
          modelProvider: ctx.params.modelProvider,
          sessionKey: ctx.params.sessionKey,
          ...(rateLimit ? { rateLimit } : {}),
        },
      });
      void ctx.params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "error",
          error: lifecycleErrorText ?? "LLM request failed.",
          ...terminalMeta,
          ...(livenessState ? { livenessState } : {}),
          ...(replayInvalid ? { replayInvalid } : {}),
        },
      });
      return;
    }
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        ...terminalMeta,
        ...(livenessState ? { livenessState } : {}),
        ...(replayInvalid ? { replayInvalid } : {}),
        endedAt: Date.now(),
        authProfileId: ctx.params.authProfileId,
        model: ctx.params.modelId,
        modelProvider: ctx.params.modelProvider,
        sessionKey: ctx.params.sessionKey,
        ...(rateLimit ? { rateLimit } : {}),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "end",
        ...terminalMeta,
        ...(livenessState ? { livenessState } : {}),
        ...(replayInvalid ? { replayInvalid } : {}),
      },
    });
  };

  const finalizeAgentEnd = () => {
    ctx.state.blockState.thinking = false;
    ctx.state.blockState.final = false;
    ctx.state.blockState.inlineCode = createInlineCodeState();

    if (ctx.state.pendingCompactionRetry > 0) {
      ctx.resolveCompactionRetry();
    } else {
      ctx.maybeResolveCompactionWait();
    }
  };

  const flushPendingMediaAndChannel = () => {
    if (ctx.params.onBlockReply) {
      const pendingToolMediaReply = consumePendingToolMediaReply(ctx.state);
      if (pendingToolMediaReply && hasAssistantVisibleReply(pendingToolMediaReply)) {
        ctx.emitBlockReply(pendingToolMediaReply);
      }
    }

    const postMediaFlushResult = ctx.flushBlockReplyBuffer();
    if (isPromiseLike<void>(postMediaFlushResult)) {
      return postMediaFlushResult.then(() => {
        const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
        if (isPromiseLike<void>(onBlockReplyFlushResult)) {
          return onBlockReplyFlushResult;
        }
        return undefined;
      });
    }

    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult;
    }
    return undefined;
  };

  let lifecycleTerminalEmitted = false;
  const emitLifecycleTerminalOnce = (): void | Promise<void> => {
    if (lifecycleTerminalEmitted) {
      return;
    }
    lifecycleTerminalEmitted = true;
    let beforeLifecycleTerminal: void | Promise<void> = undefined;
    try {
      beforeLifecycleTerminal = ctx.params.onBeforeLifecycleTerminal?.();
    } catch (err) {
      ctx.log.debug(`before lifecycle terminal failed: ${String(err)}`);
    }
    if (isPromiseLike<void>(beforeLifecycleTerminal)) {
      return Promise.resolve(beforeLifecycleTerminal)
        .catch((err) => {
          ctx.log.debug(`before lifecycle terminal failed: ${String(err)}`);
        })
        .then(() => {
          emitLifecycleTerminal();
        });
    }
    emitLifecycleTerminal();
  };

  try {
    const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
    finalizeAgentEnd();
    const flushPendingMediaAndChannelResult = isPromiseLike<void>(flushBlockReplyBufferResult)
      ? Promise.resolve(flushBlockReplyBufferResult).then(() => flushPendingMediaAndChannel())
      : flushPendingMediaAndChannel();

    if (isPromiseLike<void>(flushPendingMediaAndChannelResult)) {
      return Promise.resolve(flushPendingMediaAndChannelResult).then(
        () => emitLifecycleTerminalOnce(),
        (error) => {
          const emitted = emitLifecycleTerminalOnce();
          if (isPromiseLike<void>(emitted)) {
            return Promise.resolve(emitted).then(() => {
              throw error;
            });
          }
          throw error;
        },
      );
    }
  } catch (error) {
    const emitted = emitLifecycleTerminalOnce();
    if (isPromiseLike<void>(emitted)) {
      return Promise.resolve(emitted).then(() => {
        throw error;
      });
    }
    throw error;
  }

  return emitLifecycleTerminalOnce();
}
