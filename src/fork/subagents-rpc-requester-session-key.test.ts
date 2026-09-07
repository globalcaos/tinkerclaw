// FORK 2026-08-04. The boundary assertion behind "unattended spawns must never
// claim the human Main tab".
//
// The two CLI literals (`openclaw-spawn-subagent.mjs`, `openclaw-orchestrate.mjs`)
// were only the PROXIMATE default. Removing them alone changed nothing: the RPC
// then forwarded `undefined` and `subagent-spawn.ts` independently fell back to
// `alias` (= "main"), which `tinker-ui/src/app.ts` matches as the protected
// "🏠 Main" tab via `keySuffix === "main"` exactly as it matches "agent:main:main"
// via `endsWith(":main")`. Two independent defaults, one shared destination.
//
// So the default is applied at the RPC boundary, and this file is why that holds:
// a CLI literal can be reintroduced by anyone, but the boundary cannot be
// silently bypassed without turning these red.
import { describe, expect, it } from "vitest";
import { resolveRpcRequesterSessionKey } from "./subagents-rpc.js";

/** The two predicates the Tinker UI uses to identify the protected Main tab. */
function looksLikeMainTab(key: string): boolean {
  const suffix = key.split(":").pop() ?? "";
  return key.endsWith(":main") || suffix === "main" || key === "main";
}

describe("resolveRpcRequesterSessionKey — the headless sink boundary", () => {
  it("an explicit parentSessionKey wins untouched", () => {
    expect(resolveRpcRequesterSessionKey({ parentSessionKey: "agent:main:tinker:ms39dshj" })).toBe(
      "agent:main:tinker:ms39dshj",
    );
  });

  it("falls back to sessionKey when parentSessionKey is absent", () => {
    expect(resolveRpcRequesterSessionKey({ sessionKey: "agent:main:dashboard:abc" })).toBe(
      "agent:main:dashboard:abc",
    );
  });

  it("parentSessionKey takes precedence over sessionKey", () => {
    expect(
      resolveRpcRequesterSessionKey({
        parentSessionKey: "agent:main:tinker:parent",
        sessionKey: "agent:main:tinker:other",
      }),
    ).toBe("agent:main:tinker:parent");
  });

  // THE REGRESSION. This is the exact call ORCA makes: it shells the spawn CLI
  // with only --task/--label/--model/--json and never passes --parent.
  it("a spawn with NO requester key lands on the headless sink, never on Main", () => {
    const key = resolveRpcRequesterSessionKey({});
    expect(key).toBe("agent:main:orchestrator");
    expect(looksLikeMainTab(key)).toBe(false);
  });

  it("honours requesterAgentId when no session key is supplied", () => {
    expect(resolveRpcRequesterSessionKey({ requesterAgentId: "review" })).toBe(
      "agent:review:orchestrator",
    );
  });

  // Empty strings are what a shell script produces from an unset variable
  // (`--parent ""`), which is precisely the unattended case. `readStr` must not
  // let that through as a "supplied" key.
  it("treats empty/blank supplied keys as absent, not as a key", () => {
    for (const p of [
      { parentSessionKey: "" },
      { sessionKey: "" },
      { parentSessionKey: "", sessionKey: "" },
    ]) {
      const key = resolveRpcRequesterSessionKey(p);
      expect(looksLikeMainTab(key)).toBe(false);
      expect(key).toBe("agent:main:orchestrator");
    }
  });

  it("never returns a key the UI would treat as the protected Main tab", () => {
    for (const p of [{}, { requesterAgentId: "main" }, { requesterAgentId: "review" }]) {
      expect(looksLikeMainTab(resolveRpcRequesterSessionKey(p))).toBe(false);
    }
  });
});
