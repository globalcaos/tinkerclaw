import { describe, it, expect } from "vitest";
import type { SerializedTree } from "../agents/reasoning-tree.js";
import { consumeReasoningTrace } from "./attempt-hooks.js";
import {
  parseThoughts,
  getReasoningMode,
  shouldRunThoughtSearch,
  setReasoningRuntime,
  getReasoningRuntime,
  maybeRunThoughtSearch,
  type ReasoningMode,
  type ReasoningRuntime,
} from "./reasoning-runtime.js";

const FAKE_TREE: SerializedTree = {
  rootId: "n0",
  nodes: [
    {
      id: "n0",
      content: "root",
      score: null,
      depth: 0,
      parentId: null,
      childIds: ["n1"],
      status: "expanded",
    },
    {
      id: "n1",
      content: "winning thought",
      score: 0.9,
      depth: 1,
      parentId: "n0",
      childIds: [],
      status: "leaf",
    },
  ],
  edges: [{ from: "n0", to: "n1" }],
  winningPath: ["n0", "n1"],
};

describe("parseThoughts — generator self-score parsing", () => {
  it("parses '- thought :: score' lines into 0..1 scores", () => {
    const out = parseThoughts("- do X first :: 80\n- try Y :: 20");
    expect(out).toEqual([
      { text: "do X first", score: 0.8 },
      { text: "try Y", score: 0.2 },
    ]);
  });
  it("defaults to 0.5 when a line has no score", () => {
    expect(parseThoughts("- a bare thought")).toEqual([{ text: "a bare thought", score: 0.5 }]);
  });
  it("accepts '*' bullets and clamps scores to [0,1]", () => {
    expect(parseThoughts("* big :: 250")).toEqual([{ text: "big", score: 1 }]);
    expect(parseThoughts("- neg :: 0")).toEqual([{ text: "neg", score: 0 }]);
  });
  it("skips non-bullet / preamble / empty lines", () => {
    const out = parseThoughts(
      "Here are my ideas:\n\n- real one :: 70\nrandom prose\n- another :: 30",
    );
    expect(out.map((t) => t.text)).toEqual(["real one", "another"]);
  });
  it("returns [] for empty/garbage input", () => {
    expect(parseThoughts("")).toEqual([]);
    expect(parseThoughts("no bullets at all")).toEqual([]);
  });
});

describe("getReasoningMode — tri-state config read (default-off invariant)", () => {
  it("returns 'none' when fork.cognitive.reasoning is unset", () => {
    expect(getReasoningMode(() => ({ config: { fork: { cognitive: {} } } }))).toBe("none");
    expect(getReasoningMode(() => ({ config: {} }))).toBe("none");
    expect(getReasoningMode(() => undefined)).toBe("none");
    expect(getReasoningMode(() => null)).toBe("none");
  });
  it("returns the configured tree/lats mode", () => {
    expect(
      getReasoningMode(() => ({ config: { fork: { cognitive: { reasoning: "tree" } } } })),
    ).toBe("tree");
    expect(
      getReasoningMode(() => ({ config: { fork: { cognitive: { reasoning: "lats" } } } })),
    ).toBe("lats");
  });
  it("coerces an unknown/invalid value back to 'none' (fail safe)", () => {
    expect(
      getReasoningMode(() => ({ config: { fork: { cognitive: { reasoning: "bogus" } } } })),
    ).toBe("none");
  });
  it("returns 'none' when the snapshot read throws (safe fallback)", () => {
    expect(
      getReasoningMode(() => {
        throw new Error("no config loaded");
      }),
    ).toBe("none");
  });
});

