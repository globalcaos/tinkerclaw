/**
 * FORK: Tinkerclaw Browser Relay plugin entry.
 *
 * Registers the plugin ID for discovery. The actual Chrome extension lives in
 * the chrome-extension/ subdirectory and communicates with the gateway's
 * extension-relay server (src/browser/extension-relay.ts) over WebSocket.
 *
 * The relay server itself is started by the gateway's browser extension system;
 * this plugin merely makes the extension discoverable in the plugin registry.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "tinkerclaw-browser-relay",
  name: "Tinkerclaw Browser Relay",
  description: "Chrome extension for sharing browser tabs with Jarvis",
  register() {
    // No-op: relay server is started by the gateway's browser extension system.
    // The Chrome extension in chrome-extension/ connects to it via WebSocket.
  },
});
