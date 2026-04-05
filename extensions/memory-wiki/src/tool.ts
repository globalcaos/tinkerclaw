import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { renderMemoryWikiStatus, resolveMemoryWikiStatus } from "./status.js";

const WikiStatusSchema = Type.Object({}, { additionalProperties: false });

export function createWikiStatusTool(config: ResolvedMemoryWikiConfig): AnyAgentTool {
  return {
    name: "wiki_status",
    label: "Wiki Status",
    description:
      "Inspect the current memory wiki vault mode, health, and Obsidian CLI availability.",
    parameters: WikiStatusSchema,
    execute: async () => {
      const status = await resolveMemoryWikiStatus(config);
      return {
        content: [{ type: "text", text: renderMemoryWikiStatus(status) }],
        details: status,
      };
    },
  };
}
