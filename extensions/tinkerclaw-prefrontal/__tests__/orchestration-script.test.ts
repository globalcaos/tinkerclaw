import { describe, it, expect } from "vitest";
import { createOrchestrationRuntime } from "../orchestration-runtime.js";
import { runOrchestrationScript } from "../orchestration-script.js";

describe("runOrchestrationScript", () => {
  it("runs a script that calls agent() and returns its result", async () => {
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: `r:${p}` }) });
    const out = await runOrchestrationScript(rt, 'return await agent("x");');
    expect(out).toBe("r:x");
  });

  it("exposes parallel() + args to the script", async () => {
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: p }) });
    const out = await runOrchestrationScript(
      rt,
      "return await parallel(args.items.map((i) => () => agent(i)));",
      { items: ["a", "b"] },
    );
    expect(out).toEqual([
      { ok: true, value: "a" },
      { ok: true, value: "b" },
    ]);
  });

  it("exposes pipeline() to the script", async () => {
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: p }) });
    const out = await runOrchestrationScript(
      rt,
      "return await pipeline([1, 2], async (n) => n * 10, async (n) => n + 1);",
    );
    expect(out).toEqual([
      { ok: true, value: 11 },
      { ok: true, value: 21 },
    ]);
  });

  it("exposes phase() and log() to the script", async () => {
    const phases: string[] = [];
    const logs: string[] = [];
    const rt = createOrchestrationRuntime({
      spawn: async (p) => ({ finalText: p }),
      onPhase: (t) => phases.push(t),
    });
    await runOrchestrationScript(rt, 'phase("Scan"); log("hello"); return 1;', undefined, (m) =>
      logs.push(m),
    );
    expect(phases).toEqual(["Scan"]);
    expect(logs).toEqual(["hello"]);
  });

  it("supports agent({schema}) inside a script (typed self-correction)", async () => {
    let n = 0;
    const rt = createOrchestrationRuntime({
      spawn: async () => ({ finalText: n++ === 0 ? "{bad" : '{"ok":true}' }),
    });
    const out = await runOrchestrationScript(
      rt,
      'return await agent("x", { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } });',
    );
    expect(out).toEqual({ ok: true });
  });

  it("surfaces a thrown error (never swallowed)", async () => {
    const rt = createOrchestrationRuntime({ spawn: async (p) => ({ finalText: p }) });
    await expect(runOrchestrationScript(rt, 'throw new Error("boom");')).rejects.toThrow(/boom/);
  });
});
