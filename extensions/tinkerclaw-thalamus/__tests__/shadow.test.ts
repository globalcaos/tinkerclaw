import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createStuckTracker,
  failureSignature,
  localTaskRead,
  registerCallRouter,
  type ThalamusBoardLike,
} from "openclaw/plugin-sdk/fork-thalamus";
import { afterEach, describe, expect, it, vi } from "vitest";
// Integration: the core wrapper and the shared fixtures. Test-only relative imports.
import { wrapStreamFnWithCallRouter } from "../../../src/agents/embedded-agent-runner/call-router.js";
import type { CallRouteCall, CallRouteMeta } from "../../../src/infra/thalamus-call-router.js";
import {
  GROK,
  HAIKU,
  NOW,
  OPUS,
  R,
  SONNET,
  supplies,
} from "../../../src/shared/thalamus-v4.test-support.js";
import { createCacheFeed, newLedgerHolder } from "../src/cache-feed.js";
import { parseConfig } from "../src/config.js";
import { createRunStates } from "../src/run-state.js";
import { createShadowRouter, decisionEvent, SLOW_MS, type ShadowDeps } from "../src/shadow.js";
import { ThalamusStore } from "../src/store.js";

const meta = (over: Partial<CallRouteMeta> = {}): CallRouteMeta => ({
  runId: "run-1",
  sessionKey: "agent:main:tinker:abc",
  agentId: "main",
  trigger: "user",
  provider: "claude-code",
  model: "claude-opus-5",
  thinkLevel: "high",
  ...over,
});

const context = () => ({
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "Compare my translation with the source text." }],
});

const call = (over: Partial<CallRouteCall> = {}): CallRouteCall => ({
  model: { id: "m" },
  context: context(),
  meta: meta(),
  callIndex: 0,
  ...over,
});

const board = (): ThalamusBoardLike => ({
  rungs: [R.opus, R.sonnet, R.haiku, R.grok],
  supplies: supplies(),
  contextWindowFor: () => 1_000_000,
  dialIdx: 3,
  builtAtMs: NOW,
});

function setup(over: Partial<ShadowDeps> = {}, mode: "shadow" | "enforce" | "off" = "shadow") {
  const store = new ThalamusStore(":memory:");
  const queue: Array<() => void> = [];
  const events: Array<[string, unknown]> = [];
  const holder = newLedgerHolder();
  const feed = createCacheFeed({ holder });
  const errors: unknown[] = [];
  const shadow = createShadowRouter({
    cfg: () => parseConfig({ mode }),
    board: () => board(),
    handPicked: () => false,
    holder,
    feed,
    store: () => store,
    broadcast: (n, p) => void events.push([n, p]),
    now: () => NOW,
    defer: (fn) => void queue.push(fn),
    onError: (e) => void errors.push(e),
    ...over,
  });
  const flush = () => queue.splice(0).forEach((fn) => fn());
  return { shadow, store, queue, events, feed, holder, errors, flush };
}

let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  off = undefined;
});

