import { describe, expect, it, vi } from "vitest";
import type { RecipeParamSpec } from "./recipe-author.js";
import {
  deriveMemoryTimeoutMs,
  parseMemoryHit,
  resolveFromMemory,
  type MemoryCallGateway,
} from "./recipe-resolve-memory.js";

describe("recipe-resolve-memory: deriveMemoryTimeoutMs (J16 — never frozen)", () => {
  // §4.B #7: the timeout RESPONDS to its inputs (guards the frozen-literal regression).
  it("widens with the missing-var count", () => {
    const one = deriveMemoryTimeoutMs({ missingCount: 1, fitnessSuccessRate: 0.5 });
    const three = deriveMemoryTimeoutMs({ missingCount: 3, fitnessSuccessRate: 0.5 });
    expect(three).toBeGreaterThan(one);
  });

  it("widens as fitness falls (a shaky recipe buys more patience)", () => {
    const reliable = deriveMemoryTimeoutMs({ missingCount: 2, fitnessSuccessRate: 0.9 });
    const shaky = deriveMemoryTimeoutMs({ missingCount: 2, fitnessSuccessRate: 0.1 });
    expect(shaky).toBeGreaterThan(reliable);
  });

  it("is floored at the base round-trip budget (>= 5000)", () => {
    expect(deriveMemoryTimeoutMs({ missingCount: 0 })).toBeGreaterThanOrEqual(5_000);
    expect(
      deriveMemoryTimeoutMs({ missingCount: 1, fitnessSuccessRate: 1 }),
    ).toBeGreaterThanOrEqual(5_000);
  });
});

describe("recipe-resolve-memory: parseMemoryHit (PURE + validate)", () => {
  // §4.B #8: snippet scrape, first-match-wins, off-type/off-enum dropped.
  it("extracts a declared var from a `name: value` snippet line", () => {
    const decls: Record<string, RecipeParamSpec> = { api_token: { type: "string" } };
    const out = parseMemoryHit("...api_token: zzz999\nother: 1...", decls);
    expect(out).toEqual({ api_token: "zzz999" });
  });

  it("matches any of the `= : >` separators, case-insensitive on the name", () => {
    const decls: Record<string, RecipeParamSpec> = {
      a: { type: "string" },
      b: { type: "string" },
      c: { type: "string" },
    };
    const out = parseMemoryHit("A = one\nB: two\nc > three", decls);
    expect(out).toEqual({ a: "one", b: "two", c: "three" });
  });

  it("takes the FIRST match per var (first-wins)", () => {
    const decls: Record<string, RecipeParamSpec> = { token: { type: "string" } };
    const out = parseMemoryHit("token: first\ntoken: second", decls);
    expect(out).toEqual({ token: "first" });
  });

  it("DROPS an off-enum recalled value (validation backstop)", () => {
    const decls: Record<string, RecipeParamSpec> = {
      port: { type: "enum", enum: ["a", "b"] },
    };
    expect(parseMemoryHit("port: c", decls)).toEqual({}); // c ∉ {a,b}
    expect(parseMemoryHit("port: a", decls)).toEqual({ port: "a" });
  });

  it("DROPS a non-numeric recall for a number decl; coerces a numeric one", () => {
    const decls: Record<string, RecipeParamSpec> = { n: { type: "number" } };
    expect(parseMemoryHit("n: not-a-number", decls)).toEqual({});
    expect(parseMemoryHit("n: 7", decls)).toEqual({ n: "7" });
  });

  it("never recalls a secret var even if present in the snippet (backstop)", () => {
    const decls: Record<string, RecipeParamSpec> = {
      cred: { type: "string", secret: true },
    };
    expect(parseMemoryHit("cred: hunter2", decls)).toEqual({});
  });
});

describe("recipe-resolve-memory: resolveFromMemory (best-effort loopback)", () => {
  const decls = (): Record<string, RecipeParamSpec> => ({ api_token: { type: "string" } });

  // §4.B #9: happy path — engram returns a snippet, query + minScore are correct.
  it("resolves a var from a fork.memory.search hit", async () => {
    const callGateway = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ snippet: "api_token: zzz999", score: 0.8 }],
    }) as unknown as MemoryCallGateway;

    const out = await resolveFromMemory({
      missingDecls: decls(),
      sessionKey: "sk-1",
      fitnessSuccessRate: 0.5,
      callGateway,
    });

    expect(out).toEqual({ api_token: "zzz999" });
    expect(callGateway).toHaveBeenCalledTimes(1);
    const call = (callGateway as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.method).toBe("fork.memory.search");
    expect(call.params.query).toBe("api_token"); // single var → no OR
    expect(call.params.minScore).toBe(0.6);
    expect(call.params.maxResults).toBe(2); // missingCount * 2
    expect(call.params.sessionKey).toBe("sk-1");
    expect(typeof call.timeoutMs).toBe("number"); // J16-derived timeout passed
  });

  it("OR-joins multiple non-secret var names in the query", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValue({ ok: true, results: [] }) as unknown as MemoryCallGateway;
    await resolveFromMemory({
      missingDecls: { a: { type: "string" }, b: { type: "string" } },
      callGateway,
    });
    const call = (callGateway as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.params.query).toBe("a OR b");
    expect(call.params.maxResults).toBe(4);
  });

  // §4.B #10: best-effort — !ok / empty / throw all yield {} (no stopper).
  it("returns {} on ok:false", async () => {
    const callGateway = vi.fn().mockResolvedValue({ ok: false }) as unknown as MemoryCallGateway;
    expect(await resolveFromMemory({ missingDecls: decls(), callGateway })).toEqual({});
  });

  it("returns {} on an empty results list", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValue({ ok: true, results: [] }) as unknown as MemoryCallGateway;
    expect(await resolveFromMemory({ missingDecls: decls(), callGateway })).toEqual({});
  });

  it("returns {} (never throws) when the gateway rejects", async () => {
    const callGateway = vi
      .fn()
      .mockRejectedValue(new Error("engram down")) as unknown as MemoryCallGateway;
    await expect(resolveFromMemory({ missingDecls: decls(), callGateway })).resolves.toEqual({});
  });

  it("never queries the gateway when every missing decl is a secret", async () => {
    const callGateway = vi.fn() as unknown as MemoryCallGateway;
    const out = await resolveFromMemory({
      missingDecls: { cred: { type: "string", secret: true } },
      callGateway,
    });
    expect(out).toEqual({});
    expect(callGateway).not.toHaveBeenCalled();
  });
});
