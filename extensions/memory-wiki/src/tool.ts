import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawConfig } from "../api.js";
import { applyMemoryWikiMutation, type ApplyMemoryWikiMutation } from "./apply.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { renderMemoryWikiStatus, resolveMemoryWikiStatus } from "./status.js";

const WikiStatusSchema = Type.Object({}, { additionalProperties: false });
const WikiLintSchema = Type.Object({}, { additionalProperties: false });
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
const WikiApplySchema = Type.Object(
  {
    op: Type.Union([Type.Literal("create_synthesis"), Type.Literal("update_metadata")]),
    title: Type.Optional(Type.String({ minLength: 1 })),
    body: Type.Optional(Type.String({ minLength: 1 })),
    lookup: Type.Optional(Type.String({ minLength: 1 })),
    sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    contradictions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    questions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    confidence: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()])),
    status: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

async function syncImportedSourcesIfNeeded(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
) {
  await syncMemoryWikiImportedSources({ config, appConfig });
}

function normalizeWikiApplyMutation(rawParams: unknown): ApplyMemoryWikiMutation {
  const params = rawParams as {
    op: ApplyMemoryWikiMutation["op"];
    title?: string;
    body?: string;
    lookup?: string;
    sourceIds?: string[];
    contradictions?: string[];
    questions?: string[];
    confidence?: number | null;
    status?: string;
  };
  if (params.op === "create_synthesis") {
    if (!params.title?.trim()) {
      throw new Error("wiki_apply requires title for create_synthesis.");
    }
    if (!params.body?.trim()) {
      throw new Error("wiki_apply requires body for create_synthesis.");
    }
    if (!params.sourceIds || params.sourceIds.length === 0) {
      throw new Error("wiki_apply requires at least one sourceId for create_synthesis.");
    }
    return {
      op: "create_synthesis",
      title: params.title,
      body: params.body,
      sourceIds: params.sourceIds,
      ...(params.contradictions ? { contradictions: params.contradictions } : {}),
      ...(params.questions ? { questions: params.questions } : {}),
      ...(typeof params.confidence === "number" ? { confidence: params.confidence } : {}),
      ...(params.status ? { status: params.status } : {}),
    };
  }
  if (!params.lookup?.trim()) {
    throw new Error("wiki_apply requires lookup for update_metadata.");
  }
  return {
    op: "update_metadata",
    lookup: params.lookup,
    ...(params.sourceIds ? { sourceIds: params.sourceIds } : {}),
    ...(params.contradictions ? { contradictions: params.contradictions } : {}),
    ...(params.questions ? { questions: params.questions } : {}),
    ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
    ...(params.status ? { status: params.status } : {}),
  };
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
      await syncImportedSourcesIfNeeded(config, appConfig);
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
      await syncImportedSourcesIfNeeded(config, appConfig);
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

export function createWikiLintTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "wiki_lint",
    label: "Wiki Lint",
    description:
      "Lint the wiki vault and surface structural issues, provenance gaps, contradictions, and open questions.",
    parameters: WikiLintSchema,
    execute: async () => {
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await lintMemoryWikiVault(config);
      const contradictions = result.issuesByCategory.contradictions.length;
      const openQuestions = result.issuesByCategory["open-questions"].length;
      const provenance = result.issuesByCategory.provenance.length;
      const errors = result.issues.filter((issue) => issue.severity === "error").length;
      const warnings = result.issues.filter((issue) => issue.severity === "warning").length;
      const summary =
        result.issueCount === 0
          ? "No wiki lint issues."
          : [
              `Issues: ${result.issueCount} total (${errors} errors, ${warnings} warnings)`,
              `Contradictions: ${contradictions}`,
              `Open questions: ${openQuestions}`,
              `Provenance gaps: ${provenance}`,
              `Report: ${result.reportPath}`,
            ].join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: result,
      };
    },
  };
}

export function createWikiApplyTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "wiki_apply",
    label: "Wiki Apply",
    description:
      "Apply narrow wiki mutations for syntheses and page metadata without freeform markdown surgery.",
    parameters: WikiApplySchema,
    execute: async (_toolCallId, rawParams) => {
      const mutation = normalizeWikiApplyMutation(rawParams);
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await applyMemoryWikiMutation({ config, mutation });
      const action = result.changed ? "Updated" : "No changes for";
      const compileSummary =
        result.compile.updatedFiles.length > 0
          ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.`
          : "Indexes unchanged.";
      return {
        content: [
          {
            type: "text",
            text: `${action} ${result.pagePath} via ${result.operation}. ${compileSummary}`,
          },
        ],
        details: result,
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
      await syncImportedSourcesIfNeeded(config, appConfig);
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
