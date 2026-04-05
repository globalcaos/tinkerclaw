import type { Command } from "commander";
import { compileMemoryWikiVault } from "./compile.js";
import type { MemoryWikiPluginConfig, ResolvedMemoryWikiConfig } from "./config.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { lintMemoryWikiVault } from "./lint.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { renderMemoryWikiStatus, resolveMemoryWikiStatus } from "./status.js";
import { initializeMemoryWikiVault } from "./vault.js";

type WikiStatusCommandOptions = {
  json?: boolean;
};

type WikiInitCommandOptions = {
  json?: boolean;
};

type WikiCompileCommandOptions = {
  json?: boolean;
};

type WikiLintCommandOptions = {
  json?: boolean;
};

type WikiIngestCommandOptions = {
  json?: boolean;
  title?: string;
};

type WikiSearchCommandOptions = {
  json?: boolean;
  maxResults?: number;
};

type WikiGetCommandOptions = {
  json?: boolean;
  from?: number;
  lines?: number;
};

function writeOutput(output: string, writer: Pick<NodeJS.WriteStream, "write"> = process.stdout) {
  writer.write(output.endsWith("\n") ? output : `${output}\n`);
}

export async function runWikiStatus(params: {
  config: ResolvedMemoryWikiConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const status = await resolveMemoryWikiStatus(params.config);
  writeOutput(
    params.json ? JSON.stringify(status, null, 2) : renderMemoryWikiStatus(status),
    params.stdout,
  );
  return status;
}

export async function runWikiInit(params: {
  config: ResolvedMemoryWikiConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await initializeMemoryWikiVault(params.config);
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `Initialized wiki vault at ${result.rootDir} (${result.createdDirectories.length} dirs, ${result.createdFiles.length} files).`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiCompile(params: {
  config: ResolvedMemoryWikiConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await compileMemoryWikiVault(params.config);
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `Compiled wiki vault at ${result.vaultRoot} (${result.pages.length} pages, ${result.updatedFiles.length} indexes updated).`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiLint(params: {
  config: ResolvedMemoryWikiConfig;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await lintMemoryWikiVault(params.config);
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `Linted wiki vault at ${result.vaultRoot} (${result.issueCount} issues, report: ${result.reportPath}).`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiIngest(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  title?: string;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await ingestMemoryWikiSource({
    config: params.config,
    inputPath: params.inputPath,
    title: params.title,
  });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : `Ingested ${result.sourcePath} into ${result.pagePath}.`;
  writeOutput(summary, params.stdout);
  return result;
}

export async function runWikiSearch(params: {
  config: ResolvedMemoryWikiConfig;
  query: string;
  maxResults?: number;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const results = await searchMemoryWiki({
    config: params.config,
    query: params.query,
    maxResults: params.maxResults,
  });
  const summary = params.json
    ? JSON.stringify(results, null, 2)
    : results.length === 0
      ? "No wiki results."
      : results
          .map(
            (result, index) =>
              `${index + 1}. ${result.title} (${result.kind})\nPath: ${result.path}\nSnippet: ${result.snippet}`,
          )
          .join("\n\n");
  writeOutput(summary, params.stdout);
  return results;
}

export async function runWikiGet(params: {
  config: ResolvedMemoryWikiConfig;
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  json?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}) {
  const result = await getMemoryWikiPage({
    config: params.config,
    lookup: params.lookup,
    fromLine: params.fromLine,
    lineCount: params.lineCount,
  });
  const summary = params.json
    ? JSON.stringify(result, null, 2)
    : (result?.content ?? `Wiki page not found: ${params.lookup}`);
  writeOutput(summary, params.stdout);
  return result;
}

export function registerWikiCli(program: Command, pluginConfig?: MemoryWikiPluginConfig) {
  const config = resolveMemoryWikiConfig(pluginConfig);
  const wiki = program.command("wiki").description("Inspect and initialize the memory wiki vault");

  wiki
    .command("status")
    .description("Show wiki vault status")
    .option("--json", "Print JSON")
    .action(async (opts: WikiStatusCommandOptions) => {
      await runWikiStatus({ config, json: opts.json });
    });

  wiki
    .command("init")
    .description("Initialize the wiki vault layout")
    .option("--json", "Print JSON")
    .action(async (opts: WikiInitCommandOptions) => {
      await runWikiInit({ config, json: opts.json });
    });

  wiki
    .command("compile")
    .description("Refresh generated wiki indexes")
    .option("--json", "Print JSON")
    .action(async (opts: WikiCompileCommandOptions) => {
      await runWikiCompile({ config, json: opts.json });
    });

  wiki
    .command("lint")
    .description("Lint the wiki vault and write a report")
    .option("--json", "Print JSON")
    .action(async (opts: WikiLintCommandOptions) => {
      await runWikiLint({ config, json: opts.json });
    });

  wiki
    .command("ingest")
    .description("Ingest a local file into the wiki sources folder")
    .argument("<path>", "Local file path to ingest")
    .option("--title <title>", "Override the source title")
    .option("--json", "Print JSON")
    .action(async (inputPath: string, opts: WikiIngestCommandOptions) => {
      await runWikiIngest({ config, inputPath, title: opts.title, json: opts.json });
    });

  wiki
    .command("search")
    .description("Search wiki pages")
    .argument("<query>", "Search query")
    .option("--max-results <n>", "Maximum results", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(async (query: string, opts: WikiSearchCommandOptions) => {
      await runWikiSearch({
        config,
        query,
        maxResults: opts.maxResults,
        json: opts.json,
      });
    });

  wiki
    .command("get")
    .description("Read a wiki page by id or relative path")
    .argument("<lookup>", "Relative path or page id")
    .option("--from <n>", "Start line", (value: string) => Number(value))
    .option("--lines <n>", "Number of lines", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(async (lookup: string, opts: WikiGetCommandOptions) => {
      await runWikiGet({
        config,
        lookup,
        fromLine: opts.from,
        lineCount: opts.lines,
        json: opts.json,
      });
    });
}