describe("shouldRunThoughtSearch — escalation gating", () => {
  const Q = "How should I architect the cross-session link store given the per-session JSONL?";
  it("is false whenever mode is 'none' (even for a rich human query)", () => {
    expect(shouldRunThoughtSearch(Q, "none", false)).toBe(false);
  });
  it("is false for automated/cron/heartbeat/subagent sessions regardless of mode", () => {
    expect(shouldRunThoughtSearch(Q, "tree", true)).toBe(false);
    expect(shouldRunThoughtSearch(Q, "lats", true)).toBe(false);
  });
  it("is true for a substantive human query when mode is tree/lats", () => {
    expect(shouldRunThoughtSearch(Q, "tree", false)).toBe(true);
    expect(shouldRunThoughtSearch(Q, "lats", false)).toBe(true);
  });
  it("is false for an empty / trivial query (not search-worthy)", () => {
    expect(shouldRunThoughtSearch("", "tree", false)).toBe(false);
    expect(shouldRunThoughtSearch("   ", "tree", false)).toBe(false);
    expect(shouldRunThoughtSearch("hi", "tree", false)).toBe(false);
    expect(shouldRunThoughtSearch("thanks!", "lats", false)).toBe(false);
  });
});

describe("reasoning-runtime registry — per SessionManager identity", () => {
  it("round-trips set/get keyed by object identity", () => {
    const smA = {};
    const smB = {};
    const rt: ReasoningRuntime = { run: async () => ({ answer: "", trace: null }) };
    expect(getReasoningRuntime(smA)).toBeNull();
    setReasoningRuntime(smA, rt);
    expect(getReasoningRuntime(smA)).toBe(rt);
    expect(getReasoningRuntime(smB)).toBeNull();
  });
  it("delete via set(sm, null)", () => {
    const sm = {};
    const rt: ReasoningRuntime = { run: async () => ({ answer: "", trace: null }) };
    setReasoningRuntime(sm, rt);
    expect(getReasoningRuntime(sm)).toBe(rt);
    setReasoningRuntime(sm, null);
    expect(getReasoningRuntime(sm)).toBeNull();
  });
  it("ignores non-object session managers without throwing", () => {
    expect(getReasoningRuntime(undefined)).toBeNull();
    expect(getReasoningRuntime("nope")).toBeNull();
    // should not throw
    setReasoningRuntime(undefined, { run: async () => ({ answer: "x", trace: null }) });
  });
});

