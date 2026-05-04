/**
 * FORK: WhatsApp Backfill plugin.
 *
 * On WhatsApp reconnect, calculates actual downtime from a persisted timestamp
 * and requests history sync for stale chats (DMs + groups) via whatsmeow's
 * peer message protocol. Messages land silently in the whatsapp-history SQLite DB.
 *
 * Pairs with BOOTSTRAP.md's "Missed Trigger Review" — the agent layer scans
 * the backfilled messages on first interaction and surfaces anything actionable.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getChildLogger } from "../../../../src/logging.js";
import { getDb } from "../history/db.js";

const logger = getChildLogger({ module: "whatsapp-backfill" });

const BACKFILL_DIR = resolve(
  process.env.HOME ?? "/tmp",
  ".openclaw/workspace/memory/whatsapp-backfill",
);
const LAST_CONNECTED_FILE = resolve(BACKFILL_DIR, "last-connected.txt");

/** Read the last-connected timestamp. Returns epoch seconds, or null if unknown. */
async function readLastConnected(): Promise<number | null> {
  try {
    const raw = await readFile(LAST_CONNECTED_FILE, "utf-8");
    const ms = Date.parse(raw.trim());
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  } catch {
    return null;
  }
}

/** Persist the current timestamp as last-connected. */
export async function writeLastConnected(): Promise<void> {
  try {
    await mkdir(BACKFILL_DIR, { recursive: true });
    await writeFile(LAST_CONNECTED_FILE, new Date().toISOString(), "utf-8");
  } catch (err) {
    logger.warn({ error: String(err) }, "Failed to write last-connected timestamp");
  }
}

interface WhatsmeowLikeClient {
  buildHistorySyncRequest(
    params: { chat: string; sender: string; id: string; timestamp: number },
    count: number,
  ): Promise<Record<string, unknown> | null>;
  sendPeerMessage(msg: Record<string, unknown>): Promise<unknown>;
}

/**
 * Request backfill for chats (DMs + groups) with messages older than the downtime window.
 * Uses the last-connected timestamp to determine actual downtime.
 */
export function requestBackfill(client: WhatsmeowLikeClient, jid: string): void {
  // FORK 2026-05-01: visible diagnostics — pino logger for this module was
  // getting filtered out of the gateway journal, leaving us blind to whether
  // backfill was actually firing. console.log always reaches systemd capture.
  const visible = (msg: string, extra?: Record<string, unknown>) => {
    console.log(`[wa-backfill] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
  };
  visible("requestBackfill invoked", { jid });
  void (async () => {
    try {
      const db = getDb();
      if (!db) {
        visible("aborted — getDb() returned null");
        return;
      }

      const lastConnectedEpoch = await readLastConnected();
      const nowEpoch = Math.floor(Date.now() / 1000);

      let downtimeSeconds: number;
      if (lastConnectedEpoch) {
        downtimeSeconds = nowEpoch - lastConnectedEpoch;
      } else {
        downtimeSeconds = 3600;
        logger.info("No last-connected timestamp found — assuming 1h downtime");
        visible("no last-connected anchor; assuming 1h downtime");
      }

      const downtimeMinutes = Math.round(downtimeSeconds / 60);
      visible("computed downtime", { downtimeSeconds, downtimeMinutes });

      if (downtimeSeconds < 300) {
        logger.info({ downtimeMinutes }, "Backfill skipped — downtime under 5 minutes");
        visible("skipped — downtime < 5 min", { downtimeMinutes });
        return;
      }

      const cutoff = nowEpoch - downtimeSeconds;

      const staleChats = db
        .prepare(
          `SELECT chat_jid as chat, MAX(timestamp) as lastTs,
                (SELECT id FROM messages m2 WHERE m2.chat_jid = m.chat_jid ORDER BY timestamp DESC LIMIT 1) as lastId,
                (SELECT COALESCE(sender_jid, '') FROM messages m3 WHERE m3.chat_jid = m.chat_jid ORDER BY timestamp DESC LIMIT 1) as lastSender
         FROM messages m
         WHERE chat_jid != 'status@broadcast'
         GROUP BY chat_jid
         HAVING MAX(timestamp) < ?
         ORDER BY MAX(timestamp) DESC
         LIMIT 50`,
        )
        .all(cutoff) as Array<{
        chat: string;
        lastTs: number;
        lastId: string;
        lastSender: string;
      }>;

      if (staleChats.length === 0) {
        logger.info({ downtimeMinutes }, "No stale chats found for backfill");
        visible("no stale chats found", { downtimeMinutes });
        return;
      }

      logger.info(
        { count: staleChats.length, downtimeMinutes },
        "Found stale chats — requesting backfill (DMs + groups)",
      );
      visible("found stale chats — dispatching", {
        count: staleChats.length,
        downtimeMinutes,
        oldestChat: staleChats[staleChats.length - 1]?.chat,
      });

      let delay = 0;
      for (const chat of staleChats) {
        const ageHours = (nowEpoch - chat.lastTs) / 3600;
        delay += 200;
        setTimeout(() => {
          const isGroup = chat.chat.includes("@g.us");
          logger.info(
            { chat: chat.chat, ageHours: Math.round(ageHours), isGroup },
            "Backfill request for chat",
          );
          void client
            .buildHistorySyncRequest(
              {
                chat: chat.chat,
                sender: chat.lastSender || jid,
                id: chat.lastId,
                timestamp: Math.floor(Date.now() / 1000),
              },
              50,
            )
            .then((historyMsg) => {
              if (historyMsg) {
                return client.sendPeerMessage(historyMsg as Record<string, unknown>);
              }
              logger.warn({ chat: chat.chat }, "buildHistorySyncRequest returned null");
            })
            .then(() => {
              logger.info({ chat: chat.chat }, "Backfill request sent");
              visible("backfill request sent", { chat: chat.chat });
            })
            .catch((err: unknown) => {
              logger.warn({ chat: chat.chat, error: String(err) }, "Backfill request failed");
              visible("backfill request failed", { chat: chat.chat, error: String(err) });
            });
        }, delay);
      }
    } catch (err) {
      logger.warn({ error: String(err) }, "Failed to run backfill");
    }
  })();
}
