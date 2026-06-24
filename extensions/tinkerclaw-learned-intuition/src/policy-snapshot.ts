/**
 * FORK: AMYGDALA v3.1 — policy snapshot writer.
 *
 * Compiles the AEGIS rule set (single source of truth, `rule-based-gate.ts`)
 * into two runtime artifacts under the amygdala data dir:
 *
 *   - `policy.json`           — the serialized rules + the hookEnforcement flag,
 *                               read by the dependency-free PreToolUse hook.
 *   - `cc-hook-settings.json` — a claude-cli settings file registering the hook,
 *                               passed by tinker-bridge via `--settings` on every
 *                               spawn. Its mere presence is the enable signal.
 *
 * The hook script is STAGED (copied) into the data dir so the settings can point
 * at a stable absolute path regardless of the dist build layout.
 *
 * When hook enforcement is OFF we still write policy.json (so an observe-only
 * deployment keeps spooling) but DELETE cc-hook-settings.json, which makes
 * tinker-bridge stop injecting `--settings` (no pre-execution deny).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeAegisRules } from "./rule-based-gate.js";

const HOOK_SCRIPT_BASENAME = "amygdala-pretooluse.mjs";

export interface PolicySnapshotConfig {
  /** When false: no pre-execution deny; settings file is removed. */
  hookEnforcement: boolean;
}

export interface PolicyPaths {
  dataDir: string;
  policyPath: string;
  settingsPath: string;
  stagedHookPath: string;
}

export function policyPaths(dataDir?: string): PolicyPaths {
  const dir = dataDir ?? join(homedir(), ".openclaw", "data", "amygdala");
  return {
    dataDir: dir,
    policyPath: join(dir, "policy.json"),
    settingsPath: join(dir, "cc-hook-settings.json"),
    stagedHookPath: join(dir, HOOK_SCRIPT_BASENAME),
  };
}

/** Resolve the source hook script, trying build-relative then source-tree paths. */
function resolveHookSource(): string | null {
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return "";
    }
  })();
  const candidates = [
    here && join(here, "..", "hook", HOOK_SCRIPT_BASENAME),
    here && join(here, "hook", HOOK_SCRIPT_BASENAME),
    join(
      homedir(),
      "src",
      "tinkerclaw",
      "extensions",
      "tinkerclaw-learned-intuition",
      "hook",
      HOOK_SCRIPT_BASENAME,
    ),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

/**
 * Write the policy snapshot and (when enforcement is on) the claude-cli settings
 * file. Returns the staged hook path actually pointed at, or null if no hook
 * source could be found (in which case settings are NOT written — fail-safe).
 */
export function writePolicySnapshot(
  dataDir: string,
  config: PolicySnapshotConfig,
): { staged: string | null; settingsWritten: boolean } {
  const paths = policyPaths(dataDir);
  if (!existsSync(paths.dataDir)) {
    mkdirSync(paths.dataDir, { recursive: true });
  }

  const policy = {
    version: 1,
    generatedAt: new Date().toISOString(),
    hookEnforcement: config.hookEnforcement,
    rules: serializeAegisRules(),
  };
  atomicWrite(paths.policyPath, JSON.stringify(policy, null, 2));

  if (!config.hookEnforcement) {
    removeHookSettings(dataDir);
    return { staged: null, settingsWritten: false };
  }

  const src = resolveHookSource();
  if (!src) {
    // No script to point at — do not write a settings file that would fail.
    removeHookSettings(dataDir);
    return { staged: null, settingsWritten: false };
  }
  try {
    copyFileSync(src, paths.stagedHookPath);
  } catch {
    removeHookSettings(dataDir);
    return { staged: null, settingsWritten: false };
  }

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `node ${paths.stagedHookPath}`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
  atomicWrite(paths.settingsPath, JSON.stringify(settings, null, 2));
  return { staged: paths.stagedHookPath, settingsWritten: true };
}

/** Remove the claude-cli settings file so tinker-bridge stops injecting --settings. */
export function removeHookSettings(dataDir?: string): void {
  const paths = policyPaths(dataDir);
  try {
    if (existsSync(paths.settingsPath)) {
      rmSync(paths.settingsPath);
    }
  } catch {
    /* best-effort */
  }
}

/** Read back the current policy (used by tests / diagnostics). */
export function readPolicy(dataDir?: string): unknown {
  const paths = policyPaths(dataDir);
  try {
    return JSON.parse(readFileSync(paths.policyPath, "utf-8"));
  } catch {
    return null;
  }
}
