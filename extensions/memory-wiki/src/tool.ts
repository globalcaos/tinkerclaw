import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources } from "./bridge.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { renderMemoryWikiStatus, resolveMemoryWikiStatus } from "./status.js";

const WikiStatusSchema = Type.Object({}, { additionalProperties: false });
const WikiSearchSchema = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    maxResults: Type.Optional(Type.Number({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const WikiGetSchema = Type.Object(
  {
    lookup: Type.String({ minLength: 1 }),
    fromLine: Type.Optional(Type.Number({ minimum: 1 })),
    lineCount: Type.Optional(Type.Number({ minimum: 1 })),
  },
  { additionalProperties: false },
);

async function syncBridgeIfNeeded(config: ResolvedMemoryWikiConfig, appConfig?: OpenClawConfig) {
  await syncMemoryWikiBridgeSources({ config, appConfig });
}

export function createWikiStatusTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "wiki_status",
    label: "Wiki Status",
    description:
      "Inspect the current memory wiki vault mode, health, and Obsidian CLI availability.",
    parameters: WikiStatusSchema,
    execute: async () => {
      await syncBridgeIfNeeded(config, appConfig);
      const status = await resolveMemoryWikiStatus(config);
      return {
        content: [{ type: "text", text: renderMemoryWikiStatus(status) }],
        details: status,
      };
    },
  };
}

export function createWikiSearchTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "wiki_search",
    label: "Wiki Search",
    description: "Search wiki pages by title, path, id, or body text.",
    parameters: WikiSearchSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { query: string; maxResults?: number };
      await syncBridgeIfNeeded(config, appConfig);
      const results = await searchMemoryWiki({
        config,
        query: params.query,
        maxResults: params.maxResults,
      });
      const text =
        results.length === 0
          ? "No wiki results."
          : results
              .map(
                (result, index) =>
                  `${index + 1}. ${result.title} (${result.kind})\nPath: ${result.path}\nSnippet: ${result.snippet}`,
              )
              .join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: { results },
      };
    },
  };
}

export function createWikiGetTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "wiki_get",
    label: "Wiki Get",
    description: "Read a wiki page by id or relative path.",
    parameters: WikiGetSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { lookup: string; fromLine?: number; lineCount?: number };
      await syncBridgeIfNeeded(config, appConfig);
      const result = await getMemoryWikiPage({
        config,
        lookup: params.lookup,
        fromLine: params.fromLine,
        lineCount: params.lineCount,
      });
      if (!result) {
        return {
          content: [{ type: "text", text: `Wiki page not found: ${params.lookup}` }],
          details: { found: false },
        };
      }
      return {
        content: [{ type: "text", text: result.content }],
        details: { found: true, ...result },
      };
    },
  };
}
