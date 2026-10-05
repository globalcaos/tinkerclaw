import { describe, expect, it } from "vitest";
import { applyCallUsage, EMPTY_CACHE_LEDGER } from "./thalamus-cache-ledger.js";
import { cachePolicyFor } from "./thalamus-price-table.js";
import { routeCall } from "./thalamus-route-call.js";
import {
  createStuckTracker,
  failureSignature,
  routeCallWithStuck,
  STUCK_BAR_STEP,
} from "./thalamus-stuck.js";
import { answered, callParams, HAIKU, NOW, R, stepRead } from "./thalamus-v4.test-support.js";

describe("failureSignature: what stays the same between two runs of one failure", () => {
  it("ignores numbers, hashes, paths and quoted values", () => {
    const a = failureSignature({
      toolName: "exec",
      error: "ENOENT: no such file '/tmp/a17/x.json' at line 42 (0xdeadbeef)",
    });
    const b = failureSignature({
      toolName: "exec",
      error: "ENOENT: no such file '/home/o/b22/y.json' at line 99 (0xcafef00d)",
    });
    expect(a).toBe(b);
  });
  it("tells different failures apart, and different tools", () => {
    expect(failureSignature({ error: "ENOENT" })).not.toBe(failureSignature({ error: "EACCES" }));
    expect(failureSignature({ toolName: "read", error: "x" })).not.toBe(
      failureSignature({ toolName: "exec", error: "x" }),
    );
  });
  it("is bounded", () => {
    expect(failureSignature({ error: "e".repeat(5000) }).length).toBeLessThan(200);
  });
});

describe("the stuck tracker: the same failure twice", () => {
  const sig = (e: string) => failureSignature({ toolName: "exec", error: e });
  it("one failure is not stuck; the same one again is", () => {
    const t = createStuckTracker();
    expect(t.note("r", sig("boom 1"))).toEqual({ repeated: 1, stuck: false });
    expect(t.note("r", sig("boom 2"))).toEqual({ repeated: 2, stuck: true });
    expect(t.note("r", sig("boom 3"))).toEqual({ repeated: 3, stuck: true });
  });
  it("a different failure starts the count again", () => {
    const t = createStuckTracker();
    t.note("r", sig("boom"));
    expect(t.note("r", sig("other"))).toEqual({ repeated: 1, stuck: false });
  });
  it("a success clears it", () => {
    const t = createStuckTracker();
    t.note("r", sig("boom"));
    t.note("r", undefined);
    expect(t.note("r", sig("boom"))).toEqual({ repeated: 1, stuck: false });
  });
  it("runs are counted apart, and bounded", () => {
    const t = createStuckTracker({ maxRuns: 3 });
    t.note("a", sig("x"));
    t.note("b", sig("x"));
    expect(t.repeated("a")).toBe(1);
    for (const r of ["c", "d", "e"]) t.note(r, sig("x"));
    expect(t.size()).toBe(3);
    t.forget("e");
    expect(t.repeated("e")).toBe(0);
  });
});

describe("routeCallWithStuck: routeCall's own stuck rule decides", () => {
  const warmHaiku = applyCallUsage(
    EMPTY_CACHE_LEDGER,
    {
      conversationKey: "conv",
      modelKey: HAIKU,
      nowMs: NOW - 1000,
      input: 0,
      cacheRead: 1_000,
      cacheWrite: 0,
    },
    cachePolicyFor(HAIKU),
  );
  // The incumbent clears the bar on its own, so without a stuck signal nothing moves.
  const params = callParams({
    rungs: [R.haiku, R.sonnet, R.opus, R.grok],
    incumbentKey: HAIKU,
    incumbentEffort: "",
    cache: warmHaiku,
    feedTokens: { thread: 1_000 },
    expectedOutputTokens: () => 2_000,
    step: stepRead({ depth: answered("deep" as const) }),
    dialBar: 40,
  });

  it("not stuck is exactly routeCall", () => {
    expect(routeCallWithStuck(params, false)).toEqual(routeCall(params));
  });

  it("the incumbent that clears the bar is kept when nothing says stuck", () => {
    expect(routeCallWithStuck(params, false)!.chosen.rung.key).toBe(HAIKU);
  });

  it("stuck raises the bar just above the incumbent and lets the stuck rule decide", () => {
    const d = routeCallWithStuck(params, true)!;
    expect(d.switch).toEqual({ kind: "switch", reason: "stuck" });
    const inc = routeCall(params)!.options.find(
      (o) => o.rung.key === HAIKU && o.feed === "thread",
    )!;
    expect(d.chosen.quality).toBeGreaterThanOrEqual(inc.quality + STUCK_BAR_STEP);
  });

  it("a step the read called mechanical is still escalated once it has failed the same way twice", () => {
    const mech = {
      ...params,
      step: stepRead({ depth: answered("mechanical" as const) }),
      dialBar: 50,
    };
    expect(routeCallWithStuck(mech, false)!.chosen.rung.key).toBe(HAIKU);
    const d = routeCallWithStuck(mech, true)!;
    expect(d.switch).toEqual({ kind: "switch", reason: "stuck" });
    expect(d.chosen.rung.key).not.toBe(HAIKU);
  });

  it("a stronger model that costs far more than another try does not escalate", () => {
    // Opus alone above the incumbent, with a huge thread so its cold write dwarfs a retry on the warm incumbent.
    const dear = {
      ...params,
      rungs: [R.haiku, R.opus],
      feedTokens: { thread: 900_000 },
      cache: warmHaiku,
    };
    const d = routeCallWithStuck(dear, true)!;
    expect(d.switch.reason).not.toBe("stuck");
    expect(d.chosen.rung.key).toBe(HAIKU);
  });

  it("a hand-picked model is never escalated, stuck or not", () => {
    const d = routeCallWithStuck({ ...params, handPicked: true }, true)!;
    expect(d.switch).toEqual({ kind: "keep", reason: "hand-picked" });
  });

  it("nothing survives the vetoes: undefined, like routeCall", () => {
    expect(
      routeCallWithStuck(
        { ...params, approvedProviders: [], task: { ...params.task, private: true } },
        true,
      ),
    ).toBeUndefined();
  });
});
