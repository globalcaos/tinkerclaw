import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { BrowserToolSchema } from "./src/browser-tool.schema.js";

const BROWSER_CLI_DESCRIPTOR = {
  name: "browser",
  description: "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
  hasSubcommands: true,
};

function createLazyBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
}): AnyAgentTool {
  // FORK 2026-04-29 (Bible §5.81): description must match what the eager
  // tool exposes after lazy-load — the agent reads this string at planning
  // time, before the runtime is imported. If it advertises start/stop or
  // the openclaw/user profiles, the agent will try them and the policy
  // throws will land mid-turn instead of preventing the call entirely.
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Read/interact with browser tabs the user has explicitly shared via the Tinkerclaw relay extension. Per-tab consent only — you cannot see tabs the user hasn't shared.",
      'Profile is fixed: profile="chrome-relay" (this is the only allowed profile and it is the default; do not specify another).',
      "Allowed actions: doctor, status, tabs, focus, close, snapshot, screenshot, navigate, console, pdf, upload, dialog, act, cookies. Blocked: start, stop, profiles, open — those would either touch the browser daemon or open new tabs outside the consent model.",
      'Allowed targets: omit (default). Blocked: target="node" (no remote browser routing).',
      "For tab operations, targetId accepts tabId handles (t1) and labels from action=tabs. snapshot+act is the standard UI-automation pattern.",
      "If the relay returns no shared tabs, stop and tell the user — do not retry, do not open a new tab, do not propose enabling --remote-debugging-port or starting a managed browser.",
      'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
      "For multi-step flows, login checks, or stale refs, use the bundled browser-automation skill when it is available.",
    ].join(" "),
    parameters: BrowserToolSchema,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const { createBrowserTool } = await import("./register.runtime.js");
      const tool = createBrowserTool(opts);
      return await tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

export const browserPluginReload = { restartPrefixes: ["browser"] };

export const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  {
    command: "browser.proxy",
    cap: "browser",
    handle: async (paramsJSON) => {
      const { runBrowserProxyCommand } = await import("./register.runtime.js");
      return await runBrowserProxyCommand(paramsJSON);
    },
  },
];

export const browserSecurityAuditCollectors: OpenClawPluginSecurityAuditCollector[] = [
  async (ctx) => {
    const { collectBrowserSecurityAuditFindings } = await import("./register.runtime.js");
    return collectBrowserSecurityAuditFindings(ctx);
  },
];

function createLazyBrowserPluginService(): OpenClawPluginService {
  let service: OpenClawPluginService | null = null;
  const loadService = async () => {
    if (!service) {
      const { createBrowserPluginService } = await import("./register.runtime.js");
      service = createBrowserPluginService();
    }
    return service;
  };
  return {
    id: "browser-control",
    start: async (ctx) => {
      const loaded = await loadService();
      await loaded.start(ctx);
    },
    stop: async (ctx) => {
      if (!service?.stop) {
        return;
      }
      await service.stop(ctx);
    },
  };
}

export function registerBrowserPlugin(api: OpenClawPluginApi) {
  api.registerTool(((ctx: OpenClawPluginToolContext) =>
    createLazyBrowserTool({
      sandboxBridgeUrl: ctx.browser?.sandboxBridgeUrl,
      allowHostControl: ctx.browser?.allowHostControl,
      agentSessionKey: ctx.sessionKey,
    })) as OpenClawPluginToolFactory);
  api.registerCli(
    async ({ program }) => {
      const { registerBrowserCli } = await import("./src/cli/browser-cli.js");
      registerBrowserCli(program);
    },
    { commands: ["browser"], descriptors: [BROWSER_CLI_DESCRIPTOR] },
  );
  api.registerGatewayMethod(
    "browser.request",
    async (opts) => {
      const { handleBrowserGatewayRequest } = await import("./register.runtime.js");
      return await handleBrowserGatewayRequest(opts);
    },
    {
      scope: "operator.admin",
    },
  );
  api.registerService(createLazyBrowserPluginService());
}