describe("the shadow router: it computes and records, and changes nothing", () => {
  it("observes and returns nothing", () => {
    const t = setup();
    expect(t.shadow.router.observe(call())).toBeUndefined();
  });

  it("writes the decision after the call is on its way, not before", () => {
    const t = setup();
    t.shadow.router.observe(call());
    expect(t.store.getDecision("run-1:0")).toBeUndefined();
    expect(t.queue).toHaveLength(1);
    t.flush();
    const d = t.store.getDecision("run-1:0")!;
    expect(d).toMatchObject({
      runId: "run-1",
      callIndex: 0,
      lane: "embedded",
      mode: "shadow",
      applied: false,
      incumbent: OPUS,
      session: "agent:main:tinker:abc",
    });
    expect(t.events.map((e) => e[0])).toEqual(["thalamus.call"]);
  });

  it("keeps the model the run was on: a shadow decision that would move it is recorded, not applied", () => {
    const t = setup();
    t.shadow.router.observe(call());
    t.flush();
    const d = t.store.getDecision("run-1:0")!;
    expect(d.applied).toBe(false);
    expect(d.mode).toBe("shadow");
    expect(typeof d.wouldChange).toBe("boolean");
  });

  it("is a no-op when the mode is off", () => {
    const t = setup({}, "off");
    t.shadow.router.observe(call());
    expect(t.queue).toHaveLength(0);
    expect(t.shadow.stats().decisions).toBe(0);
  });

  it("counts a missing board and does not throw", () => {
    const t = setup({ board: () => undefined });
    expect(() => t.shadow.router.observe(call())).not.toThrow();
    expect(t.shadow.stats()).toMatchObject({ calls: 1, noBoard: 1, decisions: 0 });
    expect(t.queue).toHaveLength(0);
  });

  it("swallows an error from the board and reports it", () => {
    const t = setup({
      board: () => {
        throw new Error("board broke");
      },
    });
    expect(() => t.shadow.router.observe(call())).not.toThrow();
    expect(t.shadow.stats().errors).toBe(1);
    expect(String(t.errors[0])).toContain("board broke");
  });

  it("swallows a failing store write and reports it", () => {
    const t = setup({
      store: () => {
        throw new Error("disk full");
      },
    });
    t.shadow.router.observe(call());
    expect(() => t.flush()).not.toThrow();
    expect(t.shadow.stats().errors).toBe(1);
  });

  it("does nothing for a context it cannot read, rather than failing", () => {
    const t = setup();
    for (const bad of [undefined, null, 7, "x", {}])
      expect(() => t.shadow.router.observe(call({ context: bad })), String(bad)).not.toThrow();
    expect(t.shadow.stats().errors).toBe(0);
  });

  it("counts a call that takes longer than SLOW_MS", () => {
    let t = 0;
    const fake = setup({ clock: () => (t += SLOW_MS + 1) });
    fake.shadow.router.observe(call());
    expect(fake.shadow.stats().slow).toBe(1);
  });

  it("registers the run's model with the cache feed before the call's usage arrives", () => {
    const t = setup();
    t.shadow.router.observe(call());
    expect(t.feed.runCount()).toBe(1);
  });

  it("numbers decisions by run and call", () => {
    const t = setup();
    t.shadow.router.observe(call({ callIndex: 0 }));
    t.shadow.router.observe(call({ callIndex: 1 }));
    t.shadow.router.observe(call({ callIndex: 0, meta: meta({ runId: "run-2" }) }));
    t.flush();
    expect(
      t.store
        .listDecisions()
        .map((d) => d.id)
        .toSorted(),
    ).toEqual(["run-1:0", "run-1:1", "run-2:0"]);
  });
});

