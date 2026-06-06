import { describe, it, expect } from "vitest";
import { createOrchestrationRuntime } from "../orchestration-runtime.js";
import { classifyError } from "../recipe-types.js";

describe("agent()", () => {
  it("spawns a subagent and returns its final text", async () => {
    const spawned: string[] = [];
    const rt = createOrchestrationRuntime({
      spawn: async (p) => {
        spawned.push(p);
        return { finalText: `done:${p}` };
      },
    });
    const out = await rt.agent("hello");
    expect(spawned).toEqual(["hello"]);
    expect(out).toBe("done:hello");
  });
});

describe("parallel()", () => {
  it("barriers and isolates failures as Settled errors, preserving order", async () => {
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: p }) });
    const res = await rt.parallel([
      () => rt.agent("a"),
      async () => {
        throw new Error("x");
      },
      () => rt.agent("c"),
    ]);
    expect(res[0]).toEqual({ ok: true, value: "a" });
    expect(res[1].ok).toBe(false);
    expect(res[1].ok === false && res[1].index).toBe(1);
    expect(res[2]).toEqual({ ok: true, value: "c" });
  });

  it("preserves a thrown ClassifiedError's kind in the Settled error", async () => {
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: p }) });
    const res = await rt.parallel([
      () => rt.agent("a"),
      async () => {
        throw classifyError("budget-exceeded", "x");
      },
    ]);
    expect(res[1].ok).toBe(false);
    expect(res[1].ok === false && res[1].error.kind).toBe("budget-exceeded");
  });

  it("runs all thunks even past the concurrency cap", async () => {
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: p }) });
    const res = await rt.parallel(Array.from({ length: 50 }, (_, i) => () => rt.agent(String(i))));
    expect(res).toHaveLength(50);
    expect(res[0]).toEqual({ ok: true, value: "0" });
    expect(res[49]).toEqual({ ok: true, value: "49" });
  });
});

describe("pipeline()", () => {
  it("runs each item through all stages without a barrier", async () => {
    const order: string[] = [];
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: p }) });
    const out = await rt.pipeline(
      [1, 2],
      async (n) => {
        order.push(`s1:${n as number}`);
        return (n as number) * 10;
      },
      async (n) => {
        order.push(`s2:${n as number}`);
        return (n as number) + 1;
      },
    );
    expect(out).toEqual([
      { ok: true, value: 11 },
      { ok: true, value: 21 },
    ]);
  });

  it("drops an item to a Settled error when a stage throws, skipping remaining stages", async () => {
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: p }) });
    let stage2Ran = 0;
    const out = await rt.pipeline(
      [1, 2],
      async (n) => {
        if ((n as number) === 1) throw new Error("boom");
        return n;
      },
      async (n) => {
        stage2Ran++;
        return n;
      },
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].ok === false && out[0].index).toBe(0);
    expect(out[1]).toEqual({ ok: true, value: 2 });
    expect(stage2Ran).toBe(1); // only item 2 reached stage 2
  });

  it("preserves a thrown ClassifiedError's kind in a dropped pipeline item", async () => {
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: p }) });
    const out = await rt.pipeline([1, 2], async (n) => {
      if ((n as number) === 1) throw classifyError("budget-exceeded", "x");
      return n;
    });
    expect(out[0].ok).toBe(false);
    expect(out[0].ok === false && out[0].error.kind).toBe("budget-exceeded");
    expect(out[1]).toEqual({ ok: true, value: 2 });
  });

  it("passes (prev, originalItem, index) to each stage", async () => {
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: p }) });
    const seen: Array<[unknown, unknown, number]> = [];
    await rt.pipeline(
      ["a"],
      async (prev, item, index) => {
        seen.push([prev, item, index]);
        return "x";
      },
      async (prev, item, index) => {
        seen.push([prev, item, index]);
        return "y";
      },
    );
    expect(seen).toEqual([
      ["a", "a", 0],
      ["x", "a", 0],
    ]);
  });
});

describe("phase()", () => {
  it("emits the title to the onPhase sink", () => {
    const phases: string[] = [];
    const rt = createOrchestrationRuntime({
      spawn: async (p) => ({ finalText: p }),
      onPhase: (t) => phases.push(t),
    });
    rt.phase("Scan");
    rt.phase("Verify");
    expect(phases).toEqual(["Scan", "Verify"]);
  });

  it("never throws even if the sink throws", () => {
    const rt = createOrchestrationRuntime({
      spawn: async (p) => ({ finalText: p }),
      onPhase: () => {
        throw new Error("sink boom");
      },
    });
    expect(() => rt.phase("X")).not.toThrow();
  });
});

describe("agent({ schema })", () => {
  it("re-dispatches on invalid output then returns the validated object", async () => {
    let n = 0;
    const rt = createOrchestrationRuntime({
      spawn: async () => ({ finalText: n++ === 0 ? "{bad" : '{"ok":true}' }),
    });
    const out = await rt.agent("x", {
      schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    });
    expect(out).toEqual({ ok: true });
    expect(n).toBe(2); // one re-dispatch (1 required field → J16 budget of 1)
  });

  it("throws a classified error when output never validates within the budget", async () => {
    const rt = createOrchestrationRuntime({
      spawn: async () => ({ finalText: "{still bad" }),
    });
    await expect(
      rt.agent("x", {
        schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      }),
    ).rejects.toThrow(/never satisfied its schema/i);
  });
});
