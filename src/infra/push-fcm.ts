// FORK 2026-10-22 (the architect: "Firebase is up, can you now wake up the phone app when needed?")
// Wakes an Android node through Firebase Cloud Messaging, the way push-apns.ts wakes an iOS one.
// A high-priority data message reaches an app Android has put to sleep; the app answers by
// reconnecting its node socket. The server key is a Google service-account JSON named by
// OPENCLAW_FCM_SERVICE_ACCOUNT_FILE; it lives on the gateway host only, never in the repo.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";

const FCM_STATE_FILENAME = "push/fcm-registrations.json";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const MAX_TOKEN_LENGTH = 4096;
const SEND_TIMEOUT_MS = 10_000;

export type FcmRegistration = { nodeId: string; token: string; updatedAtMs: number };
type FcmState = { registrationsByNodeId: Record<string, FcmRegistration> };
type ServiceAccount = { project_id: string; client_email: string; private_key: string };

const withLock = createAsyncLock();
let cachedAccess: { key: string; token: string; expiresAtMs: number } | null = null;

function statePath(baseDir?: string): string {
  return path.join(baseDir ?? resolveStateDir(), FCM_STATE_FILENAME);
}

async function loadState(baseDir?: string): Promise<FcmState> {
  const raw = await readJsonFile<FcmState>(statePath(baseDir)).catch(() => null);
  return raw && typeof raw.registrationsByNodeId === "object" ? raw : { registrationsByNodeId: {} };
}

export async function registerFcmRegistration(
  params: { nodeId: string; token: string },
  baseDir?: string,
): Promise<FcmRegistration | null> {
  const nodeId = params.nodeId.trim();
  const token = params.token.trim();
  if (!nodeId || !token || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    return null;
  }
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const reg = { nodeId, token, updatedAtMs: Date.now() };
    state.registrationsByNodeId[nodeId] = reg;
    await writeJsonAtomic(statePath(baseDir), state, {
      mode: 0o600,
      ensureDirMode: 0o700,
      trailingNewline: true,
    });
    return reg;
  });
}

export async function loadFcmRegistration(
  nodeId: string,
  baseDir?: string,
): Promise<FcmRegistration | null> {
  const state = await loadState(baseDir);
  return state.registrationsByNodeId[nodeId.trim()] ?? null;
}

export async function resolveFcmServiceAccountFromEnv(
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; account: ServiceAccount } | { ok: false; error: string }> {
  const file = env.OPENCLAW_FCM_SERVICE_ACCOUNT_FILE?.trim();
  if (!file) {
    return { ok: false, error: "OPENCLAW_FCM_SERVICE_ACCOUNT_FILE not set" };
  }
  try {
    const j = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ServiceAccount>;
    if (!j.project_id || !j.client_email || !j.private_key) {
      return { ok: false, error: "service account file lacks project_id/client_email/private_key" };
    }
    return { ok: true, account: j as ServiceAccount };
  } catch (err) {
    return { ok: false, error: `cannot read service account: ${(err as Error).message}` };
  }
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

/** OAuth access token for FCM from the service account (JWT bearer grant), cached until near expiry. */
async function accessToken(account: ServiceAccount, fetchImpl: typeof fetch): Promise<string> {
  const now = Date.now();
  if (
    cachedAccess &&
    cachedAccess.key === account.client_email &&
    cachedAccess.expiresAtMs > now + 60_000
  ) {
    return cachedAccess.token;
  }
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  );
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${claims}`),
    account.private_key,
  );
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${b64url(signature)}`,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(`google token ${res.status}`);
  }
  cachedAccess = {
    key: account.client_email,
    token: body.access_token,
    expiresAtMs: now + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}

export type FcmSendResult = { ok: boolean; status: number; reason?: string };

/** A high-priority data message {type:"wake"}; the app reconnects its node socket on receipt. */
export async function sendFcmWake(params: {
  registration: FcmRegistration;
  account: ServiceAccount;
  wakeReason?: string;
  fetchImpl?: typeof fetch;
}): Promise<FcmSendResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const token = await accessToken(params.account, fetchImpl);
  const res = await fetchImpl(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(params.account.project_id)}/messages:send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: params.registration.token,
          data: { type: "wake", reason: params.wakeReason ?? "node.invoke" },
          android: { priority: "HIGH", ttl: "60s" },
        },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    },
  );
  if (res.ok) {
    return { ok: true, status: res.status };
  }
  const text = await res.text().catch(() => "");
  const reason = /"status"\s*:\s*"([A-Z_]+)"/.exec(text)?.[1] ?? text.slice(0, 120);
  return { ok: false, status: res.status, reason };
}
