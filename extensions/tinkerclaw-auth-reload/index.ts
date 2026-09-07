/**
 * FORK: Auth Reload extension.
 *
 * 1. File watcher on auth-profiles.json — invalidates runtime cache on change.
 * 2. auth.reload RPC — force re-read from disk + clear cooldowns.
 * 3. auth.reauth.start / auth.reauth.exchange RPC — in-UI OAuth PKCE flow.
 * 4. /auth/oauth/callback HTTP — auto-capture OAuth redirect.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { clearAuthProfileCooldown } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  startReauth,
  getSession,
  deleteSession,
  clearAllSessions,
  exchangeCodeForTokens,
  completeTokenExchange,
} from "./reauth.js";
import { startAuthProfileWatcher, stopAuthProfileWatcher, setBroadcast } from "./watcher.js";

export default function register(api: OpenClawPluginApi) {
  startAuthProfileWatcher();

  api.registerGatewayMethod("auth.reload", async ({ params, respond, context }) => {
    setBroadcast(context.broadcast);

    clearRuntimeAuthProfileStoreSnapshots();
    const store = ensureAuthProfileStore();
    const profileId = (params as Record<string, unknown>).profileId as string | undefined;
    const cleared: string[] = [];

    if (profileId) {
      if (store.profiles[profileId]) {
        await clearAuthProfileCooldown({ store, profileId });
        cleared.push(profileId);
      }
    } else {
      for (const [pid, cred] of Object.entries(store.profiles)) {
        if (cred.provider === "anthropic" && cred.type === "oauth") {
          await clearAuthProfileCooldown({ store, profileId: pid });
          cleared.push(pid);
        }
      }
    }

    context.broadcast("auth.profiles.updated", { source: "rpc", profiles: cleared });
    respond(true, { ok: true, profiles: cleared });
  });

  // FORK: Direct token paste — write an access token to a profile without OAuth flow
  api.registerGatewayMethod("auth.applyToken", async ({ params, respond, context }) => {
    setBroadcast(context.broadcast);
    const p = params as Record<string, unknown>;
    const profileId = p.profileId as string | undefined;
    const accessToken = p.accessToken as string | undefined;
    if (!profileId || !accessToken) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "profileId and accessToken are required",
      });
      return;
    }
    if (!accessToken.startsWith("sk-ant-")) {
      respond(false, undefined, {
        code: "INVALID_TOKEN",
        message: "Token must start with sk-ant-",
      });
      return;
    }
    try {
      const store = ensureAuthProfileStore();
      const profile = store.profiles[profileId];
      if (!profile) {
        respond(false, undefined, {
          code: "PROFILE_NOT_FOUND",
          message: `Profile ${profileId} not found`,
        });
        return;
      }
      // FORK: sk-ant-* tokens are API keys; write to `key` field on the credential
      if (profile.type === "api_key") {
        profile.key = accessToken;
      } else if (profile.type === "token") {
        profile.token = accessToken;
        profile.expires = Date.now() + 3600_000; // 1 hour from now
      } else if (profile.type === "oauth") {
        profile.access = accessToken;
        profile.expires = Date.now() + 3600_000; // 1 hour from now
      }
      saveAuthProfileStore(store);
      clearRuntimeAuthProfileStoreSnapshots();
      await clearAuthProfileCooldown({ store: ensureAuthProfileStore(), profileId });
      context.broadcast("auth.profiles.updated", {
        source: "rpc",
        profiles: [profileId],
        profileId,
      });
      respond(true, { ok: true, profileId });
      console.log(`[auth-reload] token applied for ${profileId}`);
    } catch (err: any) {
      respond(false, undefined, { code: "APPLY_FAILED", message: err?.message || String(err) });
    }
  });

  api.registerGatewayMethod("auth.reauth.start", async ({ params, respond, context }) => {
    setBroadcast(context.broadcast);

    const profileId = (params as Record<string, unknown>).profileId as string | undefined;
    if (!profileId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "profileId is required" });
      return;
    }

    try {
      const result = startReauth(profileId);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  api.registerGatewayMethod("auth.reauth.exchange", async ({ params, respond, context }) => {
    setBroadcast(context.broadcast);

    const p = params as Record<string, unknown>;
    const sessionId = p.sessionId as string | undefined;
    const rawCode = p.code as string | undefined;
    if (!sessionId || !rawCode) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "sessionId and code are required",
      });
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      respond(false, undefined, {
        code: "SESSION_EXPIRED",
        message: "PKCE session expired or not found. Start a new re-auth flow.",
      });
      return;
    }

    // Parse pasted input: "code#state", bare code, or full callback URL
    let code: string;
    let state: string | undefined;
    if (rawCode.includes("?code=")) {
      // Full URL pasted: extract code and state from query params
      const url = new URL(rawCode, "https://placeholder");
      code = url.searchParams.get("code") || rawCode;
      state = url.searchParams.get("state") || undefined;
    } else if (rawCode.includes("#")) {
      // code#state format
      const parts = rawCode.split("#");
      code = parts[0];
      state = parts[1] || undefined;
    } else {
      code = rawCode;
    }

    try {
      const tokenData = await exchangeCodeForTokens({
        code,
        state,
        redirectUri: session.fallbackRedirectUri,
        verifier: session.verifier,
      });
      const result = await completeTokenExchange(session, tokenData);
      deleteSession(sessionId);
      respond(true, { ok: true, ...result });
    } catch (err) {
      respond(false, undefined, {
        code: "EXCHANGE_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  api.registerHttpRoute({
    path: "/auth/oauth/callback",
    auth: "plugin",
    match: "exact",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");

      const sendHtml = (status: number, html: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      };

      if (!state || !code) {
        sendHtml(
          400,
          `<html><body><h2>Missing parameters</h2><p>Close this window and try again.</p></body></html>`,
        );
        return;
      }

      const session = getSession(state);
      if (!session) {
        sendHtml(
          410,
          `<html><body><h2>Session expired or invalid</h2><p>Close this window and try again.</p></body></html>`,
        );
        return;
      }

      try {
        const tokenData = await exchangeCodeForTokens({
          code,
          state: state || undefined,
          redirectUri: session.primaryRedirectUri,
          verifier: session.verifier,
        });
        await completeTokenExchange(session, tokenData);
        deleteSession(state);
        sendHtml(
          200,
          [
            "<html><body>",
            "<h2>Authentication successful</h2>",
            "<p>You can close this window.</p>",
            "<script>setTimeout(() => window.close(), 1500)</script>",
            "</body></html>",
          ].join(""),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const safe = msg
          .slice(0, 200)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        console.error(`[auth-reload] OAuth callback exchange failed: ${msg}`);
        sendHtml(
          500,
          `<html><body><h2>Authentication failed</h2><p>${safe}</p><p>Close this window and try again.</p></body></html>`,
        );
      }
    },
  });

  process.on("SIGTERM", () => {
    stopAuthProfileWatcher();
    clearAllSessions();
  });
}
