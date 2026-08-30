import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AgentCompactionMode } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveContextEngine as resolveContextEngineImpl } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildEmbeddedCompactionRuntimeContext } from "../embedded-agent-runner/compaction-runtime-context.js";
import { runContextEngineMaintenance as runContextEngineMaintenanceImpl } from "../embedded-agent-runner/context-engine-maintenance.js";
import { resolveCompactionMode } from "../embedded-agent-runner/extensions.js";
import { shouldPreemptivelyCompactBeforePrompt as shouldPreemptivelyCompactBeforePromptImpl } from "../embedded-agent-runner/run/preemptive-compaction.js";
import { resolveLiveToolResultMaxChars as resolveLiveToolResultMaxCharsImpl } from "../embedded-agent-runner/tool-result-truncation.js";
import { createPreparedEmbeddedPiSettingsManager as createPreparedEmbeddedPiSettingsManagerImpl } from "../pi-project-settings.js";
import { applyPiAutoCompactionGuard as applyPiAutoCompactionGuardImpl } from "../pi-settings.js";
import type { SkillSnapshot } from "../skills.js";
import { recordCliCompactionInStore as recordCliCompactionInStoreImpl } from "./session-store.js";

type SessionManagerLike = ReturnType<typeof SessionManager.open>;
type SettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  getCompactionKeepRecentTokens: () => number;
  applyOverrides: (overrides: {
    compaction: {
      reserveTokens?: number;
      keepRecentTokens?: number;
      // FORK 2026-07-28: must mirror PiSettingsManagerLike — applyPiAutoCompactionGuard
      // disables pi's decider through this override, and the dep slot is contravariant.
      enabled?: boolean;
    };
  }) => void;
  setCompactionEnabled?: (enabled: boolean) => void;
};
type CliCompactionDeps = {
  openSessionManager: (sessionFile: string) => SessionManagerLike;
  resolveContextEngine: (cfg: OpenClawConfig) => Promise<ContextEngine>;
  createPreparedEmbeddedPiSettingsManager: (params: {
    cwd: string;
    agentDir: string;
    cfg?: OpenClawConfig;
    contextTokenBudget?: number;
  }) => SettingsManagerLike | Promise<SettingsManagerLike>;
  applyPiAutoCompactionGuard: (params: {
    settingsManager: SettingsManagerLike;
    contextEngineInfo?: ContextEngine["info"];
    compactionMode?: AgentCompactionMode;
  }) => unknown;
  shouldPreemptivelyCompactBeforePrompt: typeof shouldPreemptivelyCompactBeforePromptImpl;
  resolveLiveToolResultMaxChars: typeof resolveLiveToolResultMaxCharsImpl;
  runContextEngineMaintenance: typeof runContextEngineMaintenanceImpl;
  recordCliCompactionInStore: typeof recordCliCompactionInStoreImpl;
};

const log = createSubsystemLogger("agents/cli-compaction");

const cliCompactionDeps: CliCompactionDeps = {
  openSessionManager: (sessionFile: string) => SessionManager.open(sessionFile),
  resolveContextEngine: resolveContextEngineImpl,
  createPreparedEmbeddedPiSettingsManager: createPreparedEmbeddedPiSettingsManagerImpl,
  applyPiAutoCompactionGuard: applyPiAutoCompactionGuardImpl,
  shouldPreemptivelyCompactBeforePrompt: shouldPreemptivelyCompactBeforePromptImpl,
  resolveLiveToolResultMaxChars: resolveLiveToolResultMaxCharsImpl,
  runContextEngineMaintenance: runContextEngineMaintenanceImpl,
  recordCliCompactionInStore: recordCliCompactionInStoreImpl,
};

export function setCliCompactionTestDeps(overrides: Partial<typeof cliCompactionDeps>): void {
  Object.assign(cliCompactionDeps, overrides);
}

