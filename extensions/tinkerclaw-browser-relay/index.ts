/**
 * FORK: Tinkerclaw Browser Relay plugin.
 *
 * Starts the extension relay server on port 18792 during gateway_start.
 * The Chrome extension in chrome-extension/ connects to this relay via WebSocket.
 * The relay forwards CDP commands between the gateway and shared browser tabs.
 *
 * bindHost (plugin config, default 127.0.0.1) controls which interface the relay listens on.
 * Set it to a LAN address or 0.0.0.0 so a Chrome on another machine can share its tabs. That
 * is gated on a gateway auth token being configured — see bind-host.ts for why.
 */
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { resolveRelayBind } from "./bind-host.js";

const RELAY_PORT = 18792;

export default definePluginEntry({
  id: "tinkerclaw-browser-relay",
  name: "Tinkerclaw Browser Relay",
  description: "Chrome extension for sharing browser tabs with Jarvis",
  register(api: OpenClawPluginApi) {
    let relayServer: { stop: () => Promise<void> } | null = null;

    api.on("gateway_start", async () => {
      const decision = resolveRelayBind({
        pluginConfig: (api.pluginConfig ?? {}) as Record<string, unknown>,
        gatewayAuthToken: api.config.gateway?.auth?.token,
        env: process.env,
        port: RELAY_PORT,
      });
      if (!decision.allowed) {
        api.logger.error(`[tinkerclaw-browser-relay] ${decision.reason}`);
        return;
      }
      const { bindHost } = decision;

      try {
        // Dynamic import to avoid bundling the full relay at parse time
        const { ensureChromeExtensionRelayServer } =
          await import("openclaw/plugin-sdk/fork-browser-relay");
        relayServer = await ensureChromeExtensionRelayServer({
          // cdpUrl must stay loopback — it is how the gateway itself reaches the relay,
          // and ensureChromeExtensionRelayServer rejects a non-loopback cdpUrl host.
          cdpUrl: `http://127.0.0.1:${RELAY_PORT}`,
          bindHost,
        });
        api.logger.info(
          `[tinkerclaw-browser-relay] Extension relay listening on ws://${bindHost}:${RELAY_PORT}/extension`,
        );
      } catch (err) {
        api.logger.warn(
          `[tinkerclaw-browser-relay] Failed to start relay: ${String(err)}`,
        );
      }
    });

    api.on("gateway_stop", async () => {
      if (relayServer) {
        await relayServer.stop();
        relayServer = null;
      }
    });
  },
});
