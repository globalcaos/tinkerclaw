/**
 * Tracks message IDs sent by the bot to prevent echo re-ingestion.
 * Used by send-api.ts (write) and monitor.ts (read).
 * FORK 2026-10-03: also keeps the send time, so `edit` can enforce WhatsApp's 15-minute window.
 */

const MAX_TRACKED = 500;
const sentIds = new Map<string, number>();

export function trackSentMessageId(id: string, sentAtMs: number = Date.now()): void {
  sentIds.set(id, sentAtMs);
  // Trim oldest entries
  if (sentIds.size > MAX_TRACKED) {
    const first = sentIds.keys().next().value;
    if (first) {
      sentIds.delete(first);
    }
  }
}

export function wasSentByBot(id: string): boolean {
  return sentIds.has(id);
}

export function getSentMessageAtMs(id: string): number | undefined {
  return sentIds.get(id);
}

export function forgetSentMessageId(id: string): void {
  sentIds.delete(id);
}
