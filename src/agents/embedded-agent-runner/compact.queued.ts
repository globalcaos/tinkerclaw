import { randomUUID } from "node:crypto";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  captureCompactionCheckpointSnapshot,
  cleanupCompactionCheckpointSnapshot,
  persistSessionCompactionCheckpoint,
  resolveSessionCompactionCheckpointReason,
  type CapturedCompactionCheckpointSnapshot,
} from "../../gateway/session-compaction-checkpoints.js";
import { clearAgentRunContext } from "../../infra/agent-events.js";
import {
  compactionTokenCount,
  emitCompactionTelemetry,
  type CompactionLane,
  type CompactionTrigger,
} from "../../infra/compaction-telemetry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { resolveUserPath } from "../../utils.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { maybeCompactAgentHarnessSession } from "../harness/selection.js";
import { normalizeProviderId } from "../provider-id.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import type { CompactEmbeddedPiSessionParams } from "./compact.types.js";
import { asCompactionHookRunner, runPostCompactionSideEffects } from "./compaction-hooks.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";
import {
  rotateTranscriptAfterCompaction,
  shouldRotateCompactionTranscript,
} from "./compaction-successor-transcript.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { readPiModelContextTokens } from "./model-context-tokens.js";
import { resolveModelAsync } from "./model.js";
import type { EmbeddedPiCompactResult } from "./types.js";

/**
 * Compacts a session with lane queueing (session lane + global lane).
 * Use this from outside a lane context. If already inside a lane, use
 * `compactEmbeddedPiSessionDirect` to avoid deadlocks.
 */
