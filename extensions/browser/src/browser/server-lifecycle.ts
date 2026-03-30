import { stopOpenClawChrome } from "./chrome.js";
import type { ResolvedBrowserConfig } from "./config.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  listKnownProfileNames,
} from "./server-context.js";

export async function ensureExtensionRelayForProfiles(params: {
  resolved: ResolvedBrowserConfig;
  onWarn: (message: string) => void;
}) {
  // FORK: Restore extension relay startup for chrome-relay profile.
  // Upstream commit 476d948732 removed this but our fork still uses it.
  const { ensureChromeExtensionRelayServer } = await import("./extension-relay.js");
  const profiles = params.resolved.profiles ?? {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.driver !== "existing-session" || !profile.cdpUrl) {
      continue;
    }
    try {
      await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl });
    } catch (err) {
      params.onWarn(
        `extension relay for profile "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
