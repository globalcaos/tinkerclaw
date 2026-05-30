// tinker-ui/src/panels/prefrontal-tree.ts
// FORK: Orchestration dashboard for Prefrontal right-panel.
//
// Redesigned 2026-04-20. Four stacked blocks:
//   0. Current Plan    -- FORK 2026-05-13 — plan-board section (Phase 2)
//   1. Recipe header   -- current recipe id + step M/N + step name + parallelism
//   2. Tree block      -- main run + subagent children (label, model, elapsed,
//                         status icon, progress shimmer)
//   3. Action trail    -- rolling last ~12 events (dispatch/complete/transition)
//
// Data sources (fed in from app.ts):
//   currentData    -- the tree (was only source before)
//   recipeState    -- from WS phase="prefrontal-recipe-state" events
//   trail          -- synthesized from lifecycle events + trail-event WS events
//   plan           -- from WS phase="prefrontal-plan-state" events (Phase 2)
//
// All blocks render together every time update() is called; partial
// updates are cheap because the DOM is just rebuilt (<~50 nodes total).

import { getProviderColor, getProviderBorderColor, getProviderLogoSvg } from "./provider-logos.js";

// FORK 2026-05-13 — Current Plan types (Phase 2 plan-board).
export type PlanStepStatus = "pending" | "in_progress" | "done" | "error";

