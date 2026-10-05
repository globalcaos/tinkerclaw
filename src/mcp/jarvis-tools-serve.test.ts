import { describe, expect, it, vi } from "vitest";
import {
  gatewayHttpBaseUrl,
  invokeGatewayTool,
  listGatewayTools,
  type JarvisToolsGateway,
} from "./jarvis-tools-serve.js";

function gw(fetchImpl: typeof fetch): JarvisToolsGateway {
  return {
    baseUrl: "http://127.0.0.1:1",
    headers: { authorization: "Bearer t" },
    sessionKey: "agent:main:claude-code",
    fetchImpl,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("jarvis-tools-serve (gateway proxy)", () => {
  it("maps ws urls to http", () => {
    expect(gatewayHttpBaseUrl("ws://127.0.0.1:18789")).toBe("http://127.0.0.1:18789");
    expect(gatewayHttpBaseUrl("wss://gw.example/")).toBe("https://gw.example");
  });

  it("lists through GET /tools/list with the session key", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        ok: true,
        tools: [{ name: "message", description: "d", parameters: { type: "object" } }],
      }),
    );
    const tools = await listGatewayTools(gw(fetchImpl as unknown as typeof fetch));
    expect(tools.map((t) => t.name)).toEqual(["message"]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1/tools/list?sessionKey=agent%3Amain%3Aclaude-code");
    expect(init.method).toBe("GET");
  });

  it("forwards calls to POST /tools/invoke and returns tool content", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { ok: true, result: { content: [{ type: "text", text: "sent" }] } }),
    );
    const out = await invokeGatewayTool(gw(fetchImpl as unknown as typeof fetch), "message", {
      action: "send",
    });
    expect(out).toEqual({ content: [{ type: "text", text: "sent" }] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1/tools/invoke");
    expect(JSON.parse(String(init.body))).toEqual({
      tool: "message",
      args: { action: "send" },
      sessionKey: "agent:main:claude-code",
    });
  });

  it("surfaces gateway refusals as MCP errors", async () => {
    const fetchImpl = vi.fn(async () =>
      json(404, { ok: false, error: { type: "not_found", message: "Tool not available: exec" } }),
    );
    const out = await invokeGatewayTool(gw(fetchImpl as unknown as typeof fetch), "exec", {});
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("Tool not available: exec");
  });
});
