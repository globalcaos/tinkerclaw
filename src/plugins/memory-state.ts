import type { OpenClawConfig } from "../config/config.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { MemorySearchManager } from "../memory-host-sdk/runtime-files.js";

export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) => string[];

export type MemoryPromptSupplementRegistration = {
  pluginId: string;
  builder: MemoryPromptSectionBuilder;
};

export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
};

export type MemoryFlushPlanResolver = (params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}) => MemoryFlushPlan | null;

export type RegisteredMemorySearchManager = MemorySearchManager;

export type MemoryRuntimeQmdConfig = {
  command?: string;
};

export type MemoryRuntimeBackendConfig =
  | {
      backend: "builtin";
    }
  | {
      backend: "qmd";
      qmd?: MemoryRuntimeQmdConfig;
    };

export type MemoryPluginRuntime = {
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<{
    manager: RegisteredMemorySearchManager | null;
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig;
  closeAllMemorySearchManagers?(): Promise<void>;
};

type MemoryPluginState = {
  promptBuilder?: MemoryPromptSectionBuilder;
  promptSupplements: MemoryPromptSupplementRegistration[];
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
};

const memoryPluginState: MemoryPluginState = {
  promptSupplements: [],
};

export function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void {
  memoryPluginState.promptBuilder = builder;
}

export function registerMemoryPromptSupplement(
  pluginId: string,
  builder: MemoryPromptSectionBuilder,
): void {
  const next = memoryPluginState.promptSupplements.filter(
    (registration) => registration.pluginId !== pluginId,
  );
  next.push({ pluginId, builder });
  memoryPluginState.promptSupplements = next;
}

export function buildMemoryPromptSection(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  const primary = memoryPluginState.promptBuilder?.(params) ?? [];
  const supplements = memoryPluginState.promptSupplements
    // Keep supplement order stable even if plugin registration order changes.
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))
    .flatMap((registration) => registration.builder(params));
  return [...primary, ...supplements];
}

export function getMemoryPromptSectionBuilder(): MemoryPromptSectionBuilder | undefined {
  return memoryPluginState.promptBuilder;
}

export function listMemoryPromptSupplements(): MemoryPromptSupplementRegistration[] {
  return [...memoryPluginState.promptSupplements];
}

export function registerMemoryFlushPlanResolver(resolver: MemoryFlushPlanResolver): void {
  memoryPluginState.flushPlanResolver = resolver;
}

export function resolveMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}): MemoryFlushPlan | null {
  return memoryPluginState.flushPlanResolver?.(params) ?? null;
}

export function getMemoryFlushPlanResolver(): MemoryFlushPlanResolver | undefined {
  return memoryPluginState.flushPlanResolver;
}

export function registerMemoryRuntime(runtime: MemoryPluginRuntime): void {
  memoryPluginState.runtime = runtime;
}

export function getMemoryRuntime(): MemoryPluginRuntime | undefined {
  return memoryPluginState.runtime;
}

export function hasMemoryRuntime(): boolean {
  return memoryPluginState.runtime !== undefined;
}

export function restoreMemoryPluginState(state: MemoryPluginState): void {
  memoryPluginState.promptBuilder = state.promptBuilder;
  memoryPluginState.promptSupplements = [...state.promptSupplements];
  memoryPluginState.flushPlanResolver = state.flushPlanResolver;
  memoryPluginState.runtime = state.runtime;
}

export function clearMemoryPluginState(): void {
  memoryPluginState.promptBuilder = undefined;
  memoryPluginState.promptSupplements = [];
  memoryPluginState.flushPlanResolver = undefined;
  memoryPluginState.runtime = undefined;
}

export const _resetMemoryPluginState = clearMemoryPluginState;
