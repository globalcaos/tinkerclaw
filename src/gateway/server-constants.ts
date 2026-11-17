// Keep server maxPayload aligned with gateway client maxPayload so high-res canvas snapshots
// don't get disconnected mid-invoke with "Max payload size exceeded".
export const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = 50 * 1024 * 1024; // per-connection send buffer limit (2x max payload)
/**
 * FORK 2026-11-04 — a frame the next one makes whole again (`dropIfSlow` with `supersededByNext`:
 * a chat delta or an assistant agent event, each holding the whole text so far) is dropped once
 * its client has this much queued, far below MAX_BUFFERED_BYTES, where a frame that must arrive
 * closes the socket instead. With one limit for both, those deltas filled a sleeping phone's queue
 * right up to the close limit, so the next frame that had to arrive (the reply's final) closed the
 * socket and was lost.
 *
 * Every other droppable frame is still dropped only above MAX_BUFFERED_BYTES: a tool row
 * (`session.tool`), a prompt typed on another screen (`session.message`), a rail row
 * (`sessions.changed`), an approval or pairing request, a cron or jev.status change. No later
 * frame carries what those carry and a page does not repair a gap in them, so dropping them at
 * this limit would lose them for good while the socket stays open.
 *
 * Above the largest chat.history response (DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES, 6 MB), so one
 * history load still in flight on a slow link does not by itself drop live frames.
 */
export const DROP_IF_SLOW_BUFFERED_BYTES = 8 * 1024 * 1024;
export const MAX_PREAUTH_PAYLOAD_BYTES = 64 * 1024;

const DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES = 6 * 1024 * 1024; // keep history responses comfortably under client WS limits
let maxChatHistoryMessagesBytes = DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES;

export const getMaxChatHistoryMessagesBytes = () => maxChatHistoryMessagesBytes;

export const __setMaxChatHistoryMessagesBytesForTest = (value?: number) => {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    return;
  }
  if (value === undefined) {
    maxChatHistoryMessagesBytes = DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES;
    return;
  }
  if (Number.isFinite(value) && value > 0) {
    maxChatHistoryMessagesBytes = value;
  }
};
export const TICK_INTERVAL_MS = 30_000;
export const HEALTH_REFRESH_INTERVAL_MS = 60_000;
export const DEDUPE_TTL_MS = 5 * 60_000;
export const DEDUPE_MAX = 1000;
