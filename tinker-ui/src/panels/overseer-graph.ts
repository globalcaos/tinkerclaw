// tinker-ui/src/panels/overseer-graph.ts

// ─── Types ───
interface GraphNode {
  key: string;
  label: string;
  provider: string;
  model: string;
  status: "working" | "waiting" | "stuck" | "idle";
  role: string;
  phase: string;
  depth: number;
  tokens: number;
  isMain: boolean;
  toolCalls: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  el?: SVGGElement;
  opacity: number;
  removing: boolean;
}

interface GraphEdge {
  source: string;
  target: string;
  el?: SVGLineElement;
}

interface TopologySnapshot {
  nodes: Array<{
    sessionKey: string;
    label: string;
    provider: string;
    model: string;
    status: "working" | "waiting" | "stuck" | "idle";
    role: string;
    phase: string;
    depth: number;
    tokens: number;
    isMain?: boolean;
    toolCalls?: number;
  }>;
  edges: Array<{ source: string; target: string }>;
}

// ─── Constants ───
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#7c3aed",
  google: "#16a34a",
  openai: "#6b7280",
  ollama: "#ca8a04",
  meta: "#0668E1",
  mistral: "#f97316",
  deepseek: "#4f8ff7",
};

const STATUS_COLORS: Record<string, string> = {
  working: "#22c55e",
  waiting: "#eab308",
  stuck: "#ef4444",
  idle: "#6b7280",
};

const NODE_RADIUS = 28;
const MAIN_NODE_RADIUS = 38;
const REPULSION = 3000;
const SPRING_K = 0.01;
const SPRING_REST = 100;
const DAMPING = 0.92;
const Y_BIAS = 0.05;
const DEPTH_SPACING = 90;
const VELOCITY_THRESHOLD = 0.1;
const FADE_DURATION = 300;

