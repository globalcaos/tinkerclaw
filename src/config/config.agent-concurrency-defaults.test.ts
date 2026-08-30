import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_SESSIONS_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  resolveAgentMaxConcurrent,
  resolveSessionsMaxConcurrent,
  resolveSubagentMaxConcurrent,
} from "./agent-limits.js";
import { applyAgentDefaults } from "./defaults.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("agent concurrency defaults", () => {
  it("resolves defaults when unset", () => {
    expect(resolveAgentMaxConcurrent({})).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(resolveSubagentMaxConcurrent({})).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
    expect(resolveSessionsMaxConcurrent({})).toBe(DEFAULT_SESSIONS_MAX_CONCURRENT);
    expect(DEFAULT_SESSIONS_MAX_CONCURRENT).toBe(8);
  });

  it("resolves sessions maxConcurrent overrides and floors fractional values", () => {
    expect(
      resolveSessionsMaxConcurrent({ agents: { defaults: { sessions: { maxConcurrent: 3 } } } }),
    ).toBe(3);
    expect(
      resolveSessionsMaxConcurrent({ agents: { defaults: { sessions: { maxConcurrent: 2.9 } } } }),
    ).toBe(2);
  });

  it("clamps invalid values to at least 1", () => {
    const cfg = {
      agents: {
        defaults: {
          maxConcurrent: 0,
          subagents: { maxConcurrent: -3 },
          sessions: { maxConcurrent: 0 },
        },
      },
    };
    expect(resolveAgentMaxConcurrent(cfg)).toBe(1);
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(1);
    expect(resolveSessionsMaxConcurrent(cfg)).toBe(1);
  });

  it("accepts subagent spawn depth and per-agent child limits", () => {
    const parsed = OpenClawSchema.parse({
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
            maxChildrenPerAgent: 7,
          },
        },
      },
    });

    expect(parsed.agents?.defaults?.subagents?.maxSpawnDepth).toBe(2);
    expect(parsed.agents?.defaults?.subagents?.maxChildrenPerAgent).toBe(7);
  });

  it("injects missing agent defaults", () => {
    const cfg = applyAgentDefaults({});

    expect(cfg.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(cfg.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });
});
