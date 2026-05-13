import fs from "node:fs";
import path from "node:path";
import { collectFilesSync, isCodeFile, relativeToCwd } from "./check-file-utils.js";

const FORBIDDEN_REPO_SRC_IMPORT = /["'](?:\.\.\/)+(?:src\/)[^"']+["']/;

// FORK: Extensions that legitimately import from src/ (fork-specific features).
// These can't use plugin-sdk subpaths because they access fork-internal APIs.
const FORK_EXTENSION_ALLOWLIST = new Set([
  "auth-reload",
  "budget-panel",
  "overseer",
  "tinkerclaw-tinker", // FORK: renamed from tinker; context-anatomy API + Tinker UI server uses fork-internal db
  "tinkerclaw-prefrontal", // FORK: imports from src/gateway/protocol/schema/ + runtime require of src/gateway/
  "whatsapp", // FORK: process-message-hooks + live-capture imports
  "tinkerclaw-whatsapp", // FORK: whatsapp history + backfill bridge uses fork-internal db/capture APIs
]);

function isProductionExtensionFile(filePath: string): boolean {
  return !(
    filePath.endsWith("/runtime-api.ts") ||
    filePath.endsWith("\\runtime-api.ts") ||
    filePath.includes(".test.") ||
    filePath.includes(".spec.") ||
    filePath.includes(".fixture.") ||
    filePath.includes(".snap") ||
    filePath.includes("test-harness") ||
    filePath.includes("test-support") ||
    filePath.includes("/__tests__/") ||
    filePath.includes("/coverage/") ||
    filePath.includes("/dist/") ||
    filePath.includes("/node_modules/")
  );
}

function isForkAllowlisted(filePath: string): boolean {
  const rel = path.relative(path.join(process.cwd(), "extensions"), filePath);
  const extName = rel.split(path.sep)[0];
  return FORK_EXTENSION_ALLOWLIST.has(extName ?? "");
}

function collectExtensionSourceFiles(rootDir: string): string[] {
  return collectFilesSync(rootDir, {
    includeFile: (filePath) => isCodeFile(filePath) && isProductionExtensionFile(filePath),
  });
}

function main() {
  const extensionsDir = path.join(process.cwd(), "extensions");
  const files = collectExtensionSourceFiles(extensionsDir);
  const offenders: string[] = [];

  for (const file of files) {
    if (isForkAllowlisted(file)) {
      continue;
    }
    const content = fs.readFileSync(file, "utf8");
    if (FORBIDDEN_REPO_SRC_IMPORT.test(content)) {
      offenders.push(file);
    }
  }

  if (offenders.length > 0) {
    console.error("Production extension files must not import the repo src/ tree directly.");
    for (const offender of offenders.toSorted()) {
      console.error(`- ${relativeToCwd(offender)}`);
    }
    console.error(
      "Publish a focused openclaw/plugin-sdk/<subpath> surface or use the extension's own public barrel instead.",
    );
    process.exit(1);
  }

  console.log(
    `OK: production extension files avoid direct repo src/ imports (${files.length} checked).`,
  );
}

main();
