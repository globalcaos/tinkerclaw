import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";

export {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_UPLOAD_DIR,
  applyBrowserProxyPaths,
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserCloseTab,
  browserCreateProfile,
  browserConsoleMessages,
  browserDeleteProfile,
  browserDoctor,
  browserFocusTab,
  browserNavigate,
  browserOpenTab,
  browserPdfSave,
  browserProfiles,
  browserResetProfile,
  browserScreenshotAction,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabAction,
  browserTabs,
  createBrowserControlContext,
  createBrowserRouteDispatcher,
  createBrowserRuntimeState,
  createBrowserRouteContext,
  ensureBrowserControlAuth,
  getBrowserControlState,
  getBrowserProfileCapabilities,
  isPersistentBrowserProfileMutation,
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
  normalizeBrowserFormField,
  normalizeBrowserFormFieldValue,
  normalizeBrowserRequestPath,
  persistBrowserProxyFiles,
  redactCdpUrl,
  registerBrowserRoutes,
  resolveBrowserConfig,
  resolveBrowserControlAuth,
  resolveExistingPathsWithinRoot,
  resolveProfile,
  resolveRequestedBrowserProfile,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
  stopBrowserRuntime,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./browser-runtime.js";
export type {
  BrowserCreateProfileResult,
  BrowserDeleteProfileResult,
  BrowserDoctorCheck,
  BrowserDoctorReport,
  BrowserFormField,
  BrowserResetProfileResult,
  BrowserRouteRegistrar,
  BrowserServerState,
  BrowserStatus,
  BrowserTab,
  BrowserTransport,
  ProfileStatus,
  SnapshotResult,
} from "./browser-runtime.js";
export {
  callGatewayTool,
  danger,
  detectMime,
  formatCliCommand,
  formatDocsLink,
  formatHelpExamples,
  inheritOptionFromParent,
  info,
  imageResultFromFile,
  jsonResult,
  listNodes,
  optionalStringEnum,
  readStringParam,
  resolveNodeIdFromList,
  selectDefaultNodeFromList,
  stringEnum,
  theme,
} from "./sdk-setup-tools.js";
export {
  getRuntimeConfig,
  normalizePluginsConfig,
  parseBooleanValue,
  resolveEffectiveEnableState,
  shortenHomePath,
} from "./sdk-config.js";
export {
  addGatewayClientOptions,
  callGatewayFromCli,
  defaultRuntime,
  ErrorCodes,
  errorShape,
  isNodeCommandAllowed,
  respondUnavailableOnNodeInvokeError,
  resolveNodeCommandAllowlist,
  runCommandWithRuntime,
  safeParseJson,
  withTimeout,
} from "./sdk-node-runtime.js";
export { createSubsystemLogger, wrapExternalContent } from "./sdk-security-runtime.js";
export type { AnyAgentTool, NodeListNode } from "./sdk-setup-tools.js";
export type { OpenClawConfig } from "./sdk-config.js";
export type {
  GatewayRequestHandlers,
  GatewayRpcOpts,
  NodeSession,
  OpenClawPluginService,
} from "./sdk-node-runtime.js";

// FORK 2026-08-03: `openclaw browser extension install|path` moved into this package (its old
// home, src/cli/browser-cli-extension.ts, had zero importers, never reached dist/, and its
// command group was never registered — the capability had silently stopped existing). Two of
// the symbols it needs are not on the surface this package already imports through, so they
// are added here instead of reaching back into src/, which is exactly what stranded the old
// copy: an import of ../browser/trash.js that stopped resolving when that file moved.
export { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

/**
 * Copy `value` to the system clipboard, returning false when no clipboard helper is available.
 *
 * Mirrors src/infra/clipboard.ts, which the plugin SDK does not export; the spawn helper it
 * uses IS exported, so this is the same fallback ladder rather than a second implementation of
 * process handling.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  const attempts: string[][] = [
    ["pbcopy"],
    ["xclip", "-selection", "clipboard"],
    ["wl-copy"],
    ["clip.exe"], // WSL / Windows
    ["powershell", "-NoProfile", "-Command", "Set-Clipboard"],
  ];
  for (const argv of attempts) {
    try {
      const result = await runCommandWithTimeout(argv, { timeoutMs: 3_000, input: value });
      if (result.code === 0 && !result.killed) {
        return true;
      }
    } catch {
      // keep trying the next fallback
    }
  }
  return false;
}
