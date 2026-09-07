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
let _createClient: ((opts: { store: string; binaryPath?: string }) => WhatsmeowClient) | null =
  null;
async function loadCreateClient(): Promise<
  (opts: { store: string; binaryPath?: string }) => WhatsmeowClient
> {
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
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

const DEFAULT_STORE_PATH = "~/.openclaw/credentials/whatsapp/default/whatsmeow.db";

/**
 * FORK 2026-08-29: escape hatch for the whatsmeow Go binary.
 *
 * WhatsApp enforces a minimum client version and raised it on ~2026-07-29.
 * Every published @whatsmeow-node release (0.5.3 through 0.7.0) embeds the same
 * Go library, `whatsmeowVersion 0.0.0-20260305`, so the channel died and NO npm
 * upgrade could revive it: WhatsApp answered `getQRChannel` with
 * `qr:error / err-client-outdated` and refused to issue a pairing code at all.
 *
 * The cure is a binary rebuilt against current go.mau.fi/whatsmeow. It cannot
 * live in node_modules, because a deploy builds in a clean worktree and
 * `pnpm install` restores the stale one. Point this at a rebuilt binary
 * instead; unset, behaviour is exactly as before.
 *
 * This WILL recur the next time WhatsApp raises the floor. Rebuild with
 * scripts/build-whatsmeow-node.sh and the symptom is the same:
 * `err-client-outdated` on a FRESH store.
 */
const BINARY_PATH_ENV = "OPENCLAW_WHATSMEOW_BINARY";

function resolveWhatsmeowBinaryPath(): string | undefined {
  const raw = process.env[BINARY_PATH_ENV]?.trim();
  if (!raw) {
    return undefined;
  }
  return resolveUserPath(raw);
}

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
  const binaryPath = resolveWhatsmeowBinaryPath();
  if (binaryPath) {
    logger.info({ binaryPath }, "whatsmeow: using binary override");
  }
  const client = createClient(binaryPath ? { store: storePath, binaryPath } : { store: storePath });

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
  // FORK 2026-05-03 (re-enabled): full payload event tap for self-DM diagnosis.
  // Earlier conclusion (whatsmeow doesn't fire `message` for peer_msg) is
  // worth re-verifying since group fromMe text DOES make it through. Logs
  // the FULL event payload to journal so we can grep for actual body text.
  const allEvents = [
    "message",
    "message:receipt",
    "history_sync",
    "chat_presence",
    "presence",
    "stream_error",
  ];
  for (const ev of allEvents) {
    client.on(ev, (payload: unknown) => {
      try {
        const summary = JSON.stringify(payload).slice(0, 1500);
        console.log(`[wm-event-full] ${ev}: ${summary}`);
      } catch {
        console.log(`[wm-event-full] ${ev}: <unserializable>`);
      }
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

  // Init (loads store, but does not connect). InitResult carries the stored
  // self JID for already-paired sessions — this is DETERMINISTIC, unlike the
  // "connected" event listener which raced on some boots and left
  // sock.user.id=null. Stash on the client so the adapter can seed selfJid
  // from a known-non-null source.
  const initResult = await client.init();
  if (initResult?.jid) {
    (client as unknown as { __initJid?: string }).__initJid = initResult.jid;
    console.log(`[wm-session] init() returned jid=${initResult.jid}`);
  } else {
    console.log("[wm-session] init() returned no jid (unpaired or fresh store)");
  }

  activeClient = client;
  return client;
}

/** Get the currently active whatsmeow client (if any). */
export function getWmClient(): WhatsmeowClient | null {
  return activeClient;
}

/** Connect + wait for connection (with timeout). */
export async function connectWmClient(client: WhatsmeowClient, timeoutMs = 60_000): Promise<void> {
  // FORK 2026-08-29: capture the REASON the link failed.
  //
  // This used to report only `connection timed out after ${timeoutMs}ms`, which
  // was doubly misleading: whatsmeow answers in seconds (waitForConnection
  // resolves false as soon as the socket gives up — observed 2-5s, never 60s),
  // and the specific cause was being thrown away. For a month the channel
  // reported a timeout while whatsmeow was in fact emitting
  // `qr:error / err-client-outdated` — WhatsApp rejecting an outdated client
  // build. Nobody could act on it because the message never named it.
  //
  // Record the last diagnostic event and put it in the thrown error.
  let reason: string | null = null;
  const note = (label: string) => (payload: unknown) => {
    if (reason) {
      return;
    }
    let detail = "";
    try {
      // Never log a QR payload: it is a pairing secret.
      detail = label === "qr" ? "" : (JSON.stringify(payload) ?? "").slice(0, 300);
    } catch {
      detail = "<unserializable>";
    }
    reason = detail ? `${label}: ${detail}` : label;
  };
  for (const ev of ["qr:error", "stream_error", "logged_out", "error", "disconnected"]) {
    try {
      client.on(ev, note(ev));
    } catch {
      // best-effort: an older addon may not emit every event
    }
  }

  const startedAt = Date.now();
  await client.connect();
  const connected = await client.waitForConnection(timeoutMs);
  if (!connected) {
    const waitedMs = Date.now() - startedAt;
    const because = reason ? ` (${reason})` : " (no diagnostic event received)";
    const hint = reason?.includes("err-client-outdated")
      ? " — WhatsApp rejected this client as OUTDATED; the whatsmeow Go binary must be" +
        ` rebuilt against a current go.mau.fi/whatsmeow and pointed at via ${BINARY_PATH_ENV}`
      : "";
    throw new Error(
      `whatsmeow: connection failed after ${waitedMs}ms (budget ${timeoutMs}ms)${because}${hint}`,
    );
  }
}

/** Gracefully disconnect AND terminate the Go subprocess.
 *
 * FORK 2026-05-01: whatsmeow-node's `client.disconnect()` only sends a
 * "disconnect" IPC message — the Go subprocess keeps running. On every
 * reconnect cycle that left the prior subprocess alive, so over a day
 * we accumulated 6 leaked `whatsmeow-node` processes all holding the
 * same SQLite store open. We now also call `client.close()` (which does
 * `this.proc.kill()`) so the subprocess actually exits. */
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
  try {
    // biome-ignore lint/suspicious/noExplicitAny: optional addon, see top-of-file structural type
    (c as any).close?.();
  } catch {
    // best-effort
  }
  if (c === activeClient) {
    activeClient = null;
  }
}
