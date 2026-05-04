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
      console.log(
        `[wm-adapter] message event received: chat=${info.chat} id=${info.id} fromMe=${info.isFromMe} isGroup=${info.isGroup} sender=${info.sender}`,
      );
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
    this.wmClient.on("connected", () => {
      this.emit("connection.update", { connection: "open", qr: undefined });
    });

    this.wmClient.on("disconnected", () => {
      this.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: new Error("disconnected") },
      });
    });

    this.wmClient.on("logged_out", ({ reason }) => {
      const err = new Error(reason) as unknown as { output?: { statusCode: number } };
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

  // FORK 2026-05-03: deterministic selfJid seeding. The "connected" event
  // listener was racing — sometimes the event fired before the listener
  // attached (especially when the connection was already up at adapter
  // construction time), leaving sock.user.id=null and breaking access-control.
  // Now we seed from THREE sources in priority order:
  //   1. opts.selfJid (explicit override)
  //   2. wmClient.__initJid (set by createWmClient from init().jid — deterministic for paired stores)
  //   3. wmClient.on("connected") (still attached as a fallback for fresh pairings)
  // This makes selfJid populated synchronously after createWmClient returns,
  // and the listener acts as a backup for cases (1) and (2) miss.
  const initJid = (wmClient as unknown as { __initJid?: string }).__initJid ?? null;
  let selfJid: string | null = opts.selfJid ?? initJid ?? null;
  console.log(
    `[wm-adapter] selfJid seeded initial=${selfJid} (from ${
      opts.selfJid ? "opts" : initJid ? "init" : "none"
    })`,
  );
  wmClient.on("connected", ({ jid }) => {
    selfJid = jid;
    console.log(`[wm-adapter] connected event captured selfJid=${jid}`);
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
      // Convert Baileys message format to whatsmeow format. The whatsmeow
      // sendMessage returns SendResponse = { id, timestamp }; the Baileys
      // callers (inbound/monitor.ts:rememberOutboundMessage at line 232)
      // read result.key.id to track outbound ids and match echoes.
      // FORK 2026-05-01: wrap the SendResponse into a Baileys-shaped key so
      // upstream sendTrackedMessage gets a real id instead of "unknown".
      let resp: { id: string; timestamp?: number };
      if (typeof content === "object" && "text" in content) {
        resp = (await wmClient.sendMessage(jid, {
          conversation: content.text as string,
        })) as { id: string; timestamp?: number };
      } else if (typeof content === "object" && "poll" in content) {
        // FORK 2026-05-03: whatsmeow-node's MessageContent only accepts text /
        // extended-text shapes; polls go through a dedicated method
        // `sendPollCreation(jid, name, options, selectableCount)`. Without
        // this branch sendRawMessage trips "unknown field 'poll'" in proto
        // parsing. The Baileys-shaped { poll: { name, values, selectableCount } }
        // maps 1:1.
        const poll = (
          content as { poll: { name: string; values: string[]; selectableCount?: number } }
        ).poll;
        resp = await (
          wmClient as unknown as {
            sendPollCreation: (
              jid: string,
              name: string,
              options: string[],
              selectableCount: number,
            ) => Promise<{ id: string; timestamp?: number }>;
          }
        ).sendPollCreation(jid, poll.name, poll.values, poll.selectableCount ?? 1);
      } else if (typeof content === "object" && "react" in content) {
        // FORK 2026-05-04: same class of bug as polls. whatsmeow-node has a
        // dedicated `sendReaction(chat, sender, id, reaction)` and rejects
        // Baileys-shaped `{react: {text, key}}` payloads via sendRawMessage.
        // Without this branch the thinking-reaction heartbeat (and any other
        // reaction send) silently no-ops at the wire — visible symptom: emoji
        // never appears on the user's message.
        const reactPayload = (
          content as {
            react: {
              text: string;
              key: { remoteJid?: string; id: string; fromMe?: boolean; participant?: string };
            };
          }
        ).react;
        const reactChat = reactPayload.key.remoteJid ?? jid;
        const reactSender = reactPayload.key.participant ?? reactPayload.key.remoteJid ?? jid;
        try {
          resp = await (
            wmClient as unknown as {
              sendReaction: (
                chat: string,
                sender: string,
                id: string,
                reaction: string,
              ) => Promise<{ id: string; timestamp?: number }>;
            }
          ).sendReaction(reactChat, reactSender, reactPayload.key.id, reactPayload.text);
          console.log(
            `[wm-adapter] reaction sent chat=${reactChat} msgId=${reactPayload.key.id} emoji=${JSON.stringify(reactPayload.text)}`,
          );
        } catch (err) {
          console.log(
            `[wm-adapter] reaction FAILED chat=${reactChat} msgId=${reactPayload.key.id} emoji=${JSON.stringify(reactPayload.text)} err=${String(err).slice(0, 200)}`,
          );
          throw err;
        }
      } else {
        resp = (await wmClient.sendRawMessage(jid, content)) as {
          id: string;
          timestamp?: number;
        };
      }
      return {
        key: { id: resp.id, remoteJid: jid, fromMe: true },
        messageTimestamp: resp.timestamp,
      };
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

    // FORK: whatsmeow-node has no bulk "fetch all participating groups" call;
    // return empty so upstream's pre-warm step succeeds. Groups still resolve
    // lazily via groupMetadata above.
    groupFetchAllParticipating: async () => {
      return {};
    },
  };

  return adapter;
}
