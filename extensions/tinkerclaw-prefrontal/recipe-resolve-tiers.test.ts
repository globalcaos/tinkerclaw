import { describe, expect, it, vi } from "vitest";
import type { RecipeParamSpec } from "./recipe-author.js";
import { resolveContextMemoryTiers, type TierCallGateway } from "./recipe-resolve-tiers.js";
import type { VarSource } from "./recipe-var-store.js";

// A scripted fake gateway: answers per-method, records every call.
function fakeGateway(handlers: Record<string, (params: unknown) => unknown>): {
  call: TierCallGateway;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call: TierCallGateway = async <T>(opts: { method: string; params?: unknown }) => {
    calls.push({ method: opts.method, params: opts.params });
    const h = handlers[opts.method];
    if (!h) throw new Error(`fake gateway: unhandled method ${opts.method}`);
    return h(opts.params) as T;
  };
  return { call, calls };
}

// Helpers to build the CONTEXT extraction reply (structured-extract returns the
// {name: value} object directly) and the MEMORY search reply (engram snippets).
const contextReply = (values: Record<string, string>) => ({ values });
const memoryReply = (snippet: string) => ({ ok: true, results: [{ snippet, score: 0.9 }] });
const emptyMemory = { ok: true, results: [] as Array<{ snippet: string }> };

describe("recipe-resolve-tiers: resolveContextMemoryTiers (Seam 3 ingress)", () => {
  // §4.D #12 — SECRET-SKIP: a secret:true unresolved var is never handed to either
  // tier and stays 'unresolved'; a non-secret one resolves via CONTEXT.
  it("#12 never passes a secret var to a tier; resolves the non-secret one", async () => {
    const declaredParams: Record<string, RecipeParamSpec> = {
      api_token: { type: "string", secret: true },
      region: { type: "string" },
    };
    const resolvedParams: Record<string, string> = {};
    const provenance: Record<string, VarSource> = {
      api_token: "unresolved",
      region: "unresolved",
    };
    const { call, calls } = fakeGateway({
      "chat.history": () => ({ messages: [] }),
      // CONTEXT must only ever be asked for the NON-secret var.
      "fork.agent.structured-extract": () => contextReply({ region: "eu-west-1" }),
      "fork.memory.search": () => emptyMemory,
    });

    await resolveContextMemoryTiers({
      declaredParams,
      resolvedParams,
      provenance,
      sessionKey: "sk-1",
      fitnessSuccessRate: 0.5,
      stepCount: 1,
      callGateway: call,
    });

    expect(resolvedParams.region).toBe("eu-west-1");
    expect(provenance.region).toBe("context");
    // The secret was never resolved and never appears in any tier query/result.
    expect(resolvedParams.api_token).toBeUndefined();
    expect(provenance.api_token).toBe("unresolved");
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("api_token");
  });

  // §4.D #13 — TIER-ORDER: CONTEXT runs first, so a var resolvable by BOTH ends
  // 'context'; a var only in MEMORY ends 'memory'; a P0-resolved var is untouched.
  it("#13 prefers CONTEXT, falls back to MEMORY, never touches a P0-resolved var", async () => {
    const declaredParams: Record<string, RecipeParamSpec> = {
      both: { type: "string" }, // resolvable by context AND memory → context wins
      mem_only: { type: "string" }, // only in memory → memory
      already: { type: "string" }, // resolved by P0 → never touched
    };
    const resolvedParams: Record<string, string> = { already: "from-p0" };
    const provenance: Record<string, VarSource> = {
      both: "unresolved",
      mem_only: "unresolved",
      already: "call-site",
    };
    const { call } = fakeGateway({
      "chat.history": () => ({ messages: [] }),
      // CONTEXT resolves only `both` (not mem_only).
      "fork.agent.structured-extract": () => contextReply({ both: "ctx-value" }),
      // MEMORY would also know `both`, plus `mem_only`.
      "fork.memory.search": () => memoryReply("both: mem-value\nmem_only: recalled"),
    });

    await resolveContextMemoryTiers({
      declaredParams,
      resolvedParams,
      provenance,
      callGateway: call,
    });

    // CONTEXT ran first → `both` is the context value, stamped 'context'.
    expect(resolvedParams.both).toBe("ctx-value");
    expect(provenance.both).toBe("context");
    // Only-in-memory var resolves via the MEMORY tier.
    expect(resolvedParams.mem_only).toBe("recalled");
    expect(provenance.mem_only).toBe("memory");
    // The P0-resolved var is never overridden.
    expect(resolvedParams.already).toBe("from-p0");
    expect(provenance.already).toBe("call-site");
  });

  // §4.D best-effort: a throwing CONTEXT tier falls through to MEMORY.
  it("falls through to MEMORY when the CONTEXT tier throws", async () => {
    const declaredParams: Record<string, RecipeParamSpec> = { v: { type: "string" } };
    const resolvedParams: Record<string, string> = {};
    const provenance: Record<string, VarSource> = { v: "unresolved" };
    const { call } = fakeGateway({
      "chat.history": () => ({ messages: [] }),
      "fork.agent.structured-extract": () => {
        throw new Error("context tier down");
      },
      "fork.agent.do-task": () => {
        throw new Error("context fallback down");
      },
      "fork.memory.search": () => memoryReply("v: recovered"),
    });

    await resolveContextMemoryTiers({
      declaredParams,
      resolvedParams,
      provenance,
      callGateway: call,
    });

    expect(resolvedParams.v).toBe("recovered");
    expect(provenance.v).toBe("memory");
  });

  it("is a no-op when there are no still-unresolved non-secret candidates", async () => {
    const declaredParams: Record<string, RecipeParamSpec> = {
      a: { type: "string" },
      s: { type: "string", secret: true },
    };
    const resolvedParams: Record<string, string> = { a: "x" };
    const provenance: Record<string, VarSource> = { a: "call-site", s: "unresolved" };
    const gateway = vi.fn() as unknown as TierCallGateway;

    const out = await resolveContextMemoryTiers({
      declaredParams,
      resolvedParams,
      provenance,
      callGateway: gateway,
    });

    // a is P0-resolved, s is a secret → no candidate → no gateway traffic at all.
    expect(gateway).not.toHaveBeenCalled();
    expect(out.resolvedParams).toBe(resolvedParams);
    expect(out.provenance).toBe(provenance);
  });

  it("is a no-op when the recipe declares no params", async () => {
    const resolvedParams: Record<string, string> = {};
    const provenance: Record<string, VarSource> = {};
    const gateway = vi.fn() as unknown as TierCallGateway;
    await resolveContextMemoryTiers({
      declaredParams: undefined,
      resolvedParams,
      provenance,
      callGateway: gateway,
    });
    expect(gateway).not.toHaveBeenCalled();
  });
});
