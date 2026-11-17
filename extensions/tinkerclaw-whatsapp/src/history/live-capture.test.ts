// 2026-11-14 burn review b1113-c F7: live capture runs inside whatsmeow-node's
// stdout handler. A throw there is an uncaught exception that exits the gateway,
// and the adapter's later `message` listener never runs. An archive that cannot
// be written must cost the archive row, never the message.
import { EventEmitter } from "node:events";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const home = mkdtempSync(path.join(tmpdir(), "wa-live-capture-home-"));
vi.stubEnv("HOME", home);
vi.stubEnv("OPENCLAW_HOME", home);
vi.stubEnv("OPENCLAW_WHATSAPP_HISTORY_RETENTION_DAYS", "");

const db = await import("./db.js");
const { bindWmHistoryCapture } = await import("./live-capture.js");

describe("live capture", () => {
  it("an unwritable archive never throws out of the event, and later listeners still run", () => {
    expect(db.HISTORY_DB_PATH.startsWith(home)).toBe(true);
    fs.mkdirSync(db.HISTORY_DB_PATH, { recursive: true }); // a directory cannot be opened as a database
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers(); // keeps the deferred backfill timers parked
    try {
      const client = new EventEmitter();
      bindWmHistoryCapture(client as never);
      const adapterListener = vi.fn(); // stands in for the adapter's listener in baileys-adapter-wm.ts
      client.on("message", adapterListener);
      const payload = {
        info: {
          id: "M1",
          chat: "34600000000@s.whatsapp.net",
          sender: "34600000000@s.whatsapp.net",
          isFromMe: false,
          isGroup: false,
          timestamp: 1_790_000_000,
        },
        message: { conversation: "hola" },
      };
      expect(() => client.emit("message", payload)).not.toThrow();
      expect(adapterListener).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("M1"));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      fs.rmdirSync(db.HISTORY_DB_PATH);
    }
  });
});
