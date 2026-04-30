import type { ResolvedBrowserProfile } from "./config.js";

export type BrowserProfileMode = "local-managed" | "local-existing-session" | "remote-cdp";

export type BrowserProfileCapabilities = {
  mode: BrowserProfileMode;
  isRemote: boolean;
  /** Profile uses the Chrome DevTools MCP server (existing-session driver). */
  usesChromeMcp: boolean;
  usesPersistentPlaywright: boolean;
  supportsPerTabWs: boolean;
  supportsJsonTabEndpoints: boolean;
  supportsReset: boolean;
  supportsManagedTabLimit: boolean;
};

export function getBrowserProfileCapabilities(
  profile: ResolvedBrowserProfile,
): BrowserProfileCapabilities {
  if (profile.driver === "existing-session") {
    // FORK 2026-04-30 (Bible §5.81f): chrome-relay bypasses both upstream
    // browser-driving paths because both have incompatible attach semantics
    // for tab-scoped chrome.debugger sessions:
    // - chrome-devtools-mcp (puppeteer): list_pages times out — pages
    //   never appear in browser.pages() through our relay.
    // - Playwright connectOverCDP: same — browser.contexts()[0].pages()
    //   returns empty even when our relay is forwarding correctly.
    //
    // For chrome-relay, route tab listing directly through the relay's
    // /json/list endpoint (which we know works — the relay extension
    // populates it from chrome.debugger.attach). Page-level operations
    // still go through Playwright via the per-tab WS URL each /json/list
    // entry provides; the per-tab WS bypasses the broken browser-context
    // discovery path entirely.
    if (profile.name === "chrome-relay") {
      return {
        mode: "local-existing-session",
        isRemote: false,
        usesChromeMcp: false,
        usesPersistentPlaywright: false,
        supportsPerTabWs: true,
        supportsJsonTabEndpoints: true,
        supportsReset: false,
        supportsManagedTabLimit: false,
      };
    }
    return {
      mode: "local-existing-session",
      isRemote: false,
      usesChromeMcp: true,
      usesPersistentPlaywright: false,
      supportsPerTabWs: false,
      supportsJsonTabEndpoints: false,
      supportsReset: false,
      supportsManagedTabLimit: false,
    };
  }

  if (!profile.cdpIsLoopback) {
    return {
      mode: "remote-cdp",
      isRemote: true,
      usesChromeMcp: false,
      usesPersistentPlaywright: true,
      supportsPerTabWs: false,
      supportsJsonTabEndpoints: false,
      supportsReset: false,
      supportsManagedTabLimit: false,
    };
  }

  return {
    mode: "local-managed",
    isRemote: false,
    usesChromeMcp: false,
    usesPersistentPlaywright: false,
    supportsPerTabWs: true,
    supportsJsonTabEndpoints: true,
    supportsReset: true,
    supportsManagedTabLimit: true,
  };
}

export function resolveDefaultSnapshotFormat(params: {
  profile: ResolvedBrowserProfile;
  hasPlaywright: boolean;
  explicitFormat?: "ai" | "aria";
  mode?: "efficient";
}): "ai" | "aria" {
  if (params.explicitFormat) {
    return params.explicitFormat;
  }
  if (params.mode === "efficient") {
    return "ai";
  }

  const capabilities = getBrowserProfileCapabilities(params.profile);
  if (capabilities.mode === "local-existing-session") {
    return "ai";
  }

  return params.hasPlaywright ? "ai" : "aria";
}

export function shouldUsePlaywrightForScreenshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
  ref?: string;
  element?: string;
}): boolean {
  return !params.wsUrl || Boolean(params.ref) || Boolean(params.element);
}

export function shouldUsePlaywrightForAriaSnapshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
}): boolean {
  return !params.wsUrl;
}
