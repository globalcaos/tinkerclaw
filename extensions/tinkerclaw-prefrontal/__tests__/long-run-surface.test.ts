import { describe, it, expect, vi } from "vitest";
import {
  buildKitStatusEnvelope,
  buildKitCompletionMessage,
  surfaceKitOutcome,
} from "../long-run-surface.js";
import { seedPlanFromPrompt } from "../recipe-matcher.js";

describe("buildKitStatusEnvelope", () => {
  it("produces a non-fatal busy envelope string prefixed with __ERR_ENV__:", () => {
    const s = buildKitStatusEnvelope({
      kitRef: "globalcaos/adversarial-verify",
      done: 2,
      total: 4,
    });
    expect(s.startsWith("__ERR_ENV__:")).toBe(true);
    const env = JSON.parse(s.slice("__ERR_ENV__:".length));
    expect(env.fatal).toBe(false);
    expect(env.category).toBe("busy");
    expect(env.headline).toContain("adversarial-verify");
    expect(env.headline).toContain("2/4");
  });
});

describe("buildKitCompletionMessage", () => {
  it("prefixes the matcher-guard sentinel and summarizes results", () => {
    const msg = buildKitCompletionMessage({
      kitRef: "globalcaos/judge-panel",
      ok: true,
      results: [
        { stepIndex: 0, title: "Rubric", status: "done", note: "3 axes" },
        { stepIndex: 1, title: "Judge A", status: "done", note: "overall=4" },
      ],
    });
    expect(msg.startsWith("__KIT_DONE__")).toBe(true);
    expect(msg).toContain("judge-panel");
    expect(msg).toContain("Rubric");
    expect(msg).toContain("overall=4");
  });
});

describe("surfaceKitOutcome", () => {
  it("injects a chip then a deliver:false completion turn via callGateway", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const fakeCall = vi.fn(async ({ method, params }: any) => {
      calls.push({ method, params });
      return { ok: true };
    });
    await surfaceKitOutcome(
      {
        sessionKey: "agent:main:main",
        kitRef: "globalcaos/judge-panel",
        ok: true,
        results: [{ stepIndex: 0, title: "Rubric", status: "done", note: "3 axes" }],
      },
      { callGateway: fakeCall },
    );
    expect(calls[0].method).toBe("chat.inject");
    expect(calls[0].params.message.startsWith("__ERR_ENV__:")).toBe(true);
    expect(calls[1].method).toBe("agent");
    expect(calls[1].params.deliver).toBe(false);
    expect(typeof calls[1].params.idempotencyKey).toBe("string");
    expect(calls[1].params.message.startsWith("__KIT_DONE__")).toBe(true);
  });
});

// Task 1.5 Step 6(a): the before_prompt_build recipe-matcher must NOT seed a plan
// for a __KIT_DONE__ completion re-injection (phantom-plan guard, mirrors the
// [System] restart-continue guard — MEMORY.md "Kit-matcher false-positive").
describe("seedPlanFromPrompt __KIT_DONE__ guard", () => {
  function deps(prompt: string) {
    const setCalls: unknown[] = [];
    return {
      setCalls,
      deps: {
        prompt,
        sessionKey: "agent:main:main",
        runId: "run-1",
        ownRecipesDir: "/nonexistent-kits-dir",
        planStore: {
          get: async () => null,
          set: async (params: unknown) => {
            setCalls.push(params);
            return params;
          },
        },
      },
    };
  }

  it("returns seeded:false and never calls planStore.set for a __KIT_DONE__ prompt", async () => {
    const { deps: d, setCalls } = deps(
      "__KIT_DONE__ Kit globalcaos/judge-panel completed. Per-step results:\n  ✓ Rubric: 3 axes",
    );
    const result = await seedPlanFromPrompt(d);
    expect(result.seeded).toBe(false);
    expect(setCalls.length).toBe(0);
  });

  it("also suppresses when the sentinel is preceded by leading whitespace", async () => {
    const { deps: d, setCalls } = deps("   __KIT_DONE__ Kit x aborted.");
    const result = await seedPlanFromPrompt(d);
    expect(result.seeded).toBe(false);
    expect(setCalls.length).toBe(0);
  });
});
