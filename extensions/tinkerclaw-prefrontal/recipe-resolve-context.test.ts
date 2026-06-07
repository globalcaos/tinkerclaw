import { describe, expect, it } from "vitest";
import type { RecipeParamSpec } from "./recipe-author.js";
import {
  deriveContextTimeoutMs,
  buildExtractionPrompt,
  parseExtraction,
  resolveFromContext,
  type GatewayCall,
} from "./recipe-resolve-context.js";

const CONTEXT_TIMEOUT_BASE = 8_000;

// A fake gateway that records every call and answers per-method from a script.
function fakeGateway(handlers: Record<string, (params: unknown) => unknown>): {
  call: GatewayCall;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call: GatewayCall = async <T>(args: { method: string; params?: unknown }) => {
    calls.push({ method: args.method, params: args.params });
    const h = handlers[args.method];
    if (!h) throw new Error(`fake gateway: unhandled method ${args.method}`);
    return h(args.params) as T;
  };
  return { call, calls };
}

describe("recipe-resolve-context: deriveContextTimeoutMs (J16 — responds, never frozen)", () => {
  it("#1 widens with more missing vars and lower fitness, floored at base", () => {
    // more vars → more time
    expect(deriveContextTimeoutMs({ missingCount: 3 })).toBeGreaterThan(
      deriveContextTimeoutMs({ missingCount: 1 }),
    );
    // lower fitness (more uncertainty) → more time
    expect(deriveContextTimeoutMs({ missingCount: 2, fitnessSuccessRate: 0.1 })).toBeGreaterThan(
      deriveContextTimeoutMs({ missingCount: 2, fitnessSuccessRate: 0.9 }),
    );
    // never below one round-trip
    expect(
      deriveContextTimeoutMs({ missingCount: 0, fitnessSuccessRate: 1 }),
    ).toBeGreaterThanOrEqual(CONTEXT_TIMEOUT_BASE);
  });
});

describe("recipe-resolve-context: buildExtractionPrompt (pure, type-aware)", () => {
  it("#2 emits enum/number/pattern lines + intent + messages + strict-JSON instruction", () => {
    const decls: Record<string, RecipeParamSpec> = {
      port: { type: "enum", enum: ["a", "b"], description: "which port" },
      n: { type: "number", description: "a count" },
      s: { type: "string", pattern: "^x", description: "an x-string" },
    };
    const prompt = buildExtractionPrompt(decls, "deploy the thing", [
      { role: "user", content: "use port a please" },
    ]);
    expect(prompt).toContain("enum: a|b");
    expect(prompt).toContain("(number)");
    expect(prompt).toContain("pattern: ^x");
    expect(prompt).toContain("deploy the thing"); // intent
    expect(prompt).toContain("use port a please"); // recent message
    expect(prompt).toContain('{name: value | "unknown"}'); // strict-JSON instruction
  });
});

describe("recipe-resolve-context: parseExtraction (pure, validate + drop)", () => {
  it("#3 drops unknowns, foreign keys, and off-type/off-enum values", () => {
    const decls: Record<string, RecipeParamSpec> = {
      n: { type: "number" },
      port: { type: "enum", enum: ["a", "b"] },
    };
    const raw = JSON.stringify({
      n: "7", // valid number → kept
      bad: "x", // not declared → dropped
      port: "c", // not in enum → dropped
      unknown_one: "unknown", // not declared (and "unknown") → dropped
    });
    expect(parseExtraction(raw, decls)).toEqual({ n: "7" });
  });

  it('#3b accepts a pre-parsed object and drops literal "unknown" for a declared key', () => {
    const decls: Record<string, RecipeParamSpec> = { token: { type: "string" } };
    expect(parseExtraction({ token: "unknown" }, decls)).toEqual({});
    expect(parseExtraction({ token: "abc" }, decls)).toEqual({ token: "abc" });
  });

  it("#3c non-JSON / non-object raw → {}", () => {
    const decls: Record<string, RecipeParamSpec> = { token: { type: "string" } };
    expect(parseExtraction("not json {", decls)).toEqual({});
    expect(parseExtraction(JSON.stringify([1, 2, 3]), decls)).toEqual({});
  });
});

describe("recipe-resolve-context: resolveFromContext (gateway-coupled, best-effort)", () => {
  const decls: Record<string, RecipeParamSpec> = { token: { type: "string" } };

  it("#4 happy path: polls chat.history ONCE then structured-extract ONCE", async () => {
    const { call, calls } = fakeGateway({
      "chat.history": () => ({ messages: [{ role: "user", content: "the token is abc123" }] }),
      "fork.agent.structured-extract": () => ({ token: "abc123" }),
    });
    const out = await resolveFromContext({
      missingDecls: decls,
      intent: "run it",
      sessionKey: "agent:main:main",
      callGateway: call,
    });
    expect(out).toEqual({ token: "abc123" });
    expect(calls.filter((c) => c.method === "chat.history")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "fork.agent.structured-extract")).toHaveLength(1);
  });

  it("#5 best-effort: any throw → {} (never throws into the run)", async () => {
    const { call } = fakeGateway({
      "chat.history": () => {
        throw new Error("history boom");
      },
      "fork.agent.structured-extract": () => {
        throw new Error("extract boom");
      },
      "fork.agent.do-task": () => {
        throw new Error("do-task boom");
      },
    });
    await expect(resolveFromContext({ missingDecls: decls, callGateway: call })).resolves.toEqual(
      {},
    );
  });

  it("#6 uses the lightweight structured-extract, never fork.subagents.spawn", async () => {
    const { call, calls } = fakeGateway({
      "chat.history": () => ({ messages: [] }),
      "fork.agent.structured-extract": () => ({ token: "xyz" }),
    });
    await resolveFromContext({ missingDecls: decls, callGateway: call });
    expect(calls.some((c) => c.method === "fork.agent.structured-extract")).toBe(true);
    expect(calls.some((c) => c.method === "fork.subagents.spawn")).toBe(false);
  });

  it("#6b falls back to fork.agent.do-task when structured-extract is absent — still never spawns", async () => {
    const { call, calls } = fakeGateway({
      "chat.history": () => ({ messages: [] }),
      "fork.agent.do-task": () => ({ token: "from-do-task" }),
      // NOTE: no "fork.agent.structured-extract" handler → the fake throws → fallback path
    });
    const out = await resolveFromContext({ missingDecls: decls, callGateway: call });
    expect(out).toEqual({ token: "from-do-task" });
    expect(calls.some((c) => c.method === "fork.agent.do-task")).toBe(true);
    expect(calls.some((c) => c.method === "fork.subagents.spawn")).toBe(false);
  });
});
