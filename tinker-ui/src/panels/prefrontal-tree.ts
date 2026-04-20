// tinker-ui/src/panels/prefrontal-tree.ts
// FORK: Orchestration dashboard for Prefrontal right-panel.
//
// Redesigned 2026-04-20. Three stacked blocks:
//   1. Recipe header    -- current recipe id + step M/N + step name + parallelism
//   2. Tree block       -- main run + subagent children (label, model, elapsed,
//                          status icon, progress shimmer)
//   3. Action trail     -- rolling last ~12 events (dispatch/complete/transition)
//
// Data sources (fed in from app.ts):
//   currentData    -- the tree (was only source before)
//   recipeState    -- from WS phase="prefrontal-recipe-state" events
//   trail          -- synthesized from lifecycle events + trail-event WS events
//
// All three pieces render together every time update() is called; partial
// updates are cheap because the DOM is just rebuilt (<~50 nodes total).

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

export interface RecipeState {
  recipeId: string;
  step?: number;
  totalSteps?: number;
  stepName?: string;
  parallelismCap?: number;
  inFlightLabels?: string[];
  note?: string;
  startedAt: number; // client-side, when we first saw this recipe
}

export type TrailEventKind =
  | "dispatch"
  | "complete"
  | "note"
  | "transition"
  | "warn"
  | "recipe-step"
  | "spawn-fail";

export interface TrailEvent {
  ts: number;
  kind: TrailEventKind;
  label?: string;
  message: string;
  icon?: string;
}

export interface PrefrontalDashboardState {
  tree: TreeResponse;
  recipe: RecipeState | null;
  trail: TrailEvent[];
}

export interface PrefrontalTreeController {
  update(state: PrefrontalDashboardState): void;
  destroy(): void;
}

