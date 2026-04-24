// extensions/prefrontal/prefrontal-monitor.ts
// FORK: Prefrontal monitoring loop — builds tree state from subagent registry,
// detects stalls, emits WebSocket updates to Tinker UI.

import type {
  PrefrontalTreeNode,
  PrefrontalTreeResponse,
  PrefrontalConfig,
} from "./prefrontal-types.js";
import { extractProvider, DEFAULT_PREFRONTAL_CONFIG } from "./prefrontal-types.js";

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

export interface ActiveMainSession {
  sessionKey: string;
  provider: string;
  model: string;
  phase: string;
}

export interface PrefrontalMonitor {
  buildTree(runs: SubagentRunInfo[], prefrontalSessionKey: string | null): PrefrontalTreeResponse;
  detectStalls(
    tree: PrefrontalTreeResponse,
    lastEventTimestamps: Map<string, number>,
    now: number,
  ): string[];
  updateNodeProgress(runId: string, progress: number, summary: string): void;
  getTreeState(sessionFilter?: string): PrefrontalTreeResponse;
  /** Set the active main session so we always show a root node when LLM is active. */
  setActiveMain(info: ActiveMainSession | null): void;
}

export function createPrefrontalMonitor(config: PrefrontalConfig): PrefrontalMonitor {
  let currentTree: PrefrontalTreeResponse = { active: false, root: null };
  const nodeProgress = new Map<string, { progress: number; summary: string }>();
  let activeMain: ActiveMainSession | null = null;

  function runToNode(run: SubagentRunInfo, now: number): PrefrontalTreeNode {
    const provider = extractProvider(run.model ?? "unknown/unknown");
    const age = run.startedAt ? Math.round((now - run.startedAt) / 1000) : 0;
    const stored = nodeProgress.get(run.runId);

    let status: PrefrontalTreeNode["status"] = "running";
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
    prefrontalSessionKey: string | null,
  ): PrefrontalTreeResponse {
    const now = Date.now();

    if (runs.length === 0) {
      // No subagents, but if there's an active main session, show it as a single root node
      if (activeMain) {
        const root: PrefrontalTreeNode = {
          runId: "main",
          model: activeMain.model,
          provider: activeMain.provider,
          label: "Prefrontal",
          status:
            activeMain.phase === "completed"
              ? "completed"
              : activeMain.phase === "responding"
                ? "running"
                : "planning",
          progress: 0,
          lastEventAge: 0,
          children: [],
        };
        currentTree = { active: true, root };
        return currentTree;
      }
      currentTree = { active: false, root: null };
      return currentTree;
    }

    const directChildren = runs.filter((r) => r.requesterSessionKey === prefrontalSessionKey);
    const childNodes = directChildren.map((r) => runToNode(r, now));

    childNodes.sort((a, b) => {
      if (a.status === "completed" && b.status !== "completed") {return 1;}
      if (a.status !== "completed" && b.status === "completed") {return -1;}
      return 0;
    });

    const root: PrefrontalTreeNode = {
      runId: "prefrontal",
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

  function calculateOverallProgress(nodes: PrefrontalTreeNode[]): number {
    if (nodes.length === 0) {return 0;}
    const total = nodes.reduce((sum, n) => sum + n.progress, 0);
    return Math.round(total / nodes.length);
  }

  function detectStalls(
    tree: PrefrontalTreeResponse,
    lastEventTimestamps: Map<string, number>,
    now: number,
  ): string[] {
    const stalledRunIds: string[] = [];
    if (!tree.root) {return stalledRunIds;}

    for (const child of tree.root.children) {
      if (child.status === "completed" || child.status === "failed") {continue;}

      const lastEvent = lastEventTimestamps.get(child.runId);
      if (!lastEvent) {continue;}

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

  function getTreeState(sessionFilter?: string): PrefrontalTreeResponse {
    if (sessionFilter && currentTree.root) {
      const filtered = currentTree.root.children.filter((c) => c.runId.includes(sessionFilter));
      if (filtered.length === 0 && !currentTree.active) {
        return { active: false, root: null };
      }
    }
    return currentTree;
  }

  function setActiveMain(info: ActiveMainSession | null): void {
    activeMain = info;
  }

  return { buildTree, detectStalls, updateNodeProgress, getTreeState, setActiveMain };
}