export async function compactEmbeddedPiSession(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult> {
  ensureRuntimePluginsLoaded({
    config: params.config,
    workspaceDir: params.workspaceDir,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  ensureContextEnginesInitialized();
  const contextEngine = await resolveContextEngine(params.config);
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  let contextTokenBudget = params.contextTokenBudget;
  if (!contextTokenBudget || !Number.isFinite(contextTokenBudget) || contextTokenBudget <= 0) {
    const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
      config: params.config,
      provider: params.provider,
      modelId: params.model,
      authProfileId: params.authProfileId,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    const ceProvider = resolvedCompactionTarget.provider ?? DEFAULT_PROVIDER;
    const ceModelId = resolvedCompactionTarget.model ?? DEFAULT_MODEL;
    const { model: ceModel } = await resolveModelAsync(
      ceProvider,
      ceModelId,
      agentDir,
      params.config,
    );
    const ceRuntimeModel = ceModel as ProviderRuntimeModel | undefined;
    contextTokenBudget = resolveContextWindowInfo({
      cfg: params.config,
      provider: ceProvider,
      modelId: ceModelId,
      modelContextTokens: readPiModelContextTokens(ceModel),
      modelContextWindow: ceRuntimeModel?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    }).tokens;
  }
  const contextEngineRuntimeContext = buildCompactionContextEngineRuntimeContext({
    params,
    agentDir,
    contextTokenBudget,
  });
  const harnessResult = await maybeCompactAgentHarnessSession({
    ...params,
    contextEngine,
    contextTokenBudget,
    contextEngineRuntimeContext,
  });
  if (harnessResult) {
    await contextEngine.dispose?.();
    return harnessResult;
  }
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      let checkpointSnapshot: CapturedCompactionCheckpointSnapshot | null = null;
      let checkpointSnapshotRetained = false;
      // When the context engine owns compaction, its compact() implementation
      // bypasses compactEmbeddedPiSessionDirect (which fires the hooks internally).
      // Fire before_compaction / after_compaction hooks here so plugin subscribers
      // are notified regardless of which engine is active.
      const engineOwnsCompaction = contextEngine.info.ownsCompaction === true;
      // The same bypass skips the leaf's compaction telemetry (context-window-panel.md §6.1
      // A2), so on that branch this wrapper is the executor that emits the A1 start / end pair.
      const compactionTelemetry = createRunnerCompactionTelemetry({
        enabled: engineOwnsCompaction,
        runId: params.runId,
        sessionKey: params.sessionKey,
        trigger: params.trigger,
        provider: params.provider,
      });
      try {
        checkpointSnapshot = engineOwnsCompaction
          ? captureCompactionCheckpointSnapshot({
              sessionManager: SessionManager.open(params.sessionFile),
              sessionFile: params.sessionFile,
            })
          : null;
        const hookRunner = engineOwnsCompaction
          ? asCompactionHookRunner(getGlobalHookRunner())
          : null;
        const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
        const { sessionAgentId } = resolveSessionAgentIds({
          sessionKey: params.sessionKey,
          config: params.config,
        });
        const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
        const hookCtx = {
          sessionId: params.sessionId,
          agentId: sessionAgentId,
          sessionKey: hookSessionKey,
          workspaceDir: resolveUserPath(params.workspaceDir),
          messageProvider: resolvedMessageProvider,
        };
        // An owning engine may still hand the algorithm back to the leaf; the stamp keeps that
        // leaf silent, so one compaction never emits two pairs.
        const runtimeContext: ContextEngineRuntimeContext = engineOwnsCompaction
          ? markCompactionTelemetryOwnedByCaller(contextEngineRuntimeContext)
          : contextEngineRuntimeContext;
        // Engine-owned compaction doesn't load the transcript at this level, so
        // message counts are unavailable. We pass sessionFile so hook subscribers
        // can read the transcript themselves if they need exact counts.
        if (hookRunner?.hasHooks?.("before_compaction") && hookRunner.runBeforeCompaction) {
          try {
            await hookRunner.runBeforeCompaction(
              {
                messageCount: -1,
                sessionFile: params.sessionFile,
              },
              hookCtx,
            );
          } catch (err) {
            log.warn("before_compaction hook failed", {
              errorMessage: formatErrorMessage(err),
            });
          }
        }
        // Opened in real time, before the engine runs (the panel pulses on it). An owning
        // engine is opaque: its refusal is only visible once compact() returns, and closes the
        // open pair as not completed. A decline the leaf decides itself precedes its start and
        // emits nothing.
        compactionTelemetry.start(params.currentTokenCount);
        const result = await contextEngine.compact({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          tokenBudget: contextTokenBudget,
          currentTokenCount: params.currentTokenCount,
          compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
          customInstructions: params.customInstructions,
          force: params.trigger === "manual",
          runtimeContext,
        });
        // Closed as soon as the engine returns: rotation, checkpoint and hooks below are
        // bookkeeping, and a failure there must not un-count a compaction that happened.
        compactionTelemetry.end({
          completed: result.ok && result.compacted,
          tokensBefore: result.result?.tokensBefore,
          tokensAfter: result.result?.tokensAfter,
          tokensDropped: readMeasuredCompactionDrop(result.result?.details),
        });
        const delegatedSessionId = result.result?.sessionId;
        const delegatedSessionFile = result.result?.sessionFile;
        const delegatedRotatedTranscript =
          (typeof delegatedSessionId === "string" && delegatedSessionId !== params.sessionId) ||
          (typeof delegatedSessionFile === "string" && delegatedSessionFile !== params.sessionFile);
        let postCompactionSessionId = delegatedSessionId ?? params.sessionId;
        let postCompactionSessionFile = delegatedSessionFile ?? params.sessionFile;
        let postCompactionLeafId: string | undefined;
        if (result.ok && result.compacted) {
          if (shouldRotateCompactionTranscript(params.config) && !delegatedRotatedTranscript) {
            try {
              const rotation = await rotateTranscriptAfterCompaction({
                sessionManager: SessionManager.open(params.sessionFile),
                sessionFile: params.sessionFile,
              });
              if (rotation.rotated) {
                postCompactionSessionId = rotation.sessionId ?? postCompactionSessionId;
                postCompactionSessionFile = rotation.sessionFile ?? postCompactionSessionFile;
                postCompactionLeafId = rotation.leafId;
                log.info(
                  `[compaction] rotated active transcript after context-engine compaction ` +
                    `(sessionKey=${params.sessionKey ?? params.sessionId})`,
                );
              }
            } catch (err) {
              log.warn("failed to rotate compacted transcript", {
                errorMessage: formatErrorMessage(err),
              });
            }
          }
          if (params.config && params.sessionKey && checkpointSnapshot) {
            try {
              const postLeafId =
                postCompactionLeafId ??
                SessionManager.open(postCompactionSessionFile).getLeafId() ??
                undefined;
              const storedCheckpoint = await persistSessionCompactionCheckpoint({
                cfg: params.config,
                sessionKey: params.sessionKey,
                sessionId: postCompactionSessionId,
                reason: resolveSessionCompactionCheckpointReason({
                  trigger: params.trigger,
                }),
                snapshot: checkpointSnapshot,
                summary: result.result?.summary,
                firstKeptEntryId: result.result?.firstKeptEntryId,
                tokensBefore: result.result?.tokensBefore,
                tokensAfter: result.result?.tokensAfter,
                postSessionFile: postCompactionSessionFile,
                postLeafId,
                postEntryId: postLeafId,
              });
              checkpointSnapshotRetained = storedCheckpoint !== null;
            } catch (err) {
              log.warn("failed to persist compaction checkpoint", {
                errorMessage: formatErrorMessage(err),
              });
            }
          }
          await runContextEngineMaintenance({
            contextEngine,
            sessionId: postCompactionSessionId,
            sessionKey: params.sessionKey,
            sessionFile: postCompactionSessionFile,
            reason: "compaction",
            runtimeContext,
          });
        }
        if (engineOwnsCompaction && result.ok && result.compacted) {
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionFile: postCompactionSessionFile,
          });
        }
        if (
          result.ok &&
          result.compacted &&
          hookRunner?.hasHooks?.("after_compaction") &&
          hookRunner.runAfterCompaction
        ) {
          try {
            const afterHookCtx = {
              ...hookCtx,
              sessionId: postCompactionSessionId,
            };
            await hookRunner.runAfterCompaction(
              {
                messageCount: -1,
                compactedCount: -1,
                tokenCount: result.result?.tokensAfter,
                sessionFile: postCompactionSessionFile,
              },
              afterHookCtx,
            );
          } catch (err) {
            log.warn("after_compaction hook failed", {
              errorMessage: formatErrorMessage(err),
            });
          }
        }
        return {
          ok: result.ok,
          compacted: result.compacted,
          reason: result.reason,
          result: result.result
            ? {
                summary: result.result.summary ?? "",
                firstKeptEntryId: result.result.firstKeptEntryId ?? "",
                tokensBefore: result.result.tokensBefore,
                tokensAfter: result.result.tokensAfter,
                details: result.result.details,
                ...(postCompactionSessionId !== params.sessionId
                  ? { sessionId: postCompactionSessionId }
                  : {}),
                ...(postCompactionSessionFile !== params.sessionFile
                  ? { sessionFile: postCompactionSessionFile }
                  : {}),
              }
            : undefined,
        };
      } finally {
        // Closes the pair when compact() threw after start; a no-op once closed or disabled.
        compactionTelemetry.end({ completed: false });
        if (!checkpointSnapshotRetained) {
          await cleanupCompactionCheckpointSnapshot(checkpointSnapshot);
        }
        await contextEngine.dispose?.();
      }
    }),
  );
}

