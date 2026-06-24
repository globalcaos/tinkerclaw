/**
 * FORK: briefing.resolve RPC handler — resolves the active briefing file for /new injection.
 *
 * Resolution order:
 *   1. `${workspaceDir}/BRIEFING.md` — user-owned workspace override
 *   2. Bundled `briefing-default.md` alongside tinkerclaw-tinker-bridge/prompts/ — shipped default
 *   3. Neither found → null fields + error string
 *
 * Wired into the gateway via server-methods.ts (spread into the combined handler map).
 * Consumed by the /new command in tinkerclaw-tinker-bridge to inject the briefing prompt.
 *
 * The `__testNoBundleSearch` param (test-only) disables the bundled-path search so the
 * "neither found" branch is reachable without removing the actual file from disk.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Candidate relative paths from this file's dist location to briefing-default.md. */
const BUNDLED_BRIEFING_RELATIVE_PATHS = [
  "../../../extensions/tinkerclaw-tinker-bridge/prompts/briefing-default.md",
  "../../extensions/tinkerclaw-tinker-bridge/prompts/briefing-default.md",
  "../extensions/tinkerclaw-tinker-bridge/prompts/briefing-default.md",
];

async function resolveBundledBriefingPath(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of BUNDLED_BRIEFING_RELATIVE_PATHS) {
    const candidate = path.resolve(here, rel);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export const briefingHandlers: GatewayRequestHandlers = {
  "briefing.resolve": async ({ params, context, respond }) => {
    const cfg = context.getRuntimeConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));

    // 1. Workspace override — user-editable BRIEFING.md
    if (workspaceDir) {
      const wsPath = path.join(workspaceDir, "BRIEFING.md");
      try {
        const wsContent = await readIfExists(wsPath);
        if (wsContent !== null) {
          respond(true, { path: wsPath, source: "workspace", content: wsContent }, undefined);
          return;
        }
      } catch (err) {
        console.warn(
          `[briefing.resolve] workspace read failed at ${wsPath}, falling back to bundled:`,
          err,
        );
      }
    }

    // 2. Bundled default — skipped when __testNoBundleSearch is set (test-only escape hatch)
    const skipBundle =
      params &&
      typeof params === "object" &&
      (params as { __testNoBundleSearch?: boolean }).__testNoBundleSearch;

    const bundledPath = skipBundle ? null : await resolveBundledBriefingPath();
    if (bundledPath) {
      const content = await readIfExists(bundledPath);
      if (content !== null) {
        respond(true, { path: bundledPath, source: "bundled", content }, undefined);
        return;
      }
    }

    // 3. Neither found
    respond(
      true,
      { path: null, source: null, content: null, error: "no briefing file found" },
      undefined,
    );
  },
};
