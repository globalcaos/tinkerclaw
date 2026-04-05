import type { Command } from "commander";
import type { MemoryWikiPluginConfig, ResolvedMemoryWikiConfig } from "./config.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { renderMemoryWikiStatus, resolveMemoryWikiStatus } from "./status.js";
import { initializeMemoryWikiVault } from "./vault.js";

type WikiStatusCommandOptions = {
  json?: boolean;
};

type WikiInitCommandOptions = {
  json?: boolean;
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
}
