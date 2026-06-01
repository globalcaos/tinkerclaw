/**
 * Tests — Upgrade 6 (J5 Voyager): skill library + invocation.
 *
 * put/version/dedup, search (keyword fallback + injected-EmbedFn semantic),
 * rank by successRate then recency, recordOutcome monotonicity, never-delete
 * deprecate, and the invocation outcome-tracking seam. temp dirs per
 * phase3.test.ts:20-28.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Skill } from "../storage/types.js";
import type { EmbedFn } from "./embedding-worker.js";
import { initialSuccessMetrics } from "./skill-extraction.js";
import {
  checkPrerequisites,
  invokeSkill,
  makeOutcomeRecorder,
  validateInputs,
} from "./skill-invocation.js";
import { createSkillLibrary, jaccard, type SkillLibrary } from "./skill-library.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-skill-lib-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let counter = 0;
function skill(overrides: Partial<Skill> = {}): Skill {
  counter += 1;
  return {
    skillId: `skill-${counter}-${Math.random().toString(36).slice(2, 8)}`,
    version: 1,
    name: "merge-conflict-resolution",
    description: "Resolve a git merge conflict and re-verify with tests",
    prerequisites: ["a checked-out branch with conflicts"],
    steps: ["identify conflicting files", "pick a resolution side", "re-run the test suite"],
    testCases: [{ input: { file: "foo.ts" }, expect: "no conflict markers" }],
    successMetrics: initialSuccessMetrics(),
    sourceEpisodeIds: ["ep-1"],
    created: "2026-02-16T10:00:00Z",
    deprecated: false,
    ...overrides,
  };
}

describe("createSkillLibrary.put", () => {
  it("stores a brand-new skill at version 1 and read() returns the body", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    const s = skill();
    const ref = await lib.put(s);
    expect(ref.version).toBe(1);
    expect(ref.skillId).toBe(s.skillId);
    const body = lib.read(s.skillId);
    expect(body?.steps.length).toBe(3);
  });

  it("a second skill with the same name creates version 2, not a duplicate", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    const first = await lib.put(skill({ sourceEpisodeIds: ["ep-1"] }));
    const second = await lib.put(skill({ sourceEpisodeIds: ["ep-2"] }));
    // Same name → same skillId, bumped version, merged provenance.
    expect(second.skillId).toBe(first.skillId);
    expect(second.version).toBe(2);
    const body = lib.read(first.skillId);
    expect(body?.sourceEpisodeIds.sort()).toEqual(["ep-1", "ep-2"]);
    // Only one logical skill in the library.
    expect(lib.list()).toHaveLength(1);
  });

  it("two near-identical skills (Jaccard > 0.8) dedup to one", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    await lib.put(
      skill({ name: "resolve-merge", description: "fix a git merge conflict cleanly" }),
    );
    // Different name but near-identical text → Jaccard dedup, not a new skill.
    await lib.put(
      skill({
        name: "resolve-merge-conflict",
        description: "fix a git merge conflict cleanly",
        steps: ["identify conflicting files", "pick a resolution side", "re-run the test suite"],
      }),
    );
    expect(lib.list()).toHaveLength(1);
  });

  it("a genuinely different skill is NOT deduped", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    await lib.put(skill({ name: "merge-conflict-resolution" }));
    await lib.put(
      skill({
        name: "deploy-rollback",
        description: "roll back a failed deployment to the last green release",
        steps: ["identify the bad release", "select prior tag", "trigger redeploy"],
      }),
    );
    expect(lib.list()).toHaveLength(2);
  });
});

describe("jaccard", () => {
  it("identical text → 1, disjoint → 0", () => {
    expect(jaccard("a b c", "a b c")).toBe(1);
    expect(jaccard("a b c", "x y z")).toBe(0);
  });
});

describe("search", () => {
  it("keyword fallback: a query matching the description returns the skill", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    await lib.put(skill({ name: "merge", description: "resolve a git merge conflict" }));
    await lib.put(
      skill({
        name: "deploy",
        description: "roll back a failed deployment",
        steps: ["identify", "rollback"],
      }),
    );
    const hits = await lib.search("git merge conflict", 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].name).toBe("merge");
  });

  it("semantic: an injected EmbedFn ranks by cosine and batches in ONE call", async () => {
    let calls = 0;
    let lastBatchSize = 0;
    // Deterministic toy embedder: vector = [countOf('merge'), countOf('deploy')].
    const embedFn: EmbedFn = async (texts) => {
      calls += 1;
      lastBatchSize = texts.length;
      return texts.map((t) => {
        const lower = t.toLowerCase();
        const merge = (lower.match(/merge/g) ?? []).length;
        const deploy = (lower.match(/deploy/g) ?? []).length;
        return new Float32Array([merge + 1, deploy + 1]);
      });
    };
    const lib = createSkillLibrary({ baseDir: tmpDir, embedFn });
    await lib.put(skill({ name: "merge", description: "merge merge merge", steps: ["merge"] }));
    await lib.put(
      skill({ name: "deploy", description: "deploy deploy deploy", steps: ["deploy"] }),
    );
    const hits = await lib.search("merge a branch merge", 5);
    expect(hits[0].name).toBe("merge");
    // ONE batch embed for [query, ...allSkills] — no N+1.
    expect(calls).toBe(1);
    expect(lastBatchSize).toBe(3); // query + 2 skills
  });

  it("excludes deprecated by default but can include them", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    const s = skill({ name: "merge", description: "resolve a git merge conflict" });
    await lib.put(s);
    lib.deprecate(s.skillId);
    expect(await lib.search("git merge conflict")).toHaveLength(0);
    const incl = await lib.search("git merge conflict", 5, { excludeDeprecated: false });
    expect(incl).toHaveLength(1);
  });
});

describe("rank + recordOutcome", () => {
  it("orders by successRate then recency, and recordOutcome moves a skill up", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    const a = skill({ name: "a", description: "alpha", created: "2026-01-01T00:00:00Z" });
    const b = skill({ name: "b", description: "bravo", created: "2026-02-01T00:00:00Z" });
    await lib.put(a);
    await lib.put(b);

    // Both fresh → equal successRate (0.5); tie-break recency → b (newer) first.
    expect(lib.rank().map((r) => r.name)).toEqual(["b", "a"]);

    // Give "a" several successes → its successRate climbs above b's.
    lib.recordOutcome(a.skillId, true);
    lib.recordOutcome(a.skillId, true);
    lib.recordOutcome(a.skillId, true);
    const ranked = lib.rank();
    expect(ranked[0].name).toBe("a");
    expect(ranked[0].successRate).toBeGreaterThan(0.5);
  });

  it("recordOutcome updates successRate monotonically across successes", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    const s = skill({ name: "x" });
    await lib.put(s);
    const r0 = lib.read(s.skillId)!.successMetrics.successRate;
    lib.recordOutcome(s.skillId, true);
    const r1 = lib.read(s.skillId)!.successMetrics.successRate;
    lib.recordOutcome(s.skillId, true);
    const r2 = lib.read(s.skillId)!.successMetrics.successRate;
    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeGreaterThan(r1);
    expect(lib.read(s.skillId)!.successMetrics.invocations).toBe(2);
    expect(lib.read(s.skillId)!.successMetrics.lastInvoked).toBeTruthy();
  });
});

describe("deprecate (never-delete invariant)", () => {
  it("marks deprecated but read() still returns the body", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    const s = skill({ name: "x" });
    await lib.put(s);
    lib.deprecate(s.skillId);
    expect(lib.list()).toHaveLength(0); // excluded from live list
    const body = lib.read(s.skillId);
    expect(body).toBeDefined();
    expect(body!.deprecated).toBe(true);
    expect(body!.steps.length).toBeGreaterThan(0); // body preserved
  });
});

describe("skill-invocation", () => {
  it("checkPrerequisites returns the unmet set", () => {
    const s = skill({ prerequisites: ["p1", "p2"] });
    expect(checkPrerequisites(s, ["p1"])).toEqual(["p2"]);
    expect(checkPrerequisites(s, ["p1", "p2"])).toEqual([]);
  });

  it("validateInputs requires every testCase input key", () => {
    const s = skill({ testCases: [{ input: { file: "x" }, expect: "ok" }] });
    expect(validateInputs(s.testCases, { file: "y" })).toBe(true);
    expect(validateInputs(s.testCases, {})).toBe(false);
  });

  it("invokeSkill refuses on unmet prereqs WITHOUT recording an outcome", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    const s = skill({ prerequisites: ["needs-clean-tree"], testCases: [] });
    await lib.put(s);
    const res = await invokeSkill(lib, s.skillId, {}, async () => ({ success: true }));
    expect(res.success).toBe(false);
    expect(res.unmetPrerequisites).toEqual(["needs-clean-tree"]);
    // Refusal must NOT touch fitness.
    expect(lib.read(s.skillId)!.successMetrics.invocations).toBe(0);
  });

  it("invokeSkill records the outcome when the runner actually ran", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    const s = skill({ prerequisites: [], testCases: [] });
    await lib.put(s);
    const res = await invokeSkill(lib, s.skillId, {}, async () => ({ success: true }));
    expect(res.success).toBe(true);
    expect(lib.read(s.skillId)!.successMetrics.invocations).toBe(1);
    expect(lib.read(s.skillId)!.successMetrics.successes).toBe(1);
  });

  it("invokeSkill records a failure outcome too", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    const s = skill({ prerequisites: [], testCases: [] });
    await lib.put(s);
    const res = await invokeSkill(lib, s.skillId, {}, async () => ({
      success: false,
      reason: "obsolete API",
    }));
    expect(res.success).toBe(false);
    expect(res.reason).toBe("obsolete API");
    expect(lib.read(s.skillId)!.successMetrics.invocations).toBe(1);
    expect(lib.read(s.skillId)!.successMetrics.successes).toBe(0);
  });

  it("makeOutcomeRecorder binds a single-skill recordOutcome callback", async () => {
    const lib = createSkillLibrary({ baseDir: tmpDir });
    const s = skill({ name: "x" });
    await lib.put(s);
    const record = makeOutcomeRecorder(lib, s.skillId);
    record(true);
    expect(lib.read(s.skillId)!.successMetrics.successes).toBe(1);
  });
});