describe("the shadow router: what it decides", () => {
  it("takes the cautious decision on a local read: a real conversation has no Jev read yet", () => {
    const t = setup();
    t.shadow.router.observe(call());
    t.flush();
    expect(t.store.getDecision("run-1:0")!.degraded).toBe(true);
  });

  it("leaves a hand-picked model alone and gives it no ladder", () => {
    const t = setup({ handPicked: () => true });
    t.shadow.router.observe(call());
    t.flush();
    const d = t.store.getDecision("run-1:0")!;
    expect(d.switchReason).toBe("hand-picked");
    expect(d.wouldChange).toBe(false);
    expect((d.ladder as { handPicked: boolean }).handPicked).toBe(true);
  });

  it("records the ladder it would use by reason", () => {
    const t = setup();
    t.shadow.router.observe(call());
    t.flush();
    const ladder = t.store.getDecision("run-1:0")!.ladder as {
      byReason: Record<string, unknown[]>;
    };
    expect(Object.keys(ladder.byReason).toSorted()).toEqual([
      "capacity",
      "engagement",
      "overloaded",
      "rate_limit",
      "timeout",
    ]);
    expect(ladder.byReason.rate_limit.map((e) => (e as { key: string }).key)).toEqual([GROK]);
  });

  it("marks a task from a messaging channel private and keeps unapproved providers out of it", () => {
    const t = setup();
    t.shadow.router.observe(
      call({ meta: meta({ sessionKey: "agent:main:whatsapp:+34600000000" }) }),
    );
    t.flush();
    const d = t.store.getDecision("run-1:0")!;
    expect(d.private).toBe(true);
    const keys = (d.options as Array<{ key: string }>).map((o) => o.key);
    expect(keys).not.toContain(GROK);
    expect(keys).toContain(OPUS);
    expect(
      (d.vetoes as Array<{ key: string; veto: string }>).find((v) => v.key === GROK)?.veto,
    ).toBe("privacy");
  });

  it("puts the effort of the run on the incumbent when the board has that rung", () => {
    const t = setup();
    t.shadow.router.observe(call());
    t.flush();
    expect(t.store.getDecision("run-1:0")!.incumbent).toBe(OPUS);
  });

  it("uses the cache ledger the feed built: a warm thread prices cheaper than a cold one", () => {
    const cold = setup();
    cold.shadow.router.observe(call());
    cold.flush();
    const warm = setup();
    warm.feed.noteRun("run-1", { conversationKey: "agent:main:tinker:abc", modelKey: OPUS });
    warm.feed.handle({
      runId: "run-1",
      stream: "call",
      ts: NOW - 1000,
      data: { phase: "usage", input: 5, cacheRead: 0, cacheWrite: 400 },
    });
    warm.shadow.router.observe(call());
    warm.flush();
    const price = (t: typeof cold) =>
      (
        t.store.getDecision("run-1:0")!.options as Array<{
          key: string;
          feed: string;
          price: number;
        }>
      ).find((o) => o.key === OPUS && o.feed === "thread")!.price;
    expect(price(warm)).toBeLessThan(price(cold));
  });

  it("describes a decision for the panel without any request text", () => {
    const t = setup();
    t.shadow.router.observe(call());
    t.flush();
    const ev = t.events[0][1] as ReturnType<typeof decisionEvent>;
    expect(ev).toMatchObject({ decisionId: "run-1:0", lane: "embedded", moneyBasis: "list" });
    expect(JSON.stringify(ev)).not.toContain("translation");
  });
});

describe("the request the runner sends is byte-for-byte the same with v4 off and in shadow", () => {
  function fakeStream() {
    const seen: unknown[][] = [];
    const fn = ((...a: unknown[]) => {
      seen.push(a);
      return { stream: true };
    }) as unknown as StreamFn;
    return { fn, seen };
  }

  it("hands the original objects on untouched, and the same bytes", () => {
    const model = { id: "claude-opus-5", provider: "claude-code", api: "anthropic-messages" };
    const ctx = context();
    const options = { maxTokens: 4096, headers: { a: "b" }, __openclawRunId: "run-1" };

    const bare = fakeStream();
    (wrapStreamFnWithCallRouter(bare.fn, meta()) as (...a: unknown[]) => unknown)(
      model,
      ctx,
      options,
    );
    const bareBytes = JSON.stringify(bare.seen[0]);
    expect(wrapStreamFnWithCallRouter(bare.fn, meta())).toBe(bare.fn);

    const t = setup({ defer: (fn) => fn() });
    off = registerCallRouter(t.shadow.router);
    const routed = fakeStream();
    const wrapped = wrapStreamFnWithCallRouter(routed.fn, meta());
    expect(wrapped).not.toBe(routed.fn);
    (wrapped as (...a: unknown[]) => unknown)(model, ctx, options);

    expect(JSON.stringify(routed.seen[0])).toBe(bareBytes);
    expect(routed.seen[0][0]).toBe(model);
    expect(routed.seen[0][1]).toBe(ctx);
    expect(routed.seen[0][2]).toBe(options);
    // ...and the shadow router really did run.
    expect(t.store.getDecision("run-1:0")).toBeDefined();
  });

  it("survives frozen arguments and a router that throws", () => {
    const boom = {
      observe: vi.fn(() => {
        throw new Error("x");
      }),
    };
    off = registerCallRouter(boom);
    const s = fakeStream();
    const wrapped = wrapStreamFnWithCallRouter(s.fn, meta()) as (...a: unknown[]) => unknown;
    const frozen = Object.freeze({
      messages: Object.freeze([Object.freeze({ role: "user", content: "hi" })]),
    });
    expect(() => wrapped(Object.freeze({}), frozen, Object.freeze({}))).not.toThrow();
    expect(s.seen).toHaveLength(1);
  });

  it("adds no work to the call path but the router's own compute: the write is deferred", () => {
    const t = setup();
    off = registerCallRouter(t.shadow.router);
    const s = fakeStream();
    (wrapStreamFnWithCallRouter(s.fn, meta()) as (...a: unknown[]) => unknown)({}, context(), {});
    // Nothing has been written or broadcast yet; it waits for the deferral.
    expect(t.store.counts().decisions).toBe(0);
    expect(t.events).toHaveLength(0);
    t.flush();
    expect(t.store.counts().decisions).toBe(1);
  });
});

