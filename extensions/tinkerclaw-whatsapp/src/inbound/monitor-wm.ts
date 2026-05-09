/**
 * WhatsApp inbound monitor — whatsmeow-node variant.
 *
 * Thin wrapper that creates a whatsmeow-node session, wraps it in
 * the Baileys adapter, and delegates to the existing monitorWebInbox
 * so we reuse all the message processing logic without duplication.
 */

import { existsSync, statSync } from "node:fs";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveUserPath } from "openclaw/plugin-sdk/text-runtime";
import { createBaileysAdapter } from "../baileys-adapter-wm.js";
import { createWmClient, connectWmClient, disconnectWmClient } from "../session-wm.js";

const logger = getChildLogger({ module: "wm-monitor" });

const DEFAULT_STORE_PATH = "~/.openclaw/credentials/whatsapp/default/whatsmeow.db";

export { createWmClient, connectWmClient, disconnectWmClient, createBaileysAdapter };

/**
 * Check if the whatsmeow store has a registered session (not just an empty schema).
 */
function hasStoredSession(storePath: string): boolean {
  const resolved = resolveUserPath(storePath);
  if (!existsSync(resolved)) {
    return false;
  }
  const stat = statSync(resolved);
  // Empty schema is ~4KB. A linked session is much larger.
  return stat.size > 8192;
}

/**
 * Create a Baileys-adapter-wrapped whatsmeow client ready for monitorWebInbox.
 * Throws if no stored session — caller should direct user to scan QR first.
 */
export async function createWmMonitorSocket(options: {
  verbose?: boolean;
  authDir?: string;
  storePath?: string;
  onQr?: (code: string) => void;
}) {
  const storePath =
    options.storePath ??
    (options.authDir ? `${options.authDir}/whatsmeow.db` : undefined) ??
    DEFAULT_STORE_PATH;

  // Don't attempt connection if no stored session — prevents timeout loops
  if (!hasStoredSession(storePath)) {
    throw new Error(
      "WhatsApp (whatsmeow) not linked. Use the Relink button in the channels tab to scan a QR code.",
    );
  }

  const client = await createWmClient({
    storePath,
    onQr: options.onQr,
    verbose: options.verbose,
  });

  // FORK 2026-05-03: build the Baileys adapter BEFORE connectWmClient. The
  // adapter installs a `wmClient.on("connected", ...)` listener that captures
  // the self-JID; if we connect first, the event fires and is gone before
  // the listener attaches, leaving sock.user.id permanently null. Symptom:
  // every inbound DM gets dropped with "selfE164=null" → access-control's
  // owner-DM (Tier 1) check can't match `from` against `selfE164` →
  // `[wa-debug] DROP: access denied from=+<owner-e164> ... fromMe=true`.
  const adapter = createBaileysAdapter({
    wmClient: client,
  });

  await connectWmClient(client);

  logger.info("whatsmeow monitor socket created and connected");

  return { adapter, client };
}
