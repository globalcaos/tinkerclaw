import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createSkillLibrary } from "../../../src/memory/engram/skill-library.js";
import { seedStdlibSkills, STDLIB_SEED_SKILLS } from "../seed-skills/index.js";

describe("seedStdlibSkills", () => {
  it("seeds typed stdlib skills that round-trip with schemas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-seed-"));
    const lib = createSkillLibrary({ baseDir: dir });
    const ids = await seedStdlibSkills(lib);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const s = lib.read(ids[0]);
    expect(s?.inputSchema).toBeDefined();
    expect(s?.outputSchema?.type).toBe("object");
    expect(s?.lineage?.composedFrom).toBe("promotion");
  });

  it("every seed is typed (input+output schema) — compose can wire ports", () => {
    for (const s of STDLIB_SEED_SKILLS) {
      expect(s.inputSchema, `${s.name} inputSchema`).toBeDefined();
      expect(s.outputSchema, `${s.name} outputSchema`).toBeDefined();
      expect(s.steps.length, `${s.name} steps`).toBeGreaterThan(0);
    }
  });

  it("a re-seed version-bumps (dedup by name), does not duplicate the library", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-reseed-"));
    const lib = createSkillLibrary({ baseDir: dir });
    const first = await seedStdlibSkills(lib);
    const second = await seedStdlibSkills(lib);
    expect(second).toEqual(first); // same skill ids, no new entries
    const s = lib.read(first[0]);
    expect(s?.version).toBe(2); // version bumped, not duplicated
  });
});
