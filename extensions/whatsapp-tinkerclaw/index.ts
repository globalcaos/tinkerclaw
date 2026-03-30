/**
 * FORK: WhatsApp TinkerClaw — consolidated fork WhatsApp enhancements.
 *
 * Bundles:
 * - history/    — SQLite message archive, live capture (Baileys + whatsmeow), import/export
 * - backfill/   — Reconnect backfill with downtime tracking
 * - multi-agent/ — Congestion control, budget-aware scheduling, lifecycle management
 * - tools/      — Agent tool for whatsapp_history queries
 *
 * The history capture and backfill are wired via the WhatsApp extension's session modules
 * (session.ts / session-wm.ts / login-qr-wm.ts). This plugin exists to:
 * 1. Register the plugin ID with OpenClaw's discovery system
 * 2. Provide a single import root for all fork WhatsApp functionality
 * 3. Make the fork's WhatsApp work packageable/distributable
 */

// Re-export key submodules for external consumers
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
} from "./history/db.js";
export { importExportFile, importDirectory, formatImportResults } from "./history/import-export.js";
export { bindWmHistoryCapture } from "./history/live-capture-wm.js";
export { bindHistoryCapture } from "./history/live-capture.js";
export { requestBackfill, writeLastConnected } from "./backfill/index.js";
export * from "./multi-agent/index.js";
export { createWhatsAppHistoryTool } from "./tools/whatsapp-history-tool.js";

const whatsappTinkerclawPlugin = {
  id: "whatsapp-tinkerclaw",
  name: "WhatsApp TinkerClaw",
  description:
    "Fork WhatsApp enhancements: message history archive, reconnect backfill, multi-agent protocol, history search tool",
  configSchema: { type: "object" as const, additionalProperties: false, properties: {} },
  register() {
    // Wiring happens via session.ts/session-wm.ts imports.
    // This registration makes the plugin visible to OpenClaw's plugin system.
  },
};

export default whatsappTinkerclawPlugin;
