/**
 * FORK: tinkerclaw-whatsapp — standalone WhatsApp channel plugin.
 *
 * Replaces the upstream Baileys-based extensions/whatsapp/ with a whatsmeow-node
 * backend. Includes: 4-tier access control, SQLite history archive, reconnect
 * backfill, multi-agent protocol, and WhatsApp history search tool.
 *
 * Architecture: whatsmeow-node (Go subprocess) → Baileys-compatible adapter →
 * existing message processing pipeline. The adapter lets us reuse upstream's
 * extract/dedupe/media code without modification.
 *
 * Task 8 registers the channel entry. Until Task 10 localizes the full plugin
 * graph, `src/channel.ts` re-exports the upstream `whatsappPlugin` so the
 * channel wiring, monitor, outbound helpers, and auto-reply pipeline compose
 * correctly with our in-plugin state (active-listener registry, send helpers,
 * reconnect policy, process-message hooks).
 */

import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "tinkerclaw-whatsapp",
  name: "WhatsApp (TinkerClaw)",
  description: "WhatsApp channel via whatsmeow-node — 4-tier access control, history, multi-agent",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "whatsappPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setWhatsAppRuntime",
  },
});

// Re-export public API for external consumers
export { createWmClient, connectWmClient, disconnectWmClient, getWmClient } from "./src/session.js";
export { createBaileysAdapter } from "./src/adapter.js";
export {
  searchMessages,
  getStats,
  insertMessage,
  insertMessages,
  upsertChat,
  upsertContact,
  getContactName,
  getChatName,
  getDb,
  type MessageRecord,
} from "./src/history/index.js";
export { bindWmHistoryCapture } from "./src/history/live-capture.js";
export * from "./src/multi-agent/index.js";
export { createWhatsAppHistoryTool } from "./src/tools/history-tool.js";
