import { vi } from "vitest";

export type StubbedCoreTool = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown> };
  ownerOnly?: boolean;
  execute: (...args: unknown[]) => unknown;
};

export function stubOpenClawCoreTool(name: string, options?: { ownerOnly?: boolean }) {
  return {
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn() as unknown as (...args: unknown[]) => unknown,
    ...(options?.ownerOnly ? { ownerOnly: true } : {}),
  } satisfies StubbedCoreTool;
}

export const fastOpenClawToolFactoryMocks = {
  createImageGenerateTool: vi.fn<(...args: unknown[]) => StubbedCoreTool | null>(() => null),
  createVideoGenerateTool: vi.fn<(...args: unknown[]) => StubbedCoreTool | null>(() => null),
};

vi.mock("../tools/agents-list-tool.js", () => ({
  createAgentsListTool: () => stubOpenClawCoreTool("agents_list"),
}));

vi.mock("../tools/canvas-tool.js", () => ({
  createCanvasTool: () => stubOpenClawCoreTool("canvas"),
}));

vi.mock("../tools/cron-tool.js", () => ({
  createCronTool: () => stubOpenClawCoreTool("cron", { ownerOnly: true }),
}));

vi.mock("../tools/gateway-tool.js", () => ({
  createGatewayTool: () => stubOpenClawCoreTool("gateway", { ownerOnly: true }),
}));

vi.mock("../tools/image-generate-tool.js", () => ({
  createImageGenerateTool: (...args: unknown[]) =>
    fastOpenClawToolFactoryMocks.createImageGenerateTool(...args),
}));

vi.mock("../tools/image-tool.js", () => ({
  createImageTool: () => null,
}));

vi.mock("../tools/message-tool.js", () => ({
  createMessageTool: () => stubOpenClawCoreTool("message"),
}));

vi.mock("../tools/music-generate-tool.js", () => ({
  createMusicGenerateTool: () => null,
}));

vi.mock("../tools/nodes-tool.js", () => ({
  createNodesTool: () => stubOpenClawCoreTool("nodes", { ownerOnly: true }),
}));

vi.mock("../tools/pdf-tool.js", () => ({
  createPdfTool: () => null,
}));

vi.mock("../tools/session-status-tool.js", () => ({
  createSessionStatusTool: () => stubOpenClawCoreTool("session_status"),
}));

vi.mock("../tools/sessions-history-tool.js", () => ({
  createSessionsHistoryTool: () => stubOpenClawCoreTool("sessions_history"),
}));

vi.mock("../tools/sessions-list-tool.js", () => ({
  createSessionsListTool: () => stubOpenClawCoreTool("sessions_list"),
}));

vi.mock("../tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: () => stubOpenClawCoreTool("sessions_send"),
}));

vi.mock("../tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: () => stubOpenClawCoreTool("sessions_spawn"),
}));

vi.mock("../tools/sessions-yield-tool.js", () => ({
  createSessionsYieldTool: () => stubOpenClawCoreTool("sessions_yield"),
}));

vi.mock("../tools/subagents-tool.js", () => ({
  createSubagentsTool: () => stubOpenClawCoreTool("subagents"),
}));

vi.mock("../tools/tts-tool.js", () => ({
  createTtsTool: () => stubOpenClawCoreTool("tts"),
}));

vi.mock("../tools/update-plan-tool.js", () => ({
  createUpdatePlanTool: () => stubOpenClawCoreTool("update_plan"),
}));

vi.mock("../tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: (...args: unknown[]) =>
    fastOpenClawToolFactoryMocks.createVideoGenerateTool(...args),
}));

vi.mock("../tools/web-tools.js", () => ({
  createWebSearchTool: () => null,
  createWebFetchTool: () => null,
}));

vi.mock("../openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));