export function resetCliCompactionTestDeps(): void {
  Object.assign(cliCompactionDeps, {
    openSessionManager: (sessionFile: string) => SessionManager.open(sessionFile),
    resolveContextEngine: resolveContextEngineImpl,
    createPreparedEmbeddedPiSettingsManager: createPreparedEmbeddedPiSettingsManagerImpl,
    applyPiAutoCompactionGuard: applyPiAutoCompactionGuardImpl,
    shouldPreemptivelyCompactBeforePrompt: shouldPreemptivelyCompactBeforePromptImpl,
    resolveLiveToolResultMaxChars: resolveLiveToolResultMaxCharsImpl,
    runContextEngineMaintenance: runContextEngineMaintenanceImpl,
    recordCliCompactionInStore: recordCliCompactionInStoreImpl,
  });
}

function resolvePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function getSessionBranchMessages(sessionManager: SessionManagerLike): AgentMessage[] {
  return sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" && typeof entry.message === "object" && entry.message !== null
        ? [entry.message]
        : [],
    );
}

function resolveSessionTokenSnapshot(sessionEntry: SessionEntry | undefined): number | undefined {
  return resolvePositiveInteger(
    sessionEntry?.totalTokensFresh === false ? undefined : sessionEntry?.totalTokens,
  );
}

async function compactCliTranscript(params: {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  sessionManager: SessionManagerLike;
  cfg: OpenClawConfig;
  workspaceDir: string;
  agentDir: string;
  provider: string;
  model: string;
  contextTokenBudget: number;
  currentTokenCount: number;
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  agentAccountId?: string;
  senderIsOwner?: boolean;
  thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  extraSystemPrompt?: string;
}) {
  const runtimeContext = {
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: params.sessionKey,
      messageChannel: params.messageChannel,
      messageProvider: params.messageChannel,
      agentAccountId: params.agentAccountId,
      authProfileId: undefined,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.cfg,
      skillsSnapshot: params.skillsSnapshot,
      senderIsOwner: params.senderIsOwner,
      provider: params.provider,
      modelId: params.model,
      thinkLevel: params.thinkLevel,
      extraSystemPrompt: params.extraSystemPrompt,
    }),
    currentTokenCount: params.currentTokenCount,
    tokenBudget: params.contextTokenBudget,
    trigger: "cli_budget",
  };

  const compactResult = await params.contextEngine.compact({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    tokenBudget: params.contextTokenBudget,
    currentTokenCount: params.currentTokenCount,
    force: true,
    compactionTarget: "budget",
    runtimeContext,
  });

  if (!compactResult.compacted) {
    log.warn(
      `CLI transcript compaction did not reduce context for ${params.provider}/${params.model}: ${compactResult.reason ?? "nothing to compact"}`,
    );
    return false;
  }

  await cliCompactionDeps.runContextEngineMaintenance({
    contextEngine: params.contextEngine,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    reason: "compaction",
    sessionManager: params.sessionManager,
    runtimeContext,
  });
  return true;
}

