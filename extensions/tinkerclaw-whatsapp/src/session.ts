/**
 * WhatsApp session module using whatsmeow-node.
 *
 * Manages whatsmeow-node client lifecycle: creation, connection, disconnection.
 * The client wraps a Go subprocess that speaks the WhatsApp protocol natively,
 * providing better stability and reconnect behaviour than Baileys.
 *
 * Wired in: index.ts re-exports the public API. The channel registration
 * (Task 8) calls createWmClient() + connectWmClient() during startup.
 */

import { createClient, type WhatsmeowClient } from "@whatsmeow-node/whatsmeow-node";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { ensureDir, resolveUserPath } from "openclaw/plugin-sdk/text-runtime";

// TODO(task-3): uncomment after history module is moved
// import { bindWmHistoryCapture } from "../src/history/live-capture-wm.js";
function bindWmHistoryCapture(_client: WhatsmeowClient): void {
  // no-op stub — will be replaced in Task 3
}

export type { WhatsmeowClient };

const DEFAULT_STORE_PATH = "~/.openclaw/credentials/whatsapp/default/whatsmeow.db";

let activeClient: WhatsmeowClient | null = null;

const logger = getChildLogger({ module: "wm-session" });

export interface CreateWmClientOptions {
  storePath?: string;
  onQr?: (code: string) => void;
  verbose?: boolean;
}

/**
 * Create and initialise a whatsmeow-node client.
 * Does NOT call connect() — caller decides when to connect.
 */
export async function createWmClient(opts: CreateWmClientOptions = {}): Promise<WhatsmeowClient> {
  const storePath = resolveUserPath(opts.storePath ?? DEFAULT_STORE_PATH);
  const storeDir = storePath.replace(/\/[^/]+$/, "");
  await ensureDir(storeDir);

  const client = createClient({ store: storePath });

  // ── QR events ──
  if (opts.onQr) {
    client.on("qr", ({ code }) => opts.onQr!(code));
  }

  // ── Connection lifecycle ──
  client.on("connected", ({ jid }) => {
    logger.info({ jid }, "whatsmeow connected");
  });

  client.on("disconnected", () => {
    logger.warn("whatsmeow disconnected");
  });

  client.on("logged_out", ({ reason }) => {
    logger.error({ reason }, "whatsmeow logged out");
  });

  // ── Forward whatsmeow internal logs when verbose ──
  if (opts.verbose) {
    client.on("log", ({ level, msg }) => {
      logger.debug({ wmLevel: level }, msg);
    });
  }

  // ── Error safety net ──
  client.on("error", (err) => {
    logger.error({ error: String(err) }, "whatsmeow client error");
  });

  // ── Bind history capture ──
  try {
    // TODO(task-3): uncomment after history module is moved
    bindWmHistoryCapture(client);
    logger.info("whatsmeow history live-capture bound");
  } catch (err) {
    logger.warn({ error: String(err) }, "whatsmeow history capture failed to bind");
  }

  // Init (loads store, but does not connect)
  await client.init();

  activeClient = client;
  return client;
}

/** Get the currently active whatsmeow client (if any). */
export function getWmClient(): WhatsmeowClient | null {
  return activeClient;
}

/** Connect + wait for connection (with timeout). */
export async function connectWmClient(client: WhatsmeowClient, timeoutMs = 60_000): Promise<void> {
  await client.connect();
  const connected = await client.waitForConnection(timeoutMs);
  if (!connected) {
    throw new Error(`whatsmeow: connection timed out after ${timeoutMs}ms`);
  }
}

/** Gracefully disconnect. */
export async function disconnectWmClient(client?: WhatsmeowClient): Promise<void> {
  const c = client ?? activeClient;
  if (!c) {
    return;
  }
  try {
    await c.disconnect();
  } catch {
    // best-effort
  }
  if (c === activeClient) {
    activeClient = null;
  }
}