// ─── Mount ───
export function mountOverseerGraph(
  container: HTMLElement,
  opts: {
    providerIcons?: Record<string, string>;
  },
): {
  update(snap: TopologySnapshot): void;
  destroy(): void;
  setSessionFilter(key: string | null): void;
} {
  const icons = opts.providerIcons ?? {};
  let filterKey: string | null = null;
  const ns = "http://www.w3.org/2000/svg";
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let animId: number | null = null;
  let sleeping = true;
  let width = container.clientWidth || 300;
  let height = 400;

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", String(height));
  svg.style.display = "block";
  container.appendChild(svg);

  const defs = document.createElementNS(ns, "defs");
  defs.innerHTML = `
    <filter id="overseer-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <marker id="overseer-arrow" viewBox="0 0 10 10" refX="10" refY="5"
      markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border, #444)"/>
    </marker>
  `;
  svg.appendChild(defs);

  const edgeGroup = document.createElementNS(ns, "g");
  edgeGroup.setAttribute("class", "overseer-edges");
  svg.appendChild(edgeGroup);

  const nodeGroup = document.createElementNS(ns, "g");
  nodeGroup.setAttribute("class", "overseer-nodes");
  svg.appendChild(nodeGroup);

  const emptyGroup = document.createElementNS(ns, "g");
  emptyGroup.setAttribute("class", "overseer-empty");
  const emptyIcon = document.createElementNS(ns, "text");
  emptyIcon.setAttribute("x", "50%");
  emptyIcon.setAttribute("y", "40%");
  emptyIcon.setAttribute("text-anchor", "middle");
  emptyIcon.setAttribute("fill", "var(--muted, #555)");
  emptyIcon.setAttribute("font-size", "24");
  emptyIcon.textContent = "\uD83D\uDD2D"; // telescope emoji
  emptyGroup.appendChild(emptyIcon);
  const emptyText = document.createElementNS(ns, "text");
  emptyText.setAttribute("x", "50%");
  emptyText.setAttribute("y", "55%");
  emptyText.setAttribute("text-anchor", "middle");
  emptyText.setAttribute("fill", "var(--muted, #666)");
  emptyText.setAttribute("font-size", "11");
  emptyText.textContent = "Overseer watching \u2014 waiting for activity";
  emptyGroup.appendChild(emptyText);
  const emptyHint = document.createElementNS(ns, "text");
  emptyHint.setAttribute("x", "50%");
  emptyHint.setAttribute("y", "67%");
  emptyHint.setAttribute("text-anchor", "middle");
  emptyHint.setAttribute("fill", "var(--muted, #444)");
  emptyHint.setAttribute("font-size", "9");
  emptyHint.textContent = "Send a prompt to see agent activity here";
  emptyGroup.appendChild(emptyHint);
  svg.appendChild(emptyGroup);

  function updateEmptyState(): void {
    const hasNodes = Array.from(nodes.values()).some((n) => !n.removing);
    emptyGroup.style.display = hasNodes ? "none" : "block";
  }

  function createNodeEl(node: GraphNode): SVGGElement {
    const g = document.createElementNS(ns, "g");
    const mainClass = node.isMain ? " overseer-node--main" : "";
    g.setAttribute("class", `overseer-node overseer-node--${node.status}${mainClass}`);
    g.style.opacity = "0";

    const r = node.isMain ? MAIN_NODE_RADIUS : NODE_RADIUS;
    const color = PROVIDER_COLORS[node.provider] || "#6b7280";
    const statusColor = STATUS_COLORS[node.status] || "#22c55e";

    const ring = document.createElementNS(ns, "circle");
    ring.setAttribute("r", String(r + 4));
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", statusColor);
    ring.setAttribute("stroke-width", node.isMain ? "3" : "2");
    ring.setAttribute("class", "overseer-status-ring");
    g.appendChild(ring);

    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", "var(--surface, #1a1a2e)");
    circle.setAttribute("stroke", color);
    circle.setAttribute("stroke-width", node.isMain ? "3" : "2.5");
    g.appendChild(circle);

    // Provider icon via foreignObject
    const iconSvg = icons[node.provider];
    if (iconSvg) {
      const fo = document.createElementNS(ns, "foreignObject");
      fo.setAttribute("x", "-7");
      fo.setAttribute("y", node.isMain ? "-20" : "-16");
      fo.setAttribute("width", "14");
      fo.setAttribute("height", "14");
      fo.setAttribute("class", "overseer-icon-fo");
      const div = document.createElement("div");
      div.style.cssText =
        "display:flex;align-items:center;justify-content:center;width:14px;height:14px";
      div.innerHTML = iconSvg;
      fo.appendChild(div);
      g.appendChild(fo);
    }

    // Model slug (primary label)
    const text = document.createElementNS(ns, "text");
    text.setAttribute("y", node.isMain ? "-2" : "0");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "var(--fg, #e0e0e0)");
    text.setAttribute("font-size", node.isMain ? "11" : "9");
    text.setAttribute("font-weight", "600");
    text.setAttribute("class", "overseer-model");
    text.textContent = shortModel(node.model) || truncate(node.label, 14);
    g.appendChild(text);

    // Role sublabel
    const sub = document.createElementNS(ns, "text");
    sub.setAttribute("y", node.isMain ? "10" : "10");
    sub.setAttribute("text-anchor", "middle");
    sub.setAttribute("fill", "var(--muted, #888)");
    sub.setAttribute("font-size", node.isMain ? "8" : "7");
    sub.setAttribute("class", "overseer-sublabel");
    sub.textContent = node.role || "";
    g.appendChild(sub);

    // Phase / status text
    const phase = document.createElementNS(ns, "text");
    phase.setAttribute("y", node.isMain ? "22" : "20");
    phase.setAttribute("text-anchor", "middle");
    phase.setAttribute("fill", statusColor);
    phase.setAttribute("font-size", node.isMain ? "8" : "7");
    phase.setAttribute("class", "overseer-phase");
    phase.textContent = node.phase || "";
    g.appendChild(phase);

    // Token counter for main node
    if (node.isMain && node.tokens > 0) {
      const tok = document.createElementNS(ns, "text");
      tok.setAttribute("y", String(r + 14));
      tok.setAttribute("text-anchor", "middle");
      tok.setAttribute("fill", "var(--muted, #666)");
      tok.setAttribute("font-size", "7");
      tok.setAttribute("class", "overseer-tokens");
      tok.textContent = formatTokens(node.tokens);
      g.appendChild(tok);
    }

    return g;
  }

  function updateNodeEl(node: GraphNode): void {
    if (!node.el) return;
    node.el.setAttribute("transform", `translate(${node.x},${node.y})`);
    node.el.style.opacity = String(node.opacity);

    const color = PROVIDER_COLORS[node.provider] || "#6b7280";
    const statusColor = STATUS_COLORS[node.status] || "#22c55e";
    const mainClass = node.isMain ? " overseer-node--main" : "";

    node.el.setAttribute("class", `overseer-node overseer-node--${node.status}${mainClass}`);
    const ring = node.el.querySelector(".overseer-status-ring");
    if (ring) ring.setAttribute("stroke", statusColor);
    const circle = node.el.querySelector("circle:nth-child(2)");
    if (circle) circle.setAttribute("stroke", color);
    const modelEl = node.el.querySelector(".overseer-model");
    if (modelEl) modelEl.textContent = shortModel(node.model) || truncate(node.label, 14);
    const sub = node.el.querySelector(".overseer-sublabel");
    if (sub) sub.textContent = node.role || "";
    const phase = node.el.querySelector(".overseer-phase");
    if (phase) phase.textContent = node.phase || "";
    const tok = node.el.querySelector(".overseer-tokens");
    if (tok) tok.textContent = node.tokens > 0 ? formatTokens(node.tokens) : "";
  }

  function createEdgeEl(): SVGLineElement {
    const line = document.createElementNS(ns, "line");
    line.setAttribute("stroke", "var(--border, #333)");
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-opacity", "0.5");
    line.setAttribute("marker-end", "url(#overseer-arrow)");
    line.setAttribute("class", "overseer-edge");
    return line;
  }

  function updateEdgeEl(edge: GraphEdge): void {
    if (!edge.el) return;
    const src = nodes.get(edge.source);
    const tgt = nodes.get(edge.target);
    if (!src || !tgt) {
      edge.el.style.display = "none";
      return;
    }
    edge.el.style.display = "";
    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;
    const srcR = src.isMain ? MAIN_NODE_RADIUS : NODE_RADIUS;
    const tgtR = tgt.isMain ? MAIN_NODE_RADIUS : NODE_RADIUS;
    edge.el.setAttribute("x1", String(src.x + nx * srcR));
    edge.el.setAttribute("y1", String(src.y + ny * srcR));
    edge.el.setAttribute("x2", String(tgt.x - nx * (tgtR + 6)));
    edge.el.setAttribute("y2", String(tgt.y - ny * (tgtR + 6)));
  }

  function tick(): void {
    const nodeArr = Array.from(nodes.values());
    if (nodeArr.length === 0) {
      sleeping = true;
      return;
    }

    let maxV = 0;
    const cx = width / 2;

    for (let i = 0; i < nodeArr.length; i++) {
      for (let j = i + 1; j < nodeArr.length; j++) {
        const a = nodeArr[i];
        const b = nodeArr[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < 1) dist = 1;
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const edge of edges) {
      const src = nodes.get(edge.source);
      const tgt = nodes.get(edge.target);
      if (!src || !tgt) continue;
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = SPRING_K * (dist - SPRING_REST);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      src.vx += fx;
      src.vy += fy;
      tgt.vx -= fx;
      tgt.vy -= fy;
    }

    for (const node of nodeArr) {
      const targetY = 40 + node.depth * DEPTH_SPACING;
      node.vy += (targetY - node.y) * Y_BIAS;
      node.vx += (cx - node.x) * 0.002;
    }

    for (const node of nodeArr) {
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      node.x += node.vx;
      node.y += node.vy;
      const nr = node.isMain ? MAIN_NODE_RADIUS : NODE_RADIUS;
      node.x = Math.max(nr + 5, Math.min(width - nr - 5, node.x));
      node.y = Math.max(nr + 5, Math.min(height - nr - 5, node.y));
      const v = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (v > maxV) maxV = v;
    }

    let anyFading = false;
    for (const node of nodeArr) {
      if (node.removing) {
        node.opacity = Math.max(0, node.opacity - 16 / FADE_DURATION);
        if (node.opacity <= 0) {
          if (node.el) nodeGroup.removeChild(node.el);
          nodes.delete(node.key);
        }
        anyFading = true;
      } else if (node.opacity < 1) {
        node.opacity = Math.min(1, node.opacity + 16 / FADE_DURATION);
        anyFading = true;
      }
    }

    for (const node of nodes.values()) {
      updateNodeEl(node);
    }
    for (const edge of edges) {
      updateEdgeEl(edge);
    }

    updateEmptyState();
    sleeping = maxV < VELOCITY_THRESHOLD && !anyFading;
  }

  function animate(): void {
    tick();
    if (!sleeping) {
      animId = requestAnimationFrame(animate);
    } else {
      animId = null;
    }
  }

  function wake(): void {
    if (sleeping || animId === null) {
      sleeping = false;
      animId = requestAnimationFrame(animate);
    }
  }

  function update(snap: TopologySnapshot): void {
    width = container.clientWidth || 300;
    svg.setAttribute("width", "100%");

    // Apply session filter if active — show only the selected session and its subagents
    if (filterKey) {
      // Build set of reachable nodes: start with filterKey, then follow edges (parent→child)
      const reachable = new Set<string>([filterKey]);
      const edgeMap = new Map<string, string[]>();
      for (const e of snap.edges) {
        const children = edgeMap.get(e.source) ?? [];
        children.push(e.target);
        edgeMap.set(e.source, children);
      }
      const queue = [filterKey];
      while (queue.length > 0) {
        const key = queue.pop()!;
        for (const child of edgeMap.get(key) ?? []) {
          if (!reachable.has(child)) {
            reachable.add(child);
            queue.push(child);
          }
        }
      }
      snap = {
        nodes: snap.nodes.filter((n) => reachable.has(n.sessionKey)),
        edges: snap.edges.filter((e) => reachable.has(e.source) && reachable.has(e.target)),
      };
    }

    const maxDepth = snap.nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    height = Math.max(200, 60 + (maxDepth + 1) * DEPTH_SPACING + 40);
    svg.setAttribute("height", String(height));

    const incomingKeys = new Set(snap.nodes.map((n) => n.sessionKey));

    for (const [key, node] of nodes) {
      if (!incomingKeys.has(key) && !node.removing) {
        node.removing = true;
      }
    }

    for (const sn of snap.nodes) {
      let node = nodes.get(sn.sessionKey);
      if (node) {
        node.provider = sn.provider;
        node.model = sn.model;
        node.status = sn.status;
        node.role = sn.role;
        node.phase = sn.phase;
        node.tokens = sn.tokens;
        node.depth = sn.depth;
        node.label = sn.label;
        node.isMain = sn.isMain ?? false;
        node.toolCalls = sn.toolCalls ?? 0;
      } else {
        const cx = width / 2 + (Math.random() - 0.5) * 60;
        const cy = 40 + sn.depth * DEPTH_SPACING + (Math.random() - 0.5) * 20;
        node = {
          key: sn.sessionKey,
          label: sn.label,
          provider: sn.provider,
          model: sn.model,
          status: sn.status,
          role: sn.role,
          phase: sn.phase,
          depth: sn.depth,
          tokens: sn.tokens,
          isMain: sn.isMain ?? false,
          toolCalls: sn.toolCalls ?? 0,
          x: cx,
          y: cy,
          vx: 0,
          vy: 0,
          opacity: 0,
          removing: false,
        };
        node.el = createNodeEl(node);
        nodeGroup.appendChild(node.el);
        nodes.set(sn.sessionKey, node);
      }
    }

    const existingEdgeKeys = new Set(edges.map((e) => `${e.source}→${e.target}`));
    const incomingEdgeKeys = new Set(snap.edges.map((e) => `${e.source}→${e.target}`));

    for (let i = edges.length - 1; i >= 0; i--) {
      const key = `${edges[i].source}→${edges[i].target}`;
      if (!incomingEdgeKeys.has(key)) {
        if (edges[i].el) edgeGroup.removeChild(edges[i].el!);
        edges.splice(i, 1);
      }
    }

    for (const se of snap.edges) {
      const key = `${se.source}→${se.target}`;
      if (!existingEdgeKeys.has(key)) {
        const el = createEdgeEl();
        edgeGroup.appendChild(el);
        edges.push({ source: se.source, target: se.target, el });
      }
    }

    wake();
  }

  function destroy(): void {
    if (animId !== null) cancelAnimationFrame(animId);
    container.removeChild(svg);
  }

  function setSessionFilter(key: string | null): void {
    filterKey = key;
  }

  updateEmptyState();
  return { update, destroy, setSessionFilter };
}

// ─── Helpers ───
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function shortModel(model: string): string {
  if (!model) return "";
  const parts = model.split("/");
  const name = parts[parts.length - 1];
  return truncate(name.replace("claude-", ""), 14);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M tok";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K tok";
  return n + " tok";
}
