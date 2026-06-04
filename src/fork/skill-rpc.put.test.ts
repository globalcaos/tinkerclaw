/**
 * SS3 Task 7 — fork.skill.put deposit RPC + the live-margin promotion bar.
 *
 * Drives the handler directly (same stub-respond approach as skill-rpc.test.ts),
 * rooting the library at a temp ENGRAM dir via OPENCLAW_HOME.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillLibrary } from "../memory/engram/skill-library.js";
import type { Skill } from "../memory/storage/types.js";
import { clearsPromotionBar, forkSkillHandlers } from "./skill-rpc.js";

let tmpHome: string;
let prevHome: string | undefined;
function engramRoot(): string {
  return path.join(tmpHome, ".openclaw", "engram");
}

beforeEach(() => {
  prevHome = process.env.OPENCLAW_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-put-home-"));
  process.env.OPENCLAW_HOME = tmpHome;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function call(
  method: keyof typeof forkSkillHandlers,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: unknown }> {
  let captured: { ok: boolean; result?: unknown; error?: unknown } = { ok: false };
  const respond = (ok: boolean, result?: unknown, error?: unknown) => {
    captured = { ok, result, error };
  };
  await forkSkillHandlers[method]!({ params, respond, isWebchatConnect: () => false } as never);
  return captured;
}

function seed(over: Partial<Skill> & Pick<Skill, "skillId" | "name">): Skill {
  return {
    version: 1,
    description: "d",
    prerequisites: [],
    steps: ["a"],
    testCases: [],
    successMetrics: { invocations: 0, successes: 0, successRate: 0.5, lastInvoked: null },
    sourceEpisodeIds: [],
    created: "2026-06-04T00:00:00.000Z",
    deprecated: false,
    ...over,
  };
}

describe("clearsPromotionBar (SS3 live-margin, J16)", () => {
  it("empty library → permissive", () => {
    expect(clearsPromotionBar(0.5, [])).toBe(true);
  });
  it("clears when strictly above mean + 1 std", () => {
    expect(clearsPromotionBar(0.95, [0.5, 0.5, 0.6, 0.4])).toBe(true);
  });
  it("an average candidate does not clear", () => {
    expect(clearsPromotionBar(0.5, [0.5, 0.5, 0.5, 0.5])).toBe(false);
  });
});

describe("fork.skill.put (SS3 deposit)", () => {
  it("deposits a skill and round-trips it (lineage + schema)", async () => {
    const { ok, result } = await call("fork.skill.put", {
      skill: {
        name: "compose-and-cite",
        description: "summarize then cite",
        steps: ["summarize", "cite"],
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        composedSkills: ["stdlib-summarize-text", "stdlib-web-search-and-cite"],
        composedFrom: "compose",
      },
    });
    expect(ok).toBe(true);
    const skillId = (result as { skillId: string }).skillId;
    const lib = createSkillLibrary({ baseDir: engramRoot() });
    const s = lib.read(skillId);
    expect(s?.name).toBe("compose-and-cite");
    expect(s?.lineage?.composedFrom).toBe("compose");
    expect(s?.lineage?.composedSkills).toEqual([
      "stdlib-summarize-text",
      "stdlib-web-search-and-cite",
    ]);
    expect(s?.outputSchema?.type).toBe("object");
  });

  it("fails closed on a malformed skill (no name / no steps)", async () => {
    const { ok, error } = await call("fork.skill.put", { skill: { description: "x" } });
    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message ?? error)).toMatch(/name|steps/i);
  });

  it("a re-put of the same name version-bumps (dedup), not duplicates", async () => {
    await call("fork.skill.put", { skill: { name: "dup", steps: ["a"] } });
    await call("fork.skill.put", { skill: { name: "dup", steps: ["a", "b"] } });
    const lib = createSkillLibrary({ baseDir: engramRoot() });
    const dups = lib.list().filter((r) => r.name === "dup");
    expect(dups).toHaveLength(1);
    expect(dups[0].version).toBe(2);
  });

  it("refuses to overwrite a curated/promoted skill without allowReplace", async () => {
    const lib = createSkillLibrary({ baseDir: engramRoot() });
    await lib.put(
      seed({ skillId: "seed-1", name: "curated", lineage: { composedFrom: "promotion" } }),
    );
    const blocked = await call("fork.skill.put", { skill: { name: "curated", steps: ["b"] } });
    expect(blocked.ok).toBe(false);
    const allowed = await call("fork.skill.put", {
      skill: { name: "curated", steps: ["b"] },
      allowReplace: true,
    });
    expect(allowed.ok).toBe(true);
  });

  it("promote:true rejects a candidate that fails the live-margin bar", async () => {
    const lib = createSkillLibrary({ baseDir: engramRoot() });
    for (const n of ["h1", "h2", "h3"]) {
      await lib.put(
        seed({
          skillId: `s-${n}`,
          name: n,
          successMetrics: { invocations: 10, successes: 10, successRate: 0.95, lastInvoked: null },
        }),
      );
    }
    const res = await call("fork.skill.put", {
      skill: { name: "weak", steps: ["a"] },
      promote: true,
      candidateRate: 0.5,
    });
    expect(res.ok).toBe(true);
    expect((res.result as { promoted: boolean }).promoted).toBe(false);
  });

  it("promote:true accepts a candidate that clears the bar", async () => {
    const lib = createSkillLibrary({ baseDir: engramRoot() });
    await lib.put(
      seed({
        skillId: "s-mid",
        name: "mid",
        successMetrics: { invocations: 4, successes: 2, successRate: 0.5, lastInvoked: null },
      }),
    );
    const res = await call("fork.skill.put", {
      skill: { name: "strong", steps: ["a"] },
      promote: true,
      candidateRate: 0.99,
    });
    expect(res.ok).toBe(true);
    expect((res.result as { promoted: boolean }).promoted).toBe(true);
  });
});
