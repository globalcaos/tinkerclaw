/**
 * FORK — tests for the skill-library RPC handlers (Upgrade 6, J5 Voyager skill-library).
 *
 * Test target: src/fork/skill-rpc.ts. We drive the handlers directly with a stub
 * GatewayRequestHandlerOptions (same approach as curiosity-rpc.test.ts). The skill
 * library is rooted at a temp ENGRAM dir via OPENCLAW_HOME, and we seed it with the
 * same createSkillLibrary the RPC uses so the search/recordOutcome round-trips.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as skillInvocation from "../memory/engram/skill-invocation.js";
import { createSkillLibrary } from "../memory/engram/skill-library.js";
import type { Skill } from "../memory/storage/types.js";
import { forkSkillHandlers } from "./skill-rpc.js";

// Spy on the skill-invocation seam while keeping its real behavior, so we can
// assert the RPC actually routes through recordSkillOutcome (the producer wiring)
// rather than poking the library directly. vi.mock is hoisted above the imports.
vi.mock("../memory/engram/skill-invocation.js", async (importActual) => {
  const actual = await importActual<typeof import("../memory/engram/skill-invocation.js")>();
  return { ...actual, recordSkillOutcome: vi.fn(actual.recordSkillOutcome) };
});

let tmpHome: string;
let prevHome: string | undefined;

function makeSkill(over: Partial<Skill> & Pick<Skill, "skillId" | "name">): Skill {
  return {
    version: 1,
    description: "",
    prerequisites: [],
    steps: [],
    testCases: [],
    successMetrics: { invocations: 0, successes: 0, successRate: 0.5, lastInvoked: null },
    sourceEpisodeIds: [],
    created: new Date().toISOString(),
    deprecated: false,
    ...over,
  };
}

/** The ENGRAM root the RPC resolves when no baseDir param is passed. */
function engramRoot(): string {
  return path.join(tmpHome, ".openclaw", "engram");
}

beforeEach(() => {
  prevHome = process.env.OPENCLAW_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-rpc-home-"));
  process.env.OPENCLAW_HOME = tmpHome;
});
afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = prevHome;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Drive a handler and capture the respond() args. */
async function call(
  method: keyof typeof forkSkillHandlers,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: unknown }> {
  let captured: { ok: boolean; result?: unknown; error?: unknown } = { ok: false };
  const respond = (ok: boolean, result?: unknown, error?: unknown) => {
    captured = { ok, result, error };
  };
  await forkSkillHandlers[method]!({
    params,
    respond,
    isWebchatConnect: () => false,
  } as never);
  return captured;
}

describe("fork.skill.search", () => {
  it("returns top-k SkillRefs matching the query (keyword fallback, no embedFn)", async () => {
    const lib = createSkillLibrary({ baseDir: engramRoot() });
    await lib.put(
      makeSkill({
        skillId: "sk-merge",
        name: "merge-conflict-resolution",
        description: "resolve git merge conflicts in package.json",
        steps: ["open the conflict", "pick incoming changes", "run the tests"],
      }),
    );
    await lib.put(
      makeSkill({
        skillId: "sk-deploy",
        name: "deploy-to-prod",
        description: "ship a release to production",
        steps: ["tag the release", "push the image"],
      }),
    );

    const { ok, result } = await call("fork.skill.search", {
      query: "git merge conflict resolution",
      k: 5,
    });
    expect(ok).toBe(true);
    const skills = (result as { skills: Array<{ skillId: string; score?: number }> }).skills;
    expect(skills.length).toBeGreaterThan(0);
    expect(skills[0].skillId).toBe("sk-merge");
  });

  it("rejects a blank query", async () => {
    const { ok, error } = await call("fork.skill.search", { query: "   " });
    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message ?? error)).toMatch(/query/i);
  });

  it("returns an empty list (not an error) when the library is empty", async () => {
    const { ok, result } = await call("fork.skill.search", { query: "anything" });
    expect(ok).toBe(true);
    expect((result as { skills: unknown[] }).skills).toEqual([]);
  });
});

describe("fork.skill.recordOutcome", () => {
  it("increments the skill's success metrics and persists them", async () => {
    const lib = createSkillLibrary({ baseDir: engramRoot() });
    await lib.put(makeSkill({ skillId: "sk-x", name: "skill-x", description: "x", steps: ["a"] }));

    const { ok, result } = await call("fork.skill.recordOutcome", {
      skillId: "sk-x",
      success: true,
    });
    expect(ok).toBe(true);
    expect((result as { ok: boolean }).ok).toBe(true);

    // PRODUCER WIRING: the RPC must route through the skill-invocation seam
    // (recordSkillOutcome), proving skill-invocation.ts is exercised by a real
    // call site rather than imported-by-nothing.
    expect(skillInvocation.recordSkillOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "sk-x",
      true,
    );

    // The library on disk now reflects the recorded invocation.
    const reread = createSkillLibrary({ baseDir: engramRoot() });
    const body = reread.read("sk-x");
    expect(body?.successMetrics.invocations).toBe(1);
    expect(body?.successMetrics.successes).toBe(1);
  });

  it("requires a skillId", async () => {
    const { ok, error } = await call("fork.skill.recordOutcome", { success: true });
    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message ?? error)).toMatch(/skillId/i);
  });

  it("reports not-found for an unknown skillId", async () => {
    const { ok, error } = await call("fork.skill.recordOutcome", {
      skillId: "does-not-exist",
      success: false,
    });
    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message ?? error)).toMatch(/not found/i);
  });

  it("honours a baseDir override param (test-only ENGRAM root redirect)", async () => {
    const altRoot = path.join(tmpHome, "alt-engram");
    const lib = createSkillLibrary({ baseDir: altRoot });
    await lib.put(makeSkill({ skillId: "sk-alt", name: "alt", description: "a", steps: ["s"] }));

    const { ok } = await call("fork.skill.recordOutcome", {
      skillId: "sk-alt",
      success: true,
      baseDir: altRoot,
    });
    expect(ok).toBe(true);
    const reread = createSkillLibrary({ baseDir: altRoot });
    expect(reread.read("sk-alt")?.successMetrics.invocations).toBe(1);
  });
});
