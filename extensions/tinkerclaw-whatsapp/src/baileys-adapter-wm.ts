/**
 * Baileys-compatible adapter for whatsmeow-node.
 *
 * Wraps a whatsmeow-node client to expose the subset of the Baileys socket
 * interface that monitor.ts and send.ts rely on. This lets us swap the
 * backend without rewriting 400+ lines of message processing.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { WhatsmeowClient } from "@whatsmeow-node/whatsmeow-node";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { archiveOutboundSend } from "./history/outbound-archive.js";

const logger = getChildLogger({ module: "wm-adapter" });

type AnyMessageContent = Record<string, unknown>;

const WM_MEDIA_KINDS = ["document", "image", "video", "audio"] as const;
type WmMediaKind = (typeof WM_MEDIA_KINDS)[number];

function findWmMediaKind(content: AnyMessageContent): WmMediaKind | undefined {
  return WM_MEDIA_KINDS.find((kind) => Buffer.isBuffer(content[kind]));
}

function carriesBytes(content: AnyMessageContent): boolean {
  return Object.values(content).some((v) => Buffer.isBuffer(v) || v instanceof Uint8Array);
}

/**
 * FORK 2026-09-25: whatsmeow-node sends media in two steps: uploadMedia(path, kind), then
 * sendRawMessage with the proto fields it returns (library README + examples/media-send-all.ts).
 * Before this, a Baileys-shaped `{document: Buffer}` fell through to sendRawMessage with the
 * file bytes inside the JSON IPC line; the Go helper died on it and the next stdin write
 * crashed the whole gateway with an uncaught `write EPIPE` (3 of 3 sends, 2026-09-15/16).
 */
export async function sendWmMedia(
  wmClient: Pick<WhatsmeowClient, "uploadMedia" | "sendRawMessage">,
  jid: string,
  content: AnyMessageContent,
): Promise<{ id: string; timestamp?: number; message: Record<string, unknown> }> {
  const kind = findWmMediaKind(content);
  if (!kind) {
    throw new Error("sendWmMedia: content has no document/image/video/audio buffer");
  }
  const buffer = content[kind] as Buffer;
  const mimetype =
    typeof content.mimetype === "string" && content.mimetype
      ? content.mimetype
      : "application/octet-stream";
  const caption =
    typeof content.caption === "string" && content.caption ? content.caption : undefined;
  const fileName =
    typeof content.fileName === "string" && content.fileName ? content.fileName : undefined;

  const tempRoot = resolvePreferredOpenClawTmpDir();
  await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(tempRoot, "wm-upload-"));
  const filePath = path.join(dir, `upload${path.extname(fileName ?? "")}`);
  try {
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    const media = await wmClient.uploadMedia(filePath, kind);
    const shared = {
      URL: media.URL,
      directPath: media.directPath,
      mediaKey: media.mediaKey,
      fileEncSHA256: media.fileEncSHA256,
      fileSHA256: media.fileSHA256,
      fileLength: String(media.fileLength),
      mimetype,
    };
    const withCaption = caption ? { caption } : {};
    const message =
      kind === "document"
        ? { documentMessage: { ...shared, fileName: fileName ?? "file", ...withCaption } }
        : kind === "image"
          ? { imageMessage: { ...shared, ...withCaption } }
          : kind === "video"
            ? {
                videoMessage: {
                  ...shared,
                  ...withCaption,
                  ...(content.gifPlayback === true ? { gifPlayback: true } : {}),
                },
              }
            : { audioMessage: { ...shared, ...(content.ptt === true ? { ptt: true } : {}) } };
    const resp = (await wmClient.sendRawMessage(jid, message)) as {
      id: string;
      timestamp?: number;
    };
    console.log(
      `[wm-adapter] media sent kind=${kind} bytes=${buffer.length} to=${jid} id=${resp.id}`,
    );
    return { ...resp, message };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** whatsmeow's send time (unix seconds), or now when the response carries none. */
function sentAtSec(resp: { timestamp?: number }): number {
  return typeof resp.timestamp === "number" && resp.timestamp > 0
    ? resp.timestamp
    : Math.floor(Date.now() / 1000);
}

type WAPresence = "available" | "unavailable" | "composing" | "recording" | "paused";

type BaileysQuote = {
  key?: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
  };
  message?: Record<string, unknown> | null;
};

/**
 * FORK 2026-10-03: a Baileys `quoted` send option as whatsmeow contextInfo. The id field is
 * `stanzaID`: the Go bridge parses messages with protojson, which rejects the `stanzaId` spelling
 * whatsmeow-node's README shows (measured against whatsmeow 2026-09-04, 2026-10-03).
 */
