/**
 * QR login flow using whatsmeow-node.
 * Drop-in alternative to login-qr.ts (Baileys).
 */

import { randomUUID } from "node:crypto";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { danger, info, success } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount } from "./accounts.js";
import { renderQrPngBase64 } from "./qr-image.js";
import {
  createWmClient,
  connectWmClient,
  disconnectWmClient,
  type WhatsmeowClient,
} from "./session-wm.js";

interface ActiveWmLogin {
  accountId: string;
  id: string;
  client: WhatsmeowClient;
  startedAt: number;
  qr?: string;
  qrDataUrl?: string;
  connected: boolean;
  error?: string;
  connectionPromise: Promise<void>;
}

const ACTIVE_LOGIN_TTL_MS = 3 * 60_000;
const activeLogins = new Map<string, ActiveWmLogin>();

function isLoginFresh(login: ActiveWmLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

async function resetActiveLogin(accountId: string): Promise<void> {
  const login = activeLogins.get(accountId);
  if (login) {
    await disconnectWmClient(login.client);
    activeLogins.delete(accountId);
  }
}

/**
 * Start a QR-based WhatsApp login using whatsmeow-node.
 * Returns a data-URL PNG of the QR code for the caller to display.
 */
export async function startWebLoginWithQr(
  opts: {
    verbose?: boolean;
    timeoutMs?: number;
    force?: boolean;
    accountId?: string;
    runtime?: RuntimeEnv;
  } = {},
): Promise<{ qrDataUrl?: string; message: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });

  // Re-use a fresh login if one exists
  const existing = activeLogins.get(account.accountId);
  if (existing && isLoginFresh(existing) && !existing.error) {
    if (existing.qr && !existing.qrDataUrl) {
      const b64 = await renderQrPngBase64(existing.qr);
      existing.qrDataUrl = `data:image/png;base64,${b64}`;
    }
    if (existing.qrDataUrl) {
      return { qrDataUrl: existing.qrDataUrl, message: "QR already active. Scan it in WhatsApp → Linked Devices." };
    }
  }

  await resetActiveLogin(account.accountId);

  // Promise that resolves when first QR arrives
  let resolveQr: ((code: string) => void) | null = null;
  let rejectQr: ((err: Error) => void) | null = null;
  const qrPromise = new Promise<string>((res, rej) => { resolveQr = res; rejectQr = rej; });

  const qrTimer = setTimeout(() => {
    rejectQr?.(new Error("Timed out waiting for WhatsApp QR"));
  }, Math.max(opts.timeoutMs ?? 30_000, 5000));

  let client: WhatsmeowClient;
  try {
    client = await createWmClient({
      verbose: opts.verbose,
      onQr: (code) => {
        const current = activeLogins.get(account.accountId);
        if (current) {
          current.qr = code;
          current.qrDataUrl = undefined;
        }
        if (resolveQr) {
          clearTimeout(qrTimer);
          runtime.log(info("WhatsApp QR received (whatsmeow)."));
          resolveQr(code);
          resolveQr = null;
        } else {
          runtime.log(info("WhatsApp QR refreshed (whatsmeow)."));
          void renderQrPngBase64(code).then((b64) => {
            const c = activeLogins.get(account.accountId);
            if (c && c.qr === code) c.qrDataUrl = `data:image/png;base64,${b64}`;
          });
        }
      },
    });
  } catch (err) {
    clearTimeout(qrTimer);
    return { message: `Failed to start WhatsApp login (whatsmeow): ${String(err)}` };
  }

  // Request QR channel then connect (triggers QR emission)
  await client.getQRChannel();

  const login: ActiveWmLogin = {
    accountId: account.accountId,
    id: randomUUID(),
    client,
    startedAt: Date.now(),
    connected: false,
    connectionPromise: Promise.resolve(),
  };
  activeLogins.set(account.accountId, login);

  // Start connection (async — emits QR events, then waits for pairing + 515 restart)
  // Use a generous timeout: QR scan + pairing + 515 restart can take up to 3 minutes
  login.connectionPromise = client.connect()
    .then(() => client.waitForConnection(180_000))
    .then((connected) => {
      const cur = activeLogins.get(account.accountId);
      if (cur?.id === login.id) {
        cur.connected = connected;
        if (!connected) cur.error = "Connection timed out after pairing";
      }
    })
    .catch((err) => {
      const cur = activeLogins.get(account.accountId);
      if (cur?.id === login.id) cur.error = String(err);
    });

  let qrCode: string;
  try {
    qrCode = await qrPromise;
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return { message: `Failed to get QR (whatsmeow): ${String(err)}` };
  }

  const base64 = await renderQrPngBase64(qrCode);
  login.qrDataUrl = `data:image/png;base64,${base64}`;
  return { qrDataUrl: login.qrDataUrl, message: "Scan this QR in WhatsApp → Linked Devices." };
}

/**
 * Wait for an active whatsmeow login to complete.
 */
export async function waitForWebLoginWm(
  opts: { timeoutMs?: number; runtime?: RuntimeEnv; accountId?: string } = {},
): Promise<{ connected: boolean; message: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const login = activeLogins.get(account.accountId);

  if (!login) return { connected: false, message: "No active WhatsApp login in progress." };
  if (!isLoginFresh(login)) {
    await resetActiveLogin(account.accountId);
    return { connected: false, message: "The login QR expired. Ask me to generate a new one." };
  }

  const timeoutMs = Math.max(opts.timeoutMs ?? 120_000, 1000);
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
  await Promise.race([login.connectionPromise, timeout]);

  if (login.error) {
    const msg = `WhatsApp login failed (whatsmeow): ${login.error}`;
    runtime.log(danger(msg));
    await resetActiveLogin(account.accountId);
    return { connected: false, message: msg };
  }

  if (login.connected) {
    runtime.log(success("✅ Linked! WhatsApp is ready (whatsmeow)."));
    // Don't reset — keep client alive for messaging
    return { connected: true, message: "✅ Linked! WhatsApp is ready." };
  }

  return { connected: false, message: "Still waiting for the QR scan. Let me know when you've scanned it." };
}
