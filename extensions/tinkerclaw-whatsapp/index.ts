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
 */

// Re-export public API for external consumers
export { createWmClient, connectWmClient, disconnectWmClient, getWmClient } from "./src/session.js";
export { createBaileysAdapter } from "./src/adapter.js";

// Plugin will be completed in Task 8 (channel registration)