export async function runCliTurnCompactionLifecycle(params: {
  cfg: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  workspaceDir: string;
  agentDir: string;
  provider: string;
  model: string;
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  agentAccountId?: string;
  senderIsOwner?: boolean;
  thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  extraSystemPrompt?: string;
}): Promise<SessionEntry | undefined> {
  const sessionFile = params.sessionEntry?.sessionFile;
  const contextTokenBudget = resolvePositiveInteger(params.sessionEntry?.contextTokens);
  if (!sessionFile || !contextTokenBudget) {
    return params.sessionEntry;
  }

  const contextEngine = await cliCompactionDeps.resolveContextEngine(params.cfg);
  const sessionManager = cliCompactionDeps.openSessionManager(sessionFile);
  const settingsManager = await cliCompactionDeps.createPreparedEmbeddedPiSettingsManager({
    cwd: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    contextTokenBudget,
  });
  await cliCompactionDeps.applyPiAutoCompactionGuard({
    settingsManager,
    contextEngineInfo: contextEngine.info,
    // FORK 2026-07-28: a non-default compaction mode means one of our extensions owns
    // compaction, so pi's own decider must be off here too. This lane does not call
    // resourceLoader.reload(), so a single application is sufficient.
    compactionMode: resolveCompactionMode(params.cfg),
  });

  // This is a LIVE production decider (it drives the real compaction below), and
  // it used to score its system prompt as 0 tokens — pi's estimateTokens() has no
  // `system` case — and never counted tool schemas at all. Source real sizes from
  // the persisted system-prompt report; sessions written before that report
  // existed simply omit the params and keep the previous behaviour.
  //
  // Deliberate omissions — do not "fix" these without re-reading the producers:
  //  - report.skills.promptChars is NOT added: resolveSkillsPromptForRun()'s output
  //    is spliced INTO the system prompt itself (system-prompt.ts
  //    buildSkillsSection, via buildEmbeddedSystemPrompt), and systemPrompt.chars
  //    measures that assembled prompt, so adding it again would double-count. The
  //    one exception is the tools-allowlist path (attempt.ts drops the skills
  //    prompt but still reports its length), a small known under-count.
  //  - report.tools.listChars is NOT used: it is hardcoded 0 (system-prompt-report.ts).
  //  - entry.schemaChars is only JSON.stringify(tool.parameters).length, roughly
  //    65-73% of the real wire payload. We knowingly under-count rather than invent
  //    an inflation multiplier.
  //  - CLI-produced reports carry `tools: []` (cli-runner/prepare.ts), so the tool
  //    sum is legitimately 0 there and the param is omitted.
  const systemPromptReport = params.sessionEntry?.systemPromptReport;
  const reportedSystemPromptChars = systemPromptReport?.systemPrompt?.chars;
  const reportedToolSchemaChars = systemPromptReport?.tools?.entries?.reduce(
    (sum, entry) =>
      sum + (entry?.schemaChars ?? 0) + (entry?.summaryChars ?? 0) + (entry?.name?.length ?? 0),
    0,
  );

  const preemptiveCompaction = cliCompactionDeps.shouldPreemptivelyCompactBeforePrompt({
    messages: getSessionBranchMessages(sessionManager),
    prompt: "",
    ...(typeof reportedSystemPromptChars === "number" && reportedSystemPromptChars > 0
      ? { systemPromptChars: reportedSystemPromptChars }
      : {}),
    ...(typeof reportedToolSchemaChars === "number" && reportedToolSchemaChars > 0
      ? { toolSchemaChars: reportedToolSchemaChars }
      : {}),
    contextTokenBudget,
    reserveTokens: settingsManager.getCompactionReserveTokens(),
    toolResultMaxChars: cliCompactionDeps.resolveLiveToolResultMaxChars({
      contextWindowTokens: contextTokenBudget,
      cfg: params.cfg,
      agentId: params.sessionAgentId,
    }),
  });
  const tokenSnapshot = resolveSessionTokenSnapshot(params.sessionEntry);
  // A snapshot larger than the context window is definitionally NOT a context
  // size — sessionEntry.totalTokens is historically polluted with the CLI's
  // turn-AGGREGATE usage (input+cache summed across internal steps, up to ~18M
  // on a 1M window), which made compaction fire on every substantive turn.
  const plausibleTokenSnapshot =
    tokenSnapshot !== undefined && tokenSnapshot <= contextTokenBudget ? tokenSnapshot : undefined;
  const currentTokenCount = Math.max(
    preemptiveCompaction.estimatedPromptTokens,
    plausibleTokenSnapshot ?? 0,
  );
  if (
    !preemptiveCompaction.shouldCompact &&
    currentTokenCount <= preemptiveCompaction.promptBudgetBeforeReserve
  ) {
    return params.sessionEntry;
  }

  const compacted = await compactCliTranscript({
    contextEngine,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile,
    sessionManager,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    provider: params.provider,
    model: params.model,
    contextTokenBudget,
    currentTokenCount,
    skillsSnapshot: params.skillsSnapshot,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
    senderIsOwner: params.senderIsOwner,
    thinkLevel: params.thinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
  });

  if (!compacted || !params.sessionStore || !params.storePath) {
    return params.sessionEntry;
  }

  return (
    (await cliCompactionDeps.recordCliCompactionInStore({
      provider: params.provider,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
    })) ?? params.sessionEntry
  );
}
