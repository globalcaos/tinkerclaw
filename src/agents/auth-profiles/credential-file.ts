/**
 * FORK: Generic credential file I/O for OAuth profiles.
 *
 * Resolves credential file paths from config (explicit) or convention
 * (derived from profile ID). Reads/writes credential files in
 * provider-appropriate formats. Supports TTL-based in-memory caching.
 *
 * Replaces the hardcoded SV/GM credential functions in cli-credentials.ts.
 */

import fs from "node:fs";
import path from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import type { OpenClawConfig } from "../../config/config.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { resolveUserPath } from "../../utils.js";
import { log } from "./constants.js";
import { ensureAuthProfileStore } from "./store.js";

/** Convention directory for auto-derived credential files. */
const CREDENTIALS_DIR = "~/.openclaw/credentials";

/** In-memory cache keyed by resolved file path. */
type CachedEntry = {
  value: CredentialFileContent | null;
  readAt: number;
  cacheKey: string;
};
const fileCache = new Map<string, CachedEntry>();

/** Credential content as read from a file (provider-normalized). */
export type CredentialFileContent = {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  expires: number;
};

/**
 * Resolve the credential file path for a profile.
 * Priority: config override → convention path.
 * Returns null for non-OAuth profiles.
 */
export function resolveCredentialFilePath(profileId: string, cfg?: OpenClawConfig): string | null {
  // 1. Config override
  const profileConfig = cfg?.auth?.profiles?.[profileId];
  if ((profileConfig as Record<string, unknown> | undefined)?.credentialFile) {
    return resolveUserPath((profileConfig as Record<string, unknown>).credentialFile as string);
  }

  // 2. Only OAuth profiles get credential files
  const store = ensureAuthProfileStore(undefined);
  const cred = store.profiles[profileId];
  const isOAuth = cred?.type === "oauth" || profileConfig?.mode === "oauth";
  if (!isOAuth) {
    return null;
  }

  // 3. Convention: ~/.openclaw/credentials/<sanitized-id>.json
  const sanitized = profileId.replace(/[:/\\]/g, "-");
  return resolveUserPath(path.join(CREDENTIALS_DIR, `${sanitized}.json`));
}

/**
 * Read OAuth credentials from a credential file.
 * Supports Anthropic nested format (claudeAiOauth) and flat format.
 */
export function readCredentialFile(
  filePath: string,
  provider: string,
  opts?: { ttlMs?: number },
): CredentialFileContent | null {
  const ttlMs = opts?.ttlMs ?? 0;
  const now = Date.now();

  // Check cache
  if (ttlMs > 0) {
    const cached = fileCache.get(filePath);
    if (cached && cached.cacheKey === filePath && now - cached.readAt < ttlMs) {
      return cached.value;
    }
  }

  const raw = loadJsonFile(filePath);
  if (!raw || typeof raw !== "object") {
    if (ttlMs > 0) {
      fileCache.set(filePath, { value: null, readAt: now, cacheKey: filePath });
    }
    return null;
  }

  const data = raw as Record<string, unknown>;
  let result: CredentialFileContent | null = null;

  // Anthropic nested format: { claudeAiOauth: { accessToken, refreshToken, expiresAt } }
  if (provider === "anthropic") {
    const oauth = data.claudeAiOauth as Record<string, unknown> | undefined;
    if (oauth && typeof oauth === "object") {
      const accessToken = oauth.accessToken;
      const refreshToken = oauth.refreshToken;
      const expiresAt = oauth.expiresAt;
      if (
        typeof accessToken === "string" &&
        accessToken &&
        typeof refreshToken === "string" &&
        refreshToken &&
        typeof expiresAt === "number" &&
        Number.isFinite(expiresAt) &&
        expiresAt > 0
      ) {
        result = {
          type: "oauth",
          provider,
          access: accessToken,
          refresh: refreshToken,
          expires: expiresAt,
        };
      }
    }
  } else {
    // Flat format: { access_token, refresh_token, expiry_date }
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;
    const expiresAt = data.expiry_date;
    if (
      typeof accessToken === "string" &&
      accessToken &&
      typeof refreshToken === "string" &&
      refreshToken &&
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt)
    ) {
      result = {
        type: "oauth",
        provider,
        access: accessToken,
        refresh: refreshToken,
        expires: expiresAt,
      };
    }
  }

  if (ttlMs > 0) {
    fileCache.set(filePath, { value: result, readAt: now, cacheKey: filePath });
  }
  return result;
}

/**
 * Write OAuth credentials to a credential file.
 * Creates parent directories if needed. Invalidates cache.
 */
export function writeCredentialFile(
  filePath: string,
  provider: string,
  cred: OAuthCredentials,
): boolean {
  try {
    // Ensure parent directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Read existing file to preserve other fields
    const raw = loadJsonFile(filePath);
    const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

    if (provider === "anthropic") {
      const existing = (
        data.claudeAiOauth && typeof data.claudeAiOauth === "object" ? data.claudeAiOauth : {}
      ) as Record<string, unknown>;
      data.claudeAiOauth = {
        ...existing,
        accessToken: cred.access,
        refreshToken: cred.refresh,
        expiresAt: cred.expires,
      };
    } else {
      data.access_token = cred.access;
      data.refresh_token = cred.refresh;
      data.expiry_date = cred.expires;
    }

    saveJsonFile(filePath, data);

    // Invalidate cache
    fileCache.delete(filePath);

    log.info("wrote refreshed credentials to credential file", {
      filePath,
      provider,
      expires: new Date(cred.expires).toISOString(),
    });
    return true;
  } catch (error) {
    log.warn("failed to write credentials to credential file", {
      filePath,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * FORK: Refresh an Anthropic OAuth token directly.
 *
 * pi-ai's `refreshAnthropicToken` uses `fetch` without a User-Agent header,
 * which Cloudflare blocks (error 1010). This function does the same refresh
 * but with proper headers, matching what Claude Code sends.
 */
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export async function refreshAnthropicOAuthToken(refreshToken: string): Promise<{
  access: string;
  refresh: string;
  expires: number;
} | null> {
  try {
    // Don't pass `scope` — omitting it preserves the original grant's scopes.
    // Passing scope: "user:inference" was downscoping the token, losing user:profile
    // which the /api/oauth/usage endpoint requires (→ 403 on budget panel).
    const body = JSON.stringify({
      grant_type: "refresh_token",
      client_id: ANTHROPIC_CLIENT_ID,
      refresh_token: refreshToken,
    });

    const response = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "openclaw-gateway/1.0",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text();
      log.warn("Anthropic OAuth refresh failed", {
        status: response.status,
        body: text.slice(0, 200),
      });
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const accessToken = data.access_token;
    const newRefreshToken = data.refresh_token;
    const expiresIn = data.expires_in;

    if (
      typeof accessToken !== "string" ||
      typeof newRefreshToken !== "string" ||
      typeof expiresIn !== "number"
    ) {
      log.warn("Anthropic OAuth refresh returned unexpected format", {
        keys: Object.keys(data),
      });
      return null;
    }

    return {
      access: accessToken,
      refresh: newRefreshToken,
      expires: Date.now() + expiresIn * 1000,
    };
  } catch (err) {
    log.warn("Anthropic OAuth refresh request failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Reset all credential file caches (for testing). */
export function resetCredentialFileCacheForTest(): void {
  fileCache.clear();
}
