import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedMemoryWikiConfig } from "./config.js";

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

async function isExecutableFile(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandOnPath(command: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const windowsExts =
    process.platform === "win32"
      ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"])
      : [""];

  if (command.includes(path.sep)) {
    return (await isExecutableFile(command)) ? command : null;
  }

  for (const dir of pathEntries) {
    for (const extension of windowsExts) {
      const candidate = path.join(dir, extension ? `${command}${extension}` : command);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
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
  const resolveCommand = deps?.resolveCommand ?? resolveCommandOnPath;
  const vaultExists = await exists(config.vault.path);
  const obsidianCommand = await resolveCommand("obsidian");

  return {
    vaultMode: config.vaultMode,
    renderMode: config.vault.renderMode,
    vaultPath: config.vault.path,
    vaultExists,
    bridge: config.bridge,
    obsidianCli: {
      enabled: config.obsidian.enabled,
      requested: config.obsidian.enabled && config.obsidian.useOfficialCli,
      available: obsidianCommand !== null,
      command: obsidianCommand,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: config.unsafeLocal.allowPrivateMemoryCoreAccess,
      pathCount: config.unsafeLocal.paths.length,
    },
    warnings: buildWarnings({ config, vaultExists, obsidianCommand }),
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
  ];

  if (status.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of status.warnings) {
      lines.push(`- ${warning.message}`);
    }
  }

  return lines.join("\n");
}
