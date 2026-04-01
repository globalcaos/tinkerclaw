// extensions/overseer/overseer-monitor.ts
// FORK: Overseer monitoring loop — builds tree state from subagent registry,
// detects stalls, emits WebSocket updates to Tinker UI.

import type { OverseerTreeNode, OverseerTreeResponse, OverseerConfig } from "./overseer-types.js";
import { extractProvider, DEFAULT_OVERSEER_CONFIG } from "./overseer-types.js";

export interface SubagentRunInfo {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  task: string;
  label?: string;
  model?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: { status: string; error?: string };
}

export interface OverseerMonitor {
  buildTree(runs: SubagentRunInfo[], overseerSessionKey: string | null): OverseerTreeResponse;
  detectStalls(
    tree: OverseerTreeResponse,
    lastEventTimestamps: Map<string, number>,
    now: number,
  ): string[];
  updateNodeProgress(runId: string, progress: number, summary: string): void;
  getTreeState(sessionFilter?: string): OverseerTreeResponse;
}

export function createOverseerMonitor(config: OverseerConfig): OverseerMonitor {
  let currentTree: OverseerTreeResponse = { active: false, root: null };
  const nodeProgress = new Map<string, { progress: number; summary: string }>();

  function runToNode(run: SubagentRunInfo, now: number): OverseerTreeNode {
    const provider = extractProvider(run.model ?? "unknown/unknown");
    const age = run.startedAt ? Math.round((now - run.startedAt) / 1000) : 0;
    const stored = nodeProgress.get(run.runId);

    let status: OverseerTreeNode["status"] = "running";
    if (run.endedAt) {
      status = run.outcome?.status === "ok" ? "completed" : "failed";
    }

    return {
      runId: run.runId,
      model: run.model ?? "unknown",
      provider,
      label: run.label ?? run.task.slice(0, 60),
      status,
      progress: stored?.progress ?? 0,
      lastEventAge: age,
      summary: stored?.summary,
      children: [],
    };
  }

  function buildTree(
    runs: SubagentRunInfo[],
    overseerSessionKey: string | null,
  ): OverseerTreeResponse {
    const now = Date.now();

    if (!overseerSessionKey || runs.length === 0) {
      currentTree = { active: false, root: null };
      return currentTree;
    }

    const directChildren = runs.filter((r) => r.requesterSessionKey === overseerSessionKey);
    const childNodes = directChildren.map((r) => runToNode(r, now));

    childNodes.sort((a, b) => {
      if (a.status === "completed" && b.status !== "completed") return 1;
      if (a.status !== "completed" && b.status === "completed") return -1;
      return 0;
    });

    const root: OverseerTreeNode = {
      runId: "overseer",
      model: config.model,
      provider: extractProvider(config.model),
      label: "Prefrontal",
      status: childNodes.length > 0 ? "monitoring" : "planning",
      progress: calculateOverallProgress(childNodes),
      lastEventAge: 0,
      children: childNodes,
    };

    currentTree = { active: true, root };
    return currentTree;
  }

  function calculateOverallProgress(nodes: OverseerTreeNode[]): number {
    if (nodes.length === 0) return 0;
    const total = nodes.reduce((sum, n) => sum + n.progress, 0);
    return Math.round(total / nodes.length);
  }

  function detectStalls(
    tree: OverseerTreeResponse,
    lastEventTimestamps: Map<string, number>,
    now: number,
  ): string[] {
    const stalledRunIds: string[] = [];
    if (!tree.root) return stalledRunIds;

    for (const child of tree.root.children) {
      if (child.status === "completed" || child.status === "failed") continue;

      const lastEvent = lastEventTimestamps.get(child.runId);
      if (!lastEvent) continue;

      const age = now - lastEvent;
      if (age > config.staleThresholdMs) {
        child.status = "stalled";
        child.lastEventAge = Math.round(age / 1000);
        stalledRunIds.push(child.runId);
      }
    }

    return stalledRunIds;
  }

  function updateNodeProgress(runId: string, progress: number, summary: string): void {
    nodeProgress.set(runId, { progress, summary });

    if (currentTree.root) {
      const node = currentTree.root.children.find((c) => c.runId === runId);
      if (node) {
        node.progress = progress;
        node.summary = summary;
      }
    }
  }

  function getTreeState(sessionFilter?: string): OverseerTreeResponse {
    if (sessionFilter && currentTree.root) {
      const filtered = currentTree.root.children.filter((c) => c.runId.includes(sessionFilter));
      if (filtered.length === 0 && !currentTree.active) {
        return { active: false, root: null };
      }
    }
    return currentTree;
  }

  return { buildTree, detectStalls, updateNodeProgress, getTreeState };
}
