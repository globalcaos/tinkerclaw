/**
 * FORK: files.openInEditor RPC handler — opens a file path in the desktop editor via xdg-open.
 *
 * Accepts `{ path: string }` and enforces a strict allowlist before spawning the OS opener:
 *   - workspaceDir  (resolved from the agent config at call time; skipped if empty)
 *   - ~/.openclaw
 *   - ~/src/tinkerclaw
 *   - ~/src/jarvis-icu
 *
 * Defense-in-depth guards run before the allowlist check:
 *   1. `path` must be a non-empty string.
 *   2. `path` must not contain `..` (traversal attempt).
 *
 * The process is spawned detached with stdio:"ignore" and immediately unref()d so the
 * gateway does not wait for the editor to close.
 *
 * Test seam: call __setSpawnImplForTest() to inject a fake spawn in unit tests.
 *
 * Wired into the gateway via server-methods.ts (spread into the combined handler map).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { GatewayRequestHandlers } from "./types.js";

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

type SpawnImpl = (cmd: string, args: string[]) => Pick<ChildProcess, "unref">;
let spawnImpl: SpawnImpl | null = null;

/** Replace the spawn implementation for unit tests. Pass null to restore default. */
export function __setSpawnImplForTest(impl: SpawnImpl | null): void {
  spawnImpl = impl;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultSpawn(cmd: string, args: string[]): Pick<ChildProcess, "unref"> {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

function buildAllowlist(workspaceDir: string | undefined | null): string[] {
  const home = os.homedir();
  const list: string[] = [];
  if (workspaceDir && workspaceDir.length > 0) list.push(path.resolve(workspaceDir));
  list.push(path.resolve(home, ".openclaw"));
  list.push(path.resolve(home, "src/tinkerclaw"));
  list.push(path.resolve(home, "src/jarvis-icu"));
  return list;
}

function isInsideAllowlist(absPath: string, allowlist: string[]): boolean {
  for (const root of allowlist) {
    const rel = path.relative(root, absPath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const filesOpenHandlers: GatewayRequestHandlers = {
  "files.openInEditor": async ({ params, context, respond }) => {
    // Guard 1: path must be a non-empty string
    const inputPath =
      params && typeof params === "object" ? (params as { path?: unknown }).path : undefined;
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      respond(true, { ok: false, reason: "path is required" }, undefined);
      return;
    }

    // Guard 2: reject traversal attempts early (allowlist check below would also catch these,
    // but an explicit message makes the intent clear to callers)
    if (inputPath.includes("..")) {
      respond(true, { ok: false, reason: "path traversal not allowed" }, undefined);
      return;
    }

    // Resolve to an absolute path before allowlist comparison
    const absPath = path.resolve(inputPath);

    // Build the allowlist using the agent's workspace dir at call time
    const cfg = context.getRuntimeConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const allowlist = buildAllowlist(workspaceDir);

    if (!isInsideAllowlist(absPath, allowlist)) {
      respond(true, { ok: false, reason: "outside allowlist" }, undefined);
      return;
    }

    // Spawn the OS file opener detached so the gateway process doesn't wait for it
    try {
      const fn = spawnImpl ?? defaultSpawn;
      fn("xdg-open", [absPath]);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(true, { ok: false, reason: (err as Error).message }, undefined);
    }
  },
};
