import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Skill } from "../storage/types.js";
import { createSkillLibrary, type SkillLibrary } from "./skill-library.js";

// `put` requires a COMPLETE Skill record; build one with sane defaults.
function mkSkill(partial: Partial<Skill> & Pick<Skill, "skillId" | "name" | "steps">): Skill {
  return {
    version: 1,
    description: "d",
    prerequisites: [],
    testCases: [],
    successMetrics: { invocations: 0, successes: 0, successRate: 0.5, lastInvoked: null },
    sourceEpisodeIds: [],
    created: "2026-06-04T00:00:00.000Z",
    deprecated: false,
    ...partial,
  };
}

describe("SS3: typed Skill record round-trips optional schema + flat lineage", () => {
  let dir: string;
  let lib: SkillLibrary;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-ss3-"));
    lib = createSkillLibrary({ baseDir: dir });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists + reads inputSchema/outputSchema/lineage", async () => {
    await lib.put(
      mkSkill({
        skillId: "typed-x",
        name: "typed-x",
        steps: ["do x"],
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        lineage: { composedFrom: "promotion", composedSkills: [] },
      }),
    );
    const s = lib.read("typed-x");
    expect(s?.inputSchema?.required).toEqual(["q"]);
    expect(s?.outputSchema?.type).toBe("object");
    expect(s?.lineage?.composedFrom).toBe("promotion");
  });

  it("untyped skill (no schema) still round-trips unchanged (overlay-not-delete)", async () => {
    await lib.put(mkSkill({ skillId: "prose-y", name: "prose-y", steps: ["do y"] }));
    const s = lib.read("prose-y");
    expect(s).toBeDefined();
    expect(s?.inputSchema).toBeUndefined();
    expect(s?.lineage).toBeUndefined();
  });

  it("a version-bump (same name) ADOPTS a newly-provided schema, else keeps existing", async () => {
    await lib.put(mkSkill({ skillId: "ver-z", name: "ver-z", steps: ["v1"] }));
    // re-put same name with a schema → version bump must adopt it
    await lib.put(
      mkSkill({
        skillId: "ver-z",
        name: "ver-z",
        steps: ["v2"],
        outputSchema: {
          type: "object",
          properties: { done: { type: "boolean" } },
          required: ["done"],
        },
      }),
    );
    const s = lib.read("ver-z");
    expect(s?.version).toBe(2);
    expect(s?.outputSchema?.required).toEqual(["done"]);
  });
});
