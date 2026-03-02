/**
 * Response Treemap — visual breakdown of LLM output token usage.
 * Squarified treemap with drill-down:
 *   L0 (per-call overview) → L1 (categories) → L2 (sub-items) → L3 (text preview).
 * Mirrors the context-treemap multi-call run pattern, fetching data from server.
 */

type ReqFn = (method: string, params?: any) => Promise<any>;

interface TreemapNode {
  key: string;
  label: string;
  chars: number;
  text?: string;
  children?: TreemapNode[];
}

interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
  node: TreemapNode;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ─── Color scheme (purple tones for output — matches RESPONSE_COLOR) ───
const CATEGORY_COLORS: Record<string, string> = {
  text: "270,65%",
  thinking: "290,60%",
  tool_use: "250,55%",
  tool_result: "310,50%",
};

function categoryHsl(key: string, lightness = 45): string {
  const base = CATEGORY_COLORS[key];
  if (base) {
    return `hsl(${base},${lightness}%)`;
  }
  const h = Math.abs(hashCode(key)) % 360;
  return `hsl(${h},50%,${lightness}%)`;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ─── Squarified treemap layout ───
function squarify(nodes: TreemapNode[], bounds: Rect): LayoutRect[] {
  if (!nodes.length || bounds.w <= 0 || bounds.h <= 0) {
    return [];
  }
  const sorted = [...nodes].toSorted((a, b) => b.chars - a.chars);
  const total = sorted.reduce((s, n) => s + n.chars, 0);
  if (total <= 0) {
    return [];
  }
  const area = bounds.w * bounds.h;
  const scaled = sorted.map((n) => ({ node: n, area: (n.chars / total) * area }));
  const result: LayoutRect[] = [];
  let rem = { ...bounds };
  let i = 0;
  while (i < scaled.length) {
    const strip: typeof scaled = [];
    const isWide = rem.w >= rem.h;
    const side = isWide ? rem.h : rem.w;
    if (side <= 0) {
      break;
    }
    let stripArea = 0,
      bestWorst = Infinity;
    while (i < scaled.length) {
      strip.push(scaled[i]);
      stripArea += scaled[i].area;
      const stripSide = stripArea / side;
      let worst = 0;
      for (const s of strip) {
        const itemSide = s.area / stripSide;
        const ratio = Math.max(stripSide / itemSide, itemSide / stripSide);
        if (ratio > worst) {
          worst = ratio;
        }
      }
      if (worst > bestWorst && strip.length > 1) {
        strip.pop();
        stripArea -= scaled[i].area;
        break;
      }
      bestWorst = worst;
      i++;
    }
    const stripSize = stripArea / side;
    let offset = 0;
    for (const s of strip) {
      const itemSize = s.area / stripSize;
      if (isWide) {
        result.push({ x: rem.x, y: rem.y + offset, w: stripSize, h: itemSize, node: s.node });
      } else {
        result.push({ x: rem.x + offset, y: rem.y, w: itemSize, h: stripSize, node: s.node });
      }
      offset += itemSize;
    }
    if (isWide) {
      rem = { x: rem.x + stripSize, y: rem.y, w: rem.w - stripSize, h: rem.h };
    } else {
      rem = { x: rem.x, y: rem.y + stripSize, w: rem.w, h: rem.h - stripSize };
    }
  }
  return result;
}

function cleanModelName(model: string): string {
  return model.replace(/^claude-/, "");
}

// ─── Helpers ───
function fmtChars(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + "M";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + "k";
  }
  return String(n);
}

