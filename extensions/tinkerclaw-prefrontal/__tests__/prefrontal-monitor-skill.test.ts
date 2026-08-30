/**
 * BROCA visibility (2026-06-06): a run's skill flows onto the tree node.
 * Target: prefrontal-monitor.ts (SubagentRunInfo.skill → runToNode → PrefrontalTreeNode.skill).
 * Bible anchor: handoff 2026-06-06-broca-visibility-server-handoff.md.
 * Bug-history: the UI colors skill-backed tree nodes — node.skill must carry the run's skill.
 * Catches: runToNode dropping skill; a non-skill run getting a spurious skill.
 */
import { describe, it, expect } from "vitest";
import { createPrefrontalMonitor, type SubagentRunInfo } from "../prefrontal-monitor.js";

const monitor = createPrefrontalMonitor({ model: "claude-code/claude-opus-5" } as never);

function run(over: Partial<SubagentRunInfo>): SubagentRunInfo {
  return {
    runId: "r",
    childSessionKey: "c",
    requesterSessionKey: "pf",
    task: "do it",
    createdAt: 0,
    startedAt: 0,
    ...over,
  };
}

describe("BROCA TreeNode.skill passthrough", () => {
  it("buildTree carries a run's skill onto the tree node", () => {
    const tree = monitor.buildTree(
      [run({ runId: "r1", label: "globalcaos/host:step-0", skill: "echo" })],
      "pf",
    );
    const node = tree.root?.children.find((c) => c.runId === "r1");
    expect(node).toBeDefined();
    expect(node?.skill).toBe("echo");
  });

  it("back-compat: a run without skill yields a node with skill undefined", () => {
    const tree = monitor.buildTree([run({ runId: "r2", label: "plain" })], "pf");
    const node = tree.root?.children.find((c) => c.runId === "r2");
    expect(node).toBeDefined();
    expect(node?.skill).toBeUndefined();
  });
});
