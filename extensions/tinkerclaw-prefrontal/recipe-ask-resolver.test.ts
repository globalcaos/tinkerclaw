import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeAskResolver,
  parseAskReply,
  type AskGatewayCall,
  type AskMessage,
} from "./recipe-ask-resolver.js";
import type { RecipeParamSpec } from "./recipe-author.js";
import { createVarStore, mergePrecedence, SECRET_MASK } from "./recipe-var-store.js";

// A scripted chat.history: each poll returns the messages-so-far. We grow the
// transcript between polls to simulate the operator typing over time. The fake
// records every call so we can assert poll counts.
function fakeGateway(script: AskMessage[][]): {
  call: AskGatewayCall;
  historyCalls: number;
} {
  let poll = 0;
  const state = { historyCalls: 0 };
  const call: AskGatewayCall = async <T>(args: { method: string }) => {
    if (args.method !== "chat.history") throw new Error(`unhandled method ${args.method}`);
    state.historyCalls++;
    const idx = Math.min(poll, script.length - 1);
    poll++;
    return { messages: script[idx] ?? [] } as T;
  };
  return {
    call,
    get historyCalls() {
      return state.historyCalls;
    },
  };
}

// A controllable clock + no-op sleep so the poll loop never waits in real time.
function fakeClock(startMs = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms; // advancing the clock IS the sleep
    },
  };
}

describe("recipe-ask-resolver: parseAskReply (pure)", () => {
  it("single missing var → whole reply is the value", () => {
    expect(parseAskReply("  thetinkerzone.com  ", ["target"])).toEqual({
      target: "thetinkerzone.com",
    });
  });

  it("multiple missing vars → one `name: value` line per var", () => {
    const out = parseAskReply("target: a.com\nbranch = develop\nnoise here", ["target", "branch"]);
    expect(out).toEqual({ target: "a.com", branch: "develop" });
  });

  it("empty / unmatched reply → {} (keep polling)", () => {
    expect(parseAskReply("   ", ["a"])).toEqual({});
    expect(parseAskReply("unrelated chatter", ["a", "b"])).toEqual({});
  });
});