function pct(n: number, total: number): string {
  return total > 0 ? ((n / total) * 100).toFixed(1) + "%" : "0%";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// chars → estimated cost in USD (price = per 1M tokens)
function charsCost(chars: number, pricePerMTok: number): number {
  return ((chars / 4) * pricePerMTok) / 1_000_000;
}

function fmtUsd(v: number): string {
  if (v >= 1) {
    return `$${v.toFixed(2)}`;
  }
  if (v >= 0.01) {
    return `$${v.toFixed(2)}`;
  }
  if (v >= 0.001) {
    return `$${v.toFixed(3)}`;
  }
  return `$${v.toFixed(4)}`;
}

// ─── Build L1 nodes from server response call data ───
function buildL1NodesFromSlim(call: any): TreemapNode[] {
  return (call.categories ?? []).map((c: any) => ({
    key: c.key,
    label: c.label ?? c.key,
    chars: c.chars,
  }));
}

// ─── Build L1 nodes from full content blocks (for L2/L3 drill-down) ───
function buildL1NodesFromContent(content: any[]): TreemapNode[] {
  const nodes: TreemapNode[] = [];
  let textChars = 0,
    textContent = "";
  let thinkingChars = 0,
    thinkingContent = "";
  const toolUses: { name: string; chars: number; text: string }[] = [];
  const toolResults: { id: string; chars: number; text: string }[] = [];

  for (const b of content) {
    if (b.type === "text") {
      const t = b.text ?? "";
      textChars += t.length;
      textContent += t;
    } else if (b.type === "thinking") {
      const t = b.thinking ?? b.text ?? "";
      thinkingChars += t.length;
      thinkingContent += t;
    } else if (b.type === "redacted_thinking") {
      // Thinking content was redacted by the API — skip base64 data blob.
      // The pre-redaction content should be captured via dump-based extraction.
      // Count as 0 chars since we don't have the actual thinking text.
    } else if (b.type === "tool_use") {
      const name = b.name ?? "tool";
      const input = JSON.stringify(b.input ?? {}, null, 2);
      toolUses.push({ name, chars: input.length + name.length, text: input });
    } else if (b.type === "tool_result") {
      const rt =
        typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "", null, 2);
      toolResults.push({ id: b.tool_use_id ?? "result", chars: rt.length, text: rt });
    }
  }

  if (textChars > 0) {
    nodes.push({ key: "text", label: "text", chars: textChars, text: textContent });
  }
  if (thinkingChars > 0) {
    nodes.push({ key: "thinking", label: "thinking", chars: thinkingChars, text: thinkingContent });
  }
  if (toolUses.length > 0) {
    const totalChars = toolUses.reduce((s, t) => s + t.chars, 0);
    nodes.push({
      key: "tool_use",
      label: "tool calls",
      chars: totalChars,
      children: toolUses.map((t) => ({ key: t.name, label: t.name, chars: t.chars, text: t.text })),
    });
  }
  if (toolResults.length > 0) {
    const totalChars = toolResults.reduce((s, t) => s + t.chars, 0);
    nodes.push({
      key: "tool_result",
      label: "tool results",
      chars: totalChars,
      children: toolResults.map((t) => ({
        key: t.id,
        label: "result",
        chars: t.chars,
        text: t.text,
      })),
    });
  }

  return nodes;
}

// ─── Rich content renderers ───

/** Simple JSON syntax highlighting */
function syntaxHighlightJson(json: string): string {
  return json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"([^"\\]*(\\.[^"\\]*)*)"\s*:/g, '<span class="tm-json-key">"$1"</span>:')
    .replace(/:\s*"([^"\\]*(\\.[^"\\]*)*)"/g, ': <span class="tm-json-str">"$1"</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="tm-json-num">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="tm-json-bool">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="tm-json-null">$1</span>');
}

/** Detect JSON and return a highlighted pre block, or null */
function tryRenderJson(text: string): HTMLElement | null {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("[")) || t.length < 3) return null;
  try {
    const parsed = JSON.parse(t);
    const pre = document.createElement("pre");
    pre.className = "tm-json-block";
    pre.innerHTML = syntaxHighlightJson(JSON.stringify(parsed, null, 2));
    return pre;
  } catch {
    return null;
  }
}

/** Render rich body for response content based on category */
function renderRichBody(text: string, category: string, nodeKey: string): HTMLElement | null {
  // Thinking: italic styled block with left border
  if (category === "thinking" || nodeKey === "thinking") {
    const div = document.createElement("div");
    div.className = "tm-thinking-block";
    div.textContent = text;
    return div;
  }

  // Tool use: show tool name header + formatted JSON input
  if (category === "tool_use") {
    const wrapper = document.createElement("div");
    wrapper.className = "tm-tool-call-block";
    const nameEl = document.createElement("div");
    nameEl.className = "tm-tool-call-name";
    nameEl.textContent = nodeKey;
    wrapper.appendChild(nameEl);
    const jsonEl = tryRenderJson(text);
    if (jsonEl) {
      wrapper.appendChild(jsonEl);
    } else {
      const pre = document.createElement("pre");
      pre.className = "tm-json-block";
      pre.textContent = text;
      wrapper.appendChild(pre);
    }
    return wrapper;
  }

  // Tool result: try JSON, otherwise formatted text
  if (category === "tool_result") {
    const jsonEl = tryRenderJson(text);
    if (jsonEl) return jsonEl;
    const div = document.createElement("div");
    div.className = "tm-text-block";
    div.textContent = text;
    return div;
  }

  // Text output: formatted text block
  if (category === "text" || nodeKey === "text") {
    const div = document.createElement("div");
    div.className = "tm-text-block";
    div.textContent = text;
    return div;
  }

  // Generic JSON detection fallback
  return tryRenderJson(text);
}

