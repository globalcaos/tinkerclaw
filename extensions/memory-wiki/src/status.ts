import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { inferWikiPageKind, type WikiPageKind } from "./markdown.js";
import { probeObsidianCli } from "./obsidian.js";

export type MemoryWikiStatusWarning = {
  code:
    | "vault-missing"
    | "obsidian-cli-missing"
    | "bridge-disabled"
    | "unsafe-local-disabled"
    | "unsafe-local-paths-missing"
    | "unsafe-local-without-mode";
  message: string;
};

export type MemoryWikiStatus = {
  vaultMode: ResolvedMemoryWikiConfig["vaultMode"];
  renderMode: ResolvedMemoryWikiConfig["vault"]["renderMode"];
  vaultPath: string;
  vaultExists: boolean;
  bridge: ResolvedMemoryWikiConfig["bridge"];
  obsidianCli: {
    enabled: boolean;
    requested: boolean;
    available: boolean;
    command: string | null;
  };
  unsafeLocal: {
    allowPrivateMemoryCoreAccess: boolean;
    pathCount: number;
  };
  pageCounts: Record<WikiPageKind, number>;
  warnings: MemoryWikiStatusWarning[];
};

type ResolveMemoryWikiStatusDeps = {
  pathExists?: (inputPath: string) => Promise<boolean>;
  resolveCommand?: (command: string) => Promise<string | null>;
};

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

async function collectPageCounts(vaultPath: string): Promise<Record<WikiPageKind, number>> {
  const counts: Record<WikiPageKind, number> = {
    entity: 0,
    concept: 0,
    source: 0,
    synthesis: 0,
    report: 0,
  };
  const dirs = ["entities", "concepts", "sources", "syntheses", "reports"] as const;
  for (const dir of dirs) {
    const entries = await fs
      .readdir(path.join(vaultPath, dir), { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
        continue;
      }
      const kind = inferWikiPageKind(path.join(dir, entry.name));
      if (kind) {
        counts[kind] += 1;
      }
    }
  }
  return counts;
}

function buildWarnings(params: {
  config: ResolvedMemoryWikiConfig;
  vaultExists: boolean;
  obsidianCommand: string | null;
}): MemoryWikiStatusWarning[] {
  const warnings: MemoryWikiStatusWarning[] = [];
  if (!params.vaultExists) {
    warnings.push({
      code: "vault-missing",
      message: "Wiki vault has not been initialized yet.",
    });
  }
  if (
    params.config.obsidian.enabled &&
    params.config.obsidian.useOfficialCli &&
    !params.obsidianCommand
  ) {
    warnings.push({
      code: "obsidian-cli-missing",
      message: "Obsidian CLI is enabled in config but `obsidian` is not available on PATH.",
    });
  }
  if (params.config.vaultMode === "bridge" && !params.config.bridge.enabled) {
    warnings.push({
      code: "bridge-disabled",
      message: "vaultMode is `bridge` but bridge.enabled is false.",
    });
  }
  if (
    params.config.vaultMode === "unsafe-local" &&
    !params.config.unsafeLocal.allowPrivateMemoryCoreAccess
  ) {
    warnings.push({
      code: "unsafe-local-disabled",
      message: "vaultMode is `unsafe-local` but private memory-core access is disabled.",
    });
  }
  if (
    params.config.vaultMode === "unsafe-local" &&
    params.config.unsafeLocal.allowPrivateMemoryCoreAccess &&
    params.config.unsafeLocal.paths.length === 0
  ) {
    warnings.push({
      code: "unsafe-local-paths-missing",
      message: "unsafe-local access is enabled but no private paths are configured.",
    });
  }
  if (
    params.config.vaultMode !== "unsafe-local" &&
    params.config.unsafeLocal.allowPrivateMemoryCoreAccess
  ) {
    warnings.push({
      code: "unsafe-local-without-mode",
      message: "Private memory-core access is enabled outside unsafe-local mode.",
    });
  }
  return warnings;
}

export async function resolveMemoryWikiStatus(
  config: ResolvedMemoryWikiConfig,
  deps?: ResolveMemoryWikiStatusDeps,
): Promise<MemoryWikiStatus> {
  const exists = deps?.pathExists ?? pathExists;
  const vaultExists = await exists(config.vault.path);
  const obsidianProbe = await probeObsidianCli({ resolveCommand: deps?.resolveCommand });
  const pageCounts = vaultExists
    ? await collectPageCounts(config.vault.path)
    : {
        entity: 0,
        concept: 0,
        source: 0,
        synthesis: 0,
        report: 0,
      };

  return {
    vaultMode: config.vaultMode,
    renderMode: config.vault.renderMode,
    vaultPath: config.vault.path,
    vaultExists,
    bridge: config.bridge,
    obsidianCli: {
      enabled: config.obsidian.enabled,
      requested: config.obsidian.enabled && config.obsidian.useOfficialCli,
      available: obsidianProbe.available,
      command: obsidianProbe.command,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: config.unsafeLocal.allowPrivateMemoryCoreAccess,
      pathCount: config.unsafeLocal.paths.length,
    },
    pageCounts,
    warnings: buildWarnings({ config, vaultExists, obsidianCommand: obsidianProbe.command }),
  };
}

export function renderMemoryWikiStatus(status: MemoryWikiStatus): string {
  const lines = [
    `Wiki vault mode: ${status.vaultMode}`,
    `Vault: ${status.vaultExists ? "ready" : "missing"} (${status.vaultPath})`,
    `Render mode: ${status.renderMode}`,
    `Obsidian CLI: ${status.obsidianCli.available ? "available" : "missing"}${status.obsidianCli.requested ? " (requested)" : ""}`,
    `Bridge: ${status.bridge.enabled ? "enabled" : "disabled"}`,
    `Unsafe local: ${status.unsafeLocal.allowPrivateMemoryCoreAccess ? `enabled (${status.unsafeLocal.pathCount} paths)` : "disabled"}`,
    `Pages: ${status.pageCounts.source} sources, ${status.pageCounts.entity} entities, ${status.pageCounts.concept} concepts, ${status.pageCounts.synthesis} syntheses, ${status.pageCounts.report} reports`,
  ];

  if (status.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of status.warnings) {
      lines.push(`- ${warning.message}`);
    }
  }

  return lines.join("\n");
}
