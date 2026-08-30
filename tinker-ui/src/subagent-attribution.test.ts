import { describe, expect, it } from "vitest";
import {
  agentRootOf,
  subagentBelongsToViewedTab,
  type SubagentAttributionDeps,
} from "./subagent-attribution.js";

const MAIN = "agent:main:main";
const TAB_A = "agent:main:tinker:aaaa";
const TAB_B = "agent:main:tinker:bbbb";
const SUB = "agent:main:subagent:11111111-2222-3333-4444-555555555555";
/** A controller lane, not a tab: what the orchestrator fan-out path resolves an owner to. */
const ORCHESTRATOR = "agent:main:orchestrator";

function deps(over: Partial<SubagentAttributionDeps> = {}): SubagentAttributionDeps {
  return {
    ownerOf: () => undefined,
    attachedTabCount: () => 1,
    keyMatches: (candidate, viewed) => candidate === viewed,
    // Default: any resolved owner IS a tab. Keeps every pre-2026-08-08 case reading exactly as
    // written; the orchestrator cases below opt out explicitly.
    isTab: () => true,
    ...over,
  };
}

describe("agentRootOf", () => {
  it("collapses every view of one agent to the same root", () => {
    expect(agentRootOf(MAIN)).toBe("agent:main");
    expect(agentRootOf(TAB_A)).toBe("agent:main");
    expect(agentRootOf(SUB)).toBe("agent:main");
  });
});

describe("subagentBelongsToViewedTab", () => {
  it("rejects non-subagent and empty keys", () => {
    expect(subagentBelongsToViewedTab(MAIN, TAB_A, deps())).toBe(false);
    expect(subagentBelongsToViewedTab(SUB, "", deps())).toBe(false);
    expect(subagentBelongsToViewedTab(undefined, TAB_A, deps())).toBe(false);
    expect(subagentBelongsToViewedTab(null, TAB_A, deps())).toBe(false);
  });

  it("rejects a subagent of a DIFFERENT agent", () => {
    const other = "agent:other:subagent:99999999-0000-0000-0000-000000000000";
    expect(subagentBelongsToViewedTab(other, TAB_A, deps())).toBe(false);
  });

  // REGRESSION (2026-07-28, the architect): typing in one tab showed Sol/Grok "thinking" because a
  // subagent dispatched from elsewhere matched on the shared agent root alone.
  it("does NOT claim another tab's subagent when ownership is known", () => {
    const d = deps({ ownerOf: () => TAB_B, attachedTabCount: () => 2 });
    expect(subagentBelongsToViewedTab(SUB, TAB_A, d)).toBe(false);
    expect(subagentBelongsToViewedTab(SUB, TAB_B, d)).toBe(true);
  });

  it("claims its own subagent even with many tabs open", () => {
    const d = deps({ ownerOf: () => TAB_A, attachedTabCount: () => 5 });
    expect(subagentBelongsToViewedTab(SUB, TAB_A, d)).toBe(true);
  });

  it("honours the UI's key-equivalence rule for the owner", () => {
    const d = deps({
      ownerOf: () => "agent:main",
      attachedTabCount: () => 3,
      keyMatches: (candidate, viewed) => viewed.startsWith(candidate),
    });
    expect(subagentBelongsToViewedTab(SUB, MAIN, d)).toBe(true);
  });

  // The asymmetry is the point: unknown ownership must not leak into a sibling tab.
  it("refuses an UNATTRIBUTED subagent while sibling tabs are attached", () => {
    const d = deps({ ownerOf: () => undefined, attachedTabCount: () => 2 });
    expect(subagentBelongsToViewedTab(SUB, TAB_A, d)).toBe(false);
  });

  it("accepts an UNATTRIBUTED subagent when this is the lone tab", () => {
    const d = deps({ ownerOf: () => undefined, attachedTabCount: () => 1 });
    expect(subagentBelongsToViewedTab(SUB, TAB_A, d)).toBe(true);
  });

  it("never throws when ownership lookup misbehaves", () => {
    const d = deps({ ownerOf: () => "", attachedTabCount: () => 1 });
    expect(subagentBelongsToViewedTab(SUB, TAB_A, d)).toBe(true);
  });

  // REGRESSION (2026-08-08, the architect: "Jarvis is doing things in parallel but the EEG does not show
  // the traces"). An orchestrator-dispatched fan-out resolves its owner to `agent:main:orchestrator`
  // — a session, but not a tab. That used to return false for EVERY tab, so four live legs were
  // invisible everywhere at once. A non-tab owner is the ABSENCE of tab evidence, not evidence of
  // a rival tab, so it must fall through to the lone-tab rule.
  it("claims an ORCHESTRATOR-owned subagent when this is the lone tab", () => {
    const d = deps({
      ownerOf: () => ORCHESTRATOR,
      attachedTabCount: () => 1,
      isTab: (sk) => sk !== ORCHESTRATOR,
    });
    expect(subagentBelongsToViewedTab(SUB, TAB_A, d)).toBe(true);
  });

  // The anti-phantom guarantee survives the fix: non-tab ownership degrades to UNKNOWN, and
  // unknown still refuses while siblings are open. It does not degrade to "claim it anyway".
  it("still refuses an ORCHESTRATOR-owned subagent while sibling tabs are attached", () => {
    const d = deps({
      ownerOf: () => ORCHESTRATOR,
      attachedTabCount: () => 2,
      isTab: (sk) => sk !== ORCHESTRATOR,
    });
    expect(subagentBelongsToViewedTab(SUB, TAB_A, d)).toBe(false);
  });

  // A real rival tab must still win outright — the non-tab escape hatch must not weaken (c).
  it("keeps rejecting a rival TAB's subagent even when this is the lone attached tab", () => {
    const d = deps({
      ownerOf: () => TAB_B,
      attachedTabCount: () => 1,
      isTab: (sk) => sk !== ORCHESTRATOR,
    });
    expect(subagentBelongsToViewedTab(SUB, TAB_A, d)).toBe(false);
  });
});
