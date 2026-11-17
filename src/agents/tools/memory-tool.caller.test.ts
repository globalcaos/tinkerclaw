import { beforeEach, describe, expect, it, vi } from "vitest";

// FORK 2026-10-29: a fake manager records what memory_search hands it. The index manager counts
// only callers 'agent' and 'rpc' as embedder demand (TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
const recorded = vi.hoisted(() => ({ calls: [] as Array<{ query: string; opts: unknown }> }));

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: async () => ({
    manager: {
      search: async (query: string, opts?: unknown) => {
        recorded.calls.push({ query, opts });
        return [];
      },
      status: () => ({ backend: "builtin", provider: "none", model: "" }),
    },
  }),
}));

import { createMemorySearchTool } from "./memory-tool.js";

describe("memory_search caller", () => {
  beforeEach(() => {
    recorded.calls.length = 0;
  });

  it("passes caller 'agent', which the embedder fit counts as demand", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemorySearchTool({ config: cfg, agentSessionKey: "agent:main:main" });
    if (!tool) {
      throw new Error("tool missing");
    }

    await tool.execute("call_1", { query: "kickoff notes", maxResults: 3, minScore: 0.2 });

    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]?.query).toBe("kickoff notes");
    expect(recorded.calls[0]?.opts).toMatchObject({
      caller: "agent",
      maxResults: 3,
      minScore: 0.2,
      sessionKey: "agent:main:main",
    });
  });
});
