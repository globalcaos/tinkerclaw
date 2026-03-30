/**
 * Baileys-compatible adapter for whatsmeow-node.
 *
 * Wraps a whatsmeow-node client to expose the subset of the Baileys socket
 * interface that monitor.ts and send.ts rely on. This lets us swap the
 * backend without rewriting 400+ lines of message processing.
 */

import { EventEmitter } from "node:events";
import type { WhatsmeowClient } from "@whatsmeow-node/whatsmeow-node";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";

const logger = getChildLogger({ module: "wm-adapter" });

type AnyMessageContent = Record<string, unknown>;
type WAPresence = "available" | "unavailable" | "composing" | "recording" | "paused";

/**
 * Minimal Baileys-compatible event emitter that bridges whatsmeow events.
 */
class BaileysEventBridge extends EventEmitter {
  /** @internal */ wmClient: WhatsmeowClient;
  constructor(wmClient: WhatsmeowClient) {
    super();
    this.wmClient = wmClient;
    this.wireEvents();
  }

  /** @internal */ wireEvents() {
    // Map whatsmeow "message" → Baileys "messages.upsert"
    this.wmClient.on("message", ({ info, message }) => {
      console.log(`[wm-adapter] message event received: chat=${info.chat} id=${info.id} fromMe=${info.isFromMe} isGroup=${info.isGroup} sender=${info.sender}`);
      const baileysMsg = {
        key: {
          remoteJid: info.chat,
          id: info.id,
          fromMe: info.isFromMe,
          participant: info.isGroup ? info.sender : undefined,
        },
        messageTimestamp: info.timestamp,
        pushName: info.pushName,
        message: message,
      };
      this.emit("messages.upsert", { messages: [baileysMsg], type: "notify" });
    });

    // Map whatsmeow connection events → Baileys "connection.update"
    this.wmClient.on("connected", ({ jid }) => {
      this.emit("connection.update", { connection: "open", qr: undefined });
    });

    this.wmClient.on("disconnected", () => {
      this.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: new Error("disconnected") },
      });
    });

    this.wmClient.on("logged_out", ({ reason }) => {
      const err = new Error(reason) as any;
      err.output = { statusCode: 401 };
      this.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: err },
      });
    });

    this.wmClient.on("qr", ({ code }) => {
      this.emit("connection.update", { qr: code });
    });
  }
}

export interface BaileysAdapterOptions {
  wmClient: WhatsmeowClient;
  selfJid?: string;
}

/**
 * Create a Baileys-compatible socket facade from a whatsmeow-node client.
 */
export function createBaileysAdapter(opts: BaileysAdapterOptions) {
  const { wmClient } = opts;
  const ev = new BaileysEventBridge(wmClient);

  let selfJid: string | null = opts.selfJid ?? null;

  wmClient.on("connected", ({ jid }) => {
    selfJid = jid;
  });

  const adapter = {
    ev,
    user: {
      get id() {
        return selfJid;
      },
    },
    ws: {
      close: () => {
        void wmClient.disconnect();
      },
      on: (_event: string, _handler: (...args: unknown[]) => void) => {
        // No-op: whatsmeow handles WS internally
      },
    },
    signalRepository: {
      // whatsmeow handles LID mapping internally
      lidMapping: undefined,
    },

    sendMessage: async (jid: string, content: AnyMessageContent) => {
      // Convert Baileys message format to whatsmeow format
      if (typeof content === "object" && "text" in content) {
        return wmClient.sendMessage(jid, {
          conversation: content.text as string,
        });
      }
      // For other message types, try sendRawMessage
      return wmClient.sendRawMessage(jid, content);
    },

    sendPresenceUpdate: async (presence: WAPresence, jid?: string) => {
      try {
        if (presence === "composing" && jid) {
          await wmClient.sendChatPresence(jid, "composing", "");
        } else if (presence === "available") {
          await wmClient.sendPresence("available");
        } else if (presence === "unavailable") {
          await wmClient.sendPresence("unavailable");
        }
      } catch (err) {
        logger.debug({ error: String(err) }, "presence update failed");
      }
    },

    readMessages: async (
      keys: Array<{ remoteJid: string; id: string; participant?: string; fromMe?: boolean }>,
    ) => {
      // Group by chat for batching
      const byChat = new Map<string, { ids: string[]; sender?: string }>();
      for (const key of keys) {
        const existing = byChat.get(key.remoteJid);
        if (existing) {
          existing.ids.push(key.id);
        } else {
          byChat.set(key.remoteJid, { ids: [key.id], sender: key.participant });
        }
      }
      for (const [chat, { ids, sender }] of byChat) {
        try {
          await wmClient.markRead(ids, chat, sender);
        } catch (err) {
          logger.debug({ error: String(err) }, "read receipt failed");
        }
      }
    },

    groupMetadata: async (jid: string) => {
      const info = await wmClient.getGroupInfo(jid);
      return {
        subject: info.name,
        participants: info.participants.map((p) => ({ id: p.jid })),
      };
    },
  };

  return adapter;
}
