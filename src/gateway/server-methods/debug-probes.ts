/**
 * FORK 2026-05-11 — debug probes for the J15 RSC discipline.
 *
 * Three single-tool-call probes for the surfaces that today require
 * grepping 5+ files to inspect. The agent-feedback symmetry principle
 * (J15 §6): anything an AI can break in one turn must be inspectable
 * deterministically in one turn.
 *
 *   debug.session.config({provider})  — effective resolved providerConfig
 *                                       including plugin overlay (the
 *                                       canary that catches the 2026-05-10
 *                                       cc-bridge timeoutSeconds dead-code
 *                                       regression class).
 *
 *   debug.session.state({sessionKey}) — session-store entry + computed
 *                                       lifecycle phase. Catches L1's
 *                                       stuck `status:running` state.
 *
 *   debug.tail.lastN({sessionFile,n}) — last N parsed messages from a
 *                                       session jsonl. Replaces the
 *                                       common ~10-line `tail | jq`
 *                                       investigation pattern.
 *
 * Scope: all three are READ_SCOPE (no credentials, no enumeration risk
 * beyond what session-list already exposes).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getPluginProviderConfigOverlay } from "../../agents/plugin-provider-config-overlay.js";
import type { GatewayRequestHandlers } from "./types.js";

function maskApiKey(key: unknown): string | undefined {
  if (typeof key !== "string" || !key) return undefined;
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function maskProviderConfig(
  cfg: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!cfg) return undefined;
  const masked: Record<string, unknown> = { ...cfg };
  if ("apiKey" in masked) {
    masked.apiKey = maskApiKey(masked.apiKey);
  }
  // headers may contain authorization tokens — mask values
  if (masked.headers && typeof masked.headers === "object" && !Array.isArray(masked.headers)) {
    const headersIn = masked.headers as Record<string, unknown>;
    const headersOut: Record<string, unknown> = {};
    for (const k of Object.keys(headersIn)) {
      const v = headersIn[k];
      headersOut[k] =
        typeof v === "string" && v.length > 12 ? `${v.slice(0, 4)}…${v.slice(-4)}` : v;
    }
    masked.headers = headersOut;
  }
  return masked;
}

export const debugProbesHandlers: GatewayRequestHandlers = {
  "debug.session.config": async ({ params, respond, context }) => {
    const p = (params ?? {}) as { provider?: unknown };
    const provider = typeof p.provider === "string" ? p.provider.trim() : "";
    if (!provider) {
      respond(true, { error: "provider required" }, undefined);
      return;
    }
    const cfg = context.getRuntimeConfig();
    const explicit = cfg?.models?.providers?.[provider] as Record<string, unknown> | undefined;
    const overlay = getPluginProviderConfigOverlay(provider);
    const effective: Record<string, unknown> | undefined =
      overlay && explicit
        ? { ...overlay, ...explicit }
        : overlay
          ? (overlay as Record<string, unknown>)
          : explicit;
    const timeoutSeconds =
      typeof effective?.timeoutSeconds === "number" ? (effective.timeoutSeconds as number) : null;
    respond(
      true,
      {
        provider,
        overlay: overlay ?? null,
        explicit: maskProviderConfig(explicit) ?? null,
        effective: maskProviderConfig(effective) ?? null,
        resolvedRequestTimeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : null,
      },
      undefined,
    );
  },

  "debug.session.state": async ({ params, respond, context }) => {
    const p = (params ?? {}) as { sessionKey?: unknown };
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
    if (!sessionKey) {
      respond(true, { error: "sessionKey required" }, undefined);
      return;
    }
    const cfg = context.getRuntimeConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const home = os.homedir();
    const sessionsPath = path.resolve(home, ".openclaw/agents", agentId, "sessions/sessions.json");
    let entry: Record<string, unknown> | null = null;
    try {
      const raw = await fs.readFile(sessionsPath, "utf8");
      const store = JSON.parse(raw) as Record<string, unknown>;
      const e = store[sessionKey];
      if (e && typeof e === "object") {
        entry = e as Record<string, unknown>;
      }
    } catch {
      // missing or unparseable — entry stays null
    }
    // Compute liveness fields from in-memory state (chatAbortControllers, registered runs)
    let activeRunIds: string[] = [];
    try {
      const controllers = (
        context as { chatAbortControllers?: Map<string, { sessionKey?: string }> }
      ).chatAbortControllers;
      if (controllers) {
        for (const [runId, info] of controllers) {
          if (info?.sessionKey === sessionKey) {
            activeRunIds.push(runId);
          }
        }
      }
    } catch {
      // best effort
    }
    respond(
      true,
      {
        sessionKey,
        agentId,
        workspaceDir,
        entry,
        activeRunIds,
        live: activeRunIds.length > 0,
      },
      undefined,
    );
  },

  "debug.tail.lastN": async ({ params, respond, context }) => {
    const p = (params ?? {}) as { sessionFile?: unknown; sessionKey?: unknown; n?: unknown };
    const requestedN = typeof p.n === "number" && p.n > 0 ? Math.min(Math.floor(p.n), 100) : 20;
    let sessionFile = typeof p.sessionFile === "string" ? p.sessionFile.trim() : "";
    // If sessionKey given but no sessionFile, resolve through the session store.
    if (!sessionFile && typeof p.sessionKey === "string" && p.sessionKey.trim()) {
      const cfg = context.getRuntimeConfig();
      const agentId = resolveDefaultAgentId(cfg);
      const home = os.homedir();
      const sessionsPath = path.resolve(
        home,
        ".openclaw/agents",
        agentId,
        "sessions/sessions.json",
      );
      try {
        const raw = await fs.readFile(sessionsPath, "utf8");
        const store = JSON.parse(raw) as Record<string, unknown>;
        const entry = store[p.sessionKey.trim()] as { sessionFile?: string } | undefined;
        if (entry?.sessionFile) {
          sessionFile = entry.sessionFile;
        }
      } catch {
        // fall through
      }
    }
    if (!sessionFile) {
      respond(true, { error: "sessionFile or sessionKey required" }, undefined);
      return;
    }
    // Path safety: must be under ~/.openclaw or a workspaceDir
    const resolved = path.resolve(sessionFile);
    const home = os.homedir();
    const allowed = [path.resolve(home, ".openclaw"), path.resolve(home, ".claude/projects")];
    if (!allowed.some((root) => resolved.startsWith(root + path.sep) || resolved === root)) {
      respond(true, { error: "sessionFile outside allowed roots" }, undefined);
      return;
    }
    let text = "";
    try {
      text = await fs.readFile(resolved, "utf8");
    } catch (err: unknown) {
      respond(true, { error: `read failed: ${String(err)}`, sessionFile: resolved }, undefined);
      return;
    }
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const tail = lines.slice(-requestedN);
    const events: Array<Record<string, unknown> | { __parseError: string; raw: string }> = [];
    for (const line of tail) {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch (err) {
        events.push({ __parseError: String(err), raw: line.slice(0, 300) });
      }
    }
    respond(
      true,
      {
        sessionFile: resolved,
        totalLines: lines.length,
        returnedCount: events.length,
        events,
      },
      undefined,
    );
  },
};
