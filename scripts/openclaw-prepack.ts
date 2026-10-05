#!/usr/bin/env -S node --import tsx

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { writePackageDistInventory } from "../src/infra/package-dist-inventory.ts";
const requiredPreparedPathGroups = [["dist/index.js", "dist/index.mjs"]];

type PreparedFileReader = {
  existsSync: typeof existsSync;
};

function normalizeFiles(files: Iterable<string>): Set<string> {
  return new Set(Array.from(files, (file) => file.replace(/\\/g, "/")));
}

export function collectPreparedPrepackErrors(files: Iterable<string>): string[] {
  const normalizedFiles = normalizeFiles(files);
  const errors: string[] = [];

  for (const group of requiredPreparedPathGroups) {
    if (group.some((path) => normalizedFiles.has(path))) {
      continue;
    }
    errors.push(`missing required prepared artifact: ${group.join(" or ")}`);
  }

  // FORK 2026-09-10: stock Control UI retired. Tinker is the operator UI, so
  // dist/control-ui is neither built nor required for packing.
  return errors;
}

function collectPreparedFilePaths(reader: PreparedFileReader = { existsSync }): {
  files: Set<string>;
} {
  const files = new Set<string>();
  for (const group of requiredPreparedPathGroups) {
    for (const path of group) {
      if (reader.existsSync(path)) {
        files.add(path);
      }
    }
  }

  return { files };
}

function ensurePreparedArtifacts(): void {
  try {
    const preparedFiles = collectPreparedFilePaths();
    const errors = collectPreparedPrepackErrors(preparedFiles.files);
    if (errors.length === 0) {
      console.error("prepack: using existing prepared artifacts.");
      return;
    }
    for (const error of errors) {
      console.error(`prepack: ${error}`);
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    console.error(`prepack: failed to verify prepared artifacts: ${message}`);
  }

  console.error(
    "prepack: requires an existing build. Run `pnpm build` before packing or publishing.",
  );
  process.exit(1);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status === 0) {
    return;
  }
  process.exit(result.status ?? 1);
}

function runBuildSmoke(): void {
  run(process.execPath, ["scripts/test-built-bundled-channel-entry-smoke.mjs"]);
}

async function writeDistInventory(): Promise<void> {
  await writePackageDistInventory(process.cwd());
}

async function main(): Promise<void> {
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  run(pnpmCommand, ["build"]);
  run(pnpmCommand, ["ui:build"]);
  ensurePreparedArtifacts();
  await writeDistInventory();
  runBuildSmoke();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
