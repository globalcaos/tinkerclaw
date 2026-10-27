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
 * Run via: openclaw mcp tools   (or: node --import tsx src/mcp/jarvis-tools-serve.ts)
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getRuntimeConfig } from "../config/config.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import { formatErrorMessage } from "../infra/errors.js";
import { VERSION } from "../version.js";
import { connectToolsMcpServerToStdio } from "./tools-stdio-server.js";

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

export async function resolveJarvisToolsGateway(
  opts: { sessionKey?: string } = {},
): Promise<JarvisToolsGateway> {
  const config = getRuntimeConfig();
  const { url } = buildGatewayConnectionDetails({ config });
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
  await connectToolsMcpServerToStdio(createJarvisToolsMcpServer(gw));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveJarvisToolsMcp().catch((err) => {
    process.stderr.write(`jarvis-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
