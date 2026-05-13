/**
 * FORK: PKCE OAuth re-authentication for Anthropic profiles.
 *
 * Manages PKCE sessions, token exchange, and credential writes.
 * Used by auth.reauth.start (RPC), /auth/oauth/callback (HTTP),
 * and auth.reauth.exchange (RPC paste fallback).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  resolveCredentialFilePath,
  writeCredentialFile,
} from "../../src/agents/auth-profiles/credential-file.js";
import {
  ensureAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "../../src/agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../../src/agents/auth-profiles/types.js";
import { clearAuthProfileCooldown } from "../../src/agents/auth-profiles/usage.js";
import { loadConfig } from "../../src/config/config.js";
import { getBroadcast } from "./watcher.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const SCOPES = "org:create_api_key user:profile user:inference";
const FALLBACK_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const GATEWAY_PORT = 18789;

const MAX_SESSIONS = 5;
const SESSION_TTL_MS = 5 * 60 * 1000;

export type PKCESession = {
  profileId: string;
  verifier: string;
  sessionId: string;
  primaryRedirectUri: string;
  fallbackRedirectUri: string;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, PKCESession>();

function evictOldest(): void {
  if (sessions.size < MAX_SESSIONS) {
    return;
  }
  let oldest: string | null = null;
  let oldestTime = Infinity;
  for (const [id, s] of sessions) {
    if (s.createdAt < oldestTime) {
      oldest = id;
      oldestTime = s.createdAt;
    }
  }
  if (oldest) {
    const s = sessions.get(oldest);
    if (s) {
      clearTimeout(s.timer);
    }
    sessions.delete(oldest!);
  }
}

function removeSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) {
    clearTimeout(s.timer);
    sessions.delete(sessionId);
  }
}

export function getSession(sessionId: string): PKCESession | undefined {
  return sessions.get(sessionId);
}

export function deleteSession(sessionId: string): void {
  removeSession(sessionId);
}

export function clearAllSessions(): void {
  for (const [, s] of sessions) {
    clearTimeout(s.timer);
  }
  sessions.clear();
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function startReauth(profileId: string): {
  sessionId: string;
  authUrl: string;
  fallbackAuthUrl: string;
} {
  const store = ensureAuthProfileStore();
  const cred = store.profiles[profileId];
  if (!cred || cred.provider !== "anthropic" || cred.type !== "oauth") {
    throw new Error(`Profile "${profileId}" is not an Anthropic OAuth profile`);
  }

  const { verifier, challenge } = generatePKCE();
  const sessionId = randomBytes(16).toString("hex");
  const primaryRedirectUri = `http://localhost:${GATEWAY_PORT}/auth/oauth/callback`;

  evictOldest();

  const timer = setTimeout(() => sessions.delete(sessionId), SESSION_TTL_MS);
  const session: PKCESession = {
    profileId,
    verifier,
    sessionId,
    primaryRedirectUri,
    fallbackRedirectUri: FALLBACK_REDIRECT_URI,
    createdAt: Date.now(),
    timer,
  };
  sessions.set(sessionId, session);

  const baseParams = {
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: sessionId,
  };

  const primaryParams = new URLSearchParams({
    ...baseParams,
    redirect_uri: primaryRedirectUri,
  });
  const fallbackParams = new URLSearchParams({
    ...baseParams,
    redirect_uri: FALLBACK_REDIRECT_URI,
  });

  return {
    sessionId,
    authUrl: `${AUTHORIZE_URL}?${primaryParams}`,
    fallbackAuthUrl: `${AUTHORIZE_URL}?${fallbackParams}`,
  };
}

export async function exchangeCodeForTokens(params: {
  code: string;
  state?: string;
  redirectUri: string;
  verifier: string;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: params.code,
    ...(params.state ? { state: params.state } : {}),
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "openclaw-gateway/1.0",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = data.expires_in;

  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    typeof expiresIn !== "number"
  ) {
    throw new Error(`Unexpected token response format: ${Object.keys(data).join(", ")}`);
  }

  return { accessToken, refreshToken, expiresIn };
}

export async function completeTokenExchange(
  session: PKCESession,
  tokenData: { accessToken: string; refreshToken: string; expiresIn: number },
): Promise<{ profileId: string; expiresAt: number }> {
  const { profileId } = session;
  const expiresAt = Date.now() + tokenData.expiresIn * 1000 - 5 * 60 * 1000;

  const updatedStore = await updateAuthProfileStoreWithLock({
    updater: (store: AuthProfileStore) => {
      store.profiles[profileId] = {
        type: "oauth",
        provider: "anthropic",
        access: tokenData.accessToken,
        refresh: tokenData.refreshToken,
        expires: expiresAt,
      };
      return true;
    },
  });

  const cfg = loadConfig();
  const credFilePath = resolveCredentialFilePath(profileId, cfg);
  if (credFilePath) {
    writeCredentialFile(credFilePath, "anthropic", {
      access: tokenData.accessToken,
      refresh: tokenData.refreshToken,
      expires: expiresAt,
    });
  }

  if (updatedStore) {
    await clearAuthProfileCooldown({ store: updatedStore, profileId });
  }

  const broadcast = getBroadcast();
  broadcast?.("auth.profiles.updated", { source: "oauth-reauth", profileId });

  console.log(
    `[auth-reload] re-auth complete for ${profileId}, expires ${new Date(expiresAt).toISOString()}`,
  );
  return { profileId, expiresAt };
}
