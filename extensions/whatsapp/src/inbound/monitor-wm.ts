/**
 * WhatsApp inbound monitor — whatsmeow-node variant.
 *
 * Thin wrapper that creates a whatsmeow-node session, wraps it in
 * the Baileys adapter, and delegates to the existing monitorWebInbox
 * so we reuse all the message processing logic without duplication.
 */

import { createWmClient, connectWmClient, disconnectWmClient } from "../session-wm.js";
import { createBaileysAdapter } from "../baileys-adapter-wm.js";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";

const logger = getChildLogger({ module: "wm-monitor" });

export { createWmClient, connectWmClient, disconnectWmClient, createBaileysAdapter };

/**
 * Create a Baileys-adapter-wrapped whatsmeow client ready for monitorWebInbox.
 *
 * Usage in channel provider:
 *   const { adapter, client } = await createWmMonitorSocket(opts);
 *   // Pass `adapter` wherever a Baileys sock is expected
 */
export async function createWmMonitorSocket(options: {
  verbose?: boolean;
  authDir?: string;
  storePath?: string;
  onQr?: (code: string) => void;
}) {
  const storePath =
    options.storePath ??
    (options.authDir ? `${options.authDir}/whatsmeow.db` : undefined);

  const client = await createWmClient({
    storePath,
    onQr: options.onQr,
    verbose: options.verbose,
  });

  await connectWmClient(client);

  const adapter = createBaileysAdapter({
    wmClient: client,
  });

  logger.info("whatsmeow monitor socket created and connected");

  return { adapter, client };
}
