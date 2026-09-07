/**
 * FORK: the Chrome extension relay server lifecycle, as a declared plugin-SDK surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tinkerclaw-browser-relay` starts and stops the relay that lets the browser extension
 * talk to the gateway. It reached the implementation with a DYNAMIC import
 * (`await import("../../src/browser/extension-relay.js")`) — lazily, to keep the module
 * off the startup path.
 *
 * A dynamic import is the same boundary violation as a static one and fails the same way:
 * the specifier is still a relative path out of the package, and it still resolves to
 * nothing once the plugin is installed under `~/.openclaw/plugins/<name>/`. It is only
 * more dangerous, because it fails at the moment the feature is first used rather than at
 * load — the plugin installs cleanly, starts cleanly, and breaks when someone tries to
 * open a browser. Rewriting it as `await import("openclaw/plugin-sdk/fork-browser-relay")`
 * keeps the laziness and fixes the resolution.
 *
 * Lifecycle only: start, stop, and the auth headers a caller needs to reach the relay it
 * just started. The server type is exported so a caller can hold the handle.
 */

export {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
  getChromeExtensionRelayAuthHeaders,
} from "../browser/extension-relay.js";
export type { ChromeExtensionRelayServer } from "../browser/extension-relay.js";
