/**
 * FORK: tinkerclaw-orca — plugin entry.
 *
 * Hosts ORCA's cross-session file-lease registry as gateway RPCs + a stale-lease
 * GC janitor. The lease source of truth is atomic on-disk files (lease-core.mjs),
 * so a down gateway never blocks an edit; this plugin is the management/RPC/GC
 * layer, used by programmatic agents (Jarvis, the ORCA workflow). The Edit/Write
 * PreToolUse hook talks to the SAME lease-core.mjs as a CLI.
 *
 * RPCs:
 *   orca.lease.acquire {repo, path, owner, pid?, sessionId?, ttlMs?, intent?}
 *   orca.lease.release {repo, path, owner}
 *   orca.lease.status  {repo, path}
 *   orca.lease.list    {repo}
 */
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { acquire, release, status, list, gcAll, DEFAULT_TTL_MS } from "./lease-core.mjs";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

type GatewayMethodHandlerArg = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function ok(handler: (p: GatewayMethodHandlerArg) => void) {
  return async (arg: GatewayMethodHandlerArg) => {
    try {
      handler(arg);
    } catch (err) {
      arg.respond(false, undefined, {
        code: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

interface OrcaPluginConfig {
  leaseTtlMs?: number;
  janitorCadenceMs?: number;
}

export default definePluginEntry({
  id: "tinkerclaw-orca",
  name: "ORCA Lease Registry",
  description:
    "FORK: cross-session per-file lease registry (no branches, no merges) — orca.lease.* RPCs over atomic on-disk leases + stale-lease GC janitor.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as OrcaPluginConfig;
    const ttlMs = num(cfg.leaseTtlMs) ?? DEFAULT_TTL_MS;
    const janitorCadenceMs = num(cfg.janitorCadenceMs) ?? 60_000;
    const log = (msg: string) => api.logger.info(`[orca] ${msg}`);

    api.registerGatewayMethod(
      "orca.lease.acquire",
      ok(({ params: p, respond }) => {
        const repo = str(p?.repo);
        const filePath = str(p?.path);
        const owner = str(p?.owner);
        if (!repo || !filePath || !owner) {
          respond(false, undefined, {
            code: "invalid_argument",
            message: "orca.lease.acquire requires repo, path, owner",
          });
          return;
        }
        respond(
          true,
          acquire({
            repo,
            path: filePath,
            owner,
            sessionId: str(p?.sessionId) ?? owner,
            pid: num(p?.pid),
            ttlMs: num(p?.ttlMs) ?? ttlMs,
            intent: str(p?.intent) ?? "",
          }),
        );
      }),
      { scope: WRITE_SCOPE },
    );

    api.registerGatewayMethod(
      "orca.lease.release",
      ok(({ params: p, respond }) => {
        const repo = str(p?.repo);
        const filePath = str(p?.path);
        const owner = str(p?.owner);
        if (!repo || !filePath || !owner) {
          respond(false, undefined, {
            code: "invalid_argument",
            message: "orca.lease.release requires repo, path, owner",
          });
          return;
        }
        respond(true, release({ repo, path: filePath, owner }));
      }),
      { scope: WRITE_SCOPE },
    );

    api.registerGatewayMethod(
      "orca.lease.status",
      ok(({ params: p, respond }) => {
        const repo = str(p?.repo);
        const filePath = str(p?.path);
        if (!repo || !filePath) {
          respond(false, undefined, {
            code: "invalid_argument",
            message: "orca.lease.status requires repo, path",
          });
          return;
        }
        respond(true, status({ repo, path: filePath }));
      }),
      { scope: READ_SCOPE },
    );

    api.registerGatewayMethod(
      "orca.lease.list",
      ok(({ params: p, respond }) => {
        const repo = str(p?.repo);
        if (!repo) {
          respond(false, undefined, {
            code: "invalid_argument",
            message: "orca.lease.list requires repo",
          });
          return;
        }
        const leases = list({ repo });
        respond(true, { leases, count: leases.length });
      }),
      { scope: READ_SCOPE },
    );

    // Background janitor — reclaim stale leases (crashed holders that never
    // released). Only in a real runtime load ("full"); never during the
    // build-time discovery/cli-metadata scans (a timer would block exit).
    if (api.registrationMode === "full") {
      const timer = setInterval(() => {
        try {
          const { reclaimed } = gcAll();
          if (reclaimed > 0) log(`janitor reclaimed ${reclaimed} stale lease(s)`);
        } catch (err) {
          log(`janitor error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, janitorCadenceMs);
      timer.unref?.();
    }

    log(`ready (leaseTtlMs=${ttlMs}, janitorCadenceMs=${janitorCadenceMs})`);
  },
});