describe("maybeRunThoughtSearch — pre-prompt hook (pass-through + augmentation)", () => {
  const SYS = "## System\nyou are jarvis";
  const Q = "How should I architect the cross-session link store given the per-session JSONL?";

  it("is a pure pass-through when mode is 'none' (no runtime call)", async () => {
    const sm = {};
    let called = false;
    setReasoningRuntime(sm, {
      run: async () => {
        called = true;
        return { answer: "deliberated", trace: null };
      },
    });
    const out = await maybeRunThoughtSearch({
      sessionManager: sm,
      systemPromptText: SYS,
      query: Q,
      isAutomatedSession: false,
      readMode: () => "none" as ReasoningMode,
    });
    expect(out).toBe(SYS);
    expect(called).toBe(false);
  });

  it("is a pass-through when there is no registered runtime", async () => {
    const sm = {};
    const out = await maybeRunThoughtSearch({
      sessionManager: sm,
      systemPromptText: SYS,
      query: Q,
      isAutomatedSession: false,
      readMode: () => "tree" as ReasoningMode,
    });
    expect(out).toBe(SYS);
  });

  it("is a pass-through for an automated session even when mode=tree + runtime present", async () => {
    const sm = {};
    let called = false;
    setReasoningRuntime(sm, {
      run: async () => {
        called = true;
        return { answer: "deliberated", trace: null };
      },
    });
    const out = await maybeRunThoughtSearch({
      sessionManager: sm,
      systemPromptText: SYS,
      query: Q,
      isAutomatedSession: true,
      readMode: () => "tree" as ReasoningMode,
    });
    expect(out).toBe(SYS);
    expect(called).toBe(false);
  });

  it("appends a ## Deliberation block when mode=tree, runtime present, query search-worthy", async () => {
    const sm = {};
    setReasoningRuntime(sm, {
      run: async (query) => ({ answer: `winner for: ${query.slice(0, 4)}`, trace: null }),
    });
    const out = await maybeRunThoughtSearch({
      sessionManager: sm,
      systemPromptText: SYS,
      query: Q,
      isAutomatedSession: false,
      readMode: () => "tree" as ReasoningMode,
    });
    expect(out.startsWith(SYS)).toBe(true);
    expect(out).toContain("## Deliberation");
    expect(out).toContain("winner for:");
  });

  it("never throws on runtime failure — degrades to pass-through", async () => {
    const sm = {};
    setReasoningRuntime(sm, {
      run: async () => {
        throw new Error("search blew up");
      },
    });
    const out = await maybeRunThoughtSearch({
      sessionManager: sm,
      systemPromptText: SYS,
      query: Q,
      isAutomatedSession: false,
      readMode: () => "lats" as ReasoningMode,
    });
    expect(out).toBe(SYS);
  });

  // U10 PRODUCER WIRING — the search tree must be stashed by runId so
  // onTurnComplete (attempt-hooks consumeReasoningTrace) can persist it.
  it("stashes the search trace for the runId (injected sink)", async () => {
    const sm = {};
    setReasoningRuntime(sm, {
      run: async () => ({ answer: "winning thought", trace: FAKE_TREE }),
    });
    const stashed: Array<{ runId: string; trace: SerializedTree | null }> = [];
    const out = await maybeRunThoughtSearch({
      sessionManager: sm,
      systemPromptText: SYS,
      query: Q,
      isAutomatedSession: false,
      runId: "run-stash-1",
      readMode: () => "tree" as ReasoningMode,
      stashTrace: (runId, trace) => stashed.push({ runId, trace }),
    });
    // Deliberation still folds in (unchanged behavior).
    expect(out).toContain("## Deliberation");
    // And the trace is now stashed for the run — the producer fires.
    expect(stashed).toHaveLength(1);
    expect(stashed[0].runId).toBe("run-stash-1");
    expect(stashed[0].trace).toBe(FAKE_TREE);
  });

  it("threads the trace through the REAL stash → consumeReasoningTrace returns it", async () => {
    const sm = {};
    setReasoningRuntime(sm, {
      run: async () => ({ answer: "winning thought", trace: FAKE_TREE }),
    });
    const runId = `run-real-${Date.now()}`;
    await maybeRunThoughtSearch({
      sessionManager: sm,
      systemPromptText: SYS,
      query: Q,
      isAutomatedSession: false,
      runId,
      readMode: () => "tree" as ReasoningMode,
      // No stashTrace → exercises the real attempt-hooks stash sink (the live wiring).
    });
    const got = consumeReasoningTrace(runId);
    expect(got).toBe(FAKE_TREE);
    expect(got?.nodes).toHaveLength(2);
    // consume clears it (one-shot semantics).
    expect(consumeReasoningTrace(runId)).toBeUndefined();
  });

  it("does not stash when there is no runId", async () => {
    const sm = {};
    setReasoningRuntime(sm, {
      run: async () => ({ answer: "winning thought", trace: FAKE_TREE }),
    });
    let stashCalls = 0;
    await maybeRunThoughtSearch({
      sessionManager: sm,
      systemPromptText: SYS,
      query: Q,
      isAutomatedSession: false,
      readMode: () => "tree" as ReasoningMode,
      stashTrace: () => {
        stashCalls++;
      },
    });
    expect(stashCalls).toBe(0);
  });

  it("a stash failure never breaks the turn — deliberation still folds in", async () => {
    const sm = {};
    setReasoningRuntime(sm, {
      run: async () => ({ answer: "winning thought", trace: FAKE_TREE }),
    });
    const out = await maybeRunThoughtSearch({
      sessionManager: sm,
      systemPromptText: SYS,
      query: Q,
      isAutomatedSession: false,
      runId: "run-throws",
      readMode: () => "tree" as ReasoningMode,
      stashTrace: () => {
        throw new Error("stash blew up");
      },
    });
    expect(out).toContain("## Deliberation");
  });
});
