// extensions/prefrontal/permission-hooks.ts
// FORK: Hook-based permission system — operator-supplied scripts gate tool calls.
//
// SECURITY MODEL (hardened 2026-09-08). This module executes code supplied
// through configuration, on every tool call, inside the gateway process. That
// is the highest-authority surface in this plugin, so it is deliberately
// narrow:
//
//   1. EXPLICIT OPT-IN. Nothing runs unless the operator sets
//      `hooks.enabled: true`. Defining a hook is not by itself consent to
//      execute it.
//   2. NO SHELL. Hooks are executed with execFileSync and `shell: false`.
//      `script` must be a path to an executable file, never a command string,
//      so there is no shell metacharacter, pipeline or interpolation surface.
//   3. PATH ALLOWLIST. The resolved, symlink-followed real path must sit
//      inside one of `hooks.allowedRoots` (default `~/.openclaw/hooks`). A
//      symlink pointing out of an allowed root is rejected, not followed.
//   4. NOT WORLD/GROUP-WRITABLE. A permission gate that anyone on the box can
//      rewrite is not a permission gate.
//   5. LEAST PRIVILEGE ENV. Hooks get PATH/HOME/LANG and nothing else. They do
//      NOT inherit the gateway's environment, which holds the gateway auth
//      token and provider API keys.
//   6. FAIL CLOSED. A hook that times out, crashes, is misconfigured or emits
//      unparseable output DENIES. This reverses the previous behaviour, which
//      approved on error — a gate that approves whenever it breaks provides
//      only the appearance of enforcement.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HookDef {
  /** Tool name to gate, or "*" for every tool. */
  tool: string;
  /** Absolute path (or ~-relative) to an executable file. NOT a shell command. */
  script: string;
  /** Arguments passed to the script. No shell expansion is performed. */
  args?: string[];
  /** Milliseconds before the hook is killed and the call denied. */
  timeout?: number;
}

export interface HookResult {
  decision: "approve" | "deny";
  feedback?: string;
}

export interface PermissionHooksOptions {
  /** Master opt-in. When false (the default) no hook is ever executed. */
  enabled: boolean;
  /** Directories a hook script must live under. Defaults to ~/.openclaw/hooks. */
  allowedRoots?: string[];
  logger?: { warn: (msg: string) => void };
}

