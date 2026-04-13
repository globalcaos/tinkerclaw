import { stopOpenClawChrome } from "./chrome.js";
import type { ResolvedBrowserConfig } from "./config.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  listKnownProfileNames,
} from "./server-context.js";

/**
 * FORK: Default relay port — the extension relay listens on this port.
 * Chrome extensions connect to ws://127.0.0.1:RELAY_PORT/extension.
 * This is NOT Chrome's CDP port (9222) — the relay is a separate server
 * that bridges between the Chrome extension and OpenClaw's browser tool.
 */
const DEFAULT_RELAY_PORT = 18792;

export async function ensureExtensionRelayForProfiles(params: {
  resolved: ResolvedBrowserConfig;
  onWarn: (message: string) => void;
}) {
  // FORK: Restore extension relay startup for existing-session profiles.
  // Upstream commit 476d948732 removed this but our fork still uses it.
  //
  // The relay server binds on its own port (18792) — NOT Chrome's CDP port.
  // Chrome extensions connect to the relay via WebSocket; the relay then
  // forwards CDP commands to Chrome through the extension's debugger API.
  // Only one relay instance is needed regardless of how many profiles exist.
  const { ensureChromeExtensionRelayServer } = await import("./extension-relay.js");
  const profiles = params.resolved.profiles ?? {};
  const hasExistingSession = Object.values(profiles).some((p) => p.driver === "existing-session");
  if (!hasExistingSession) {
    return;
  }
  const cdpUrl = `http://127.0.0.1:${DEFAULT_RELAY_PORT}`;
  try {
    await ensureChromeExtensionRelayServer({ cdpUrl, bindHost: "127.0.0.1" });
  } catch (err) {
    params.onWarn(`extension relay: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function stopKnownBrowserProfiles(params: {
  getState: () => BrowserServerState | null;
  onWarn: (message: string) => void;
}) {
  const current = params.getState();
  if (!current) {
    return;
  }
  const ctx = createBrowserRouteContext({
    getState: params.getState,
    refreshConfigFromDisk: true,
  });
  try {
    for (const name of listKnownProfileNames(current)) {
      try {
        const runtime = current.profiles.get(name);
        if (runtime?.running) {
          await stopOpenClawChrome(runtime.running);
          runtime.running = null;
          continue;
        }
        await ctx.forProfile(name).stopRunningBrowser();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    params.onWarn(`openclaw browser stop failed: ${String(err)}`);
  }
}
