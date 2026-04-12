/**
 * FORK: tinkerclaw-whatsapp whatsmeow inbound message monitor.
 *
 * Creates a whatsmeow client, wraps it in the Baileys adapter, and
 * listens for messages. Access control is applied before dispatching
 * to the agent system.
 */

import { existsSync, statSync } from "node:fs";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveUserPath } from "openclaw/plugin-sdk/text-runtime";
import { createBaileysAdapter } from "../adapter.js";
import { setGroupMetadataFetcher, updateGroupName } from "../group-name-cache.js";
import { createWmClient, connectWmClient } from "../session.js";

const logger = getChildLogger({ module: "tinkerclaw-wa-monitor" });

const DEFAULT_STORE_PATH = "~/.openclaw/credentials/whatsapp/default/whatsmeow.db";

function hasStoredSession(storePath: string): boolean {
  const resolved = resolveUserPath(storePath);
  if (!existsSync(resolved)) {
    return false;
  }
  return statSync(resolved).size > 8192;
}

/**
 * Create a whatsmeow client + Baileys adapter ready for monitoring.
 */
export async function createMonitorSocket(options: {
  verbose?: boolean;
  authDir?: string;
  storePath?: string;
  onQr?: (code: string) => void;
}) {
  const storePath =
    options.storePath ??
    (options.authDir ? `${options.authDir}/whatsmeow.db` : undefined) ??
    DEFAULT_STORE_PATH;

  if (!hasStoredSession(storePath)) {
    throw new Error("WhatsApp (whatsmeow) not linked. Use the Relink button to scan a QR code.");
  }

  const client = await createWmClient({
    storePath,
    onQr: options.onQr,
    verbose: options.verbose,
  });

  const adapter = createBaileysAdapter({ wmClient: client });

  await connectWmClient(client);

  setGroupMetadataFetcher(async (jid) => {
    const info = await client.getGroupInfo(jid);
    return { subject: info.name };
  });

  client.on("group_update", ({ jid, subject }) => {
    if (subject) {
      updateGroupName(jid, subject);
    }
  });

  logger.info("whatsmeow monitor socket created and connected");

  return { adapter, client };
}
