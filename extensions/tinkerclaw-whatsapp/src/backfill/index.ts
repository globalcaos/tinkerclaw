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
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
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

      // FORK 2026-08-04 — CIRCUIT BREAKER + COLLAPSED FAILURE LOG.
      //
      // Every chat used to get its own setTimeout, its own send, and its own failure
      // line. When the socket is down every one of the 50 fails identically, and the
      // caller re-invokes on each rebind: 256,809 "websocket not connected" lines in
      // three days, 66% of the whole gateway journal, drowning every other signal.
      //
      // A dropped link is a BATCH-level fact, not a per-chat one. The first transport
      // failure aborts the rest of the batch and reports once. Per-chat failures that
      // are NOT transport-level (a malformed id, say) do not abort — those are genuinely
      // per-chat and worth seeing individually.
      const isTransportDown = (e: string) =>
        /websocket not connected|websocket disconnected|not connected|Go process exited|connection (closed|timed out)/i.test(
          e,
        );

      // SEQUENTIAL, not 50 pre-scheduled timers. The first version of this fix kept the
      // fan-out of setTimeout(…, i*200) and aborted from inside the shared catch — which
      // measured 356 failures across 8 batches (~44 of 50 each) because a send takes longer
      // to fail than 200 ms, so nearly every timer had already fired before the first error
      // came back. Awaiting each send makes the circuit breaker actually immediate, and is
      // gentler on the socket besides.
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      for (let i = 0; i < staleChats.length; i++) {
        const chat = staleChats[i]!;
        const ageHours = (nowEpoch - chat.lastTs) / 3600;
        if (i > 0) await sleep(200);

        const isGroup = chat.chat.includes("@g.us");
        logger.info(
          { chat: chat.chat, ageHours: Math.round(ageHours), isGroup },
          "Backfill request for chat",
        );
        try {
          const historyMsg = await client.buildHistorySyncRequest(
            {
              chat: chat.chat,
              sender: chat.lastSender || jid,
              id: chat.lastId,
              timestamp: Math.floor(Date.now() / 1000),
            },
            50,
          );
          if (historyMsg) {
            await client.sendPeerMessage(historyMsg as Record<string, unknown>);
          } else {
            logger.warn({ chat: chat.chat }, "buildHistorySyncRequest returned null");
          }
          sent += 1;
          logger.info({ chat: chat.chat }, "Backfill request sent");
          visible("backfill request sent", { chat: chat.chat });
        } catch (err: unknown) {
          const msg = String(err);
          if (isTransportDown(msg)) {
            skipped = staleChats.length - i - 1;
            logger.warn(
              { sent, failed, skipped, error: msg },
              "Backfill batch aborted — transport down",
            );
            visible("backfill batch aborted — transport down", {
              sent,
              failed,
              skipped,
              error: msg,
            });
            return;
          }
          failed += 1;
          logger.warn({ chat: chat.chat, error: msg }, "Backfill request failed");
          visible("backfill request failed", { chat: chat.chat, error: msg });
        }
      }
      visible("backfill batch complete", { sent, failed });
    } catch (err) {
      logger.warn({ error: String(err) }, "Failed to run backfill");
    }
  })();
}
