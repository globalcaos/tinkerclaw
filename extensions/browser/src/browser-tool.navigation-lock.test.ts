import { describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  browserNavigate: vi.fn(async () => ({ ok: true })),
  browserOpenTab: vi.fn(async () => ({ ok: true, targetId: "t1" })),
  callGatewayTool: vi.fn(async () => ({ ok: true, payload: { result: {} } })),
  listNodes: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
}));

vi.mock("./browser-tool.runtime.js", () => {
  const readStringValue = (value: unknown) => (typeof value === "string" ? value : undefined);
  const readStringParam = (
    params: Record<string, unknown>,
    key: string,
    opts?: { required?: boolean; label?: string },
  ) => {
    const v = readStringValue(params[key])?.trim();
    if (v) return v;
    if (opts?.required) throw new Error(`${opts.label ?? key} required`);
    return undefined;
  };
  return {
    BrowserToolSchema: {},
    DEFAULT_AI_SNAPSHOT_MAX_CHARS: 40_000,
    DEFAULT_UPLOAD_DIR: "/tmp",
    applyBrowserProxyPaths: vi.fn(),
    browserAct: vi.fn(async () => ({ ok: true })),
    browserArmDialog: vi.fn(async () => ({ ok: true })),
    browserArmFileChooser: vi.fn(async () => ({ ok: true })),
    browserCloseTab: vi.fn(async () => ({})),
    browserConsoleMessages: vi.fn(async () => ({ ok: true, messages: [] })),
    browserDoctor: vi.fn(async () => ({ ok: true })),
    browserFocusTab: vi.fn(async () => ({})),
    browserNavigate: runtimeMocks.browserNavigate,
    browserOpenTab: runtimeMocks.browserOpenTab,
    browserPdfSave: vi.fn(async () => ({ ok: true, path: "/tmp/test.pdf" })),
    browserProfiles: vi.fn(async () => [] as Array<Record<string, unknown>>),
    browserScreenshotAction: vi.fn(async () => ({ ok: true, path: "/tmp/test.png" })),
    browserSnapshot: vi.fn(async () => ({ ok: true, snapshot: "" })),
    browserStart: vi.fn(async () => ({})),
    browserStatus: vi.fn(async () => ({ ok: true })),
    browserStop: vi.fn(async () => ({})),
    browserTabs: vi.fn(async () => [] as Array<Record<string, unknown>>),
    callGatewayTool: runtimeMocks.callGatewayTool,
    getBrowserProfileCapabilities: () => ({ usesChromeMcp: false }),
    getRuntimeConfig: () => ({ browser: {} }),
    imageResultFromFile: vi.fn(),
    jsonResult: (result: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      details: result,
    }),
    listNodes: runtimeMocks.listNodes,
    normalizeOptionalString: (value: unknown) => readStringValue(value)?.trim() || undefined,
    persistBrowserProxyFiles: vi.fn(async () => new Map<string, string>()),
    readStringParam,
    readStringValue,
    resolveBrowserConfig: () => ({
      enabled: true,
      controlPort: 18791,
      profiles: {},
      defaultProfile: "openclaw",
      actionTimeoutMs: 60_000,
    }),
    resolveExistingPathsWithinRoot: vi.fn(),
    resolveNodeIdFromList: vi.fn(),
    resolveProfile: () => null,
    selectDefaultNodeFromList: () => null,
    touchSessionBrowserTab: vi.fn(),
    trackSessionBrowserTab: vi.fn(),
    untrackSessionBrowserTab: vi.fn(),
    wrapExternalContent: (text: string) => text,
  };
});

const { createBrowserTool } = await import("./browser-tool.js");
const { NAVIGATION_FORBIDDEN_REASON, buildNavigationForbiddenBody } =
  await import("./browser/routes/navigation-lock.js");

interface ForbiddenDetails {
  status: string;
  action: string;
  reason: string;
}

async function runAction(action: string) {
  const tool = createBrowserTool();
  const result = (await tool.execute?.("call-1", {
    action,
    url: "https://example.com",
  })) as { details: ForbiddenDetails } | undefined;
  return result;
}

describe("browser-tool CLI navigation lock", () => {
  it("refuses action=navigate without calling browserNavigate or any proxy path", async () => {
    runtimeMocks.browserNavigate.mockClear();
    runtimeMocks.callGatewayTool.mockClear();
    const result = await runAction("navigate");
    expect(result?.details).toEqual(buildNavigationForbiddenBody("navigate"));
    expect(result?.details).toMatchObject({
      status: "forbidden",
      action: "navigate",
      reason: NAVIGATION_FORBIDDEN_REASON,
    });
    expect(runtimeMocks.browserNavigate).not.toHaveBeenCalled();
    expect(runtimeMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("refuses action=open without calling browserOpenTab or any proxy path", async () => {
    runtimeMocks.browserOpenTab.mockClear();
    runtimeMocks.callGatewayTool.mockClear();
    const result = await runAction("open");
    expect(result?.details).toEqual(buildNavigationForbiddenBody("open"));
    expect(result?.details).toMatchObject({
      status: "forbidden",
      action: "open",
      reason: NAVIGATION_FORBIDDEN_REASON,
    });
    expect(runtimeMocks.browserOpenTab).not.toHaveBeenCalled();
    expect(runtimeMocks.callGatewayTool).not.toHaveBeenCalled();
  });
});