describe("recipe-ask-resolver: makeAskResolver", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-resolver-"));
  });
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  // §3.C #8 — happy path: answer parsed + varStore.set(kitRef,name,value,false),
  // then a later mergePrecedence resolves it from the recipe-store tier (asked-once-then-reused).
  it("#8 happy path: parses the answer, persists non-secret, and is reused via mergePrecedence", async () => {
    const varStore = createVarStore(baseDir);
    const kitRef = "globalcaos/funnel";
    const decls: Record<string, RecipeParamSpec> = { target: { type: "string" } };
    const clock = fakeClock();
    const gw = fakeGateway([
      [{ role: "user", content: "thetinkerzone.com" }], // first poll already has the answer
    ]);
    const resolve = makeAskResolver({
      callGateway: gw.call,
      varStore,
      declaredParams: decls,
      pollIntervalMs: 3_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    const out = await resolve({
      sessionKey: "agent:main:main",
      kitRef,
      missingVars: [{ name: "target", prompt: "which target site?" }],
      timeoutMs: 30_000,
    });

    expect(out).toEqual({ target: "thetinkerzone.com" });
    // persisted into the recipe scope, NOT secret
    expect(varStore.read(kitRef, "target")).toBe("thetinkerzone.com");
    expect(varStore.isSecret(kitRef, "target")).toBe(false);

    // asked-once-then-reused: a later resolve finds it via the recipe-store tier.
    const { resolvedParams, provenance } = mergePrecedence(decls, {}, varStore, kitRef, {});
    expect(resolvedParams.target).toBe("thetinkerzone.com");
    expect(provenance.target).toBe("recipe-store");
  });

  // §3.C #9 — timeout: no reply → null.
  it("#9 timeout: no operator reply before the deadline → null (nothing persisted)", async () => {
    const varStore = createVarStore(baseDir);
    const clock = fakeClock();
    const gw = fakeGateway([[], [], []]); // every poll: empty transcript
    const resolve = makeAskResolver({
      callGateway: gw.call,
      varStore,
      declaredParams: { target: { type: "string" } },
      pollIntervalMs: 3_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    const out = await resolve({
      sessionKey: "s",
      kitRef: "o/s",
      missingVars: [{ name: "target", prompt: "?" }],
      timeoutMs: 9_000, // ~3 polls at 3s before the clock crosses the deadline
    });

    expect(out).toBeNull();
    expect(gw.historyCalls).toBeGreaterThan(1); // it actually polled
    expect(varStore.read("o/s", "target")).toBeUndefined(); // nothing written
  });

  // §3.C #10 — secret: value masked in the returned form + NOT persisted until the confirm
  // turn, then persisted with secret=true + isSecret true.
  it("#10 secret: masked in return, not persisted until confirm, then persisted secret=true", async () => {
    const varStore = createVarStore(baseDir);
    const kitRef = "globalcaos/deploy";
    const RAW_SECRET = "sk-live-supersecret-123";
    const decls: Record<string, RecipeParamSpec> = { api_key: { type: "string", secret: true } };
    const clock = fakeClock();
    // poll 1: the secret value is given (must NOT persist yet, must be masked)
    // poll 2: still no confirm → still not persisted
    // poll 3: an explicit confirm turn arrives → now persist secret=true
    const gw = fakeGateway([
      [{ role: "user", content: RAW_SECRET }],
      [{ role: "user", content: RAW_SECRET }],
      [
        { role: "user", content: RAW_SECRET },
        { role: "user", content: "yes" },
      ],
    ]);
    const resolve = makeAskResolver({
      callGateway: gw.call,
      varStore,
      declaredParams: decls,
      pollIntervalMs: 3_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    const out = await resolve({
      sessionKey: "s",
      kitRef,
      missingVars: [{ name: "api_key", prompt: "paste the key" }],
      timeoutMs: 60_000,
    });

    // returned form is MASKED — the raw secret never leaves the resolver
    expect(out).toEqual({ api_key: SECRET_MASK });
    expect(JSON.stringify(out)).not.toContain(RAW_SECRET);
    // persisted only after the confirm turn, and flagged secret
    expect(varStore.read(kitRef, "api_key")).toBe(RAW_SECRET);
    expect(varStore.isSecret(kitRef, "api_key")).toBe(true);
  });

  it("#10b secret without a confirm turn → masked return but NEVER persisted", async () => {
    const varStore = createVarStore(baseDir);
    const kitRef = "o/s";
    const RAW_SECRET = "sk-never-saved";
    const clock = fakeClock();
    const gw = fakeGateway([
      [{ role: "user", content: RAW_SECRET }],
      [{ role: "user", content: RAW_SECRET }],
      [{ role: "user", content: RAW_SECRET }],
    ]); // value given, confirm never arrives
    const resolve = makeAskResolver({
      callGateway: gw.call,
      varStore,
      declaredParams: { api_key: { type: "string", secret: true } },
      pollIntervalMs: 3_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    const out = await resolve({
      sessionKey: "s",
      kitRef,
      missingVars: [{ name: "api_key", prompt: "?" }],
      timeoutMs: 9_000,
    });

    expect(out).toEqual({ api_key: SECRET_MASK }); // masked, since it was answered
    expect(varStore.read(kitRef, "api_key")).toBeUndefined(); // never persisted without confirm
  });

  it("any gateway error → null (never throws into the run)", async () => {
    const varStore = createVarStore(baseDir);
    const clock = fakeClock();
    const call: AskGatewayCall = async () => {
      throw new Error("gateway boom");
    };
    const resolve = makeAskResolver({
      callGateway: call,
      varStore,
      pollIntervalMs: 3_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await expect(
      resolve({
        sessionKey: "s",
        kitRef: "o/s",
        missingVars: [{ name: "x", prompt: "?" }],
        timeoutMs: 6_000,
      }),
    ).resolves.toBeNull();
  });
});
