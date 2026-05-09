import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { briefingHandlers } from "./briefing.js";

function makeContext(workspaceDir: string) {
  return {
    getRuntimeConfig: () => ({ workspaceDir }) as never,
  } as never;
}

describe("briefing.resolve", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "briefing-test-"));
  });
  afterEach(async () => {
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
});
