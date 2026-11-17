/**
 * FORK 2026-10-29 — the `mcp tools` startup fast path. The CLI catalog entry keeps the bridge
 * off the config guard and the plugin loaders, and the bridge resolves its gateway URL and auth
 * from a minimal config (through a stub gateway) without importing the plugin loader, the full
 * config reader (src/config/io.ts) or the gateway WebSocket client (src/gateway/call.ts).
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCliCatalogCommandPath,
  resolveCliCommandPathPolicy,
  resolveCliNetworkProxyPolicy,
} from "../cli/command-path-policy.js";
import {
  resolveCliStartupPolicy,
  shouldBypassConfigGuardForCommandPath,
} from "../cli/command-startup-policy.js";
import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import { listGatewayTools, resolveJarvisToolsGateway } from "./jarvis-tools-serve.js";

// Module-graph probes: a flag flips when anything imports its module after the mocks are set.
// The three heavy modules become empty stubs, so the controls stay cheap and a regression that
// imports one of them fails loudly instead of silently loading it.
const probe = vi.hoisted(() => ({
  pluginLoader: false,
  configIo: false,
  gatewayCall: false,
  dotenvCalls: 0,
}));

vi.mock("../plugins/loader.js", () => {
  probe.pluginLoader = true;
  return {};
});
vi.mock("../config/io.js", () => {
  probe.configIo = true;
  return {};
});
vi.mock("../gateway/call.js", () => {
  probe.gatewayCall = true;
  return {};
});
// The real step reads the cwd and state-dir .env files into process.env. Counting the call is
// all this test needs, and it keeps the test sandboxed by construction.
vi.mock("../infra/dotenv.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/dotenv.js")>()),
  loadDotEnv: () => {
    probe.dotenvCalls += 1;
  },
}));

/** Env the gateway derivation reads; each test starts with all of them blank. */
const GATEWAY_ENV = [
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_SERVICE_KIND",
  "OPENCLAW_LOAD_SHELL_ENV",
];

const STUB_TOOLS = [{ name: "browser", description: "stub", parameters: { type: "object" } }];

type StubGateway = {
  port: number;
  seen: Array<{ url: string; authorization: string | undefined }>;
  close: () => Promise<void>;
};

/** Stands in for the gateway's GET /tools/list: 200 for the expected bearer, 401 otherwise. */
async function startStubGateway(expectedToken: string): Promise<StubGateway> {
  const seen: StubGateway["seen"] = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
    const authorized = req.headers.authorization === `Bearer ${expectedToken}`;
    const body = authorized
      ? { ok: true, tools: STUB_TOOLS }
      : { ok: false, error: { message: "unauthorized" } };
    res.writeHead(authorized ? 200 : 401, {
      "content-type": "application/json",
      connection: "close",
    });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("mcp tools: CLI catalog entry", () => {
  it("bypasses the config guard, never loads plugins and keeps the egress proxy off", () => {
    expect(resolveCliCommandPathPolicy(["mcp", "tools"])).toEqual({
      bypassConfigGuard: true,
      routeConfigGuard: "never",
      loadPlugins: "never",
      hideBanner: true,
      ensureCliPath: false,
      networkProxy: "bypass",
    });
    // The predicates preaction and the startup policy actually call.
    expect(shouldBypassConfigGuardForCommandPath(["mcp", "tools"])).toBe(true);
    const startup = resolveCliStartupPolicy({
      commandPath: ["mcp", "tools"],
      jsonOutputMode: false,
      env: {},
    });
    expect(startup).toMatchObject({ hideBanner: true, loadPlugins: false });
    const argv = ["node", "openclaw", "mcp", "tools", "--session-key", "agent:main:fast-path"];
    expect(resolveCliCatalogCommandPath(argv)).toEqual(["mcp", "tools"]);
    expect(resolveCliNetworkProxyPolicy(argv)).toBe("bypass");
  });

  it("leaves the other mcp subcommands on the guarded startup", () => {
    for (const sub of ["serve", "list", "show", "set", "unset"]) {
      expect(resolveCliCommandPathPolicy(["mcp", sub]).bypassConfigGuard, sub).toBe(false);
    }
  });
});

describe("mcp tools: gateway URL and auth from a minimal config", () => {
  let dir = "";
  let configPath = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tools-fast-path-"));
    configPath = path.join(dir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    for (const name of GATEWAY_ENV) {
      vi.stubEnv(name, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("follows $include and an env reference to the URL and token", async () => {
    const gateway = await startStubGateway("token-from-env-ref");
    try {
      vi.stubEnv("JARVIS_BRIDGE_TEST_TOKEN", "token-from-env-ref");
      fs.writeFileSync(configPath, JSON.stringify({ $include: "./gateway.json5" }));
      fs.writeFileSync(
        path.join(dir, "gateway.json5"),
        JSON.stringify({
          gateway: {
            port: gateway.port,
            auth: { mode: "token", token: "${JARVIS_BRIDGE_TEST_TOKEN}" },
          },
        }),
      );
      const gw = await resolveJarvisToolsGateway();
      expect(gw.baseUrl).toBe(`http://127.0.0.1:${gateway.port}`);
      expect(gw.headers).toEqual({ authorization: "Bearer token-from-env-ref" });
      expect((await listGatewayTools(gw)).map((tool) => tool.name)).toEqual(["browser"]);
      expect(gateway.seen).toEqual([
        {
          url: "/tools/list?sessionKey=agent%3Amain%3Aclaude-code",
          authorization: "Bearer token-from-env-ref",
        },
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("lets the env override the config's port and token", async () => {
    const gateway = await startStubGateway("token-from-env");
    try {
      // The config names a dead port and another token; the env must win for both.
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { port: 1, auth: { mode: "token", token: "token-from-config" } },
        }),
      );
      vi.stubEnv("OPENCLAW_GATEWAY_PORT", String(gateway.port));
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "token-from-env");
      const gw = await resolveJarvisToolsGateway({ sessionKey: "agent:main:fast-path" });
      expect(gw).toMatchObject({
        baseUrl: `http://127.0.0.1:${gateway.port}`,
        headers: { authorization: "Bearer token-from-env" },
        sessionKey: "agent:main:fast-path",
      });
      await listGatewayTools(gw);
      expect(gateway.seen.map((request) => request.authorization)).toEqual([
        "Bearer token-from-env",
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("falls back to the default port and no auth when no config file exists", async () => {
    const gw = await resolveJarvisToolsGateway();
    expect(gw.baseUrl).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`);
    expect(gw.headers).toEqual({});
  });

  it("resolves without importing the plugin loader, io.ts or call.ts", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { port: DEFAULT_GATEWAY_PORT + 1 } }));
    // A fresh module graph, so a module some setup file preloaded cannot hide an import.
    vi.resetModules();
    Object.assign(probe, {
      pluginLoader: false,
      configIo: false,
      gatewayCall: false,
      dotenvCalls: 0,
    });
    const bridge = await import("./jarvis-tools-serve.js");
    const gw = await bridge.resolveJarvisToolsGateway();
    expect(gw.baseUrl).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT + 1}`);
    expect(probe).toEqual({
      pluginLoader: false,
      configIo: false,
      gatewayCall: false,
      dotenvCalls: 1,
    });
    // Control: each probe does flip on import, so the assertion above is not vacuous.
    await import("../plugins/loader.js");
    await import("../config/io.js");
    await import("../gateway/call.js");
    expect(probe).toMatchObject({ pluginLoader: true, configIo: true, gatewayCall: true });
  });
});
