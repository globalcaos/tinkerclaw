import "./monitor-inbox.test-harness.js";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  installWebMonitorInboxUnitTestHooks,
  setHistoryDbForTest,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

function seedHistory(rows: Array<{ chat: string; ts: number; type: string }>) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE messages (chat_jid TEXT, timestamp INTEGER, message_type TEXT)");
  const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?)");
  for (const row of rows) {
    insert.run(row.chat, row.ts, row.type);
  }
  return db;
}

describe("append upsert handling (#20952)", () => {
  installWebMonitorInboxUnitTestHooks();

  it("processes recent append messages (within 60s of connect)", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    // Timestamp ~5 seconds ago — recent, should be processed.
    const recentTs = Math.floor(Date.now() / 1000) - 5;
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "recent-1", fromMe: false, remoteJid: "120363@g.us" },
          message: { conversation: "hello from group" },
          messageTimestamp: recentTs,
          pushName: "Tester",
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("skips stale append messages (older than 60s before connect)", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    // Timestamp 5 minutes ago — stale history sync, should be skipped.
    const staleTs = Math.floor(Date.now() / 1000) - 300;
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "stale-1", fromMe: false, remoteJid: "120363@g.us" },
          message: { conversation: "old history sync" },
          messageTimestamp: staleTs,
          pushName: "OldTester",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("skips append messages with NaN/non-finite timestamps", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    // NaN timestamp should be treated as 0 (stale) and skipped.
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "nan-1", fromMe: false, remoteJid: "120363@g.us" },
          message: { conversation: "bad timestamp" },
          messageTimestamp: Number.NaN,
          pushName: "BadTs",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("handles Long-like protobuf timestamps correctly", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    // Baileys can deliver messageTimestamp as a Long object (from protobufjs).
    // Number(longObj) calls valueOf() and returns the numeric value.
    const recentTs = Math.floor(Date.now() / 1000) - 5;
    const longLike = { low: recentTs, high: 0, unsigned: true, valueOf: () => recentTs };
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "long-1", fromMe: false, remoteJid: "120363@g.us" },
          message: { conversation: "long timestamp" },
          messageTimestamp: longLike,
          pushName: "LongTs",
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  // A notify message is exempt from the append gate (which skips anything older
  // than connect-60s), so an offline-queued message delivered on reconnect still
  // gets answered. One hour old would be dropped as "append", kept as "notify".
  it("processes notify messages predating connect (offline queue)", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    const oldTs = Math.floor(Date.now() / 1000) - 3600;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "notify-1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "normal message" },
          messageTimestamp: oldTs,
          pushName: "User",
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  // REGRESSION 2026-09-17: this case previously asserted the opposite ("always
  // processes notify messages regardless of timestamp"), which was true of the
  // Baileys backend, where notify meant live. The whatsmeow adapter labels every
  // message notify — including the ON_DEMAND history-sync replays requested on
  // each reconnect — so that assumption re-fired a 71-day-old owner message and
  // posted the answer twice into a 25-person group. Old is old on every type.
  it("skips notify messages older than the absolute staleness cap", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    const replayedTs = Math.floor(Date.now() / 1000) - 71 * 86400;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "replay-1", fromMe: false, remoteJid: "120363@g.us" },
          message: { conversation: "Jarvis, summarize that video here" },
          messageTimestamp: replayedTs,
          pushName: "Owner",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  // 2026-09-30, the architect: "don't reply without understanding if the conversation
  // has moved forward". A reconnect also replays messages younger than the 12h
  // cap, and one the agent already answered must not be answered again.
  it("skips an older message the conversation has already moved past", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    setHistoryDbForTest(seedHistory([{ chat: "120363@g.us", ts: nowSec - 3540, type: "text" }]));
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "answered-1", fromMe: false, remoteJid: "120363@g.us" },
          message: { conversation: "Jarvis, summarize that video here" },
          messageTimestamp: nowSec - 3600,
          pushName: "Owner",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("still answers an older message that is the end of the conversation", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Only a reaction came after it, and reactions are not conversation.
    setHistoryDbForTest(
      seedHistory([{ chat: "120363@g.us", ts: nowSec - 3540, type: "reaction" }]),
    );
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "unanswered-1", fromMe: false, remoteJid: "120363@g.us" },
          message: { conversation: "Jarvis, are you there?" },
          messageTimestamp: nowSec - 3600,
          pushName: "Owner",
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });
});
