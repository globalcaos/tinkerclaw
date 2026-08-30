/**
 * FORK: Tinkerclaw Browser Relay plugin.
 *
 * Starts the extension relay server on port 18792 during gateway_start.
 * The Chrome extension in chrome-extension/ connects to this relay via WebSocket.
 * The relay forwards CDP commands between the gateway and shared browser tabs.
 */
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const RELAY_PORT = 18792;

export default definePluginEntry({
  id: "tinkerclaw-browser-relay",
  name: "Tinkerclaw Browser Relay",
  description: "Chrome extension for sharing browser tabs with Jarvis",
  register(api: OpenClawPluginApi) {
    let relayServer: { stop: () => Promise<void> } | null = null;

    api.on("gateway_start", async () => {
      try {
        // Dynamic import to avoid bundling the full relay at parse time
        const { ensureChromeExtensionRelayServer } =
          await import("openclaw/plugin-sdk/fork-browser-relay");
        relayServer = await ensureChromeExtensionRelayServer({
          cdpUrl: `http://127.0.0.1:${RELAY_PORT}`,
          bindHost: "127.0.0.1",
        });
        api.logger.info(
          `[tinkerclaw-browser-relay] Extension relay listening on ws://127.0.0.1:${RELAY_PORT}/extension`,
        );
      } catch (err) {
        api.logger.warn(`[tinkerclaw-browser-relay] Failed to start relay: ${String(err)}`);
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