export interface PanelPlanStep {
  title: string;
  status: PlanStepStatus;
  note?: string;
  artifact?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PanelPlan {
  sessionKey: string;
  runId: string;
  intent: string;
  recipe?: string;
  kitRef?: string;
  started: string;
  updated: string;
  status: "in_progress" | "done" | "aborted";
  currentStep: number;
  steps: PanelPlanStep[];
}

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
  // FORK 2026-05-29: per-subagent vitals joined from the topology graph.
  tokens?: number;
  toolCalls?: number;
  phase?: string;
  currentToolArg?: string;
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
  | "spawn-fail"
  // FORK 2026-05-29: recipe-lifecycle provenance — searched/matched/merged the
  // catalog, composed from sub-recipes, or authored a new one on the fly.
  | "searched"
  | "matched"
  | "merged"
  | "composed"
  | "authored";

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
  plan: PanelPlan | null; // FORK 2026-05-13 — current plan (null when none active)
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
  searched: "🔎",
  matched: "🎯",
  merged: "🧩",
  composed: "🪢",
  authored: "✦",
};

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
function fmtDuration(seconds: number): string {
  if (seconds < 0 || !Number.isFinite(seconds)) {
    return "-";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

// FORK 2026-05-29: per-subagent vitals — phase + current tool(arg) + tool count
// + token spend, joined from the topology graph onto each tree node. Renders a
// compact sub-line under the subagent row so "how is each subagent going" is
// visible without expanding the chat tool rows.
function renderVitals(node: TreeNode): HTMLElement | null {
  const bits: string[] = [];
  const phase = (node.phase ?? "").trim();
  if (phase) {
    const toolMatch = /^tool:\s*(.+)$/i.exec(phase);
    if (toolMatch) {
      bits.push(`🔧 ${toolMatch[1]}${node.currentToolArg ? `(${node.currentToolArg})` : ""}`);
    } else {
      bits.push(phase);
    }
  }
  if (typeof node.toolCalls === "number" && node.toolCalls > 0)
    bits.push(`${node.toolCalls} tools`);
  if (typeof node.tokens === "number" && node.tokens > 0)
    bits.push(`${fmtTokens(node.tokens)} tok`);
  if (bits.length === 0) return null;
  const v = el("div", "pf-vitals");
  v.textContent = bits.join(" · ");
  return v;
}

// FORK 2026-05-30: recipe DECISION TRAIL — the compact-by-default, expand-on-click
// log of what Jarvis decided about recipes (searched/matched/merged/composed/
// authored + stage transitions). Collapsed it's a single line ("N decisions ·
// <latest>"); clicking uncovers the full trail underneath — mirroring the main
// chat's compaction banner so the panel stays terse but the reasoning is one
// click away. Open state is persisted by the caller (expanded Set) so it
// survives the panel's frequent re-renders.
const DECISION_KINDS = new Set<TrailEventKind>([
  "searched",
  "matched",
  "merged",
  "composed",
  "authored",
  "transition",
  "recipe-step",
]);
function renderDecisionTrail(
  trail: TrailEvent[],
  isOpen: boolean,
  onToggle: () => void,
): HTMLElement | null {
  const now = Date.now();
  const recent = trail.filter((t) => DECISION_KINDS.has(t.kind) && now - t.ts < 300_000);
  if (recent.length === 0) return null;
  const wrap = el("div", `pf-decisions${isOpen ? " is-open" : ""}`);

  const summary = el("div", "pf-decisions-summary");
  const chev = el("span", "pf-decisions-chev");
  chev.textContent = isOpen ? "▾" : "▸";
  const count = el("span", "pf-decisions-count");
  count.textContent = `${recent.length} decision${recent.length > 1 ? "s" : ""}`;
  const latest = recent[recent.length - 1];
  const head = el("span", "pf-decisions-latest");
  head.textContent = `${TRAIL_ICON_BY_KIND[latest.kind] ?? "•"} ${latest.label ? latest.label + " · " : ""}${latest.message}`;
  summary.appendChild(chev);
  summary.appendChild(count);
  summary.appendChild(head);
  summary.addEventListener("click", onToggle);
  wrap.appendChild(summary);

  if (isOpen) {
    const body = el("div", "pf-decisions-body");
    for (const t of recent) {
      const row = el("div", "pf-decision-row");
      const clk = el("span", "pf-decision-clock");
      clk.textContent = fmtClock(t.ts);
      const ic = el("span", "pf-decision-icon");
      ic.textContent = TRAIL_ICON_BY_KIND[t.kind] ?? "•";
      const msg = el("span", "pf-decision-msg");
      msg.textContent = `${t.label ? t.label + " · " : ""}${t.message}`;
      row.appendChild(clk);
      row.appendChild(ic);
      row.appendChild(msg);
      body.appendChild(row);
    }
    wrap.appendChild(body);
  }
  return wrap;
}

// FORK 2026-05-14: map the raw root.status string from the prefrontal tree
// into a human-readable activity label for the implicit 2-step plan panel.
// The raw status is one of:
//   "thinking" | "reflecting" | "responding" | "tool: <Name>" | "final" | "completed"
// Generic "Doing" was boring after a few seconds — the user reads this panel
// to know what the agent is *actually* doing right now without expanding the
// chat tool rows. See panels.md (implicit 2-step plan must be content-rich).
const TOOL_LABELS: Record<string, string> = {
  Bash: "🔧 Running shell",
  Read: "📖 Reading files",
  Edit: "✏ Editing files",
  Write: "📝 Writing files",
  Grep: "🔍 Searching code",
  Glob: "🔍 Searching files",
  WebFetch: "🌐 Fetching web page",
  WebSearch: "🔎 Searching the web",
  Skill: "🧰 Invoking a skill",
  ToolSearch: "🧭 Looking up a tool",
};
function humanizeRootStatus(status: string | undefined | null): string {
  const s = (status ?? "").trim();
  if (!s) return "Acting";
  const low = s.toLowerCase();
  if (low === "thinking") return "🧠 Thinking";
  if (low === "reflecting") return "🌿 Reflecting";
  if (low === "responding") return "💬 Writing reply";
  if (low === "final" || low === "completed") return "Done";
  if (low.startsWith("tool:")) {
    const name = s.slice(s.indexOf(":") + 1).trim();
    return TOOL_LABELS[name] ?? `🔧 ${name}`;
  }
  // Unknown status — surface it raw so we can see what to map next.
  return s;
}

// FORK 2026-04-20: expanded-state persistence so expanding a subagent or
// a trail group survives across rerenders (the whole panel DOM rebuilds on
// every event).
const EXPAND_STORAGE_KEY = "tinker-pf-expanded";
function loadExpandedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPAND_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}
function saveExpandedSet(set: Set<string>): void {
  try {
    localStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {}
}

export function mountPrefrontalTree(container: HTMLElement): PrefrontalTreeController {
  let currentState: PrefrontalDashboardState | null = null;
  const expanded = loadExpandedSet();
  function toggleExpanded(id: string): void {
    if (expanded.has(id)) {
      expanded.delete(id);
    } else {
      expanded.add(id);
    }
    saveExpandedSet(expanded);
    render();
  }

  // FORK 2026-05-13 — elapsed time between two ISO-8601 strings.
  function elapsedIso(a: string, b: string): string {
    const ms = new Date(b).getTime() - new Date(a).getTime();
    return fmtDuration(Math.max(0, Math.round(ms / 1000)));
  }

  // FORK 2026-05-14 — Current Plan section (panels.md "always active" contract).
  // Returns an HTMLElement always — never null.
  // Priority: (1) explicit plan in_progress, (2) synthetic 2-step from live tree,
  // (3) idle line. No blank state ever.
  function renderPlanSection(plan: PanelPlan | null, tree: TreeResponse): HTMLElement {
    const now = new Date().toISOString();

    // ── Priority 1: explicit plan ────────────────────────────────────────────
    if (plan && plan.status === "in_progress") {
      const section = el("div", "pf-plan");

      // Header: "▼ Current Plan — «intent»" with total elapsed on the right.
      const header = el("div", "pf-plan-header");
      const totalEl = el("span", "pf-plan-total");
      totalEl.textContent = elapsedIso(plan.started, now);
      header.appendChild(totalEl);
      const headerText = document.createTextNode(`▼ Current Plan — "${plan.intent}"`);
      header.insertBefore(headerText, totalEl);
      section.appendChild(header);

      // Kit row (optional).
      if (plan.kitRef) {
        const kitRow = el("div", "pf-plan-kit");
        kitRow.textContent = `kit: ${plan.kitRef}`;
        section.appendChild(kitRow);
      }

      // Step rows.
      plan.steps.forEach((s, i) => {
        const stepEl = el("div", `pf-step pf-step-${s.status}`);

        const marker =
          s.status === "done"
            ? "✓"
            : s.status === "in_progress"
              ? "▶"
              : s.status === "error"
                ? "✗"
                : "○";

        // Time: completed steps show duration; in-progress shows running time.
        if (s.completedAt && s.startedAt) {
          const timeEl = el("span", "pf-step-time");
          timeEl.textContent = elapsedIso(s.startedAt, s.completedAt);
          stepEl.appendChild(timeEl);
        } else if (s.startedAt && s.status === "in_progress") {
          const timeEl = el("span", "pf-step-time");
          timeEl.textContent = elapsedIso(s.startedAt, now);
          stepEl.appendChild(timeEl);
        }

        const titleEl = document.createTextNode(`${marker} `);
        stepEl.insertBefore(titleEl, stepEl.firstChild);
        const bold = document.createElement("strong");
        bold.textContent = `${i}. ${s.title}`;
        stepEl.insertBefore(bold, stepEl.firstChild?.nextSibling ?? null);

        if (s.note) {
          const note = s.note.length > 80 ? `${s.note.slice(0, 79)}…` : s.note;
          const noteEl = el("span", "pf-step-note");
          noteEl.textContent = ` · ${note}`;
          // Insert note before the time element (which is already appended).
          const timeEl = stepEl.querySelector(".pf-step-time");
          if (timeEl) {
            stepEl.insertBefore(noteEl, timeEl);
          } else {
            stepEl.appendChild(noteEl);
          }
        }

        section.appendChild(stepEl);
      });

      return section;
    }

    // ── Priority 2: synthetic 2-step plan from live tree ─────────────────────
    // FORK 2026-05-14: replaced the abstract "Thinking" / "Doing" labels with
    // content-rich activity strings derived from root.status. Generic words
    // get boring after some time — see panels.md (implicit 2-step plan must
    // be content-rich, not placeholder text). Three pieces of info per the
    // UX contract: WHO (model in header), HOW MANY (subagent badge when
    // children.length > 0), WHAT (humanizeRootStatus on the active step).
    if (tree.active && tree.root) {
      const root = tree.root;
      const section = el("div", "pf-plan pf-plan-synthetic");

      // Header: "▼ Current Plan — «model»" plus optional parallel badge.
      const header = el("div", "pf-plan-header");
      const ageEl = el("span", "pf-plan-total");
      ageEl.textContent = fmtDuration(Math.max(0, root.lastEventAge));
      header.appendChild(ageEl);
      const childCount = root.children?.length ?? 0;
      const parallelTag =
        childCount > 0 ? ` • ${childCount} worker${childCount === 1 ? "" : "s"}` : "";
      const modelLabel = root.model ?? "model";
      const headerText = document.createTextNode(`▼ Current Plan — ${modelLabel}${parallelTag}`);
      header.insertBefore(headerText, ageEl);
      section.appendChild(header);

      // Determine phase from root status string.
      // "thinking" / "reflecting" → thinking step in_progress, doing step pending.
      // Any tool call or text delta ("tool: *", "responding", "final", "completed") → thinking done, doing in_progress or done.
      const statusLow = (root.status ?? "").toLowerCase();
      const isFinal =
        root.status === "completed" || root.status === "final" || statusLow.includes("final");
      const isDoingPhase =
        isFinal ||
        statusLow.startsWith("tool:") ||
        statusLow === "responding" ||
        statusLow === "reflecting";

      const thinkingStatus = isDoingPhase ? "done" : "in_progress";
      const doingStatus = isFinal ? "done" : isDoingPhase ? "in_progress" : "pending";

      const thinkingMarker = thinkingStatus === "done" ? "✓" : "▶";
      const doingMarker = doingStatus === "done" ? "✓" : doingStatus === "in_progress" ? "▶" : "○";

      // First step: "Thinking" while we're pre-tool, then collapsed to ✓ once
      // a tool or text delta fires. The label stays "Thinking" because it's
      // intrinsically about *establishing context*; the content-rich half is
      // the second step below.
      const thinkingEl = el("div", `pf-step pf-step-${thinkingStatus}`);
      thinkingEl.appendChild(document.createTextNode(`${thinkingMarker} Thinking`));
      section.appendChild(thinkingEl);

      // Second step: the WHAT. Label is derived from root.status via
      // humanizeRootStatus — e.g. "🔧 Running Bash" when claude-cli is mid
      // tool call, "💬 Writing reply" when streaming text, "🌿 Reflecting"
      // for the Fractal section. When pending (still in Thinking), show a
      // neutral "Acting — waiting on context" rather than "Doing".
      const doingEl = el("div", `pf-step pf-step-${doingStatus}`);
      const doingLabel =
        doingStatus === "pending"
          ? "Acting — waiting on context"
          : isFinal
            ? "Done"
            : humanizeRootStatus(root.status);
      doingEl.appendChild(document.createTextNode(`${doingMarker} ${doingLabel}`));
      section.appendChild(doingEl);

      return section;
    }

    // ── Priority 3: idle ─────────────────────────────────────────────────────
    const idleLine = el("div", "pf-plan-idle");
    idleLine.textContent = "○ Idle — waiting for the next turn";
    return idleLine;
  }

  function render(): void {
    container.style.display = "block";
    container.innerHTML = "";

    // Single card that groups all three blocks visually. Darker wood
    // background so cream/gold text reads cleanly against the rpanel's
    // lighter base wood texture.
    const card = el("div", "pf-card");

    // FORK 2026-04-27: removed the inner "Orchestration" title bar (icon +
    // text + idle badge). The outer rpanel already announces "Prefrontal"
    // via its own header — the redundant inline title and the "idle" badge
    // when nothing was running were both noise. If no LLM call is visible,
    // the panel is idle by definition; the user doesn't need a label
    // saying so. Recipe state, the active-count badge, and "no active
    // recipe" inline have all been removed too — when a recipe IS active
    // its full progress shows below via renderRecipeHeader, and when the
    // tree is empty the existing "No active LLM calls" empty state below
    // is the only signal needed.
    const tree = currentState?.tree ?? { active: false, root: null };
    const recipe = currentState?.recipe ?? null;
    const trail = currentState?.trail ?? [];
    const plan = currentState?.plan ?? null;

    // FORK 2026-05-23: when the tree has no active LLM calls, the job is
    // done and the panel should return to its default ("blank") state.
    // The plan section stays because it's the persistent task tracker.
    // Recipe header + action trail are in-flight indicators — they
    // accumulate during a job and were sticking around after completion,
    // making the panel verbose-looking when nothing was actually running.
    // The recipe/trail state stays in memory (so a quickly-fired follow-up
    // job picks up where it left off), but is not rendered while idle.
    const treeIdle = !tree.active || !tree.root;

    // ─── Recipe decision trail (FORK 2026-05-30) ──────────────────────────
    // Compact by default ("N decisions · <latest>"); click to uncover the full
    // trail of recipe decisions underneath. Open state persists in `expanded`.
    const prov = renderDecisionTrail(trail, expanded.has("decisions"), () =>
      toggleExpanded("decisions"),
    );
    if (prov) card.appendChild(prov);

    // ─── Current Plan (FORK 2026-05-14 — always renders per panels.md) ──────
    card.appendChild(renderPlanSection(plan, tree));

    // ─── Recipe header (only when a recipe is active AND tree is busy) ──────
    if (recipe && !treeIdle) {
      card.appendChild(renderRecipeHeader(recipe));
    }

    // ─── Tree block (recursive) ─────────────────────────────
    if (treeIdle) {
      const empty = el("div", "pf-empty");
      empty.textContent = "No active LLM calls";
      card.appendChild(empty);
    } else {
      const treeBlock = el("div", "pf-tree");
      treeBlock.appendChild(renderNodeRecursive(tree.root, 0, trail));
      card.appendChild(treeBlock);
    }

    // ─── Action trail ────────────────────────────────────────
    // Show ALL trail entries that don't belong to a subagent's own trail
    // (those are inlined under the subagent row). Anything with no child
    // node match lives here at the root. Suppressed entirely when the
    // tree is idle (per the FORK 2026-05-23 idle-blank rule above).
    if (!treeIdle) {
      const rootOwnedTrail = filterRootTrail(trail, tree);
      if (rootOwnedTrail.length > 0) {
        card.appendChild(renderTrail(rootOwnedTrail, "root"));
      }
    }

    container.appendChild(card);
  }

  /**
   * Render a TreeNode and its children recursively. Depth drives indent.
   * For non-root nodes the row is clickable to expand the subagent's own
   * trail slice (filterNodeTrail below).
   */
  function renderNodeRecursive(node: TreeNode, depth: number, trail: TrailEvent[]): HTMLElement {
    const wrap = el("div", `pf-branch pf-branch-depth-${Math.min(depth, 5)}`);
    const isRoot = depth === 0;
    const row = renderNode(node, !isRoot);

    // Make subagent rows clickable to expand their own trail slice.
    const expandKey = `node:${node.runId}`;
    const nodeTrail = isRoot ? [] : filterNodeTrail(trail, node);
    const hasOwnTrail = nodeTrail.length > 0;
    const isExpanded = expanded.has(expandKey);
    if (!isRoot && hasOwnTrail) {
      row.classList.add("pf-clickable");
      const caret = el("span", "pf-caret");
      caret.textContent = isExpanded ? "▾" : "▸";
      caret.title = "Toggle this subagent's trail";
      row.insertBefore(caret, row.firstChild);
      row.addEventListener("click", () => toggleExpanded(expandKey));
    }
    wrap.appendChild(row);

    // FORK 2026-05-29: per-subagent vitals sub-line (how this subagent is going).
    if (!isRoot) {
      const vitals = renderVitals(node);
      if (vitals) wrap.appendChild(vitals);
    }

    // Render this node's own trail (expanded) and its children (always).
    const needsChildrenContainer =
      (!isRoot && isExpanded && hasOwnTrail) || node.children.length > 0;
    if (needsChildrenContainer) {
      const childrenEl = el("div", "pf-children");
      if (!isRoot && isExpanded && hasOwnTrail) {
        childrenEl.appendChild(renderTrail(nodeTrail, `node-${node.runId}`, /*inline*/ true));
      }
      for (const child of node.children) {
        childrenEl.appendChild(renderNodeRecursive(child, depth + 1, trail));
      }
      wrap.appendChild(childrenEl);
    }
    return wrap;
  }

  // Filter: trail events that "belong" to this subagent node. A node claims
  // a trail event when the event's label matches the node's label (case-
  // insensitive) OR contains the node's short runId tail.
  function filterNodeTrail(trail: TrailEvent[], node: TreeNode): TrailEvent[] {
    const labelLower = (node.label ?? "").toLowerCase().trim();
    const idTail = (node.runId ?? "").slice(0, 8);
    return trail.filter((evt) => {
      const evtLabel = (evt.label ?? "").toLowerCase().trim();
      if (!evtLabel) {
        return false;
      }
      if (labelLower && evtLabel === labelLower) {
        return true;
      }
      if (idTail && evtLabel.includes(idTail)) {
        return true;
      }
      return false;
    });
  }

  // Anything not owned by ANY subagent node lives at the root trail.
  function filterRootTrail(trail: TrailEvent[], tree: TreeResponse): TrailEvent[] {
    if (!tree.root) {
      return trail;
    }
    const allSubagentNodes: TreeNode[] = [];
    (function walk(n: TreeNode) {
      for (const c of n.children) {
        allSubagentNodes.push(c);
        walk(c);
      }
    })(tree.root);
    return trail.filter((evt) => {
      for (const sub of allSubagentNodes) {
        if (filterNodeTrail([evt], sub).length > 0) {
          return false;
        }
      }
      return true;
    });
  }

  // FORK 2026-05-14: caller now gates recipe rendering — only called when recipe
  // is non-null. The "no active recipe" idle text has been removed per panels.md.
  function renderRecipeHeader(recipe: RecipeState): HTMLElement {
    const bar = el("div", "pf-recipe-bar");

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

    if (
      recipe.parallelismCap != null ||
      (recipe.inFlightLabels && recipe.inFlightLabels.length > 0)
    ) {
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
    if (node.status === "completed") {
      glyph.textContent = "\u2713";
    } else if (node.status === "failed") {
      glyph.textContent = "\u2717";
    } else if (node.status === "stalled") {
      glyph.textContent = "!";
    } else {
      // FORK 2026-05-30: a filled dot, not a "▶" triangle — the triangle read
      // as a fake expand-arrow (only the pf-caret should look expandable).
      glyph.textContent = isActive ? "●" : "·";
    }
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

  /**
   * Render a trail block. If `groupId` is provided, group entries by their
   * `label` so all events for the same tool/label fold into one expandable
   * branch. The default view shows the most recent 12 entries expanded and
   * collapses the rest (newest-first), with a scrolling container.
   * When `inline=true`, the block is rendered as a nested child of a
   * subagent row (no outer header, smaller visual weight).
   */
  function renderTrail(trail: TrailEvent[], groupId: string, inline = false): HTMLElement {
    const wrap = el("div", `pf-trail${inline ? " pf-trail-inline" : ""}`);
    if (!inline) {
      const header = el("div", "pf-trail-header");
      header.textContent = `Trail · ${trail.length} events`;
      wrap.appendChild(header);
    }
    const list = el("div", "pf-trail-list");

    // Group entries by label. Entries without a label stay ungrouped.
    // "Groups" of size 1 render as a plain trail item (not a branch).
    const groups = new Map<string, TrailEvent[]>();
    const ungrouped: TrailEvent[] = [];
    for (const evt of trail) {
      if (evt.label && evt.label.trim()) {
        const key = evt.label.trim();
        const arr = groups.get(key) ?? [];
        arr.push(evt);
        groups.set(key, arr);
      } else {
        ungrouped.push(evt);
      }
    }

    // Render groups + ungrouped together, newest-first by the group's
    // latest event timestamp.
    type GroupOrEvt =
      | { ts: number; kind: "group"; label: string; evts: TrailEvent[] }
      | { ts: number; kind: "evt"; evt: TrailEvent };
    const combined: GroupOrEvt[] = [];
    for (const [label, evts] of groups.entries()) {
      const latestTs = Math.max(...evts.map((e) => e.ts));
      if (evts.length === 1) {
        combined.push({ ts: latestTs, kind: "evt", evt: evts[0] });
      } else {
        combined.push({ ts: latestTs, kind: "group", label, evts });
      }
    }
    for (const evt of ungrouped) {
      combined.push({ ts: evt.ts, kind: "evt", evt });
    }
    combined.sort((a, b) => b.ts - a.ts);

    for (const entry of combined) {
      if (entry.kind === "evt") {
        list.appendChild(renderTrailItem(entry.evt));
      } else {
        list.appendChild(renderTrailGroup(entry.label, entry.evts, groupId));
      }
    }
    wrap.appendChild(list);
    return wrap;
  }

  function renderTrailItem(evt: TrailEvent, indented = false): HTMLElement {
    const item = el(
      "div",
      `pf-trail-item pf-trail-${evt.kind}${indented ? " pf-trail-item-sub" : ""}`,
    );
    const clock = el("span", "pf-trail-clock");
    clock.textContent = fmtClock(evt.ts);
    item.appendChild(clock);
    const iconEl = el("span", "pf-trail-icon");
    iconEl.textContent = evt.icon ?? TRAIL_ICON_BY_KIND[evt.kind] ?? "·";
    item.appendChild(iconEl);
    if (evt.label && !indented) {
      const lbl = el("span", "pf-trail-label");
      lbl.textContent = evt.label;
      item.appendChild(lbl);
    } else {
      item.appendChild(el("span", "pf-trail-label-placeholder"));
    }
    const msg = el("span", "pf-trail-msg");
    msg.textContent = evt.message;
    msg.title = evt.message;
    item.appendChild(msg);
    return item;
  }

  function renderTrailGroup(label: string, evts: TrailEvent[], groupId: string): HTMLElement {
    const groupKey = `group:${groupId}:${label}`;
    const isExpanded = expanded.has(groupKey);
    const ordered = [...evts].toSorted((a, b) => b.ts - a.ts);
    const latestEvt = ordered[0];
    const wrap = el("div", "pf-trail-group");

    const header = el("div", `pf-trail-item pf-trail-group-header pf-trail-${latestEvt.kind}`);
    const clock = el("span", "pf-trail-clock");
    clock.textContent = fmtClock(latestEvt.ts);
    header.appendChild(clock);
    const caret = el("span", "pf-trail-icon pf-trail-caret");
    caret.textContent = isExpanded ? "▾" : "▸";
    header.appendChild(caret);
    const lbl = el("span", "pf-trail-label");
    lbl.textContent = label;
    header.appendChild(lbl);
    const msg = el("span", "pf-trail-msg");
    msg.textContent = `${evts.length} events · latest: ${latestEvt.message}`;
    msg.title = latestEvt.message;
    header.appendChild(msg);
    header.addEventListener("click", () => toggleExpanded(groupKey));
    wrap.appendChild(header);

    if (isExpanded) {
      const sub = el("div", "pf-trail-group-body");
      for (const e of ordered) {
        sub.appendChild(renderTrailItem(e, /*indented*/ true));
      }
      wrap.appendChild(sub);
    }
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
      /* ─── Palette (wood-panel theme) ───
         Background: darker wood (#3a2b22) multiplied over wood-panel.jpg --
         same approach the old .pf-tree-panel used so cream text renders
         cleanly. All text uses warm cream / tan shades; zero cold grays.
         Accent: #d4a574 (sand), gold: #e8cc93, warm-muted: #a89080. */

      .pf-card {
        background: url("./wood-panel.jpg") repeat;
        background-blend-mode: multiply;
        background-color: #3a2b22;
        border: 1px solid rgba(193, 154, 107, 0.35);
        border-radius: 10px;
        padding: 0.55rem 0.65rem 0.7rem;
        display: flex; flex-direction: column; gap: 0.5rem;
        box-shadow: 0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,220,180,0.06);
      }
      .pf-card-title {
        display: flex; align-items: center; justify-content: space-between;
        gap: 0.5rem;
        padding-bottom: 0.4rem;
        border-bottom: 1px solid rgba(193, 154, 107, 0.22);
        color: #e8d4b0;
      }
      .pf-card-title-left { display: flex; align-items: center; gap: 0.4rem; }
      .pf-card-title-icon { font-size: 0.92rem; }
      .pf-card-title-text {
        font-size: 0.68rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: #e8cc93;
      }
      .pf-card-title-badge {
        font-size: 0.62rem;
        font-family: ui-monospace, "Courier New", monospace;
        color: #d4a574;
        background: rgba(0,0,0,0.25);
        padding: 0.12rem 0.5rem;
        border-radius: 10px;
        border: 1px solid rgba(193, 154, 107, 0.28);
        white-space: nowrap;
      }
      .pf-card-title-badge-idle { color: #a89080; }

      /* ─── Recipe header ─── */
      .pf-recipe-bar {
        display: flex; align-items: center; gap: 0.4rem;
        padding: 0.35rem 0.55rem;
        background: rgba(0,0,0,0.22);
        border: 1px solid rgba(193, 154, 107, 0.25);
        border-radius: 7px;
        font-size: 0.72rem;
      }
      .pf-recipe-idle { color: #b8a593; font-style: italic; }
      .pf-recipe-icon { font-size: 0.85rem; filter: saturate(1.2); }
      .pf-recipe-id { color: #e8cc93; font-weight: 700; letter-spacing: 0.02em; }
      .pf-recipe-step { color: #d4bf9e; font-weight: 600; }
      .pf-recipe-step-name { color: #c9b8a0; font-style: italic; }
      .pf-recipe-spacer { flex: 1; }
      .pf-recipe-parallel {
        color: #d4a574;
        font-family: ui-monospace, "Courier New", monospace;
        font-size: 0.68rem;
      }
      .pf-recipe-elapsed {
        color: #b8a593;
        font-family: ui-monospace, "Courier New", monospace;
        font-size: 0.68rem;
        min-width: 2.5ch; text-align: right;
      }

      /* ─── Idle ─── */
      .pf-empty {
        display: flex; align-items: center; justify-content: center;
        padding: 0.85rem 0.5rem;
        color: #b8a593;
        font-size: 0.72rem; font-style: italic;
      }

      /* ─── Tree (recursive branches) ─── */
      .pf-tree { display: flex; flex-direction: column; gap: 0.3rem; }
      .pf-branch { display: flex; flex-direction: column; gap: 0.28rem; }
      .pf-branch.pf-branch-depth-1 .pf-children,
      .pf-branch.pf-branch-depth-2 .pf-children,
      .pf-branch.pf-branch-depth-3 .pf-children,
      .pf-branch.pf-branch-depth-4 .pf-children,
      .pf-branch.pf-branch-depth-5 .pf-children {
        border-left-color: rgba(193, 154, 107, 0.22);
      }
      .pf-node.pf-clickable { cursor: pointer; user-select: none; }
      .pf-node.pf-clickable:hover { background: rgba(0, 0, 0, 0.32); }
      .pf-caret {
        color: #d4a574;
        font-size: 0.65rem;
        width: 10px;
        flex-shrink: 0;
        text-align: center;
      }
      @keyframes pf-shimmer {
        0%   { background-position: 150% 0, center; }
        100% { background-position: -150% 0, center; }
      }
      .pf-node {
        display: flex; align-items: center; gap: 0.4rem;
        background: rgba(0,0,0,0.18);
        border: 1px solid rgba(193, 154, 107, 0.22);
        border-radius: 8px;
        padding: 0.32rem 0.55rem;
        position: relative;
        font-size: 0.72rem;
      }
      .pf-node.pf-active {
        border: 1px solid rgba(193, 154, 107, 0.35);
        background-image:
          linear-gradient(90deg, transparent 0%, var(--pf-glow-bg, rgba(107,142,35,0.15)) 47%, var(--pf-glow-bg2, rgba(107,142,35,0.45)) 50%, var(--pf-glow-bg, rgba(107,142,35,0.15)) 53%, transparent 100%),
          radial-gradient(ellipse at center, var(--pf-glow, rgba(107,142,35,0.2)) 0%, transparent 70%),
          linear-gradient(rgba(0,0,0,0.18), rgba(0,0,0,0.18));
        background-size: 150% 100%, 100% 100%, 100% 100%;
        animation: pf-shimmer 1.2s ease-in-out infinite;
      }
      .pf-root:not(.pf-active) {
        border-color: rgba(163,113,247,0.45);
        box-shadow: 0 0 8px rgba(163,113,247,0.15);
      }
      .pf-completed { opacity: 0.65; animation: none !important; }
      .pf-failed { opacity: 0.8; border-color: rgba(248,81,73,0.55) !important; }

      .pf-children {
        padding-left: 0.9rem; margin-left: 0.4rem;
        border-left: 1px dashed rgba(193, 154, 107, 0.3);
        display: flex; flex-direction: column; gap: 0.28rem;
      }
      .pf-child { position: relative; }
      .pf-connector {
        position: absolute; left: -0.95rem; top: 50%;
        width: 0.9rem; height: 1px;
        background: rgba(193, 154, 107, 0.3);
      }

      .pf-glyph {
        font-size: 0.72rem; flex-shrink: 0; width: 12px; text-align: center;
      }
      .pf-logo { display: flex; align-items: center; flex-shrink: 0; }
      .pf-logo svg { width: 13px; height: 13px; }

      .pf-model-wrap { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .pf-model {
        font-weight: 700; font-size: 0.7rem;
        letter-spacing: 0.01em;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        text-shadow: 0 1px 1px rgba(0,0,0,0.35);
      }
      .pf-label {
        color: #e8d4b0;
        font-size: 0.66rem;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        max-width: 220px;
      }

      .pf-spacer { flex: 1; }
      .pf-age {
        color: #c9b8a0;
        font-family: ui-monospace, "Courier New", monospace;
        font-size: 0.65rem;
        min-width: 3ch; text-align: right;
      }
      .pf-root-status {
        color: #d4bf9e;
        font-size: 0.65rem; font-style: italic;
      }
      .pf-stall {
        color: #ff8a82;
        font-size: 0.62rem; font-weight: 700;
        letter-spacing: 0.04em;
      }
      .pf-failed-text { color: #ff8a82; font-size: 0.65rem; font-style: italic; }

      .pf-progress-bar {
        width: 52px; height: 3px;
        background: rgba(0,0,0,0.4);
        border-radius: 2px; overflow: hidden; flex-shrink: 0;
      }
      .pf-progress-fill { height: 100%; border-radius: 2px; transition: width 0.25s; }
      .pf-pct { font-size: 0.6rem; min-width: 28px; text-align: right; }

      /* ─── Plan board (FORK 2026-05-13/14) ─── */
      .pf-plan {
        display: flex; flex-direction: column; gap: 0.28rem;
        padding: 0.4rem 0.5rem;
        background: rgba(0,0,0,0.18);
        border: 1px solid rgba(193, 154, 107, 0.3);
        border-radius: 7px;
        font-size: 0.72rem;
      }
      .pf-plan-synthetic {
        border-style: dashed;
        border-color: #4a4a4a;
        opacity: 0.92;
      }
      .pf-plan-synthetic .pf-plan-header {
        font-style: italic;
      }
      .pf-plan-idle {
        color: #666;
        font-size: 0.9em;
        padding: 6px 8px;
      }
      .pf-plan-header {
        display: flex; align-items: center; justify-content: space-between;
        color: #e8cc93;
        font-size: 0.72rem;
        font-weight: 700;
        gap: 0.4rem;
      }
      .pf-plan-total {
        color: #b8a593;
        font-family: ui-monospace, "Courier New", monospace;
        font-size: 0.65rem;
        min-width: 3ch; text-align: right;
        flex-shrink: 0;
      }
      .pf-plan-kit {
        color: #d4a574;
        font-size: 0.65rem; font-style: italic;
        padding-left: 0.2rem;
      }
      .pf-step {
        display: flex; align-items: baseline; gap: 0.3rem;
        padding: 0.18rem 0.3rem;
        border-radius: 4px;
        font-size: 0.7rem;
      }
      .pf-step-done {
        color: #7ed77a; opacity: 0.8;
      }
      .pf-step-in_progress {
        color: #e8d4b0;
        background: rgba(0,0,0,0.15);
      }
      .pf-step-pending {
        color: #a89080;
      }
      .pf-step-error {
        color: #ff8a82;
      }
      .pf-step-time {
        color: #b8a593;
        font-family: ui-monospace, "Courier New", monospace;
        font-size: 0.64rem;
        margin-left: auto;
        flex-shrink: 0;
        min-width: 3ch; text-align: right;
      }
      .pf-step-note {
        color: #c9b8a0;
        font-style: italic;
        font-size: 0.67rem;
      }

      /* ─── Trail ─── */
      .pf-trail {
        border-top: 1px dashed rgba(193, 154, 107, 0.25);
        padding-top: 0.45rem;
        margin-top: 0.15rem;
        display: flex; flex-direction: column; gap: 0.25rem;
      }
      .pf-trail-header {
        color: #d4a574;
        font-size: 0.62rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-weight: 700;
      }
      .pf-trail-list {
        display: flex; flex-direction: column; gap: 0.12rem;
        max-height: min(420px, 45vh);
        overflow-y: auto;
        padding-right: 2px;
        scrollbar-width: thin;
        scrollbar-color: rgba(193, 154, 107, 0.45) transparent;
      }
      .pf-trail-inline .pf-trail-list {
        max-height: min(240px, 30vh);
      }
      .pf-trail-list::-webkit-scrollbar { width: 6px; }
      .pf-trail-list::-webkit-scrollbar-track { background: transparent; }
      .pf-trail-list::-webkit-scrollbar-thumb {
        background: rgba(193, 154, 107, 0.5);
        border-radius: 3px;
      }
      .pf-trail-list::-webkit-scrollbar-thumb:hover {
        background: rgba(193, 154, 107, 0.7);
      }
      .pf-trail-inline {
        border-top: none;
        margin-top: 0;
        padding-top: 0.25rem;
        padding-left: 0.3rem;
      }
      .pf-trail-group { display: flex; flex-direction: column; gap: 0.08rem; }
      .pf-trail-group-header { cursor: pointer; user-select: none; border-radius: 3px; padding: 0.08rem 0.2rem; margin-left: -0.2rem; }
      .pf-trail-group-header:hover { background: rgba(0,0,0,0.25); }
      .pf-trail-caret { color: #d4a574; }
      .pf-trail-group-body {
        display: flex; flex-direction: column; gap: 0.08rem;
        padding-left: 0.75rem;
        border-left: 1px dashed rgba(193, 154, 107, 0.25);
        margin-left: 0.6rem;
      }
      .pf-trail-item-sub {
        grid-template-columns: 54px 16px 0 1fr;
        opacity: 0.9;
      }
      .pf-trail-label-placeholder { width: 0; }
      .pf-trail-item {
        display: grid;
        grid-template-columns: 54px 16px auto 1fr;
        align-items: baseline;
        gap: 0.35rem;
        font-size: 0.68rem;
        font-family: ui-monospace, "Courier New", monospace;
        line-height: 1.3;
      }
      .pf-trail-clock { color: #b8a593; white-space: nowrap; }
      .pf-trail-icon { text-align: center; }
      .pf-trail-label {
        color: #e8cc93;
        font-weight: 700; font-family: inherit;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        max-width: 14ch;
      }
      .pf-trail-msg {
        color: #e8d4b0;
        font-family: inherit;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pf-trail-dispatch .pf-trail-icon { color: #80baff; }
      .pf-trail-complete .pf-trail-icon { color: #7ed77a; }
      .pf-trail-warn .pf-trail-icon { color: #ffae5c; }
      .pf-trail-spawn-fail .pf-trail-icon { color: #ff8a82; }
      .pf-trail-transition .pf-trail-icon { color: #d9b3ff; }
      .pf-trail-recipe-step .pf-trail-icon { color: #e8cc93; }
      .pf-trail-note .pf-trail-icon { color: #d4a574; }
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