function buildCompactionContextEngineRuntimeContext(params: {
  params: CompactEmbeddedPiSessionParams;
  agentDir: string;
  contextTokenBudget?: number;
}): ContextEngineRuntimeContext {
  return {
    ...params.params,
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: params.params.sessionKey,
      messageChannel: params.params.messageChannel,
      messageProvider: params.params.messageProvider,
      agentAccountId: params.params.agentAccountId,
      currentChannelId: params.params.currentChannelId,
      currentThreadTs: params.params.currentThreadTs,
      currentMessageId: params.params.currentMessageId,
      authProfileId: params.params.authProfileId,
      workspaceDir: params.params.workspaceDir,
      agentDir: params.agentDir,
      config: params.params.config,
      skillsSnapshot: params.params.skillsSnapshot,
      senderIsOwner: params.params.senderIsOwner,
      senderId: params.params.senderId,
      provider: params.params.provider,
      modelId: params.params.model,
      thinkLevel: params.params.thinkLevel,
      reasoningLevel: params.params.reasoningLevel,
      bashElevated: params.params.bashElevated,
      extraSystemPrompt: params.params.extraSystemPrompt,
      sourceReplyDeliveryMode: params.params.sourceReplyDeliveryMode,
      ownerNumbers: params.params.ownerNumbers,
    }),
    tokenBudget: params.contextTokenBudget,
    currentTokenCount: params.params.currentTokenCount,
  };
}

