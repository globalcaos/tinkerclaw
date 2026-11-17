/**
 * FORK 2026-09-22 — the agent's tool set over MCP stdio, PROXIED to the running gateway.
 *
 * `openclaw-tools-serve` (upstream) exposes only `cron`, and `plugin-tools-serve`
 * builds plugin tools in-process. Building the full set in-process loads the whole
 * plugin runtime a second time — measured: plugin services start (learned-intuition,
 * pulse-panel backfill) and write to the same state files as the live gateway. So
 * this server builds NOTHING locally: it lists tools from the gateway's
 * `GET /tools/list` and forwards each call to `POST /tools/invoke`. Execution, owner
 * policy, before_tool_call hooks and the HTTP deny list (`gateway.tools.allow` to
 * re-enable) all stay in the one live runtime.
 *
 * Calls run as their own session identity (default `agent:main:claude-code`) so they
 * are attributable and never land in a live chat. Channels keep their delivery mode —
 * WhatsApp sends go through the gateway's own socket.
 *
 * FORK 2026-10-29 — startup fast path. Every Claude worker spawns this bridge (about 500 a
 * day on the reference host, and about 2.4% of them call a jarvis tool). Each start used to
 * boot the whole CLI: the config guard, then getRuntimeConfig(), whose legacy and doctor rule
 * collection loaded a full channel plugin only to learn a port and a token. Measured there on
 * 2026-10-29: 7.4 s wall, 11.2 CPU-s and about 520 MB peak per start, and under load it missed
 * Claude Code's 30 s MCP connect timeout. Now `mcp tools` skips the guard and never loads
 * plugins (src/cli/command-catalog.ts), readJarvisToolsGatewayConfig() runs only the config's
 * read stage, and the canonical builders derive the URL and auth from it.
 *
 * Run via: openclaw mcp tools   (or: node --import tsx src/mcp/jarvis-tools-serve.ts)
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import JSON5 from "json5";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { applyConfigEnvVars } from "../config/env-vars.js";
import { resolveConfigIncludes } from "../config/includes.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../gateway/connection-details.js";
import { loadDotEnv } from "../infra/dotenv.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import { isRecord } from "../utils.js";
import { VERSION } from "../version.js";

export const DEFAULT_JARVIS_TOOLS_SESSION_KEY = "agent:main:claude-code";

export type GatewayToolDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type JarvisToolsGateway = {
  baseUrl: string;
  headers: Record<string, string>;
  sessionKey: string;
  fetchImpl?: typeof fetch;
};

/** ws://host:port → http://host:port (wss → https). */
export function gatewayHttpBaseUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//i, "http$1://").replace(/\/+$/, "");
}

export type JarvisToolsGatewayConfig = { config: OpenClawConfig; configPath: string };

/**
 * FORK 2026-10-29 — the config read this bridge needs, and nothing more. It runs the read
 * stage of src/config/io.ts in the same order and through the same helpers: .env hydration,
 * JSON5, `$include` (resolveConfigIncludes, with its file guards), `config.env`, `${VAR}` (a
 * missing var is a warning, as in loadConfig), then finalizeLoadedRuntimeConfig's second
 * `config.env` pass and its opt-in login-shell fallback, which can supply
 * OPENCLAW_GATEWAY_TOKEN and OPENCLAW_GATEWAY_PASSWORD.
 *
 * It skips what getRuntimeConfig() adds on top. None of it reaches the gateway URL or auth:
 * - legacy and doctor rule collection (it loaded a whole channel plugin) and the runtime legacy
 *   migrations, whose gateway rules only rewrite gateway.bind host aliases (display text here)
 *   and seed controlUi origins;
 * - validation and the plugin metadata snapshot: neither the gateway nor the secrets schema has
 *   defaults, and the gateway, which validated the config it runs, refuses a wrong token at the
 *   first /tools/list;
 * - defaults materialization: no default touches gateway.* or secrets.*, and SecretRef file and
 *   exec paths expand `~` in src/secrets/resolve.ts;
 * - read-time recovery and the plugin-install migration, both of which write files. A proxy
 *   that every worker spawns must never rewrite the config.
 *
 * Declared twin: io.ts keeps this stage in private helpers (resolveConfigIncludesForRead,
 * resolveConfigForRead). The collapse is to export that stage from io.ts and call it here.
 */
export async function readJarvisToolsGatewayConfig(): Promise<JarvisToolsGatewayConfig> {
  const env = process.env;
  loadDotEnv({ quiet: true });
  const configPath = resolveConfigPath(env, resolveStateDir(env));
  let parsed: unknown = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      throw new Error(`config ${configPath} is not valid JSON5: ${formatErrorMessage(err)}`, {
        cause: err,
      });
    }
  }
  const included = resolveConfigIncludes(parsed, configPath);
  if (isRecord(included)) {
    applyConfigEnvVars(included as OpenClawConfig, env);
  }
  const resolved = resolveConfigEnvVars(included, env, {
    onMissing: (warning) => {
      process.stderr.write(
        `jarvis-tools-serve: missing env var "${warning.varName}" at ${warning.configPath}\n`,
      );
    },
  });
  const config: OpenClawConfig = isRecord(resolved) ? (resolved as OpenClawConfig) : {};
  applyConfigEnvVars(config, env);
  const shellEnv = config.env?.shellEnv;
  if (
    (shouldEnableShellEnvFallback(env) || shellEnv?.enabled === true) &&
    !shouldDeferShellEnvFallback(env)
  ) {
    // The expected-key list walks the plugin manifest registry, so it loads only on this
    // opt-in path.
    const { resolveShellEnvExpectedKeys } = await import("../config/shell-env-expected-keys.js");
    loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: resolveShellEnvExpectedKeys(env),
      logger: { warn: (message) => process.stderr.write(`jarvis-tools-serve: ${message}\n`) },
      timeoutMs: shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(env),
    });
  }
  return { config, configPath };
}

