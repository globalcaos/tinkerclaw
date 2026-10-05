import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProductionOrchestrationRuntime,
  THALAMUS_LEAF_RESOLVER_SLOT,
  type CallGateway,
} from "../orchestration-deps.js";

// THALAMUS v4 phase E3: `model: "auto"` in an orchestrate script. With no resolver registered it must be exactly an
// omitted model; with one, the answer is still held to the claude-code billing guard.

const SLOT = Symbol.for(THALAMUS_LEAF_RESOLVER_SLOT);
const g = globalThis as Record<symbol, unknown>;
afterEach(() => {
  delete g[SLOT];
});

function gateway() {
  const spawns: Array<{ model?: string; thinking?: string; task?: string }> = [];
  const call = (async (args: { method: string; params?: Record<string, unknown> }) => {
    if (args.method === "fork.subagents.spawn") {
      spawns.push({
        model: args.params?.model as string,
        thinking: args.params?.thinking as string | undefined,
        task: args.params?.task as string,
      });
      return { ok: true, childSessionKey: "cs", runId: "r1" };
    }
    if (args.method === "agent.wait") return { status: "ok" };
    if (args.method === "chat.history") {
      return { messages: [{ role: "assistant", content: "done" }] };
    }
    return {};
  }) as unknown as CallGateway;
  return { call, spawns };
}

async function modelFor(
  opts: Record<string, unknown> | undefined,
  leafModel?: string,
): Promise<{ model?: string; thinking?: string }> {
  const { call, spawns } = gateway();
  const rt = createProductionOrchestrationRuntime({ callGateway: call, leafModel });
  await rt.agent("do the thing", opts as never);
  return spawns[0];
}

describe('model: "auto" with no resolver registered is an omitted model', () => {
  it("uses the default leaf model, whichever it is", async () => {
    expect(await modelFor({ model: "auto" })).toEqual(await modelFor(undefined));
    expect(await modelFor({ model: "auto" }, "claude-code/claude-haiku-4-5")).toEqual(
      await modelFor(undefined, "claude-code/claude-haiku-4-5"),
    );
    expect((await modelFor({ model: "auto" }, "claude-code/claude-haiku-4-5")).model).toBe(
      "claude-code/claude-haiku-4-5",
    );
  });

  it("keeps the script's own effort", async () => {
    expect((await modelFor({ model: "auto", thinking: "high" })).thinking).toBe("high");
  });

  it("leaves every other model request exactly as it was", async () => {
    expect((await modelFor({ model: "claude-code/claude-opus-5" })).model).toBe(
      "claude-code/claude-opus-5",
    );
    expect((await modelFor({ model: "xai/grok-4.7" })).model).toBe("claude-code/claude-sonnet-5-5");
    expect((await modelFor({ model: "gpt-4o" }, "claude-code/claude-haiku-4-5")).model).toBe(
      "claude-code/claude-sonnet-5-5",
    );
    expect(await modelFor(undefined)).toEqual({
      model: "claude-code/claude-sonnet-5-5",
      thinking: undefined,
      task: "do the thing",
    });
  });
});

describe('model: "auto" with a resolver registered', () => {
  const register = (r: unknown) => {
    g[SLOT] = r;
  };

  it("takes the resolver's model and effort", async () => {
    register({ resolve: () => ({ model: "claude-code/claude-opus-5", thinking: "high" }) });
    const out = await modelFor({ model: "auto" });
    expect(out.model).toBe("claude-code/claude-opus-5");
    expect(out.thinking).toBe("high");
  });

  it("lets the script's own effort win over the resolver's", async () => {
    register({ resolve: () => ({ model: "claude-code/claude-opus-5", thinking: "high" }) });
    expect((await modelFor({ model: "auto", thinking: "low" })).thinking).toBe("low");
  });

  it("hands the resolver the prompt, the label and what the script declared", async () => {
    const seen: unknown[] = [];
    register({
      resolve: (r: unknown) => {
        seen.push(r);
        return undefined;
      },
    });
    await modelFor({
      model: "auto",
      label: "reader-3",
      reads: ["a.md"],
      writes: ["out/b.md"],
      thinking: "low",
    });
    expect(seen).toEqual([
      {
        prompt: "do the thing",
        label: "reader-3",
        reads: ["a.md"],
        writes: ["out/b.md"],
        thinking: "low",
        site: "orchestrate-auto",
      },
    ]);
  });

  it("still forces a claude-code model: the billing guard has the last word", async () => {
    register({ resolve: () => ({ model: "xai/grok-4.7", thinking: "high" }) });
    expect((await modelFor({ model: "auto" })).model).toBe("claude-code/claude-sonnet-5-5");
    expect((await modelFor({ model: "auto" }, "claude-code/claude-haiku-4-5")).model).toBe(
      "claude-code/claude-sonnet-5-5",
    );
  });

  it("uses the default leaf model when it offers nothing, throws, or answers junk", async () => {
    for (const r of [
      { resolve: () => undefined },
      {
        resolve: () => {
          throw new Error("boom");
        },
      },
      { resolve: () => ({ model: "" }) },
      { resolve: () => ({ model: 42 }) },
      { resolve: () => "claude-code/claude-opus-5" },
      {},
      "not a resolver",
    ]) {
      register(r);
      expect(await modelFor({ model: "auto" }, "claude-code/claude-haiku-4-5")).toEqual(
        await modelFor(undefined, "claude-code/claude-haiku-4-5"),
      );
    }
  });

  it("is asked for a unit that says auto and for one with no model, each with its site, never for a named model", async () => {
    const sites: unknown[] = [];
    register({
      resolve: (r: { site?: unknown }) => {
        sites.push(r.site);
        return { model: "claude-code/claude-opus-5-5" };
      },
    });
    expect((await modelFor({ model: "claude-code/claude-haiku-4-5" })).model).toBe(
      "claude-code/claude-haiku-4-5",
    );
    expect(sites).toEqual([]);
    expect((await modelFor(undefined)).model).toBe("claude-code/claude-opus-5-5");
    expect((await modelFor({})).model).toBe("claude-code/claude-opus-5-5");
    await modelFor({ model: "auto" });
    expect(sites).toEqual(["orchestrate-default", "orchestrate-default", "orchestrate-auto"]);
  });

  it("leaves a unit with no model on the caller's own configured default leaf", async () => {
    let asked = 0;
    register({
      resolve: () => {
        asked += 1;
        return { model: "claude-code/claude-opus-5-5" };
      },
    });
    expect((await modelFor(undefined, "claude-code/claude-haiku-4-5")).model).toBe(
      "claude-code/claude-haiku-4-5",
    );
    expect(asked).toBe(0);
  });
});

describe("the slot key", () => {
  it("equals the registry's in core, so a resolver registered there is the one read here", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const core = readFileSync(join(here, "../../../src/infra/thalamus-call-router.ts"), "utf8");
    expect(core).toContain(`LEAF_RESOLVER_SLOT = "${THALAMUS_LEAF_RESOLVER_SLOT}"`);
  });
});