// The wrapper swallows a throw from the router, so a router that wrote into the context it was handed would fail
// silently while possibly changing what is sent. These tests call `observe` DIRECTLY, with no wrapper to hide behind,
// on a context frozen all the way down (writing to a frozen object throws in strict mode).
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

const richContext = () => ({
  systemPrompt: "You are helpful.",
  tools: [
    { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
  ],
  messages: [
    { role: "user", content: "Compare my translation with the source text." },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "…", thinkingSignature: "sig" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/a" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(4000) }],
    },
    { role: "user", content: [{ type: "text", text: "and the second file" }] },
  ],
});

describe("the shadow router never writes into what it is handed", () => {
  for (const mode of ["shadow", "enforce"] as const) {
    it(`${mode}: observe on a deep-frozen call completes, records a decision and raises nothing`, () => {
      const t = setup({}, mode);
      const c = deepFreeze(
        call({ context: richContext() as never, options: { reasoning: "high" } as never }),
      );
      expect(() => t.shadow.router.observe(c)).not.toThrow();
      t.flush();
      expect(t.errors).toEqual([]);
      expect(t.shadow.stats().errors).toBe(0);
      expect(t.shadow.stats().decisions).toBe(1);
      expect(t.store.counts().decisions).toBe(1);
    });
  }

  it("the call and its context are byte-for-byte the same after observe", () => {
    const t = setup();
    const c = call({ context: richContext() as never });
    const before = JSON.stringify(c);
    t.shadow.router.observe(c);
    t.flush();
    expect(JSON.stringify(c)).toBe(before);
  });

  it("a frozen call for a hand-picked session (no decision) also leaves everything untouched", () => {
    const t = setup({ handPicked: () => true });
    const c = deepFreeze(call({ context: richContext() as never }));
    expect(() => t.shadow.router.observe(c)).not.toThrow();
    t.flush();
    expect(t.errors).toEqual([]);
  });
});