export interface PermissionHooks {
  check(toolName: string, context: Record<string, unknown>): Promise<HookResult>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export const DEFAULT_HOOK_ROOT = path.join(os.homedir(), ".openclaw", "hooks");

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** True when `child` is `root` itself or sits underneath it. */
function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

type ValidatedHook =
  | { tool: string; ok: true; scriptPath: string; args: string[]; timeout: number }
  | { tool: string; ok: false; reason: string };

/**
 * Enforce rules 2–4 above. Returns a rejection reason instead of throwing so a
 * bad hook denies its own tools rather than crashing the gateway or, worse,
 * quietly disappearing and leaving the operator believing a gate is active.
 */
function validateHook(hook: HookDef, allowedRoots: string[]): ValidatedHook {
  const tool = hook.tool;
  if (typeof hook.script !== "string" || hook.script.trim() === "") {
    return { tool, ok: false, reason: "hook.script is empty" };
  }
  const candidate = expandHome(hook.script.trim());
  if (!path.isAbsolute(candidate)) {
    return {
      tool,
      ok: false,
      reason: `hook.script must be an absolute path to an executable file, not a command string (got ${JSON.stringify(hook.script)})`,
    };
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(candidate);
  } catch {
    return { tool, ok: false, reason: `hook script not found: ${candidate}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return { tool, ok: false, reason: `cannot stat hook script: ${realPath}` };
  }
  if (!stat.isFile()) {
    return { tool, ok: false, reason: `hook script is not a regular file: ${realPath}` };
  }

  // Compare real paths on both sides so neither a symlinked script nor a
  // symlinked root can be used to step outside the allowlist.
  const roots = allowedRoots.map((r) => {
    try {
      return fs.realpathSync(expandHome(r));
    } catch {
      return path.resolve(expandHome(r));
    }
  });
  if (!roots.some((root) => isInside(root, realPath))) {
    return {
      tool,
      ok: false,
      reason: `hook script ${realPath} is outside the allowed roots [${roots.join(", ")}] — move it there or add the directory to hooks.allowedRoots`,
    };
  }

  // 0o022 = group-write | other-write.
  if ((stat.mode & 0o022) !== 0) {
    return {
      tool,
      ok: false,
      reason: `hook script ${realPath} is group- or world-writable (mode ${(stat.mode & 0o777).toString(8)}) — chmod go-w it`,
    };
  }

  return {
    tool,
    ok: true,
    scriptPath: realPath,
    args: Array.isArray(hook.args) ? hook.args.map(String) : [],
    timeout:
      typeof hook.timeout === "number" && hook.timeout > 0 ? hook.timeout : DEFAULT_TIMEOUT_MS,
  };
}

/** Rule 5: the only environment a hook receives. */
function hookEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG"]) {
    const v = process.env[key];
    if (typeof v === "string") {
      env[key] = v;
    }
  }
  return env;
}

export function createPermissionHooks(
  hooks: HookDef[],
  options: PermissionHooksOptions,
): PermissionHooks {
  const log = options.logger ?? { warn: (m: string) => console.warn(m) };

  if (!options.enabled) {
    if (hooks.length > 0) {
      log.warn(
        `[prefrontal] ${hooks.length} permission hook(s) are configured but NOT running: ` +
          `executing them is opt-in. Set prefrontal config hooks.enabled = true to activate. ` +
          `Until then every tool call is approved by this gate.`,
      );
    }
    return {
      async check() {
        return { decision: "approve" };
      },
    };
  }

  const allowedRoots =
    Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0
      ? options.allowedRoots
      : [DEFAULT_HOOK_ROOT];

  const validated = hooks.map((h) => validateHook(h, allowedRoots));
  for (const v of validated) {
    if (!v.ok) {
      log.warn(
        `[prefrontal] permission hook for tool "${v.tool}" is invalid and will DENY that tool: ${v.reason}`,
      );
    }
  }

  return {
    async check(toolName: string, context: Record<string, unknown>): Promise<HookResult> {
      const matching = validated.filter((h) => h.tool === toolName || h.tool === "*");
      if (matching.length === 0) {
        return { decision: "approve" };
      }

      for (const hook of matching) {
        // Rule 6: a hook we could not validate cannot vouch for this call.
        if (!hook.ok) {
          return {
            decision: "deny",
            feedback: `Permission hook for "${hook.tool}" is misconfigured, so the call is denied: ${hook.reason}`,
          };
        }

        let output: string;
        let stdinDir: string | undefined;
        let stdinFd: number | undefined;
        try {
          // A fast hook can exit before Node finishes writing to a pipe, which
          // makes execFileSync report EPIPE even though the hook succeeded.
          // Feed stdin from an owner-only temporary file instead. The file is
          // removed in the finally block before this check returns.
          stdinDir = fs.mkdtempSync(path.join(os.tmpdir(), "prefrontal-hook-input-"));
          fs.chmodSync(stdinDir, 0o700);
          const stdinPath = path.join(stdinDir, "context.json");
          fs.writeFileSync(stdinPath, JSON.stringify({ tool: toolName, ...context }), {
            encoding: "utf8",
            mode: 0o600,
          });
          stdinFd = fs.openSync(stdinPath, "r");
          output = execFileSync(hook.scriptPath, hook.args, {
            timeout: hook.timeout,
            encoding: "utf-8",
            stdio: [stdinFd, "pipe", "pipe"],
            maxBuffer: MAX_OUTPUT_BYTES,
            env: hookEnv(),
            shell: false,
          });
        } catch (err) {
          return {
            decision: "deny",
            feedback: `Permission hook ${hook.scriptPath} failed or timed out, so the call is denied (fail-closed): ${(err as Error).message}`,
          };
        } finally {
          if (stdinFd !== undefined) {
            fs.closeSync(stdinFd);
          }
          if (stdinDir !== undefined) {
            fs.rmSync(stdinDir, { recursive: true, force: true });
          }
        }

        let parsed: HookResult;
        try {
          parsed = JSON.parse(output.trim()) as HookResult;
        } catch {
          return {
            decision: "deny",
            feedback: `Permission hook ${hook.scriptPath} did not emit valid JSON, so the call is denied (fail-closed).`,
          };
        }
        if (parsed?.decision === "deny") {
          return parsed;
        }
        if (parsed?.decision !== "approve") {
          return {
            decision: "deny",
            feedback: `Permission hook ${hook.scriptPath} returned no usable decision, so the call is denied (fail-closed).`,
          };
        }
      }

      return { decision: "approve" };
    },
  };
}
