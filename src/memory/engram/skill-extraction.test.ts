/**
 * Tests — Upgrade 6 (J5 Voyager): skill extraction.
 *
 * isSkillWorthy gate + extractSkill synthesis with a deterministic stub LLM
 * (stubbed the same way summarizeEpisode is in phase3.test.ts). A Skill is the
 * STRUCTURED-PROCEDURE shape (steps + prerequisites + successMetrics) with an
 * OPTIONAL verifiedCode field; one skill per worthy episode.
 */

import { describe, expect, it } from "vitest";
import type { Episode } from "./episode-detection.js";
import type { MemoryEvent } from "./event-types.js";
import { extractSkill, isSkillWorthy, type SkillExtractor } from "./skill-extraction.js";

const BASE = new Date("2026-02-16T10:00:00Z").getTime();

/** Build a MemoryEvent with sensible defaults. */
function ev(overrides: Partial<MemoryEvent> & { id: string }): MemoryEvent {
  return {
    timestamp: new Date(BASE).toISOString(),
    turnId: 0,
    sessionKey: "test",
    kind: "user_message",
    content: "msg",
    tokens: 10,
    metadata: {},
    ...overrides,
  };
}

/** Build an Episode with sensible defaults over the given event ids. */
function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: "ep-1",
    startEventId: "ev-0",
    endEventId: "ev-2",
    startTime: new Date(BASE).toISOString(),
    endTime: new Date(BASE + 60_000).toISOString(),
    turnCount: 1,
    topic: "resolve a merge conflict",
    participants: ["user", "agent"],
    outcome: "completed",
    keyDecisions: ["chose ours then re-ran tests"],
    sourceEventIds: ["ev-0", "ev-1", "ev-2"],
    ...overrides,
  };
}

/** A worthy event set: completed episode with a tool_call and a decision. */
function worthyEvents(): MemoryEvent[] {
  return [
    ev({ id: "ev-0", kind: "user_message", content: "fix the merge conflict in foo.ts" }),
    ev({ id: "ev-1", kind: "tool_call", content: "git checkout --ours foo.ts" }),
    ev({ id: "ev-2", kind: "agent_message", content: "resolved; tests green" }),
  ];
}

/** Deterministic stub LLM that returns a well-formed skill body. */
const stubLlm: SkillExtractor = (_episode, _events) => ({
  name: "merge-conflict-resolution",
  description: "Resolve a git merge conflict and re-verify with tests",
  prerequisites: ["a checked-out branch with conflicts"],
  steps: ["identify conflicting files", "pick a resolution side", "re-run the test suite"],
  testCases: [{ input: { file: "foo.ts" }, expect: "no conflict markers remain" }],
});

describe("isSkillWorthy", () => {
  it("completed episode with a tool_call + key decision → true", () => {
    expect(isSkillWorthy(episode(), worthyEvents())).toBe(true);
  });

  it("abandoned episode → false (do not learn from failures)", () => {
    expect(isSkillWorthy(episode({ outcome: "abandoned" }), worthyEvents())).toBe(false);
  });

  it("ongoing episode → false", () => {
    expect(isSkillWorthy(episode({ outcome: "ongoing" }), worthyEvents())).toBe(false);
  });

  it("pure chat episode with no tool use → false", () => {
    const chat = [
      ev({ id: "ev-0", kind: "user_message", content: "hello" }),
      ev({ id: "ev-1", kind: "agent_message", content: "hi there" }),
    ];
    expect(isSkillWorthy(episode({ keyDecisions: [] }), chat)).toBe(false);
  });

  it("tool-using episode with no key decision → false", () => {
    expect(isSkillWorthy(episode({ keyDecisions: [] }), worthyEvents())).toBe(false);
  });
});

describe("extractSkill", () => {
  it("worthy episode + stub LLM → well-formed Skill", async () => {
    const skill = await extractSkill(episode(), worthyEvents(), stubLlm);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("merge-conflict-resolution");
    expect(skill!.steps.length).toBeGreaterThan(0);
    expect(skill!.testCases.length).toBeGreaterThanOrEqual(1);
    expect(skill!.version).toBe(1);
    expect(skill!.deprecated).toBe(false);
    expect(skill!.sourceEpisodeIds).toEqual(["ep-1"]);
    // fresh skill: no invocations yet, Laplace-smoothed rate.
    expect(skill!.successMetrics.invocations).toBe(0);
    expect(skill!.successMetrics.successRate).toBeCloseTo(0.5, 5);
    expect(typeof skill!.skillId).toBe("string");
    expect(skill!.skillId.length).toBeGreaterThan(0);
    expect(() => new Date(skill!.created).toISOString()).not.toThrow();
  });

  it("returns null when isSkillWorthy is false (no spurious skills)", async () => {
    const skill = await extractSkill(episode({ outcome: "abandoned" }), worthyEvents(), stubLlm);
    expect(skill).toBeNull();
  });

  it("returns null when the LLM declines (returns null)", async () => {
    const declining: SkillExtractor = () => null;
    expect(await extractSkill(episode(), worthyEvents(), declining)).toBeNull();
  });

  it("returns null when the LLM yields empty steps (malformed → reject)", async () => {
    const empty: SkillExtractor = () => ({
      name: "x",
      description: "y",
      prerequisites: [],
      steps: [],
      testCases: [],
    });
    expect(await extractSkill(episode(), worthyEvents(), empty)).toBeNull();
  });

  it("carries an optional verifiedCode field when the LLM supplies one", async () => {
    const coded: SkillExtractor = () => ({
      name: "merge-conflict-resolution",
      description: "...",
      prerequisites: [],
      steps: ["a step"],
      testCases: [{ input: {}, expect: "ok" }],
      verifiedCode: "export function resolve() {}",
    });
    const skill = await extractSkill(episode(), worthyEvents(), coded);
    expect(skill!.verifiedCode).toBe("export function resolve() {}");
  });
});