describe("the shadow router feeds the fresh-point services and applies the stuck rule", () => {
  it("stores the run's routeCall parameters and its aim for the digest, check and finish services", () => {
    const runs = createRunStates();
    const t = setup({ runs });
    t.shadow.router.observe(call());
    const st = runs.get("run-1")!;
    expect(st.base?.incumbentKey).toBe("claude-code/claude-opus-5");
    expect(st.base?.runId).toBe("run-1");
    expect(st.aim).toBe("Compare my translation with the source text.");
    expect(st.sessionKey).toBe("agent:main:tinker:abc");
  });

  it("without those dependencies the decision is the same as with them", () => {
    const withDeps = setup({ runs: createRunStates(), stuck: createStuckTracker() });
    const without = setup();
    withDeps.shadow.router.observe(call());
    without.shadow.router.observe(call());
    withDeps.flush();
    without.flush();
    const a = withDeps.store.listDecisions({ limit: 1 })[0];
    const b = without.store.listDecisions({ limit: 1 })[0];
    expect({ ...a, computeMs: 0 }).toEqual({ ...b, computeMs: 0 });
  });

  const haikuMeta = meta({ model: "claude-haiku-4-5", thinkLevel: "" });
  const stuckBoard = (): ThalamusBoardLike => ({
    ...board(),
    rungs: [R.haiku, R.sonnet, R.opus, R.grok],
  });
  const failTwice = (stuck: ReturnType<typeof createStuckTracker>) => {
    stuck.note("run-1", failureSignature({ toolName: "exec", error: "ENOENT /tmp/a1" }));
    stuck.note("run-1", failureSignature({ toolName: "exec", error: "ENOENT /tmp/b2" }));
  };

  it("one failure is not stuck: no stuck record, and the decision is the ordinary one", () => {
    const stuck = createStuckTracker();
    stuck.note("run-1", failureSignature({ toolName: "exec", error: "ENOENT" }));
    const t = setup({ stuck, board: () => stuckBoard() });
    t.shadow.router.observe(call({ meta: haikuMeta }));
    t.flush();
    expect(t.store.listFreshPoints({ kind: "stuck" })).toHaveLength(0);
    expect(t.store.listDecisions({ limit: 1 })[0].switchReason).not.toBe("stuck");
  });

  it("the same failure twice: the stuck rule weighs a stronger model, and the record says what it would do and that it did not", () => {
    const stuck = createStuckTracker();
    failTwice(stuck);
    const t = setup({ stuck, board: () => stuckBoard() });
    const c = call({ meta: haikuMeta });
    const sent = JSON.stringify(c);
    t.shadow.router.observe(c);
    t.flush();
    const [row] = t.store.listFreshPoints({ kind: "stuck" });
    expect(row).toMatchObject({ acted: false, runId: "run-1", mode: "shadow" });
    expect(row.reason).toBe("would-escalate");
    expect(row.detail).toMatchObject({ repeated: 2, incumbent: "claude-code/claude-haiku-4-5" });
    const d = t.store.listDecisions({ limit: 1 })[0];
    expect(d.applied).toBe(false);
    expect(d.switchReason).toBe("stuck");
    expect(row.model).not.toBe("claude-code/claude-haiku-4-5");
    expect(JSON.stringify(c)).toBe(sent);
  });

  it("a success clears the count, so the next call is an ordinary one", () => {
    const stuck = createStuckTracker();
    failTwice(stuck);
    stuck.note("run-1", undefined);
    const t = setup({ stuck, board: () => stuckBoard() });
    t.shadow.router.observe(call({ meta: haikuMeta }));
    t.flush();
    expect(t.store.listFreshPoints({ kind: "stuck" })).toHaveLength(0);
  });

  it("a hand-picked model is never escalated, stuck or not", () => {
    const stuck = createStuckTracker();
    failTwice(stuck);
    const t = setup({ stuck, board: () => stuckBoard(), handPicked: () => true });
    t.shadow.router.observe(call({ meta: haikuMeta }));
    t.flush();
    const [row] = t.store.listFreshPoints({ kind: "stuck" });
    expect(row.reason).toBe("kept");
    expect(t.store.listDecisions({ limit: 1 })[0].switchReason).toBe("hand-picked");
  });
});

