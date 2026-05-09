import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

// Stub the workspace resolver so tests control which directory is used,
// rather than depending on the real ~/.openclaw/workspace layout.
vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => ""),
}));

// Allow per-test control of readFile behaviour (used in the EPERM test).
// The factory captures the hoisted `simulateEpermPath` ref so each test can
// set it before invoking the handler.
let simulateEpermPath: string | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: async (filePath: unknown, ...args: unknown[]) => {
      if (simulateEpermPath !== null && filePath === simulateEpermPath) {
        const err = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        throw err;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real.readFile as any)(filePath, ...args);
    },
  };
});

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { briefingHandlers } from "./briefing.js";

function makeContext(workspaceDir: string) {
  // Provide a config that the (mocked) resolver receives as its first argument.
  // The mock ignores cfg and returns whatever the third parameter is, but we
  // override the mock return value per-test via mockReturnValue when needed.
  return {
    getRuntimeConfig: () => ({}),
  } as never;
}

describe("briefing.resolve", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "briefing-test-"));
    // Default: resolveAgentWorkspaceDir returns the per-test temp dir.
    vi.mocked(resolveAgentWorkspaceDir).mockReturnValue(tmp);
    vi.mocked(resolveDefaultAgentId).mockReturnValue("main");
  });

  afterEach(async () => {
    simulateEpermPath = null;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("returns workspace BRIEFING.md when present", async () => {
    const wsPath = path.join(tmp, "BRIEFING.md");
    await fs.writeFile(wsPath, "# Workspace briefing\nstep 1");
    let captured: unknown;
    await briefingHandlers["briefing.resolve"]({
      params: {},
      context: makeContext(tmp),
      respond: (_ok, result) => {
        captured = result;
      },
      client: undefined,
    } as never);
    expect(captured).toEqual({
      path: wsPath,
      source: "workspace",
      content: "# Workspace briefing\nstep 1",
    });
  });

  test("falls back to bundled briefing-default.md when workspace missing", async () => {
    // tmp dir exists but has no BRIEFING.md → falls back to bundled
    let captured: { path: string; source: string; content: string } | undefined;
    await briefingHandlers["briefing.resolve"]({
      params: {},
      context: makeContext(tmp),
      respond: (_ok, result) => {
        captured = result as never;
      },
      client: undefined,
    } as never);
    expect(captured?.source).toBe("bundled");
    expect(captured?.path).toMatch(/briefing-default\.md$/);
    expect(captured?.content).toMatch(/Persona|Briefing|briefing/i);
  });

  test("returns null fields with error when bundle search disabled and workspace missing", async () => {
    let captured: { path: unknown; error: unknown } | undefined;
    await briefingHandlers["briefing.resolve"]({
      params: { __testNoBundleSearch: true },
      context: makeContext(tmp),
      respond: (_ok, result) => {
        captured = result as never;
      },
      client: undefined,
    } as never);
    expect(captured?.path).toBeNull();
    expect(captured?.error).toBeTruthy();
  });

  test("falls back to bundled when workspace BRIEFING.md read throws EPERM", async () => {
    // Place a BRIEFING.md in the temp dir so readIfExists would normally find it,
    // then activate the mock readFile to throw EPERM for that specific path.
    const wsPath = path.join(tmp, "BRIEFING.md");
    await fs.writeFile(wsPath, "secret");
    simulateEpermPath = wsPath;

    let captured: { path: unknown; source: unknown; content: unknown; error?: unknown } | undefined;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await briefingHandlers["briefing.resolve"]({
      params: {},
      context: makeContext(tmp),
      respond: (_ok, result) => {
        captured = result as never;
      },
      client: undefined,
    } as never);

    // Should have warned and fallen through to bundled
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[briefing.resolve] workspace read failed"),
      expect.anything(),
    );
    expect(captured?.source).toBe("bundled");
    expect(captured?.path).toMatch(/briefing-default\.md$/);

    warnSpy.mockRestore();
  });
});
