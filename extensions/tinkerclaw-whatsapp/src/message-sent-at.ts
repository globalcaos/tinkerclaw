import { getDbIfExists } from "./history/db.js";
import { getSentMessageAtMs } from "./inbound/sent-ids.js";

/**
 * When a WhatsApp message was sent, in ms since epoch: this process's own sends first, then the
 * local history DB (seconds there). Undefined when neither knows the id.
 */
export function resolveWhatsAppMessageSentAtMs(messageId: string): number | undefined {
  const tracked = getSentMessageAtMs(messageId);
  if (tracked !== undefined) {
    return tracked;
  }
  try {
    const row = getDbIfExists()
      ?.prepare("SELECT timestamp FROM messages WHERE id = ?")
      .get(messageId) as { timestamp?: unknown } | undefined;
    return typeof row?.timestamp === "number" ? row.timestamp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
