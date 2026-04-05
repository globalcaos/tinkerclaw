import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources, type BridgeMemoryWikiResult } from "./bridge.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

export async function syncMemoryWikiImportedSources(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
}): Promise<BridgeMemoryWikiResult> {
  if (params.config.vaultMode === "bridge") {
    return await syncMemoryWikiBridgeSources(params);
  }
  if (params.config.vaultMode === "unsafe-local") {
    return await syncMemoryWikiUnsafeLocalSources(params.config);
  }
  return {
    importedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    artifactCount: 0,
    workspaces: 0,
    pagePaths: [],
  };
}