export async function resolveJarvisToolsGateway(
  opts: { sessionKey?: string } = {},
): Promise<JarvisToolsGateway> {
  const { config, configPath } = await readJarvisToolsGatewayConfig();
  // FORK 2026-10-29: buildGatewayConnectionDetailsWithResolvers is the derivation that
  // buildGatewayConnectionDetails in src/gateway/call.ts delegates to, with the same defaults
  // once a config is passed. call.ts itself is not imported: it loads the WebSocket client and
  // src/gateway/protocol/index.ts, which compiles 129 AJV validators at import, and this HTTP
  // proxy uses none of them. Env overrides (OPENCLAW_GATEWAY_URL/PORT/TOKEN/PASSWORD) and
  // SecretRefs resolve inside these two builders and nowhere else. The token is never logged.
  const { url } = buildGatewayConnectionDetailsWithResolvers({ config, configPath });
  const auth = await resolveGatewayConnectionAuth({ config });
  const secret = auth.token ?? auth.password;
  return {
    baseUrl: gatewayHttpBaseUrl(url),
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    sessionKey: opts.sessionKey?.trim() || DEFAULT_JARVIS_TOOLS_SESSION_KEY,
  };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, error: { message: `HTTP ${res.status}: ${text.slice(0, 300)}` } };
  }
}

function errorMessage(body: Record<string, unknown>, status: number): string {
  const err = body.error as { message?: string } | string | undefined;
  const msg = typeof err === "string" ? err : err?.message;
  return msg || `HTTP ${status}`;
}

export async function listGatewayTools(gw: JarvisToolsGateway): Promise<GatewayToolDescriptor[]> {
  const fetchImpl = gw.fetchImpl ?? fetch;
  const url = `${gw.baseUrl}/tools/list?sessionKey=${encodeURIComponent(gw.sessionKey)}`;
  const res = await fetchImpl(url, { method: "GET", headers: gw.headers });
  const body = await readJson(res);
  if (!res.ok || body.ok !== true || !Array.isArray(body.tools)) {
    throw new Error(`gateway /tools/list failed: ${errorMessage(body, res.status)}`);
  }
  return body.tools as GatewayToolDescriptor[];
}

type McpContent = Array<{ type: string; text?: string; [k: string]: unknown }>;

export async function invokeGatewayTool(
  gw: JarvisToolsGateway,
  name: string,
  args: unknown,
): Promise<{ content: McpContent; isError?: boolean }> {
  const fetchImpl = gw.fetchImpl ?? fetch;
  const res = await fetchImpl(`${gw.baseUrl}/tools/invoke`, {
    method: "POST",
    headers: { ...gw.headers, "content-type": "application/json" },
    body: JSON.stringify({
      tool: name,
      args: args && typeof args === "object" ? args : {},
      sessionKey: gw.sessionKey,
    }),
  });
  const body = await readJson(res);
  if (!res.ok || body.ok !== true) {
    return {
      content: [{ type: "text", text: `Tool error: ${errorMessage(body, res.status)}` }],
      isError: true,
    };
  }
  const result = body.result as { content?: unknown } | undefined;
  const content = result?.content;
  if (Array.isArray(content)) {
    return { content: content as McpContent };
  }
  return {
    content: [
      {
        type: "text",
        text: typeof content === "string" ? content : JSON.stringify(result ?? null),
      },
    ],
  };
}

export function createJarvisToolsMcpServer(gw: JarvisToolsGateway): Server {
  const server = new Server({ name: "jarvis", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await listGatewayTools(gw)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await invokeGatewayTool(gw, request.params.name, request.params.arguments);
    } catch (err) {
      return {
        content: [{ type: "text", text: `Tool error: ${formatErrorMessage(err)}` }],
        isError: true,
      };
    }
  });
  return server;
}

export async function serveJarvisToolsMcp(opts: { sessionKey?: string } = {}): Promise<void> {
  const gw = await resolveJarvisToolsGateway(opts);
  // FORK 2026-10-29: imported here, not at the top. tools-stdio-server.ts also builds
  // in-process tool servers, and their handlers import the plugin tool runtime and with it
  // src/plugins/loader.ts, so resolving the gateway must not depend on that module. Serving
  // still loads it; on the CLI path preaction.ts has loaded the same graph already.
  const { connectToolsMcpServerToStdio } = await import("./tools-stdio-server.js");
  await connectToolsMcpServerToStdio(createJarvisToolsMcpServer(gw));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveJarvisToolsMcp().catch((err) => {
    process.stderr.write(`jarvis-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