// FORK 2026-09-24 — runner compaction telemetry (TINKER_UI_DESIGN_BIBLE/context-window-panel.md
// §6.1 A2): the runner's half of the A1 contract, whose single owner and only stream writer is
// src/infra/compaction-telemetry.ts. Before it every runner compaction was silent (finding F3b),
// so the CONTEXT WINDOW panel's compaction counter could only read 0.
//
// ONE PAIR PER COMPACTION, FROM THE EXECUTOR THAT RAN IT. A runner compaction runs in one of two
// places:
//   - the LEAF, compactEmbeddedPiSessionDirect (compact.ts). The legacy context engine delegates
//     to it (legacy.ts -> delegate.ts), so every runner gate reaches it with no edit to run.ts:
//     the overflow recovery (trigger "overflow", which attempt.ts's preemptive precheck and the
//     tool-loop guard both feed, as overflow errors), the timeout recovery ("timeout_recovery"),
//     this file's legacy path (sessions.compact and /compact, "manual"; the preflight compaction
//     in agent-runner-memory.ts, "budget") and cli-compaction.ts ("cli_budget").
//   - the engine-owned branch of compactEmbeddedPiSession above, which bypasses the leaf.
// NEVER BOTH. An owning engine may still hand the algorithm back to the leaf (delegate.ts invites
// exactly that), so the branch stamps the runtime context it gives the engine;
// delegateCompactionToRuntime spreads that context into the leaf's params, and a stamped leaf
// stays silent.

/** The stamp. Set only by an executor that already emits the pair for this compaction. */
const COMPACTION_TELEMETRY_OWNED_BY_CALLER = "compactionTelemetryOwnedByCaller";

function markCompactionTelemetryOwnedByCaller(
  runtimeContext: ContextEngineRuntimeContext,
): ContextEngineRuntimeContext {
  return { ...runtimeContext, [COMPACTION_TELEMETRY_OWNED_BY_CALLER]: true };
}

/**
 * True when the executor that reached the leaf already emits this compaction's pair. The stamp
 * rides the untyped runtime context, so it is read off the params as a plain record.
 */
export function isCompactionTelemetryOwnedByCaller(params: object): boolean {
  return (params as Record<string, unknown>)[COMPACTION_TELEMETRY_OWNED_BY_CALLER] === true;
}

/**
 * A runner trigger -> the A1 trigger. The runtime context is untyped past
 * CompactEmbeddedPiSessionParams, so two values arrive that its `trigger` type does not list:
 * run.ts's "timeout_recovery" and cli-compaction.ts's "cli_budget".
 */
export function resolveRunnerCompactionTrigger(trigger: unknown): CompactionTrigger {
  switch (trigger) {
    case "overflow":
      // run.ts's overflow recovery. The preemptive precheck and the tool-loop guard reach it as
      // overflow errors and run.ts (tier-1) does not say which, so all three report "overflow".
      return "overflow";
    case "timeout_recovery":
      return "timeout";
    case "budget":
      // The preflight compaction (agent-runner-memory.ts): the queued path's automatic caller.
      return "queued";
    case "cli_budget":
      // cli-compaction.ts: the preemptive decider, run over a CLI session's gateway transcript.
      return "preemptive";
    default:
      // "manual" (sessions.compact, /compact) and a missing trigger, which the leaf has always
      // logged as manual. An unlisted trigger lands here too until it gets its own case.
      return "manual";
  }
}

/**
 * The tinker-bridge's provider id: `PROVIDER_ID` in
 * extensions/tinkerclaw-tinker-bridge/src/defaults.ts. Core does not import extensions, so it is
 * named here, as session-eviction.ts names it.
 */
const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/**
 * The A1 `lane` of a runner compaction. On the tinker-bridge's lane the model reads the claude
 * CLI's own transcript, so a runner compaction there shrank the gateway's mirror, not what the
 * model sees (context-window-panel.md F2): "cc-bridge". Everything else is "embedded", a CLI
 * backend included: cli-compaction.ts clears the CLI session after compacting, so the next call
 * is rebuilt from the compacted gateway transcript.
 *
 * The leaf reads the provider off its runtime context, where
 * buildEmbeddedCompactionRuntimeContext has already put a cross-provider
 * `agents.defaults.compaction.model` override in its place; under such an override a
 * tinker-bridge session's leaf compaction reports "embedded".
 */
export function resolveRunnerCompactionLane(provider: unknown): CompactionLane {
  return typeof provider === "string" && normalizeProviderId(provider) === CLAUDE_CODE_PROVIDER_ID
    ? "cc-bridge"
    : "embedded";
}

