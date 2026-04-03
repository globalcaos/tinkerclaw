// tinker-ui/src/panels/prefrontal-tree.ts
// FORK: Compact call tree panel for Prefrontal.
// Renders only when subagents are active. Each node is a single compact row.

import { getProviderColor, getProviderBorderColor, getProviderLogoSvg } from "./provider-logos.js";

export interface TreeNode {
  runId: string;
  model: string;
  provider: string;
  label: string;
  status: string;
  progress: number;
  lastEventAge: number;
  skill?: string;
  summary?: string;
  children: TreeNode[];
}

export interface TreeResponse {
  active: boolean;
  root: TreeNode | null;
}

export interface PrefrontalTreeController {
  update(data: TreeResponse): void;
  destroy(): void;
}

export function mountPrefrontalTree(container: HTMLElement): PrefrontalTreeController {
  let currentData: TreeResponse | null = null;
  let filterMode: "session" | "all" = "session";

  function render(): void {
    container.style.display = "block";
    container.innerHTML = "";

    if (!currentData || !currentData.active || !currentData.root) {
      // Show empty bubble when idle
      const panel = el("div", "pf-tree-panel");
      const empty = el("div", "pf-empty");
      empty.textContent = "No active LLM calls";
      panel.appendChild(empty);
      container.appendChild(panel);
      return;
    }

    const panel = el("div", "pf-tree-panel");

    // No inline header — title and toggle live in the rpanel-header (app.ts HTML)

    // Root node
    panel.appendChild(renderNode(currentData.root, false));

    // Children
    const childrenContainer = el("div", "pf-children");
    for (const child of currentData.root.children) {
      childrenContainer.appendChild(renderNode(child, true));
    }
    panel.appendChild(childrenContainer);

    container.appendChild(panel);
  }

  function renderNode(node: TreeNode, isChild: boolean): HTMLElement {
    const row = el("div", `pf-node ${isChild ? "pf-child" : "pf-root"}`);
    const color = getProviderColor(node.provider);
    const borderColor = getProviderBorderColor(node.provider);
    const isActive =
      node.status !== "completed" && node.status !== "failed" && node.status !== "stalled";

    if (isActive) {
      row.classList.add("pf-active");
      row.style.setProperty("--pf-glow", color + "40");
      row.style.setProperty("--pf-glow-bg", color + "20");
      row.style.setProperty("--pf-glow-bg2", color + "30");
    }

    if (node.status === "completed") row.classList.add("pf-completed");
    if (node.status === "stalled") {
      row.style.borderColor = "#f85149";
    } else if (isChild && !isActive) {
      row.style.borderColor = borderColor;
    }

    if (isChild) {
      const connector = el("div", "pf-connector");
      row.appendChild(connector);
    }

    // Completed checkmark (before logo)
    if (node.status === "completed") {
      const check = el("span", "pf-check");
      check.textContent = "\u2713";
      row.appendChild(check);
    }

    // Logo
    const logo = el("span", "pf-logo");
    logo.style.color = color;
    logo.innerHTML = getProviderLogoSvg(node.provider);
    row.appendChild(logo);

    // Model name
    const modelName = el("span", "pf-model");
    modelName.style.color = color;
    const shortModel = node.model.split("/").pop() ?? node.model;
    modelName.textContent = shortModel;
    row.appendChild(modelName);

    // Label — skip for root node (redundant with panel header)
    if (isChild) {
      const label = el("span", "pf-label");
      label.textContent = node.label;
      row.appendChild(label);
    }

    // Spacer
    row.appendChild(el("span", "pf-spacer"));

    // Progress or stall indicator
    if (node.status === "stalled") {
      const stall = el("span", "pf-stall");
      const mins = Math.floor(node.lastEventAge / 60);
      stall.textContent = `STALLED ${mins}m`;
      row.appendChild(stall);
    } else if (isChild && node.status !== "completed" && node.status !== "failed") {
      const bar = el("div", "pf-progress-bar");
      const fill = el("div", "pf-progress-fill");
      fill.style.width = `${node.progress}%`;
      fill.style.background = color;
      bar.appendChild(fill);
      row.appendChild(bar);

      const pct = el("span", "pf-pct");
      pct.style.color = color;
      pct.textContent = `${node.progress}%`;
      row.appendChild(pct);
    } else if (!isChild) {
      const rootStatus = el("span", "pf-root-status");
      rootStatus.textContent = node.status;
      row.appendChild(rootStatus);
    }

    return row;
  }

  function el(tag: string, className: string): HTMLElement {
    const e = document.createElement(tag);
    e.className = className;
    return e;
  }

  // Inject styles once
  if (!document.getElementById("prefrontal-tree-styles")) {
    const style = document.createElement("style");
    style.id = "prefrontal-tree-styles";
    style.textContent = `
      .pf-tree-panel { border-radius: 12px; padding: 0.75rem; margin-bottom: 0.75rem; }
      .pf-empty { display: flex; align-items: center; justify-content: center; padding: 0.5rem; color: #a89080; font-size: 0.75rem; font-style: italic; }
      .pf-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem; }
      .pf-header-left { display: flex; align-items: center; gap: 0.4rem; }
      .pf-dot { width: 7px; height: 7px; background: #3fb950; border-radius: 50%; box-shadow: 0 0 6px #3fb950; display: inline-block; }
      .pf-title { color: #c9d1d9; font-size: 0.8rem; font-weight: 600; }
      .pf-count { color: #484f58; font-size: 0.7rem; }
      .pf-toggle { display: flex; gap: 0.3rem; }
      .pf-toggle-btn { color: #484f58; font-size: 0.65rem; padding: 0.1rem 0.35rem; border: 1px solid #30363d; border-radius: 3px; cursor: pointer; user-select: none; }
      .pf-toggle-btn.pf-active { color: #3fb950; border-color: #3fb950; }
      @keyframes pf-shimmer {
        0%   { background-position: 150% 0, center; }
        100% { background-position: -150% 0, center; }
      }
      .pf-node { display: flex; align-items: center; gap: 0.4rem; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 0.35rem 0.6rem; position: relative; }
      .pf-node.pf-active {
        border: none;
        background-image:
          linear-gradient(90deg, transparent 0%, var(--pf-glow-bg, rgba(107,142,35,0.15)) 47%, var(--pf-glow-bg2, rgba(107,142,35,0.45)) 50%, var(--pf-glow-bg, rgba(107,142,35,0.15)) 53%, transparent 100%),
          radial-gradient(ellipse at center, var(--pf-glow, rgba(107,142,35,0.2)) 0%, transparent 70%);
        background-size: 150% 100%, 100% 100%;
        animation: pf-shimmer 1s ease-in-out infinite;
      }
      .pf-root { margin-bottom: 0.35rem; }
      .pf-root:not(.pf-active) { border-color: rgba(163,113,247,0.3); box-shadow: 0 0 8px rgba(163,113,247,0.1); }
      .pf-children { padding-left: 1rem; border-left: 1px solid rgba(255,255,255,0.1); margin-left: 0.75rem; display: flex; flex-direction: column; gap: 0.3rem; }
      .pf-child { position: relative; }
      .pf-connector { position: absolute; left: -1.1rem; top: 50%; width: 1rem; height: 1px; background: rgba(255,255,255,0.1); }
      .pf-completed { opacity: 0.5; animation: none !important; }
      .pf-logo { display: flex; align-items: center; flex-shrink: 0; }
      .pf-logo svg { width: 13px; height: 13px; }
      .pf-model { font-size: 0.72rem; font-weight: 600; flex-shrink: 0; }
      .pf-label { color: #c9b9a9; font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
      .pf-check { color: #3fb950; font-size: 0.72rem; flex-shrink: 0; }
      .pf-spacer { flex: 1; }
      .pf-stall { color: #f85149; font-size: 0.6rem; font-weight: 600; flex-shrink: 0; }
      .pf-progress-bar { width: 40px; height: 3px; background: #21262d; border-radius: 2px; overflow: hidden; flex-shrink: 0; }
      .pf-progress-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }
      .pf-pct { font-size: 0.62rem; min-width: 24px; text-align: right; flex-shrink: 0; }
      .pf-root-status { color: #a89080; font-size: 0.65rem; flex-shrink: 0; }
    `;
    document.head.appendChild(style);
  }

  return {
    update(data: TreeResponse) {
      currentData = data;
      render();
    },
    destroy() {
      container.innerHTML = "";
      container.style.display = "none";
    },
  };
}
