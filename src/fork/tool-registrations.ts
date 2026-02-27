/**
 * FORK: Custom tool registrations.
 *
 * All fork-specific tools (whatsapp-history, hippocampus-bridge, synapse-debate)
 * are registered here. Upstream files import this single module and call
 * `getForkTools()` / `getForkToolHandlers()`.
 */
import { createWhatsAppHistoryTool } from "../agents/tools/whatsapp-history-tool.js";

/**
 * Returns fork-specific tool definitions for the embedded Pi runner.
 */
export function getForkToolDefinitions(): Array<{ name: string; definition: unknown }> {
  return [
    { name: "whatsapp_history", definition: createWhatsAppHistoryTool() },
  ];
}
