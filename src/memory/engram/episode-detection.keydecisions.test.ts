/**
 * SS3 Task 0b — close the keyDecisions extractor gap.
 *
 * Before: buildEpisode hardcoded `keyDecisions: []`, so isSkillWorthy's third gate
 * declined EVERY freshly-detected episode → the library only ever grew by hand.
 * After: buildEpisode derives the decision trace from the episode's tool_call
 * events. A genuine multi-step procedure (>=2 actions) now auto-qualifies; a lone
 * one-shot tool call stays declined (no spurious skill spam).
 */
import { describe, it, expect } from "vitest";
import { detectEpisodes } from "./episode-detection.js";
import type { MemoryEvent } from "./event-types.js";
import { isSkillWorthy } from "./skill-extraction.js";

const BASE = new Date("2026-06-04T10:00:00Z").getTime();

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

describe("detectEpisodes populates keyDecisions (Task 0b)", () => {
  it("a multi-step procedure (>=2 tool calls, completed) → decisions populated → skill-worthy", async () => {
    const events = [
      ev({ id: "e0", kind: "user_message", content: "migrate the auth module" }),
      ev({ id: "e1", kind: "tool_call", content: "git checkout -b migrate-auth" }),
      ev({ id: "e2", kind: "tool_call", content: "pnpm run codemod auth" }),
      ev({ id: "e3", kind: "agent_message", content: "migration done, tests green" }),
    ];
    const [episode] = await detectEpisodes(events);
    expect(episode.outcome).toBe("completed");
    expect(episode.keyDecisions.length).toBeGreaterThanOrEqual(2);
    expect(isSkillWorthy(episode, events)).toBe(true);
  });

  it("a trivial one-shot (single tool call) → no decisions → declined (no spam)", async () => {
    const events = [
      ev({ id: "e0", kind: "user_message", content: "what time is it" }),
      ev({ id: "e1", kind: "tool_call", content: "clock.now" }),
      ev({ id: "e2", kind: "agent_message", content: "it's noon" }),
    ];
    const [episode] = await detectEpisodes(events);
    expect(episode.keyDecisions).toEqual([]);
    expect(isSkillWorthy(episode, events)).toBe(false);
  });

  it("a pure-chat episode (no tool use) → no decisions → declined", async () => {
    const events = [
      ev({ id: "e0", kind: "user_message", content: "hi" }),
      ev({ id: "e1", kind: "agent_message", content: "hello" }),
    ];
    const [episode] = await detectEpisodes(events);
    expect(episode.keyDecisions).toEqual([]);
    expect(isSkillWorthy(episode, events)).toBe(false);
  });
});
