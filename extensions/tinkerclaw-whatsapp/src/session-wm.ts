/**
 * FORK: WhatsApp session module using whatsmeow-node.
 * Drop-in alternative to session.ts (Baileys).
 *
 * whatsmeow-node is an OPTIONAL Go-native addon. It may be absent on
 * machines without the Go toolchain (dev laptops, CI runners, Docker).
 * To keep the gateway bootable in that case, the package is loaded
 * LAZILY — only when createWmClient() is actually called. The top-level
 * type is declared structurally so tsc can still type-check without the
 * real module's types.
 */

import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { ensureDir, resolveUserPath } from "openclaw/plugin-sdk/text-runtime";
import { bindWmHistoryCapture } from "../../tinkerclaw-whatsapp/src/history/live-capture.js";

// FORK: structural type for WhatsmeowClient. Matches the subset of methods
// we actually call. The real module's type is imported dynamically below.
export type WhatsmeowClient = {
  // biome-ignore lint/suspicious/noExplicitAny: optional Go-native addon shape
  on(event: string, handler: (payload: any) => void): void;
  init(): Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic
  [key: string]: any;
};

// Lazy holder for the createClient function from the optional module.
// biome-ignore lint/suspicious/noExplicitAny: optional module
let _createClient: ((opts: { store: string }) => WhatsmeowClient) | null = null;
async function loadCreateClient(): Promise<(opts: { store: string }) => WhatsmeowClient> {
  if (_createClient) {
    return _createClient;
  }
  try {
    // biome-ignore lint/suspicious/noExplicitAny: optional module
    const mod = (await import("@whatsmeow-node/whatsmeow-node" as string)) as any;
    _createClient = mod.createClient;
    return _createClient!;
  } catch (err) {
    throw new Error(
      "whatsmeow-node is not installed. Install the optional Go addon with " +
      "`pnpm add @whatsmeow-node/whatsmeow-node` (requires Go toolchain). " +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`, { cause: err },
    );
  }
}

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

  const createClient = await loadCreateClient();
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
