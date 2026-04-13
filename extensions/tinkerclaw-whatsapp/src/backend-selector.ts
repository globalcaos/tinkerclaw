/**
 * WhatsApp backend selector.
 *
 * Reads a config/env flag to decide whether to use Baileys or whatsmeow-node.
 * This is the single point that needs to change to swap backends.
 *
 * Set OPENCLAW_WHATSAPP_BACKEND=whatsmeow to use whatsmeow-node.
 * Default: "baileys" (existing behavior).
 */

export type WhatsAppBackend = "baileys" | "whatsmeow";

export function resolveWhatsAppBackend(): WhatsAppBackend {
  const env = process.env.OPENCLAW_WHATSAPP_BACKEND?.toLowerCase().trim();
  if (env === "whatsmeow" || env === "wm") {
    return "whatsmeow";
  }
  return "baileys";
}

export function isWhatsmeowBackend(): boolean {
  return resolveWhatsAppBackend() === "whatsmeow";
}