const TRAIL_ICON_BY_KIND: Record<TrailEventKind, string> = {
  dispatch: "▶",
  complete: "✓",
  note: "•",
  transition: "↪",
  warn: "!",
  "recipe-step": "🕸",
  "spawn-fail": "✗",
};

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
function fmtDuration(seconds: number): string {
  if (seconds < 0 || !Number.isFinite(seconds)) return "-";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

export function mountPrefrontalTree(container: HTMLElement): PrefrontalTreeController {
  let currentState: PrefrontalDashboardState | null = null;

  function render(): void {
    container.style.display = "block";
    container.innerHTML = "";

    const panel = el("div", "pf-panel");

    // ─── Recipe header ──────────────────────────────────────
    panel.appendChild(renderRecipeHeader(currentState?.recipe ?? null));

    // ─── Tree block ─────────────────────────────────────────
    const tree = currentState?.tree ?? { active: false, root: null };
    if (!tree.active || !tree.root) {
      const empty = el("div", "pf-empty");
      empty.textContent = "No active LLM calls";
      panel.appendChild(empty);
    } else {
      const treeBlock = el("div", "pf-tree");
      treeBlock.appendChild(renderNode(tree.root, false));
      if (tree.root.children.length > 0) {
        const childrenEl = el("div", "pf-children");
        for (const child of tree.root.children) {
          childrenEl.appendChild(renderNode(child, true));
        }
        treeBlock.appendChild(childrenEl);
      }
      panel.appendChild(treeBlock);
    }

    // ─── Action trail ────────────────────────────────────────
    const trail = currentState?.trail ?? [];
    if (trail.length > 0) {
      panel.appendChild(renderTrail(trail));
    }

    container.appendChild(panel);
  }

  function renderRecipeHeader(recipe: RecipeState | null): HTMLElement {
    const bar = el("div", "pf-recipe-bar");

    if (!recipe) {
      const idle = el("span", "pf-recipe-idle");
      idle.textContent = "no active recipe";
      bar.appendChild(idle);
      return bar;
    }

    const icon = el("span", "pf-recipe-icon");
    icon.textContent = "🕸";
    bar.appendChild(icon);

    const id = el("span", "pf-recipe-id");
    id.textContent = recipe.recipeId;
    bar.appendChild(id);

    if (recipe.step != null) {
      const stepEl = el("span", "pf-recipe-step");
      const total = recipe.totalSteps != null ? `/${recipe.totalSteps}` : "";
      stepEl.textContent = `Step ${recipe.step}${total}`;
      bar.appendChild(stepEl);
    }

    if (recipe.stepName) {
      const nameEl = el("span", "pf-recipe-step-name");
      nameEl.textContent = recipe.stepName;
      bar.appendChild(nameEl);
    }

    // Right-aligned parallelism + elapsed
    const spacer = el("span", "pf-recipe-spacer");
    bar.appendChild(spacer);

    if (recipe.parallelismCap != null || (recipe.inFlightLabels && recipe.inFlightLabels.length > 0)) {
      const inflight = recipe.inFlightLabels?.length ?? 0;
      const cap = recipe.parallelismCap ?? "-";
      const par = el("span", "pf-recipe-parallel");
      par.textContent = `║ ${inflight}/${cap}`;
      par.title = "in-flight / concurrency cap";
      bar.appendChild(par);
    }

    const elapsed = Math.floor((Date.now() - recipe.startedAt) / 1000);
    const elEl = el("span", "pf-recipe-elapsed");
    elEl.textContent = fmtDuration(elapsed);
    bar.appendChild(elEl);

    return bar;
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
    if (node.status === "completed") {
      row.classList.add("pf-completed");
    }
    if (node.status === "failed") {
      row.classList.add("pf-failed");
    }
    if (node.status === "stalled") {
      row.style.borderColor = "#f85149";
    } else if (isChild && !isActive) {
      row.style.borderColor = borderColor;
    }

    if (isChild) {
      row.appendChild(el("div", "pf-connector"));
    }

    // Status glyph
    const glyph = el("span", "pf-glyph");
    if (node.status === "completed") glyph.textContent = "\u2713";
    else if (node.status === "failed") glyph.textContent = "\u2717";
    else if (node.status === "stalled") glyph.textContent = "!";
    else glyph.textContent = isActive ? "▶" : "·";
    glyph.style.color = node.status === "failed" ? "#f85149" : color;
    row.appendChild(glyph);

    // Logo
    const logo = el("span", "pf-logo");
    logo.style.color = color;
    logo.innerHTML = getProviderLogoSvg(node.provider);
    row.appendChild(logo);

    // Model/label
    const modelWrap = el("span", "pf-model-wrap");
    const modelName = el("span", "pf-model");
    modelName.style.color = color;
    const shortModel = (node.model ?? "").split("/").pop() ?? node.model ?? "";
    modelName.textContent = shortModel;
    modelWrap.appendChild(modelName);
    if (isChild && node.label && node.label !== shortModel) {
      const label = el("span", "pf-label");
      label.textContent = node.label;
      modelWrap.appendChild(label);
    }
    row.appendChild(modelWrap);

    // Spacer + meta on the right
    row.appendChild(el("span", "pf-spacer"));

    // Elapsed
    const age = el("span", "pf-age");
    age.textContent = fmtDuration(node.lastEventAge);
    row.appendChild(age);

    // Progress or status hint
    if (node.status === "stalled") {
      const stall = el("span", "pf-stall");
      stall.textContent = "STALLED";
      row.appendChild(stall);
    } else if (node.status === "failed") {
      const failed = el("span", "pf-failed-text");
      failed.textContent = "failed";
      row.appendChild(failed);
    } else if (isChild && node.status !== "completed") {
      const bar = el("div", "pf-progress-bar");
      const fill = el("div", "pf-progress-fill");
      fill.style.width = `${Math.max(0, Math.min(100, node.progress))}%`;
      fill.style.background = color;
      bar.appendChild(fill);
      row.appendChild(bar);
      if (node.progress > 0) {
        const pct = el("span", "pf-pct");
        pct.style.color = color;
        pct.textContent = `${Math.round(node.progress)}%`;
        row.appendChild(pct);
      }
    } else if (!isChild) {
      const statusLabel = el("span", "pf-root-status");
      statusLabel.textContent = node.status;
      row.appendChild(statusLabel);
    }

    return row;
  }

  function renderTrail(trail: TrailEvent[]): HTMLElement {
    const wrap = el("div", "pf-trail");
    const header = el("div", "pf-trail-header");
    header.textContent = `Trail · last ${trail.length}`;
    wrap.appendChild(header);
    const list = el("div", "pf-trail-list");
    // Newest first
    const ordered = [...trail].sort((a, b) => b.ts - a.ts);
    for (const evt of ordered) {
      const item = el("div", `pf-trail-item pf-trail-${evt.kind}`);

      const clock = el("span", "pf-trail-clock");
      clock.textContent = fmtClock(evt.ts);
      item.appendChild(clock);

      const iconEl = el("span", "pf-trail-icon");
      iconEl.textContent = evt.icon ?? TRAIL_ICON_BY_KIND[evt.kind] ?? "·";
      item.appendChild(iconEl);

      if (evt.label) {
        const lbl = el("span", "pf-trail-label");
        lbl.textContent = evt.label;
        item.appendChild(lbl);
      }

      const msg = el("span", "pf-trail-msg");
      msg.textContent = evt.message;
      item.appendChild(msg);

      list.appendChild(item);
    }
    wrap.appendChild(list);
    return wrap;
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
      .pf-panel { padding: 0.5rem 0.6rem; display: flex; flex-direction: column; gap: 0.55rem; }
      .pf-recipe-bar {
        display: flex; align-items: center; gap: 0.35rem;
        padding: 0.35rem 0.55rem;
        background: rgba(193, 154, 107, 0.08);
        border: 1px solid rgba(193, 154, 107, 0.25);
        border-radius: 7px;
        font-size: 0.72rem;
      }
      .pf-recipe-idle { color: #8a7d6e; font-style: italic; }
      .pf-recipe-icon { font-size: 0.85rem; }
      .pf-recipe-id { color: #c19a6b; font-weight: 700; letter-spacing: 0.02em; }
      .pf-recipe-step { color: #c9d1d9; font-weight: 600; }
      .pf-recipe-step-name { color: #a89080; font-style: italic; }
      .pf-recipe-spacer { flex: 1; }
      .pf-recipe-parallel { color: #8ab4f8; font-family: ui-monospace, "Courier New", monospace; font-size: 0.68rem; }
      .pf-recipe-elapsed { color: #6e7681; font-family: ui-monospace, "Courier New", monospace; font-size: 0.68rem; min-width: 2.5ch; text-align: right; }

      .pf-empty { display: flex; align-items: center; justify-content: center; padding: 0.75rem 0.5rem; color: #8a7d6e; font-size: 0.72rem; font-style: italic; }

      .pf-tree { display: flex; flex-direction: column; gap: 0.3rem; }
      @keyframes pf-shimmer {
        0%   { background-position: 150% 0, center; }
        100% { background-position: -150% 0, center; }
      }
      .pf-node {
        display: flex; align-items: center; gap: 0.4rem;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.09);
        border-radius: 8px;
        padding: 0.32rem 0.55rem;
        position: relative;
        font-size: 0.72rem;
      }
      .pf-node.pf-active {
        border: none;
        background-image:
          linear-gradient(90deg, transparent 0%, var(--pf-glow-bg, rgba(107,142,35,0.15)) 47%, var(--pf-glow-bg2, rgba(107,142,35,0.45)) 50%, var(--pf-glow-bg, rgba(107,142,35,0.15)) 53%, transparent 100%),
          radial-gradient(ellipse at center, var(--pf-glow, rgba(107,142,35,0.2)) 0%, transparent 70%);
        background-size: 150% 100%, 100% 100%;
        animation: pf-shimmer 1.2s ease-in-out infinite;
      }
      .pf-root:not(.pf-active) { border-color: rgba(163,113,247,0.35); box-shadow: 0 0 8px rgba(163,113,247,0.1); }
      .pf-completed { opacity: 0.55; animation: none !important; }
      .pf-failed { opacity: 0.7; border-color: rgba(248,81,73,0.5) !important; }

      .pf-children { padding-left: 0.9rem; margin-left: 0.4rem; border-left: 1px solid rgba(255,255,255,0.1); display: flex; flex-direction: column; gap: 0.28rem; }
      .pf-child { position: relative; }
      .pf-connector { position: absolute; left: -0.95rem; top: 50%; width: 0.9rem; height: 1px; background: rgba(255,255,255,0.14); }

      .pf-glyph { font-size: 0.72rem; flex-shrink: 0; width: 12px; text-align: center; }
      .pf-logo { display: flex; align-items: center; flex-shrink: 0; }
      .pf-logo svg { width: 13px; height: 13px; }

      .pf-model-wrap { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .pf-model { font-weight: 700; font-size: 0.7rem; letter-spacing: 0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pf-label { color: #c9b9a9; font-size: 0.66rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }

      .pf-spacer { flex: 1; }
      .pf-age { color: #8a7d6e; font-family: ui-monospace, "Courier New", monospace; font-size: 0.65rem; min-width: 3ch; text-align: right; }
      .pf-root-status { color: #a89080; font-size: 0.65rem; font-style: italic; }
      .pf-stall { color: #f85149; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.04em; }
      .pf-failed-text { color: #f85149; font-size: 0.65rem; font-style: italic; }

      .pf-progress-bar { width: 52px; height: 3px; background: #21262d; border-radius: 2px; overflow: hidden; flex-shrink: 0; }
      .pf-progress-fill { height: 100%; border-radius: 2px; transition: width 0.25s; }
      .pf-pct { font-size: 0.6rem; min-width: 28px; text-align: right; }

      /* ─── Trail ─── */
      .pf-trail {
        border-top: 1px dashed rgba(255,255,255,0.08);
        padding-top: 0.45rem;
        margin-top: 0.2rem;
        display: flex; flex-direction: column; gap: 0.2rem;
      }
      .pf-trail-header { color: #6e7681; font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; }
      .pf-trail-list { display: flex; flex-direction: column; gap: 0.12rem; max-height: 180px; overflow-y: auto; }
      .pf-trail-item {
        display: grid;
        grid-template-columns: 54px 16px auto 1fr;
        align-items: baseline;
        gap: 0.35rem;
        font-size: 0.68rem;
        font-family: ui-monospace, "Courier New", monospace;
        line-height: 1.3;
      }
      .pf-trail-clock { color: #484f58; white-space: nowrap; }
      .pf-trail-icon { text-align: center; }
      .pf-trail-label { color: #c19a6b; font-weight: 700; font-family: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 14ch; }
      .pf-trail-msg { color: #c9d1d9; font-family: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pf-trail-dispatch .pf-trail-icon { color: #8ab4f8; }
      .pf-trail-complete .pf-trail-icon { color: #3fb950; }
      .pf-trail-warn .pf-trail-icon { color: #f0883e; }
      .pf-trail-spawn-fail .pf-trail-icon { color: #f85149; }
      .pf-trail-transition .pf-trail-icon { color: #d2a8ff; }
      .pf-trail-recipe-step .pf-trail-icon { color: #c19a6b; }
    `;
    document.head.appendChild(style);
  }

  return {
    update(state: PrefrontalDashboardState) {
      currentState = state;
      render();
    },
    destroy() {
      container.innerHTML = "";
      container.style.display = "none";
    },
  };
}
