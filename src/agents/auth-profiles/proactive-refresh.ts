/**
 * FORK: Proactive OAuth token refresh for all configured OAuth profiles.
 *
 * Mirrors Claude Code's behavior: tokens are refreshed BEFORE they expire,
 * so the gateway never hits a request-time refresh failure. Runs on startup
 * and every REFRESH_CHECK_INTERVAL_MS thereafter.
 *
 * Wired into the gateway via server.impl.ts.
 */

import {
  getOAuthApiKey,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai/oauth";
import { loadConfig } from "../../config/config.js";
import { withFileLock } from "../../infra/file-lock.js";
import { AUTH_STORE_LOCK_OPTIONS, EXTERNAL_CLI_NEAR_EXPIRY_MS, log } from "./constants.js";

// FORK: Track consecutive refresh failures per profile. After MAX_CONSECUTIVE
// failures, the profile enters a cooldown where no further refresh attempts
// are made until either (a) the cooldown expires, or (b) the store is manually
// updated (e.g. via anthropic-oauth-login.mjs). This prevents the gateway from
// spamming Anthropic's token endpoint during an outage and triggering a 15+ min
// rate limit that blocks even manual re-auth attempts.
const MAX_CONSECUTIVE_REFRESH_FAILURES = 3;
const REFRESH_FAILURE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const refreshFailureState = new Map<string, { count: number; lastFailedAtMs: number }>();

function isRefreshInCooldown(profileId: string): boolean {
  const state = refreshFailureState.get(profileId);
  if (!state) {
    return false;
  }
  if (state.count < MAX_CONSECUTIVE_REFRESH_FAILURES) {
    return false;
  }
  return Date.now() - state.lastFailedAtMs < REFRESH_FAILURE_COOLDOWN_MS;
}

function recordRefreshFailure(profileId: string): void {
  const state = refreshFailureState.get(profileId) ?? { count: 0, lastFailedAtMs: 0 };
  state.count += 1;
  state.lastFailedAtMs = Date.now();
  refreshFailureState.set(profileId, state);
  if (state.count >= MAX_CONSECUTIVE_REFRESH_FAILURES) {
    log.warn("proactive refresh: entering cooldown — too many consecutive failures", {
      profileId,
      failures: state.count,
      cooldownMinutes: REFRESH_FAILURE_COOLDOWN_MS / 60_000,
    });
  }
}

function resetRefreshFailures(profileId: string): void {
  refreshFailureState.delete(profileId);
}
import {
  readCredentialFile,
  refreshAnthropicOAuthToken,
  resolveCredentialFilePath,
  writeCredentialFile,
} from "./credential-file.js";
import { ensureAuthStoreFile, resolveAuthStorePath } from "./paths.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store.js";

/** How often to check token expiry (15 minutes). */
const REFRESH_CHECK_INTERVAL_MS = 15 * 60 * 1000;

const OAUTH_PROVIDER_IDS = new Set<string>(getOAuthProviders().map((p) => p.id));

const resolveOAuthProvider = (provider: string): OAuthProvider | null =>
  OAUTH_PROVIDER_IDS.has(provider) ? (provider as OAuthProvider) : null;

/**
 * Refresh a single OAuth profile if it is expired or near-expiry.
 * Returns true if the token is valid (refreshed or still fresh), false on failure.
 */
async function refreshProfileProactively(profileId: string): Promise<boolean> {
  const authPath = resolveAuthStorePath(undefined);
  ensureAuthStoreFile(authPath);

  return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
    const store = ensureAuthProfileStore(undefined);
    const cred = store.profiles[profileId];
    if (!cred || cred.type !== "oauth") {
      return false;
    }

    // FORK: Skip if this profile has failed too many consecutive refreshes.
    // Prevents rate-limit poisoning — the gateway was spamming the token
    // endpoint during a 2026-04-16 outage, triggering a 15+ min Anthropic
    // rate limit that blocked even manual re-auth.
    if (isRefreshInCooldown(profileId)) {
      log.info("proactive refresh: skipping — in cooldown after repeated failures", {
        profileId,
        cooldownRemainingMin: Math.round(
          (REFRESH_FAILURE_COOLDOWN_MS -
            (Date.now() - (refreshFailureState.get(profileId)?.lastFailedAtMs ?? 0))) /
            60_000,
        ),
      });
      return false;
    }

    const now = Date.now();
    const cfg = loadConfig();
    const credFilePath = resolveCredentialFilePath(profileId, cfg);

    // FORK: Always consult the credential file first when it exists, BEFORE
    // checking the store's own expiry. Claude Code (Zen) is the single-writer
    // for credential files and rotates tokens independently of the gateway's
    // 15-minute tick. If we trust only the store's `expires` field, we can
    // keep a locally-valid-looking-but-server-revoked access token for up to
    // 15 minutes — which manifests as hanging API calls (Anthropic stalls on
    // the stale token instead of 401'ing) until the next proactive tick.
    // Syncing from the credential file whenever it has a *different* token
    // or a *fresher* expiry keeps the store in lock-step with Claude Code.
    if (credFilePath) {
      const fresh = readCredentialFile(credFilePath, cred.provider);
      if (
        fresh &&
        now < fresh.expires &&
        fresh.expires - now > EXTERNAL_CLI_NEAR_EXPIRY_MS &&
        (fresh.access !== cred.access || fresh.expires > cred.expires)
      ) {
        store.profiles[profileId] = {
          ...cred,
          access: fresh.access,
          refresh: fresh.refresh,
          expires: fresh.expires,
          type: "oauth",
        };
        saveAuthProfileStore(store, undefined);
        resetRefreshFailures(profileId);
        log.info("proactive refresh: synced from credential file (drift sync)", {
          profileId,
          expiresInMin: Math.round((fresh.expires - now) / 60_000),
          reason: fresh.access !== cred.access ? "access_token_rotated" : "expires_bumped",
        });
        return true;
      }
    }

    const timeUntilExpiry = cred.expires - now;

    // Still valid and not near expiry — nothing to do.
    if (timeUntilExpiry > EXTERNAL_CLI_NEAR_EXPIRY_MS) {
      return true;
    }

    const isExpired = timeUntilExpiry <= 0;
    log.info(`proactive refresh: ${profileId} token ${isExpired ? "expired" : "near expiry"}`, {
      profileId,
      expiresInMin: Math.round(timeUntilExpiry / 60_000),
    });

    // Check credential file for a fresher token
    if (credFilePath) {
      const fresh = readCredentialFile(credFilePath, cred.provider);
      if (fresh && now < fresh.expires && fresh.expires - now > EXTERNAL_CLI_NEAR_EXPIRY_MS) {
        // Credential file has a valid token — sync it into the store
        store.profiles[profileId] = {
          ...cred,
          access: fresh.access,
          refresh: fresh.refresh,
          expires: fresh.expires,
          type: "oauth",
        };
        saveAuthProfileStore(store, undefined);
        log.info("proactive refresh: synced from credential file", {
          profileId,
          expiresInMin: Math.round((fresh.expires - now) / 60_000),
        });
        return true;
      }

      // Log when credential file exists but has expired/near-expiry tokens
      if (fresh && (fresh.expires <= now || fresh.expires - now <= EXTERNAL_CLI_NEAR_EXPIRY_MS)) {
        log.info("proactive refresh: credential file token also expired, attempting refresh", {
          profileId,
          credentialFile: credFilePath,
          credFileExpiredMinAgo: Math.round((now - fresh.expires) / 60_000),
        });
      } else if (!fresh) {
        log.info("proactive refresh: credential file unreadable or empty", {
          profileId,
          credentialFile: credFilePath,
        });
      }

      // Try refreshing using the credential file's (or store's) refresh token
      const refreshSource = fresh ?? cred;
      if (refreshSource.refresh) {
        try {
          // FORK: Use our own refresh for Anthropic (pi-ai's lacks User-Agent → Cloudflare blocks it).
          const refreshed =
            cred.provider === "anthropic"
              ? await (async () => {
                  const result = await refreshAnthropicOAuthToken(refreshSource.refresh);
                  if (!result) {
                    return null;
                  }
                  return {
                    apiKey: result.access,
                    newCredentials: {
                      ...cred,
                      access: result.access,
                      refresh: result.refresh,
                      expires: result.expires,
                      type: "oauth" as const,
                    },
                  };
                })()
              : await (async () => {
                  const oauthProvider = resolveOAuthProvider(cred.provider);
                  if (!oauthProvider) {
                    return null;
                  }
                  const refreshCred: OAuthCredentials = {
                    ...cred,
                    access: refreshSource.access,
                    refresh: refreshSource.refresh,
                    expires: refreshSource.expires,
                    type: "oauth",
                  };
                  return await getOAuthApiKey(oauthProvider, { [cred.provider]: refreshCred });
                })();
          if (refreshed) {
            store.profiles[profileId] = {
              ...cred,
              ...refreshed.newCredentials,
              type: "oauth",
            };
            saveAuthProfileStore(store, undefined);
            writeCredentialFile(credFilePath, cred.provider, refreshed.newCredentials);
            resetRefreshFailures(profileId);
            log.info("proactive refresh: token refreshed", {
              profileId,
              expiresInMin: Math.round((refreshed.newCredentials.expires - now) / 60_000),
            });
            return true;
          }
          // Refresh returned null — stale refresh token or API error
          recordRefreshFailure(profileId);
          log.warn("proactive refresh: refresh returned null (likely stale refresh token)", {
            profileId,
            credentialFile: credFilePath,
            credFileExpired: fresh ? fresh.expires < now : "no file",
            consecutiveFailures: refreshFailureState.get(profileId)?.count ?? 0,
            action: "re-run anthropic-oauth-login.mjs --profile <id> to obtain fresh tokens",
          });
        } catch (err) {
          recordRefreshFailure(profileId);
          log.warn("proactive refresh: refresh failed", {
            profileId,
            credentialFile: credFilePath,
            consecutiveFailures: refreshFailureState.get(profileId)?.count ?? 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        log.warn("proactive refresh: no refresh token or provider available", {
          profileId,
          hasFresh: !!fresh,
        });
      }

      return false;
    }

    // No credential file — try refreshing from store token directly
    const oauthProvider = resolveOAuthProvider(cred.provider);
    if (oauthProvider && cred.refresh) {
      try {
        const creds: Record<string, OAuthCredentials> = { [cred.provider]: cred };
        const refreshed = await getOAuthApiKey(oauthProvider, creds);
        if (refreshed) {
          store.profiles[profileId] = {
            ...cred,
            ...refreshed.newCredentials,
            type: "oauth",
          };
          saveAuthProfileStore(store, undefined);
          log.info("proactive refresh: token refreshed (no credential file)", {
            profileId,
            expiresInMin: Math.round((refreshed.newCredentials.expires - now) / 60_000),
          });
          return true;
        }
      } catch (err) {
        log.warn("proactive refresh: refresh failed (no credential file)", {
          profileId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return false;
  });
}

/**
 * Run proactive refresh for all OAuth profiles that have credential files.
 * Safe to call from any context — errors are logged, never thrown.
 */
async function refreshAllOAuthProfiles(): Promise<void> {
  const store = ensureAuthProfileStore(undefined);
  const cfg = loadConfig();

  for (const [profileId, cred] of Object.entries(store.profiles)) {
    if (cred.type !== "oauth") {
      continue;
    }

    // Only proactively refresh OAuth profiles that resolve to a credential file.
    // Non-OAuth profiles (api_key, token) are skipped by the type check above.
    // OAuth profiles without a credential file path (no config, no convention)
    // are also skipped — they use external refresh mechanisms.
    const credFilePath = resolveCredentialFilePath(profileId, cfg);
    if (!credFilePath) {
      continue;
    }

    try {
      await refreshProfileProactively(profileId);
    } catch (err) {
      log.warn("proactive refresh: unexpected error", {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export type ProactiveRefreshHandle = {
  stop: () => void;
};

/**
 * Start proactive OAuth token refresh.
 * Runs immediately on call, then every REFRESH_CHECK_INTERVAL_MS.
 */
export function startProactiveOAuthRefresh(): ProactiveRefreshHandle {
  log.info("proactive OAuth refresh started", {
    intervalMin: REFRESH_CHECK_INTERVAL_MS / 60_000,
    nearExpiryMin: EXTERNAL_CLI_NEAR_EXPIRY_MS / 60_000,
  });

  // Run immediately on startup.
  void refreshAllOAuthProfiles();

  const interval = setInterval(() => {
    void refreshAllOAuthProfiles();
  }, REFRESH_CHECK_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(interval);
      log.info("proactive OAuth refresh stopped");
    },
  };
}
