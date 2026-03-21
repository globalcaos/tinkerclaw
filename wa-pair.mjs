import { mkdir } from "fs/promises";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

const AUTH_DIR = "/home/globalcaos/.openclaw/credentials/whatsapp/default";
const logger = pino({ level: "warn" });

await mkdir(AUTH_DIR, { recursive: true });
const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
const { version } = await fetchLatestBaileysVersion();
console.log("WA version:", version);
console.log("Auth dir:", AUTH_DIR);
console.log("\nWaiting for QR... Scan it with WhatsApp > Linked Devices\n");

const sock = makeWASocket({
  auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
  version,
  logger,
  browser: ["openclaw", "cli", "2026.3.14"],
  syncFullHistory: false,
  markOnlineOnConnect: false,
});

sock.ev.on("creds.update", saveCreds);
sock.ev.on("connection.update", (update) => {
  const { connection, lastDisconnect, qr } = update;
  if (qr) {
    console.log("\n========== SCAN THIS QR CODE ==========\n");
    qrcode.generate(qr, { small: true });
    console.log("\n=======================================\n");
  }
  if (connection === "close") {
    const code = lastDisconnect?.error?.output?.statusCode;
    console.log("Connection closed, code:", code);
    if (code === 515) {
      console.log("Got 515 - reconnecting...");
      // Don't exit, Baileys will auto-reconnect
    } else {
      process.exit(1);
    }
  }
  if (connection === "open") {
    console.log("\n✅ SUCCESS! WhatsApp paired and connected!");
    console.log("Session saved to:", AUTH_DIR);
    console.log(
      "\nYou can now start the gateway: systemctl --user start openclaw-gateway.service\n",
    );
    setTimeout(() => process.exit(0), 3000);
  }
});

setTimeout(() => {
  console.log("\nTimeout after 3 minutes. Try again.");
  process.exit(1);
}, 180000);