export function toWmQuoteContext(
  quoted: BaileysQuote,
  selfJid: string | null,
): Record<string, unknown> | undefined {
  const id = quoted.key?.id;
  if (!id) {
    return undefined;
  }
  const sender = quoted.key?.fromMe
    ? selfJid?.replace(/:\d+@/, "@")
    : (quoted.key?.participant ?? quoted.key?.remoteJid);
  return {
    stanzaID: id,
    ...(sender ? { participant: sender } : {}),
    ...(quoted.message ? { quotedMessage: quoted.message } : {}),
  };
}

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

    sendMessage: async (
      jid: string,
      content: AnyMessageContent,
      options?: { quoted?: BaileysQuote },
    ) => {
      // Convert Baileys message format to whatsmeow format. The whatsmeow
      // sendMessage returns SendResponse = { id, timestamp }; the Baileys
      // callers (inbound/monitor.ts:rememberOutboundMessage at line 232)
      // read result.key.id to track outbound ids and match echoes.
      // FORK 2026-05-01: wrap the SendResponse into a Baileys-shaped key so
      // upstream sendTrackedMessage gets a real id instead of "unknown".
      let resp: { id: string; timestamp?: number };
      // FORK 2026-10-03: the message that went on the wire, for the history DB (outbound-archive.ts).
      // Reactions and polls stay out: the thinking-reaction cycle alone would flood it.
      let sent: Record<string, unknown> | undefined;
      if (typeof content === "object" && content.edit && "text" in content) {
        // FORK 2026-10-03: edit. Baileys sends `{text, edit: key}`, which the text branch below
        // would post as a NEW message; whatsmeow-node's editMessage does BuildEdit + send.
        const key = content.edit as { remoteJid?: string; id: string };
        resp = await wmClient.editMessage(key.remoteJid ?? jid, key.id, {
          conversation: content.text as string,
        });
        console.log(`[wm-adapter] edited chat=${key.remoteJid ?? jid} msgId=${key.id}`);
        archiveOutboundSend({
          kind: "edit",
          id: key.id,
          text: content.text as string,
          atSec: sentAtSec(resp),
        });
      } else if (typeof content === "object" && "text" in content) {
        // A quoted reply goes raw: same bridge command, but the typed form spells `stanzaId`.
        const quote = options?.quoted ? toWmQuoteContext(options.quoted, selfJid) : undefined;
        sent = quote
          ? { extendedTextMessage: { text: content.text as string, contextInfo: quote } }
          : { conversation: content.text as string };
        resp = (
          quote
            ? await wmClient.sendRawMessage(jid, sent)
            : await wmClient.sendMessage(jid, { conversation: content.text as string })
        ) as { id: string; timestamp?: number };
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
      } else if (typeof content === "object" && "delete" in content) {
        // FORK 2026-10-02: delete-for-everyone. Baileys sends `{delete: key}`; whatsmeow-node has
        // a dedicated revokeMessage(chat, sender, id) and sendRawMessage rejects the Baileys shape.
        // Our own message: sender = selfJid (whatsmeow compares the user part and sets FromMe).
        const key = (
          content as {
            delete: { remoteJid?: string; id: string; fromMe?: boolean; participant?: string };
          }
        ).delete;
        const chat = key.remoteJid ?? jid;
        const sender = key.fromMe === false ? (key.participant ?? chat) : (selfJid ?? "");
        await wmClient.revokeMessage(chat, sender, key.id);
        console.log(
          `[wm-adapter] revoked chat=${chat} msgId=${key.id} fromMe=${key.fromMe !== false}`,
        );
        resp = { id: key.id };
        if (key.fromMe !== false) {
          archiveOutboundSend({ kind: "revoke", id: key.id, atSec: sentAtSec(resp) });
        }
      } else if (typeof content === "object" && findWmMediaKind(content)) {
        const media = await sendWmMedia(wmClient, jid, content);
        resp = media;
        sent = media.message;
      } else if (typeof content === "object" && carriesBytes(content)) {
        // Guard, not cure: any other payload with raw bytes (sticker, etc.) would take the same
        // IPC path that killed the gateway. Fail this one send instead.
        throw new Error(
          `[wm-adapter] refusing raw send with binary payload (keys: ${Object.keys(content).join(",")}); ` +
            "whatsmeow needs uploadMedia first",
        );
      } else {
        resp = (await wmClient.sendRawMessage(jid, content)) as {
          id: string;
          timestamp?: number;
        };
        sent = content;
      }
      if (sent) {
        archiveOutboundSend({
          kind: "message",
          id: resp.id,
          chatJid: jid,
          timestampSec: sentAtSec(resp),
          message: sent,
        });
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

    // FORK 2026-10-03: the group calls behind the plugin's renameGroup / setGroupIcon / leaveGroup.
    groupUpdateSubject: (jid: string, subject: string) => wmClient.setGroupName(jid, subject),
    updateProfilePicture: async (jid: string, content: { url?: unknown }) => {
      if (typeof content?.url !== "string") {
        throw new Error("[wm-adapter] group icon needs a local file path ({url: path})");
      }
      // whatsmeow reads the file itself and only takes a JPEG.
      await wmClient.setGroupPhoto(jid, content.url);
    },
    groupLeave: (jid: string) => wmClient.leaveGroup(jid),

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
