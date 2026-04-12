/**
 * FORK: tinkerclaw-whatsapp Baileys runtime API re-exports.
 *
 * Centralizes @whiskeysockets/baileys runtime imports used by the
 * inbound pipeline so other modules can depend on a stable surface.
 */
export {
  DisconnectReason,
  downloadMediaMessage,
  isJidGroup,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
export { saveMediaBuffer } from "./save-media.runtime.js";
