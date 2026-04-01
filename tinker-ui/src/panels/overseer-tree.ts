// tinker-ui/src/panels/overseer-tree.ts
// FORK: Compact call tree panel for the Overseer (display name: Prefrontal).
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

export interface OverseerTreeController {
  update(data: TreeResponse): void;
  destroy(): void;
}

export function mountOverseerTree(container: HTMLElement): OverseerTreeController {
  let currentData: TreeResponse | null = null;
  let filterMode: "session" | "all" = "session";

  function render(): void {
    if (!currentData || !currentData.active || !currentData.root) {
      container.style.display = "none";
      return;
    }
    container.style.display = "block";
    container.innerHTML = "";

    const panel = el("div", "overseer-tree-panel");

    // Header
    const header = el("div", "ot-header");
    header.innerHTML = `
      <div class="ot-header-left">
        <span class="ot-dot"></span>
        <span class="ot-title">Prefrontal</span>
        <span class="ot-count">${currentData.root.children.length} agents</span>
      </div>
      <div class="ot-toggle">
        <span class="ot-toggle-btn ${filterMode === "session" ? "ot-active" : ""}" data-mode="session">Session</span>
        <span class="ot-toggle-btn ${filterMode === "all" ? "ot-active" : ""}" data-mode="all">All</span>
      </div>
    `;
    header.querySelectorAll(".ot-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        filterMode = (btn as HTMLElement).dataset.mode as "session" | "all";
        render();
      });
    });
    panel.appendChild(header);

    // Root node
    panel.appendChild(renderNode(currentData.root, false));

    // Children
    const childrenContainer = el("div", "ot-children");
    for (const child of currentData.root.children) {
      childrenContainer.appendChild(renderNode(child, true));
    }
    panel.appendChild(childrenContainer);

    container.appendChild(panel);
  }

  function renderNode(node: TreeNode, isChild: boolean): HTMLElement {
    const row = el("div", `ot-node ${isChild ? "ot-child" : "ot-root"}`);
    const color = getProviderColor(node.provider);
    const borderColor = getProviderBorderColor(node.provider);

    if (node.status === "completed") row.classList.add("ot-completed");
    if (node.status === "stalled") {
      row.style.borderColor = "#f85149";
    } else if (isChild) {
      row.style.borderColor = borderColor;
    }

    if (isChild) {
      const connector = el("div", "ot-connector");
      row.appendChild(connector);
    }

    // Completed checkmark (before logo)
    if (node.status === "completed") {
      const check = el("span", "ot-check");
      check.textContent = "\u2713";
      row.appendChild(check);
    }

    // Logo
    const logo = el("span", "ot-logo");
    logo.style.color = color;
    logo.innerHTML = getProviderLogoSvg(node.provider);
    row.appendChild(logo);

    // Model name
    const modelName = el("span", "ot-model");
    modelName.style.color = color;
    const shortModel = node.model.split("/").pop() ?? node.model;
    modelName.textContent = shortModel;
    row.appendChild(modelName);

    // Label
    const label = el("span", "ot-label");
    label.textContent = node.label;
    row.appendChild(label);

    // Spacer
    row.appendChild(el("span", "ot-spacer"));

    // Progress or stall indicator
    if (node.status === "stalled") {
      const stall = el("span", "ot-stall");
      const mins = Math.floor(node.lastEventAge / 60);
      stall.textContent = `STALLED ${mins}m`;
      row.appendChild(stall);
    } else if (isChild && node.status !== "completed" && node.status !== "failed") {
      const bar = el("div", "ot-progress-bar");
      const fill = el("div", "ot-progress-fill");
      fill.style.width = `${node.progress}%`;
      fill.style.background = color;
      bar.appendChild(fill);
      row.appendChild(bar);

      const pct = el("span", "ot-pct");
      pct.style.color = color;
      pct.textContent = `${node.progress}%`;
      row.appendChild(pct);
    } else if (!isChild) {
      const rootStatus = el("span", "ot-root-status");
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
  if (!document.getElementById("overseer-tree-styles")) {
    const style = document.createElement("style");
    style.id = "overseer-tree-styles";
    style.textContent = `
      .overseer-tree-panel { background: #0d1117; border-radius: 12px; padding: 1rem; border: 1px solid #30363d; margin-bottom: 0.75rem; }
      .ot-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem; }
      .ot-header-left { display: flex; align-items: center; gap: 0.4rem; }
      .ot-dot { width: 7px; height: 7px; background: #3fb950; border-radius: 50%; box-shadow: 0 0 6px #3fb950; display: inline-block; }
      .ot-title { color: #c9d1d9; font-size: 0.8rem; font-weight: 600; }
      .ot-count { color: #484f58; font-size: 0.7rem; }
      .ot-toggle { display: flex; gap: 0.3rem; }
      .ot-toggle-btn { color: #484f58; font-size: 0.65rem; padding: 0.1rem 0.35rem; border: 1px solid #30363d; border-radius: 3px; cursor: pointer; user-select: none; }
      .ot-toggle-btn.ot-active { color: #3fb950; border-color: #3fb950; }
      .ot-node { display: flex; align-items: center; gap: 0.4rem; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 0.35rem 0.6rem; position: relative; }
      .ot-root { border-color: #6e40c9; box-shadow: 0 0 8px rgba(163,113,247,0.1); margin-bottom: 0.35rem; }
      .ot-children { padding-left: 1rem; border-left: 1px solid #30363d; margin-left: 0.75rem; display: flex; flex-direction: column; gap: 0.3rem; }
      .ot-child { position: relative; }
      .ot-connector { position: absolute; left: -1.1rem; top: 50%; width: 1rem; height: 1px; background: #30363d; }
      .ot-completed { opacity: 0.5; }
      .ot-logo { display: flex; align-items: center; flex-shrink: 0; }
      .ot-logo svg { width: 13px; height: 13px; }
      .ot-model { font-size: 0.72rem; font-weight: 600; flex-shrink: 0; }
      .ot-label { color: #8b949e; font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
      .ot-check { color: #3fb950; font-size: 0.72rem; flex-shrink: 0; }
      .ot-spacer { flex: 1; }
      .ot-stall { color: #f85149; font-size: 0.6rem; font-weight: 600; flex-shrink: 0; }
      .ot-progress-bar { width: 40px; height: 3px; background: #21262d; border-radius: 2px; overflow: hidden; flex-shrink: 0; }
      .ot-progress-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }
      .ot-pct { font-size: 0.62rem; min-width: 24px; text-align: right; flex-shrink: 0; }
      .ot-root-status { color: #484f58; font-size: 0.65rem; flex-shrink: 0; }
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
