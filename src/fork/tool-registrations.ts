/**
 * FORK: Custom tool registrations.
 *
 * Registers fork-specific tools for the embedded Pi runner.
 * Currently only whatsapp_history is wired in.
 *
 * NOTE: getForkToolDefinitions() is defined but not yet called from
 * upstream code. It's the designated hook point for when we wire
 * fork tools into the Pi runner's tool array.
 */
import { createWhatsAppHistoryTool } from "../agents/tools/whatsapp-history-tool.js";

/**
 * Returns fork-specific tool definitions for the embedded Pi runner.
 * Each entry provides a tool name and its JSON Schema definition.
 */
export function getForkToolDefinitions(): Array<{ name: string; definition: unknown }> {
  return [{ name: "whatsapp_history", definition: createWhatsAppHistoryTool() }];
}
