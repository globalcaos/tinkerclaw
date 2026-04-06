// extensions/prefrontal/hook-types.ts
// FORK: Local type declarations for OpenClaw plugin hook events.
// These mirror the types from openclaw/plugin-sdk but are declared locally
// to avoid depending on fork-internal source paths. This makes the plugin
// installable on vanilla OpenClaw.

export type PluginHookSubagentSpawnedEvent = {
  runId: string;
  childSessionKey: string;
  label?: string;
  agentId: string;
  [key: string]: unknown;
};

export type PluginHookSubagentEndedEvent = {
  targetSessionKey: string;
  outcome?: string;
  [key: string]: unknown;
};

export type PluginHookSubagentContext = {
  requesterSessionKey?: string;
  [key: string]: unknown;
};

export type PluginHookLlmInputEvent = {
  provider: string;
  model: string;
  runId?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
};

export type PluginHookLlmOutputEvent = {
  usage?: Record<string, unknown>;
  [key: string]: unknown;
};

export type PluginHookAgentEndEvent = {
  success: boolean;
  durationMs?: number;
  usage?: { totalTokens?: number; [key: string]: unknown };
  [key: string]: unknown;
};

export type PluginHookAgentContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  trigger?: string;
  [key: string]: unknown;
};

export type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  [key: string]: unknown;
};

export type PluginHookAfterToolCallEvent = {
  toolName: string;
  [key: string]: unknown;
};

export type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  trigger?: string;
  [key: string]: unknown;
};

export type PluginHookGatewayStartEvent = Record<string, unknown>;
export type PluginHookGatewayStopEvent = Record<string, unknown>;
export type PluginHookGatewayContext = Record<string, unknown>;
