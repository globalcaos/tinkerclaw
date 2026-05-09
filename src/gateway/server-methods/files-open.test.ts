/**
 * FORK: Tests for files.openInEditor RPC handler.
 *
 * Uses vi.mock to control resolveAgentWorkspaceDir so tests don't depend on the
 * real ~/.openclaw/workspace layout, following the same pattern as briefing.test.ts.
 */

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

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { filesOpenHandlers, __setSpawnImplForTest } from "./files-open.js";

function makeContext() {
  return {
    getRuntimeConfig: () => ({}),
  } as never;
}

describe("files.openInEditor", () => {
  let tmp: string;
  let spawnCalls: Array<{ cmd: string; args: string[] }>;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "files-open-test-"));
    spawnCalls = [];
    // Default: resolveAgentWorkspaceDir returns the per-test temp dir as the workspace.
    vi.mocked(resolveAgentWorkspaceDir).mockReturnValue(tmp);
    vi.mocked(resolveDefaultAgentId).mockReturnValue("main");
    // Inject a fake spawn that records calls instead of actually spawning xdg-open.
    __setSpawnImplForTest((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      return { unref: () => undefined };
    });
  });

  afterEach(async () => {
    __setSpawnImplForTest(null);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("opens path inside workspace via xdg-open", async () => {
    // Write a real file inside the workspace temp dir so path.resolve will point to it.
    const filePath = path.join(tmp, "BRIEFING.md");
    await fs.writeFile(filePath, "# test");

    let captured: unknown;
    await filesOpenHandlers["files.openInEditor"]({
      params: { path: filePath },
      context: makeContext(),
      respond: (_ok, result) => {
        captured = result;
      },
      client: undefined,
    } as never);

    expect(captured).toEqual({ ok: true });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe("xdg-open");
    expect(spawnCalls[0].args).toEqual([filePath]);
  });

  test("rejects path outside the allowlist", async () => {
    let captured: unknown;
    await filesOpenHandlers["files.openInEditor"]({
      params: { path: "/etc/passwd" },
      context: makeContext(),
      respond: (_ok, result) => {
        captured = result;
      },
      client: undefined,
    } as never);

    expect(captured).toMatchObject({ ok: false });
    expect((captured as { reason: string }).reason).toMatch(/allowlist|outside/i);
    expect(spawnCalls).toHaveLength(0);
  });

  test("rejects path with .. traversal", async () => {
    let captured: unknown;
    await filesOpenHandlers["files.openInEditor"]({
      params: { path: `${tmp}/../etc/passwd` },
      context: makeContext(),
      respond: (_ok, result) => {
        captured = result;
      },
      client: undefined,
    } as never);

    expect(captured).toMatchObject({ ok: false });
    expect((captured as { reason: string }).reason).toMatch(/traversal/i);
    expect(spawnCalls).toHaveLength(0);
  });

  test("returns ok:false when params.path is missing", async () => {
    let captured: unknown;
    await filesOpenHandlers["files.openInEditor"]({
      params: {},
      context: makeContext(),
      respond: (_ok, result) => {
        captured = result;
      },
      client: undefined,
    } as never);

    expect(captured).toMatchObject({ ok: false });
    expect((captured as { reason: string }).reason).toMatch(/path is required/i);
    expect(spawnCalls).toHaveLength(0);
  });
});