/**
 * FORK 2026-09-25 — the tokens a compaction removed, as the compaction itself measured them, read
 * off its result's `details` (pi's CompactionResult.details, or an owning engine's; untyped): what
 * a runner `end` may send as tokensDropped, a figure the A1 contract takes only from an executor
 * that measured it.
 *
 * The one producer today is the engram executor (src/agents/pi-extensions/compaction-engram.ts,
 * the `compaction.mode = "engram"` arm): `details.tokensEvicted`, the chars/4 size of the messages
 * it moved out of the context. sessions.compact already replies with that figure as
 * `evictedTokens`, so the reply and the stream carry one number. A result that measured no drop
 * yields undefined (P10: absent, never 0); a measured 0 stays 0. NEVER tokensBefore minus
 * tokensAfter: on the engram path tokensBefore is a store-wide running total (sessions.ts measured
 * 7,855,029 on a 175,850-token session), and the contract leaves that subtraction to the consumer.
 *
 * Wired on both runner executors: the engine-owned branch of compactEmbeddedPiSession above, and
 * the leaf's completed end (compactEmbeddedPiSessionDirect, compact.ts), which the default legacy
 * engine reaches.
 */
export function readMeasuredCompactionDrop(details: unknown): number | undefined {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  return compactionTokenCount((details as { tokensEvicted?: unknown }).tokensEvicted);
}

export type RunnerCompactionTelemetry = {
  /** Open the pair; a no-op while one is open, so a retry of one compaction opens nothing. */
  start: (tokensBefore?: number) => void;
  /** Close the open pair; a no-op when none is open, so a decline before start stays silent. */
  end: (outcome: {
    completed: boolean;
    tokensBefore?: number;
    tokensAfter?: number;
    /**
     * The drop this compaction measured itself (readMeasuredCompactionDrop), never one derived
     * from before and after. Sent only on a completed end.
     */
    tokensDropped?: number;
  }) => void;
};

/**
 * One executor's start / end pair for one compaction. Provenance is always "estimated":
 * tokensAfter is a local estimate on every runner path, a caller's tokensBefore is exact only on
 * some, and a measured drop (readMeasuredCompactionDrop) is a chars/4 count, so the pair claims no
 * more than its weakest figure (P5).
 */
export function createRunnerCompactionTelemetry(params: {
  enabled: boolean;
  runId?: string;
  sessionKey?: string;
  trigger: unknown;
  provider: unknown;
}): RunnerCompactionTelemetry {
  const trigger = resolveRunnerCompactionTrigger(params.trigger);
  const lane = resolveRunnerCompactionLane(params.provider);
  const callerRunId = params.runId?.trim() || undefined;
  // A compaction outside a run (sessions.compact, /compact) gets a run id of its own, cleared
  // after `end` so the bus's per-run sequence map keeps no entry per compaction (as
  // session-eviction.ts does).
  const runId = callerRunId ?? `compaction:${randomUUID()}`;
  const sessionKey = params.sessionKey?.trim() || undefined;
  const target = { runId, ...(sessionKey ? { sessionKey } : {}) };
  let openedAt: number | undefined;
  let openTokensBefore: number | undefined;
  return {
    start(tokensBefore) {
      if (!params.enabled || openedAt !== undefined) {
        return;
      }
      openedAt = Date.now();
      openTokensBefore = compactionTokenCount(tokensBefore);
      emitCompactionTelemetry(target, {
        phase: "start",
        trigger,
        lane,
        provenance: "estimated",
        tokensBefore: openTokensBefore,
      });
    },
    end(outcome) {
      if (openedAt === undefined) {
        return;
      }
      const durationMs = Date.now() - openedAt;
      openedAt = undefined;
      emitCompactionTelemetry(target, {
        phase: "end",
        trigger,
        lane,
        provenance: "estimated",
        completed: outcome.completed,
        tokensBefore: compactionTokenCount(outcome.tokensBefore) ?? openTokensBefore,
        tokensAfter: outcome.tokensAfter,
        // Only a compaction that happened dropped anything.
        tokensDropped: outcome.completed ? outcome.tokensDropped : undefined,
        durationMs,
      });
      if (!callerRunId) {
        clearAgentRunContext(runId);
      }
    },
  };
}
