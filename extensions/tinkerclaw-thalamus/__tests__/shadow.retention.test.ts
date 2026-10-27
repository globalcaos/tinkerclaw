import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { ThalamusBoardLike } from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it } from "vitest";
// Test-only relative imports, as in shadow.test.ts.
import type { CallRouteCall } from "../../../src/infra/thalamus-call-router.js";
import { NOW, R, supplies } from "../../../src/shared/thalamus-v4.test-support.js";
import { createCacheFeed, newLedgerHolder } from "../src/cache-feed.js";
import { parseConfig } from "../src/config.js";
import { createRunStates } from "../src/run-state.js";
import { createShadowRouter, EXPECTED_OUTPUT_TOKENS } from "../src/shadow.js";
import { ThalamusStore } from "../src/store.js";

// The run state keeps the latest routeCall parameters of up to 256 runs. Those parameters must not pin the call they
// were computed from: a call's context is the whole conversation plus the tools, and the tools reach the agent session
// and its parsed transcript. Measured 2026-10-10 on a copy of the gateway: ~17 MB per turn stayed reachable this way
// (run-state.runs -> base.expectedOutputTokens -> observe()'s closure context -> call -> context -> tools -> AgentSession).

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const board = (): ThalamusBoardLike => ({
  rungs: [R.opus, R.sonnet, R.haiku, R.grok],
  supplies: supplies(),
  contextWindowFor: () => 1_000_000,
  dialIdx: 3,
  builtAtMs: NOW,
});

describe("the shadow router does not keep the calls it routed", () => {
  it("drops the call's context once the decision is written, while the run state keeps its parameters", async () => {
    const runs = createRunStates();
    const queue: Array<() => void> = [];
    const holder = newLedgerHolder();
    const shadow = createShadowRouter({
      cfg: () => parseConfig({ mode: "shadow" }),
      board: () => board(),
      handPicked: () => false,
      holder,
      feed: createCacheFeed({ holder }),
      store: () => new ThalamusStore(":memory:"),
      broadcast: () => {},
      now: () => NOW,
      defer: (fn) => void queue.push(fn),
      runs,
    });

    // Built in its own frame so the test itself holds no strong reference to the context afterwards.
    const route = (): WeakRef<object> => {
      const context = {
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "Compare my translation with the source text." }],
        // Stands in for the transcript and the tools a real call carries.
        tools: [{ name: "Bash", payload: "x".repeat(1_000_000) }],
      };
      const call: CallRouteCall = {
        model: { id: "m" },
        context,
        meta: {
          runId: "run-1",
          sessionKey: "agent:main:tinker:abc",
          agentId: "main",
          trigger: "user",
          provider: "claude-code",
          model: "claude-opus-5",
          thinkLevel: "high",
        },
        callIndex: 0,
      } as CallRouteCall;
      shadow.router.observe(call);
      return new WeakRef(context);
    };

    const ref = route();
    queue.splice(0).forEach((fn) => fn());
    // A WeakRef target lives until the current job ends; collect after it.
    await new Promise((r) => setImmediate(r));
    gc();
    await new Promise((r) => setImmediate(r));
    gc();

    const base = runs.get("run-1")?.base;
    expect(base?.callIndex).toBe(0);
    expect(base?.expectedOutputTokens(R.opus)).toBe(EXPECTED_OUTPUT_TOKENS);
    expect(ref.deref() === undefined, "the routed call's context is still reachable").toBe(true);
  });
});