describe("what the ledger taught the shadow router (phase F)", () => {
  const quality = (t: ReturnType<typeof setup>, key: string): number => {
    t.shadow.router.observe(call({ meta: meta({ model: "claude-haiku-4-5", thinkLevel: "" }) }));
    t.flush();
    const opts = t.store.getDecision("run-1:0")!.options as Array<{ key: string; quality: number }>;
    return opts.find((o) => o.key === key)!.quality;
  };

  it("reads the public map alone when nothing was learned, and is unchanged by a provider that offers nothing", () => {
    const plain = quality(setup(), SONNET);
    expect(quality(setup({ learned: () => ({}) }), SONNET)).toBe(plain);
    expect(quality(setup({ learned: undefined }), SONNET)).toBe(plain);
  });

  it("moves an option's quality by twenty AA points per unit of learned strength, and records the decision it made", () => {
    const strengthFor = (key: string): number | undefined =>
      key === OPUS ? 0.5 : key === SONNET ? 0.9 : undefined;
    const learned = quality(setup({ learned: () => ({ strengthFor }) }), SONNET);
    // Sonnet's smart height is 64; quality = 64 + 20 x (0.9 - the anchor's 0.5) = 72.
    expect(learned).toBeCloseTo(72, 9);
    expect(learned).toBeGreaterThan(quality(setup(), SONNET));
  });

  it("vetoes a family the ledger has seen refuse twice in the task's class, through the router's own veto", () => {
    const refusals = [
      { family: "claude-opus-5", cls: "medical" as const, atMs: NOW - 1000 },
      { family: "claude-opus-5", cls: "medical" as const, atMs: NOW - 2000 },
    ];
    const text =
      "My doctor prescribed a medication dose for my symptoms, what are the side effects of this treatment and diagnosis";
    expect(
      localTaskRead({
        id: "x",
        ts: NOW,
        sessionKey: "s",
        text,
        trigger: "user",
        private: false,
        floor: 0.6,
      }).topic.value,
    ).toBe("medical");
    const ask = (learned: ShadowDeps["learned"], body: string) => {
      const t = setup({ learned });
      t.shadow.router.observe(
        call({ context: { systemPrompt: "x", messages: [{ role: "user", content: body }] } }),
      );
      t.flush();
      return t.store.getDecision("run-1:0")!;
    };
    const vetoed = ask(() => ({ refusals }), text);
    expect((vetoed.vetoes as Array<{ key: string }>).some((v) => v.key === OPUS)).toBe(true);
    expect((vetoed.options as Array<{ key: string }>).map((o) => o.key)).not.toContain(OPUS);
    // A shadow read is local, so the router is unsure of the topic and cautious: a silent reader never makes a route
    // riskier (paper 4), so the vendor with a refusal record is left out for every task, whatever its class. The class-
    // specific case, with a confident read, is proven on `routeCall` itself in `thalamus-learning.test.ts`.
    const other = ask(
      () => ({ refusals }),
      "Fix the failing unit test in this TypeScript function",
    );
    expect((other.vetoes as Array<{ key: string }>).some((v) => v.key === OPUS)).toBe(true);
    expect(other.degraded).toBe(true);
    // And without the ledger's refusals a medical task keeps Opus too.
    const none = ask(undefined, text);
    expect((none.vetoes as Array<{ key: string }>).some((v) => v.key === OPUS)).toBe(false);
  });
});

// the architect, 2026-10-02 (full deploy): the per-call router reads the same suggestion and the same cooling store as the per-turn one.
describe("the shadow router: the suggestion, the cooling store and midThread", () => {
  it("passes the board's suggestion to routeCall and puts what became of it on the call event", () => {
    const t = setup({
      board: () => ({ ...board(), suggestion: { key: SONNET, effort: "medium" } }),
    });
    t.shadow.router.observe(call());
    t.flush();
    const ev = t.events.find((e) => e[0] === "thalamus.call")![1] as {
      pick: string;
      suggestion?: { state: string; key: string };
    };
    expect(ev.suggestion).toMatchObject({ state: "kept", key: SONNET });
    expect(ev.pick).toBe(`${SONNET}@medium`);
  });

  it("passes the board's cooling set, so a supply that hit a limit is vetoed in the decision", () => {
    const t = setup({
      board: () => ({
        ...board(),
        suggestion: { key: SONNET, effort: "medium" },
        cooling: new Set(["anthropic"]),
      }),
    });
    t.shadow.router.observe(call());
    t.flush();
    const ev = t.events.find((e) => e[0] === "thalamus.call")![1] as {
      suggestion?: { state: string; cause?: string };
    };
    expect(ev.suggestion).toMatchObject({ state: "moved", cause: "supply-cooling" });
    const vetoes = t.store.getDecision("run-1:0")!.vetoes as Array<{ veto: string }>;
    expect(vetoes.some((v) => v.veto === "supply-cooling")).toBe(true);
  });

  it("an event for a stop with no suggestion carries none", () => {
    const t = setup();
    t.shadow.router.observe(call());
    t.flush();
    const ev = t.events.find((e) => e[0] === "thalamus.call")![1] as Record<string, unknown>;
    expect("suggestion" in ev).toBe(false);
  });
});
