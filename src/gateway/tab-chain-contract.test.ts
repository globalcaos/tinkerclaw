import { describe, expect, it } from "vitest";
import { checkTabContract, isAgentTabMessage, resolveChains } from "./tab-chain-contract.js";

const state = {
  tabs: [
    { id: "t-m", sessionKey: "agent:main:tinker:aaa" },
    { id: "t-s", sessionKey: "agent:main:tinker:bbb" },
    { id: "t-x", sessionKey: "agent:main:tinker:ccc" },
  ],
  choices: {
    "loop:chains": JSON.stringify([
      {
        master: "t-m",
        slave: "t-s",
        color: 0,
        masterKey: "agent:main:tinker:old",
        slaveKey: "agent:main:tinker:bbb",
      },
    ]),
  },
};

describe("tab chain contract", () => {
  const chains = resolveChains(state);

  it("resolves a chain to the tabs' live keys, not the snapshot", () => {
    expect(chains).toHaveLength(1);
    expect(chains[0].master.sessionKey).toBe("agent:main:tinker:aaa");
  });

  it("lets the two ends of a chain talk in either direction", () => {
    expect(
      checkTabContract({ fromKey: "agent:main:tinker:bbb", toKey: "agent:main:tinker:aaa", chains })
        .ok,
    ).toBe(true);
    expect(
      checkTabContract({ fromKey: "tinker:aaa", toKey: "agent:main:tinker:bbb", chains }).ok,
    ).toBe(true);
  });

  it("lets a tab talk into itself", () => {
    expect(
      checkTabContract({ fromKey: "agent:main:tinker:ccc", toKey: "agent:main:tinker:ccc", chains })
        .ok,
    ).toBe(true);
  });

  it("refuses an unchained tab, with the fix in the reason", () => {
    const v = checkTabContract({
      fromKey: "agent:main:tinker:ccc",
      toKey: "agent:main:tinker:aaa",
      chains,
    });
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain("Set conversation slave");
  });

  it("refuses an anonymous sender", () => {
    expect(
      checkTabContract({ fromKey: undefined, toKey: "agent:main:tinker:aaa", chains }).ok,
    ).toBe(false);
  });

  it("refuses everything when the state has no chains or is corrupt", () => {
    expect(resolveChains({ choices: { "loop:chains": "not json" } })).toEqual([]);
    expect(
      checkTabContract({
        fromKey: "agent:main:tinker:bbb",
        toKey: "agent:main:tinker:aaa",
        chains: [],
      }).ok,
    ).toBe(false);
  });

  it("recognises the agent marker with and without a label", () => {
    expect(isAgentTabMessage("⟦AGENT⟧ hi")).toBe(true);
    expect(isAgentTabMessage("⟦AGENT:📚 J11⟧ hi")).toBe(true);
    expect(isAgentTabMessage("⟦OVERSEER⟧ nudge")).toBe(false);
    expect(isAgentTabMessage("plain typed prompt")).toBe(false);
  });
});