// ─── Main mount function ───
export function mountResponseTreemap(
  container: HTMLElement,
  footerEl: HTMLElement,
  breadcrumbEl: HTMLElement,
  reqFn: ReqFn,
  getSessionKey: () => string = () => "",
  costEl?: HTMLElement,
  modelEl?: HTMLElement,
): void {
  let currentRunData: any = null;
  let currentCallContent: any[] | null = null;
  let selectedCallIndex: number | null = null;
  let level: 1 | 2 | 3 = 1;
  let drillParent: TreemapNode | null = null;
  let drillChild: TreemapNode | null = null;
  let l1Nodes: TreemapNode[] = [];
  let outputPricePerMTok = 15; // default Sonnet pricing
  let currentModel = "";

  // ─── Render empty state ───
  function renderEmpty(msg = "No response data yet.") {
    container.innerHTML = `<div class="tm-empty">${esc(msg)}</div>`;
    footerEl.textContent = "";
    breadcrumbEl.innerHTML = "";
    if (costEl) {
      costEl.textContent = "";
    }
    if (modelEl) {
      modelEl.textContent = "";
    }
  }

  // ─── Render breadcrumb ───
  function renderBreadcrumb() {
    if (level === 1) {
      breadcrumbEl.innerHTML = "";
      return;
    }
    let html = `<span data-nav="1">Response</span>`;
    if (level >= 2 && drillParent) {
      html += ` \u203A <span data-nav="2">${esc(drillParent.label)}</span>`;
    }
    if (level === 3 && drillChild) {
      html += ` \u203A <span>${esc(drillChild.label)}</span>`;
    }
    breadcrumbEl.innerHTML = html;

    breadcrumbEl.querySelectorAll("[data-nav]").forEach((el) => {
      el.addEventListener("click", () => {
        const target = parseInt((el as HTMLElement).dataset.nav!, 10) as 1 | 2;
        if (target === 1) {
          level = 1;
          drillParent = null;
          drillChild = null;
          renderLevel();
        } else if (target === 2 && level === 3) {
          level = 2;
          drillChild = null;
          renderLevel();
        }
      });
    });
  }

  // ─── Render boxes ───
  function renderBoxes(nodes: TreemapNode[], parentKey: string | null) {
    container.innerHTML = "";
    const t = nodes.reduce((s, n) => s + n.chars, 0);
    const bounds: Rect = { x: 0, y: 0, w: container.offsetWidth, h: container.offsetHeight };
    const rects = squarify(nodes, bounds);

    for (const r of rects) {
      const box = document.createElement("div");
      box.className = "tm-box";
      let bg: string;
      if (parentKey) {
        const idx = nodes.indexOf(r.node);
        const lightness = 40 + (idx / Math.max(nodes.length - 1, 1)) * 25;
        bg = categoryHsl(parentKey, lightness);
      } else {
        bg = categoryHsl(r.node.key);
      }
      box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${bg};`;
      if (r.w >= 40 && r.h >= 30) {
        const lbl = document.createElement("div");
        lbl.className = "tm-lbl";
        lbl.textContent = r.node.label;
        box.appendChild(lbl);
        if (r.w >= 60 && r.h >= 44) {
          const sub = document.createElement("div");
          sub.className = "tm-sub";
          const cost = charsCost(r.node.chars, outputPricePerMTok);
          sub.textContent = `${fmtChars(r.node.chars)}  ${pct(r.node.chars, t)}  ${fmtUsd(cost)}`;
          box.appendChild(sub);
        }
      }
      box.addEventListener("click", () => onBoxClick(r.node, parentKey));
      container.appendChild(box);
    }
  }

  // ─── Box click ───
  function onBoxClick(node: TreemapNode, _parentKey: string | null) {
    if (level === 1) {
      if (node.children && node.children.length > 0) {
        drillParent = node;
        level = 2;
        renderLevel();
      } else if (node.text) {
        drillParent = node;
        drillChild = node;
        level = 3;
        showPreview(node);
      }
    } else if (level === 2 && drillParent) {
      drillChild = node;
      level = 3;
      showPreview(node);
    }
  }

  // ─── L3 preview ───
  function showPreview(node: TreemapNode) {
    const text = node.text ?? "";
    const estTokens = Math.ceil(node.chars / 4);
    const bgKey = drillParent?.key ?? node.key;
    const bg = categoryHsl(bgKey, 30);

    const previewEl = document.createElement("div");
    previewEl.className = "tm-preview";
    previewEl.style.background = bg;

    const headerEl = document.createElement("div");
    headerEl.className = "tm-preview-header";
    headerEl.textContent = node.label;

    const metaEl = document.createElement("div");
    metaEl.className = "tm-preview-meta";
    metaEl.textContent = `${fmtChars(node.chars)} chars \u00b7 ~${fmtChars(estTokens)} tokens`;

    const bodyEl = document.createElement("div");
    const category = drillParent?.key ?? node.key;
    const richEl = renderRichBody(text, category, node.key);
    if (richEl) {
      bodyEl.appendChild(richEl);
    } else {
      bodyEl.className = "tm-text-block";
      bodyEl.textContent = text;
    }

    previewEl.appendChild(headerEl);
    previewEl.appendChild(metaEl);
    previewEl.appendChild(bodyEl);

    container.innerHTML = "";
    container.appendChild(previewEl);
    updateFooter();
    (container as any).__onLevelChange?.();
  }

  // ─── L3 preview via server fetch (when no local text) ───
  async function showPreviewFromServer(node: TreemapNode) {
    const bgKey = drillParent?.key ?? node.key;
    const bg = categoryHsl(bgKey, 30);
    container.innerHTML = `<div class="tm-preview" style="background:${bg}"><div class="tm-preview-meta">Loading...</div></div>`;

    try {
      const sk = getSessionKey();
      const detail = await reqFn("forensic.getResponseDetail", {
        sessionKey: sk || undefined,
        callIndex: selectedCallIndex,
      });
      const content = detail?.content ?? [];
      // Build full L1 nodes with text and drill into the right category
      const fullNodes = buildL1NodesFromContent(content);
      currentCallContent = content;
      l1Nodes = fullNodes;

      // Find the matching node by key
      const match = fullNodes.find((n) => n.key === node.key);
      if (match) {
        if (match.children && match.children.length > 0) {
          drillParent = match;
          level = 2;
          renderLevel();
        } else if (match.text) {
          drillParent = match;
          drillChild = match;
          level = 3;
          showPreview(match);
        } else {
          level = 1;
          renderLevel();
        }
      } else {
        level = 1;
        renderLevel();
      }
    } catch {
      container.innerHTML = `<div class="tm-preview" style="background:${bg}"><div class="tm-preview-meta">Failed to load detail</div></div>`;
      (container as any).__onLevelChange?.();
    }
  }

  // ─── Go back ───
  function goBack() {
    if (level === 3) {
      if (drillParent?.children?.length) {
        level = 2;
        drillChild = null;
      } else {
        level = 1;
        drillParent = null;
        drillChild = null;
      }
    } else if (level === 2) {
      level = 1;
      drillParent = null;
    }
    renderLevel();
  }

  // ─── Update footer ───
  function updateFooter() {
    if (level === 1) {
      const totalChars = l1Nodes.reduce((s, n) => s + n.chars, 0);
      const estTokens = Math.ceil(totalChars / 4);
      const totalCost = charsCost(totalChars, outputPricePerMTok);
      footerEl.textContent = `${fmtChars(totalChars)} chars \u00b7 ~${fmtChars(estTokens)} tokens output \u00b7 ${fmtUsd(totalCost)}`;
      if (costEl) {
        costEl.textContent = fmtUsd(totalCost);
      }
      if (modelEl) {
        modelEl.textContent = currentModel ? `(${cleanModelName(currentModel)})` : "";
      }
    } else if (level === 2 && drillParent) {
      const cost = charsCost(drillParent.chars, outputPricePerMTok);
      footerEl.textContent = `${drillParent.label} \u00b7 ${fmtChars(drillParent.chars)} chars \u00b7 ${fmtUsd(cost)}`;
    } else if (level === 3 && drillChild) {
      const cost = charsCost(drillChild.chars, outputPricePerMTok);
      footerEl.textContent = `${drillChild.label} \u00b7 ${fmtChars(drillChild.chars)} chars \u00b7 ${fmtUsd(cost)}`;
    }
  }

  // ─── Render current level ───
  function renderLevel() {
    renderBreadcrumb();

    if (l1Nodes.length === 0) {
      renderEmpty();
      return;
    }

    if (level === 1) {
      // If we only have slim data (no text), need to check if we have full content
      if (!currentCallContent && l1Nodes.every((n) => !n.text && !n.children)) {
        // We have slim L1 data from the run overview — render it but clicking will fetch detail
        renderSlimL1();
      } else {
        renderBoxes(l1Nodes, null);
      }
    } else if (level === 2 && drillParent) {
      const children = drillParent.children ?? [];
      if (children.length === 0) {
        renderBoxes([drillParent], drillParent.key);
      } else {
        renderBoxes(children, drillParent.key);
      }
    }
    // L3 handled by showPreview
    updateFooter();

    // Notify parent (back button visibility etc.)
    (container as any).__onLevelChange?.();
  }

  // ─── Render slim L1 (from server overview, clicking fetches detail) ───
  function renderSlimL1() {
    container.innerHTML = "";
    const t = l1Nodes.reduce((s, n) => s + n.chars, 0);
    const bounds: Rect = { x: 0, y: 0, w: container.offsetWidth, h: container.offsetHeight };
    const rects = squarify(l1Nodes, bounds);

    for (const r of rects) {
      const box = document.createElement("div");
      box.className = "tm-box";
      const bg = categoryHsl(r.node.key);
      box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${bg};`;
      if (r.w >= 40 && r.h >= 30) {
        const lbl = document.createElement("div");
        lbl.className = "tm-lbl";
        lbl.textContent = r.node.label;
        box.appendChild(lbl);
        if (r.w >= 60 && r.h >= 44) {
          const sub = document.createElement("div");
          sub.className = "tm-sub";
          const cost = charsCost(r.node.chars, outputPricePerMTok);
          sub.textContent = `${fmtChars(r.node.chars)}  ${pct(r.node.chars, t)}  ${fmtUsd(cost)}`;
          box.appendChild(sub);
        }
      }
      // Click fetches full detail then drills in
      box.addEventListener("click", () => {
        drillParent = r.node;
        drillChild = r.node;
        level = 3;
        showPreviewFromServer(r.node);
      });
      container.appendChild(box);
    }
  }

  // ─── Load latest response data from server ───
  async function loadLatest() {
    container.innerHTML = `<div class="tm-empty">Loading...</div>`;
    try {
      const sk = getSessionKey();
      const data = await reqFn("forensic.getResponseLive", { sessionKey: sk || undefined });
      currentRunData = data;
      if (data.pricing) {
        outputPricePerMTok = data.pricing.output ?? 15;
      }
      currentModel = data.model ?? "";
      currentCallContent = null;
      drillParent = null;
      drillChild = null;
      selectedCallIndex = null;

      if (data.callCount >= 1) {
        // Always skip L0 — go directly to latest call's L1 breakdown
        const lastIdx = data.callCount - 1;
        const detail = await reqFn("forensic.getResponseDetail", {
          sessionKey: sk || undefined,
          callIndex: lastIdx,
        });
        currentCallContent = detail?.content ?? [];
        l1Nodes = buildL1NodesFromContent(currentCallContent);
        selectedCallIndex = lastIdx;
        level = 1;
      } else {
        renderEmpty();
        return;
      }
      renderLevel();
    } catch {
      renderEmpty("No response data yet.");
    }
  }

  // ─── Escape key handler ───
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (level === 3) {
        if (drillParent?.children?.length) {
          level = 2;
          drillChild = null;
        } else {
          level = 1;
          drillParent = null;
          drillChild = null;
        }
        renderLevel();
      } else if (level === 2) {
        level = 1;
        drillParent = null;
        renderLevel();
      }
    }
  });

  // ─── Public hooks ───
  (container as any).__responseRefresh = loadLatest;
  (container as any).__responseBack = goBack;
  (container as any).__responseLevel = () => level;
  (container as any).__responseCanGoBack = () => level > 1;

  // Initial state
  renderEmpty();
}
