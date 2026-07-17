/**
 * FORK 2026-05-09 — Restored `config.openExternalFile` RPC.
 *
 * Bible §5.68 ("Clickable Filesystem Path Links", 2026-04-19) documented this
 * RPC as DEPLOYED, but the actual handler implementation was lost — likely
 * wiped by an upstream merge somewhere between April 19 and May 9. Verified
 * by `grep -rn openExternalFile src/ extensions/ dist/` returning zero hits
 * on 2026-05-09 14:26. The client-side `.fs-link` global click delegate at
 * `tinker-ui/src/app.ts:5777-5807` was sending requests; the gateway was
 * rejecting all of them with `unknown method: config.openExternalFile`.
 *
 * Symptom that surfaced the breakage: clicking the path in the new /new
 * briefing summary did nothing. Every other `.fs-link` click across Tinker
 * (recipe paths, system-message paths, fractal pointers) had been silently
 * failing for an unknown duration.
 *
 * Behavior contract (matches bible §5.68):
 *   - Param: { path: string } — supports `~/…` expansion + absolute paths.
 *   - Returns: { ok: boolean, error?: string, path?: string }.
 *   - Allowlist: workspaceDir, ~/.openclaw, ~/src/tinkerclaw, ~/src/jarvis-icu.
 *   - Cross-platform: xdg-open (linux), open (macOS), Start-Process (windows).
 *   - Detached + stdio:"ignore" + unref so the editor outlives the gateway.
 *   - Symlink escape NOT defended — relies on ADMIN_SCOPE gating + trusted
 *     callers (this RPC is not exposed to untrusted operators).
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { GatewayRequestHandlers } from "./types.js";

type SpawnImpl = (cmd: string, args: string[]) => Pick<ChildProcess, "unref">;

let spawnImpl: SpawnImpl | null = null;
/** Test seam — pass null to restore default. */
export function __setSpawnImplForTest(impl: SpawnImpl | null): void {
  spawnImpl = impl;
}

function defaultSpawn(cmd: string, args: string[]): Pick<ChildProcess, "unref"> {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

function expandTilde(input: string): string {
  if (input === "~" || input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function buildAllowlist(workspaceDir: string | undefined | null): string[] {
  const home = os.homedir();
  const list: string[] = [];
  if (workspaceDir && workspaceDir.length > 0) list.push(path.resolve(workspaceDir));
  list.push(path.resolve(home, ".openclaw"));
  list.push(path.resolve(home, "src/tinkerclaw"));
  list.push(path.resolve(home, "src/jarvis-icu"));
  // FORK 2026-07-08: the four roots above are code/workspace dirs, but the
  // user's REAL documents (drafts, PDFs, plans we point him at) live under the
  // standard XDG home dirs. Every `.fs-link` to a real doc — e.g. an Olivella
  // licence draft under ~/Documents — was rejected server-side with "outside
  // allowlist" even after the client matcher learned to render spaced/accented
  // paths as clickable. The client fix was necessary but not sufficient; the
  // server guard is where the click actually died. This RPC is ADMIN_SCOPE
  // gated + trusted-caller only and merely xdg-opens (a reversible viewer open,
  // no data egress), so widening to the human-file dirs is proportionate.
  list.push(path.resolve(home, "Documents"));
  list.push(path.resolve(home, "Downloads"));
  list.push(path.resolve(home, "Desktop"));
  list.push(path.resolve(home, "Pictures"));
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

function platformOpenCommand(): { cmd: string; argsBefore: string[] } {
  switch (process.platform) {
    case "darwin":
      return { cmd: "open", argsBefore: [] };
    case "win32":
      return { cmd: "cmd.exe", argsBefore: ["/c", "start", ""] };
    default:
      return { cmd: "xdg-open", argsBefore: [] };
  }
}

export const configOpenExternalHandlers: GatewayRequestHandlers = {
  "config.openExternalFile": async ({ params, context, respond }) => {
    const inputPath =
      params && typeof params === "object" ? (params as { path?: unknown }).path : undefined;
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      respond(true, { ok: false, error: "path is required" }, undefined);
      return;
    }
    if (inputPath.includes("..")) {
      respond(true, { ok: false, error: "path traversal not allowed" }, undefined);
      return;
    }
    const expanded = expandTilde(inputPath);
    const absPath = path.resolve(expanded);
    const cfg = context.getRuntimeConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const allowlist = buildAllowlist(workspaceDir);
    if (!isInsideAllowlist(absPath, allowlist)) {
      respond(true, { ok: false, error: "outside allowlist", path: absPath }, undefined);
      return;
    }
    try {
      const fn = spawnImpl ?? defaultSpawn;
      const { cmd, argsBefore } = platformOpenCommand();
      // XIVATO 2026-07-13: measure the spawn hand-off. xdg-open returns as soon
      // as it delegates to the desktop handler, so serverMs only covers OUR leg;
      // a slow viewer app (MarkText cold start) shows up as a gap AFTER this.
      const t0 = Date.now();
      fn(cmd, [...argsBefore, absPath]);
      const serverMs = Date.now() - t0;
      context.logGateway?.info?.("config.openExternalFile spawned", {
        path: absPath,
        cmd,
        serverMs,
      });
      respond(true, { ok: true, path: absPath, serverMs }, undefined);
    } catch (err) {
      context.logGateway?.error?.("config.openExternalFile spawn failed", {
        path: absPath,
        err,
      });
      respond(true, { ok: false, error: (err as Error).message, path: absPath }, undefined);
    }
  },
};
