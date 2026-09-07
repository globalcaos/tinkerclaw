/**
 * FORK: Live Message Capture — whatsmeow-node backend.
 * Bridges whatsmeow-node events to the SQLite history database.
 *
 * Captures every inbound/outbound message in real time, upserts chat metadata,
 * and triggers backfill for stale DM chats on connect. The backfill module
 * (../backfill/index.js) is loaded lazily so the history system works even
 * when backfill is not yet wired (Task 4).
 *
 * Wired in: session.ts calls bindWmHistoryCapture(client) after client creation.
 */

// FORK: whatsmeow-node is an optional Go-native addon; its types may be
// absent at type-check time. The client instance is supplied by session.ts
// at bind time, so we only need a loose structural shape that accepts the
// methods we actually call. Intersecting with Record keeps tsc happy for
// any downstream utility that poke at additional properties (e.g. the
// backfill module's WhatsmeowLikeClient). Runtime behavior unchanged.
type WhatsmeowClient = {
  // biome-ignore lint/suspicious/noExplicitAny: deliberate structural escape for optional Go addon
  on(event: string, handler: (payload: any) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic shape — the actual implementation lives in whatsmeow-node
  buildHistorySyncRequest(...args: any[]): any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic shape — the actual implementation lives in whatsmeow-node
  sendPeerMessage(...args: any[]): any;
} & Record<string, unknown>;
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { insertMessage, upsertChat, type MessageRecord } from "./db.js";

const logger = getChildLogger({ module: "wa-history-wm" });
// FORK 2026-05-01: a parallel visible log channel — the wa-history-wm pino
// child was getting filtered out of the gateway journal, leaving us blind
// to whether backfill was firing. Use console.log for the load-bearing
// lifecycle markers so they always reach systemd's journal capture.
const visible = (msg: string, extra?: Record<string, unknown>) => {
  console.log(`[wa-history-wm] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
};

/**
 * Extract text from a whatsmeow-node message payload.
 */
function extractText(msg: Record<string, unknown>): { text: string | null; type: string } {
  if (typeof msg.conversation === "string") {
    return { text: msg.conversation, type: "text" };
  }

  const ext = msg.extendedTextMessage as Record<string, unknown> | undefined;
  if (ext && typeof ext.text === "string") {
    return { text: ext.text, type: "text" };
  }

  if (msg.imageMessage) {
    const im = msg.imageMessage as Record<string, unknown>;
    return { text: (im.caption as string) || null, type: "image" };
  }
  if (msg.videoMessage) {
    const vm = msg.videoMessage as Record<string, unknown>;
    return { text: (vm.caption as string) || null, type: "video" };
  }
  if (msg.documentMessage) {
    const dm = msg.documentMessage as Record<string, unknown>;
    return { text: (dm.caption as string) || (dm.fileName as string) || null, type: "document" };
  }
  if (msg.audioMessage) {
    const am = msg.audioMessage as Record<string, unknown>;
    return { text: null, type: am.ptt ? "voice" : "audio" };
  }
  if (msg.stickerMessage) {
    return { text: null, type: "sticker" };
  }
  if (msg.locationMessage) {
    const lm = msg.locationMessage as Record<string, unknown>;
    return {
      text: (lm.name as string) || `${String(lm.degreesLatitude)},${String(lm.degreesLongitude)}`,
      type: "location",
    };
  }
  if (msg.reactionMessage) {
    const rm = msg.reactionMessage as Record<string, unknown>;
    return { text: (rm.text as string) || null, type: "reaction" };
  }
  if (msg.contactMessage) {
    const cm = msg.contactMessage as Record<string, unknown>;
    return { text: (cm.displayName as string) || null, type: "contact" };
  }
  if (msg.protocolMessage) {
    return { text: null, type: "protocol" };
  }

  return { text: null, type: "unknown" };
}

/**
 * Extract quoted message info from contextInfo.
 */
function extractQuotedInfo(msg: Record<string, unknown>): {
  quotedId: string | null;
  quotedText: string | null;
} {
  const ext = msg.extendedTextMessage as Record<string, unknown> | undefined;
  const ctx = ext?.contextInfo as Record<string, unknown> | undefined;
  if (!ctx?.quotedMessage) {
    return { quotedId: null, quotedText: null };
  }

  const quotedId = (ctx.stanzaId as string) || null;
  const qm = ctx.quotedMessage as Record<string, unknown>;
  let quotedText: string | null = null;
  if (typeof qm.conversation === "string") {
    quotedText = qm.conversation;
  } else if ((qm.extendedTextMessage as Record<string, unknown>)?.text) {
    quotedText = (qm.extendedTextMessage as Record<string, unknown>).text as string;
  }

  return { quotedId, quotedText };
}

// Backfill logic lives in ../backfill/index.ts — lazy-loaded so history
// works even before the backfill module is wired (Task 4).
let _backfillModule: typeof import("../backfill/index.js") | null = null;

async function loadBackfill() {
  if (!_backfillModule) {
    try {
      _backfillModule = await import("../backfill/index.js");
    } catch (err) {
      logger.warn({ error: String(err) }, "whatsapp-backfill module not available");
    }
  }
  return _backfillModule;
}

/**
 * Bind whatsmeow-node client events to SQLite history capture.
 */
export function bindWmHistoryCapture(client: WhatsmeowClient): void {
  // Guard: skip binding if client is a stub (whatsmeow-node not installed)
  if (!client || (client as unknown as { _isStub?: boolean })._isStub) {
    logger.info("Skipping whatsmeow history capture (stub client)");
    visible("skipping bind — stub client");
    return;
  }
  logger.info("Binding whatsmeow history capture");
  visible("binding whatsmeow history capture");

  // FORK: whatsmeow-node payload shapes are dynamic — treat via Record casts.
  type WmMessageInfo = {
    id: string;
    chat: string;
    sender: string;
    pushName?: string;
    isFromMe: boolean;
    isGroup: boolean;
    timestamp: number;
  };
  type WmMessagePayload = { info: WmMessageInfo; message: Record<string, unknown> };
  client.on("message", ({ info, message }: WmMessagePayload) => {
    const { text, type } = extractText(message);
    const { quotedId, quotedText } = extractQuotedInfo(message);

    const record: MessageRecord = {
      id: info.id,
      chat_jid: info.chat,
      sender_jid: info.isFromMe ? undefined : info.sender,
      sender_pushname: info.pushName || undefined,
      from_me: info.isFromMe,
      timestamp: info.timestamp,
      message_type: type,
      text_content: text || undefined,
      quoted_id: quotedId || undefined,
      quoted_text: quotedText || undefined,
      raw_json: JSON.stringify({ info, message }),
      source: "live-wm",
    };

    // Upsert chat metadata
    upsertChat(info.chat, undefined, info.isGroup);

    try {
      insertMessage(record);
      logger.debug({ id: info.id, chat: info.chat, type }, "Message captured (wm)");
    } catch {
      // INSERT OR REPLACE handles duplicates
    }
  });

  client.on("history_sync", ({ type }: { type: string }) => {
    logger.info({ type }, "History sync event received (whatsmeow)");
    // whatsmeow-node delivers history_sync as a notification;
    // individual messages arrive via the "message" event after sync completes.
  });

  let connectedJid: string | null = null;
  // FORK 2026-08-04: link state, tracked from the client's own lifecycle events.
  // Backfill sends peer messages over the socket, so dispatching while the link is
  // down produces nothing but failures — see the deferred triggers below.
  let linkUp = false;
  const deferredTimers: ReturnType<typeof setTimeout>[] = [];
  const cancelDeferred = (why: string) => {
    if (deferredTimers.length === 0) return;
    for (const t of deferredTimers) clearTimeout(t);
    deferredTimers.length = 0;
    visible("cancelled pending deferred backfill timers", { why });
  };

  client.on("connected", ({ jid }: { jid: string }) => {
    logger.info({ jid }, "Connected — history capture active (wm)");
    visible("connected event received", { jid });
    connectedJid = jid;
    linkUp = true;
    void loadBackfill().then((mod) => {
      if (!mod) {
        visible("backfill module unavailable on connected");
        return;
      }
      visible("invoking requestBackfill from connected handler", { jid });
      mod.requestBackfill(client, jid);
      void mod.writeLastConnected();
    });
  });

  // FORK 2026-08-04: the link going down must stop pending backfills. Without this,
  // a bind whose socket never came up still fired both deferred triggers below.
  for (const ev of ["disconnected", "logged_out"]) {
    client.on(ev, () => {
      linkUp = false;
      cancelDeferred(ev);
    });
  }

  // Deferred backfill trigger: fires 8s after bind to catch the case where
  // the 'connected' event already fired before we registered the listener
  // (common during QR login -> 515 restart -> fresh client handoff).
  //
  // FORK 2026-08-04 — THIS USED TO RUN "ANYWAY" WHEN connectedJid WAS NULL, and the
  // 60s trigger below ran unconditionally. Both dispatch up to 50 peer messages. The
  // WhatsApp channel rebinds constantly (2,573 "channel exited without an error" in
  // three days, most with `connection timed out after 60000ms`), so every rebind fired
  // 2 x 50 sends into a socket that was not up: 256,809 "backfill request failed
  // ... websocket not connected" lines in 3 days — 66% of the ENTIRE gateway journal.
  //
  // "connected not yet received" and "link is down" are indistinguishable from a null
  // jid alone, and the honest reading of a missing connected event is that we are NOT
  // connected. Both triggers now require a live link; a genuinely-missed connected
  // event is still covered, because whatsmeow re-emits it on the next successful bind.
  deferredTimers.push(
    setTimeout(() => {
      if (linkUp) {
        visible("8s deferred backfill firing — link up, connected event was missed", {
          jid: connectedJid ?? "",
        });
        void loadBackfill().then((mod) => mod?.requestBackfill(client, connectedJid ?? ""));
      } else {
        visible("8s deferred backfill SKIPPED — link is down");
      }
    }, 8000),
  );

  // Second attempt at 60s in case the first was too early (session still stabilizing).
  deferredTimers.push(
    setTimeout(() => {
      if (!linkUp) {
        visible("60s scheduled backfill SKIPPED — link is down");
        return;
      }
      logger.info("Scheduled backfill check (60s post-bind)");
      visible("60s scheduled backfill firing", { jid: connectedJid ?? "" });
      void loadBackfill().then((mod) => mod?.requestBackfill(client, connectedJid ?? ""));
    }, 60_000),
  );

  logger.info("whatsmeow history capture bound successfully");
  visible("bind complete; awaiting connected event");
}
