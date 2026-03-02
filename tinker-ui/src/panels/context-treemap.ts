/**
 * Context Treemap — visual breakdown of LLM context token usage.
 * Squarified treemap with 3-level drill-down: L1 (categories) → L2 (sub-items) → L3 (text preview).
 */

type ReqFn = (method: string, params?: any) => Promise<any>;

interface TreemapNode {
  key: string;
  label: string;
  chars: number;
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

// ─── Color scheme ───
const L0_HUES = [200, 340, 50, 120, 280, 30, 160, 240]; // distinct hues for call boxes

const CATEGORY_COLORS: Record<string, string> = {
  system_prompt: "220,60%",
  tools: "30,70%",
  conversation_history: "270,50%",
  current_prompt: "145,60%",
};

function categoryHsl(key: string, lightness = 45): string {
  const base = CATEGORY_COLORS[key];
  if (base) {
    return `hsl(${base},${lightness}%)`;
  }
  // fallback
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

    // Greedily add items to strip while aspect ratio improves
    let stripArea = 0;
    let bestWorst = Infinity;

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
        // Adding this item made it worse — remove and stop
        strip.pop();
        stripArea -= scaled[i].area;
        break;
      }
      bestWorst = worst;
      i++;
    }

    // Lay out the strip
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

    // Shrink remaining bounds
    if (isWide) {
      rem = { x: rem.x + stripSize, y: rem.y, w: rem.w - stripSize, h: rem.h };
    } else {
      rem = { x: rem.x, y: rem.y + stripSize, w: rem.w, h: rem.h - stripSize };
    }
  }

  return result;
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
  if (total <= 0) {
    return "0%";
  }
  return ((n / total) * 100).toFixed(1) + "%";
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

// ─── Tool schema rich renderer ───
function renderToolDetail(text: string): HTMLElement | null {
  let tool: any;
  try {
    tool = JSON.parse(text);
  } catch {
    return null;
  }
  if (!tool || typeof tool !== "object" || !tool.name) {
    return null;
  }

  const el = document.createElement("div");
  el.className = "tm-tool-detail";

  // Header: name + label
  const nameEl = document.createElement("div");
  nameEl.className = "tm-tool-name";
  nameEl.textContent = tool.name;
  if (tool.label && tool.label !== tool.name) {
    const lbl = document.createElement("span");
    lbl.className = "tm-tool-label";
    lbl.textContent = ` ${tool.label}`;
    nameEl.appendChild(lbl);
  }
  el.appendChild(nameEl);

  // Description
  if (tool.description) {
    const descEl = document.createElement("div");
    descEl.className = "tm-tool-desc";
    descEl.textContent = tool.description;
    el.appendChild(descEl);
  }

  // Parameters
  const params = tool.parameters ?? tool.input_schema;
  if (params?.properties && Object.keys(params.properties).length > 0) {
    const required = new Set(params.required ?? []);

    const sectionEl = document.createElement("div");
    sectionEl.className = "tm-tool-section";
    const sectionTitle = document.createElement("div");
    sectionTitle.className = "tm-tool-section-title";
    sectionTitle.textContent = `Parameters (${Object.keys(params.properties).length})`;
    sectionEl.appendChild(sectionTitle);

    const table = document.createElement("table");
    table.className = "tm-tool-params";

    // Header row
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const h of ["Name", "Type", "Description"]) {
      const th = document.createElement("th");
      th.textContent = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const [pName, pSchema] of Object.entries(params.properties) as [string, any][]) {
      const tr = document.createElement("tr");

      // Name cell
      const tdName = document.createElement("td");
      tdName.className = "tm-tool-param-name";
      const nameSpan = document.createElement("code");
      nameSpan.textContent = pName;
      tdName.appendChild(nameSpan);
      if (required.has(pName)) {
        const req = document.createElement("span");
        req.className = "tm-tool-required";
        req.textContent = "*";
        req.title = "required";
        tdName.appendChild(req);
      }
      tr.appendChild(tdName);

      // Type cell
      const tdType = document.createElement("td");
      tdType.className = "tm-tool-param-type";
      let typeStr = pSchema?.type ?? "any";
      if (pSchema?.enum) {
        typeStr = pSchema.enum.map((v: any) => `"${v}"`).join(" | ");
        if (typeStr.length > 60) {
          typeStr = pSchema.type + ` (${pSchema.enum.length} values)`;
        }
      } else if (pSchema?.type === "array" && pSchema.items?.type) {
        typeStr = `${pSchema.items.type}[]`;
      }
      tdType.textContent = typeStr;
      tr.appendChild(tdType);

      // Description cell
      const tdDesc = document.createElement("td");
      tdDesc.textContent = pSchema?.description ?? "";
      tr.appendChild(tdDesc);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    sectionEl.appendChild(table);
    el.appendChild(sectionEl);
  }

  return el;
}

// ─── Build L1 nodes from slim dump ───
function buildL1Nodes(dump: any): TreemapNode[] {
  const nodes: TreemapNode[] = [];

  // system_prompt
  const sp = dump.system_prompt;
  if (sp && sp.chars > 0) {
    nodes.push({
      key: "system_prompt",
      label: "system_prompt",
      chars: sp.chars,
      children: (sp.sections ?? []).map((s: any) => ({
        key: s.name,
        label: s.name,
        chars: s.chars,
      })),
    });
  }

  // tools
  const tools = dump.tools;
  if (tools && tools.chars > 0) {
    nodes.push({
      key: "tools",
      label: "tools",
      chars: tools.chars,
      children: (tools.definitions ?? []).map((d: any) => ({
        key: d.name,
        label: d.name,
        chars: d.schema_chars,
      })),
    });
  }

  // conversation_history — split into individual messages
  const ch = dump.conversation_history;
  if (ch && ch.chars > 0) {
    const msgSlim = ch.messages_slim ?? [];
    const children: TreemapNode[] = msgSlim.map((m: any) => ({
      key: String(m.index),
      label: `${m.role}[${m.index}]`,
      chars: m.chars,
    }));
    nodes.push({
      key: "conversation_history",
      label: "conversation_history",
      chars: ch.chars,
      children: children.length > 0 ? children : undefined,
    });
  }

  // current_prompt
  const cp = dump.current_prompt;
  if (cp && cp.chars > 0) {
    nodes.push({
      key: "current_prompt",
      label: "current_prompt",
      chars: cp.chars,
    });
  }

  return nodes;
}

// ─── Build L0 nodes from slim run ───
function buildL0Nodes(run: any): TreemapNode[] {
  return (run.calls ?? []).map((c: any) => ({
    key: `call-${c.index}`,
    label: `#${c.index}`,
    chars: c.totalChars,
  }));
}

// ─── Main mount function ───
export function mountContextTreemap(
  container: HTMLElement,
  footerEl: HTMLElement,
  breadcrumbEl: HTMLElement,
  reqFn: ReqFn,
  getSessionKey: () => string = () => "",
  costEl?: HTMLElement,
  modelEl?: HTMLElement,
): void {
  let currentDump: any = null;
  let currentRun: any = null;
  let selectedCallIndex: number | null = null;
  let level: 0 | 1 | 2 | 3 = 1;
  let drillParent: TreemapNode | null = null;
  let drillChild: TreemapNode | null = null;
  let l1Nodes: TreemapNode[] = [];
  let l0Nodes: TreemapNode[] = [];
  let inputPricePerMTok = 3; // default Sonnet pricing
  let currentModel = "";

  // ─── Render empty state ───
  function renderEmpty(msg = "No forensic dump loaded. Toggle 🛡️, send a message, then click ↻") {
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
    const isMultiCall = currentRun && currentRun.callCount > 1;
    if (level === 0 || (level === 1 && !isMultiCall)) {
      breadcrumbEl.innerHTML = "";
      return;
    }
    let html = "";
    if (isMultiCall) {
      html += `<span data-nav="0">Run</span>`;
      if (level >= 1 && selectedCallIndex !== null) {
        html += ` › <span data-nav="1">Call #${selectedCallIndex}</span>`;
      }
    } else {
      html += `<span data-nav="1">Context</span>`;
    }
    if (level >= 2 && drillParent) {
      html += ` › <span data-nav="2">${esc(drillParent.label)}</span>`;
    }
    if (level === 3 && drillChild) {
      html += ` › <span>${esc(drillChild.label)}</span>`;
    }
    breadcrumbEl.innerHTML = html;

    // Wire breadcrumb clicks
    breadcrumbEl.querySelectorAll("[data-nav]").forEach((el) => {
      el.addEventListener("click", () => {
        const target = parseInt((el as HTMLElement).dataset.nav!, 10) as 0 | 1 | 2;
        if (target === 0) {
          level = 0;
          selectedCallIndex = null;
          drillParent = null;
          drillChild = null;
          renderLevel();
        } else if (target === 1) {
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
    const totalChars = nodes.reduce((s, n) => s + n.chars, 0);
    const bounds: Rect = { x: 0, y: 0, w: container.offsetWidth, h: container.offsetHeight };
    const rects = squarify(nodes, bounds);

    for (const r of rects) {
      const box = document.createElement("div");
      box.className = "tm-box";

      // Color: L1 uses category color, L2 uses parent's hue with varying lightness
      let bg: string;
      if (parentKey) {
        const idx = nodes.indexOf(r.node);
        const lightness = 40 + (idx / Math.max(nodes.length - 1, 1)) * 25;
        bg = categoryHsl(parentKey, lightness);
      } else {
        bg = categoryHsl(r.node.key);
      }

      box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${bg};`;

      // Labels based on box size
      if (r.w >= 40 && r.h >= 30) {
        const lbl = document.createElement("div");
        lbl.className = "tm-lbl";
        lbl.textContent = r.node.label;
        box.appendChild(lbl);

        if (r.w >= 60 && r.h >= 44) {
          const sub = document.createElement("div");
          sub.className = "tm-sub";
          const cost = charsCost(r.node.chars, inputPricePerMTok);
          sub.textContent = `${fmtChars(r.node.chars)}  ${pct(r.node.chars, totalChars)}  ${fmtUsd(cost)}`;
          box.appendChild(sub);

          // Summary button
          const sumBtn = document.createElement("button");
          sumBtn.className = "tm-summary-btn";
          sumBtn.textContent = "\u2728";
          sumBtn.title = "Summarize";
          sumBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            onSummaryClick(sumBtn, box, r.node, parentKey);
          });
          box.appendChild(sumBtn);
        }
      }

      // Click handler
      box.addEventListener("click", () => onBoxClick(r.node, parentKey));
      container.appendChild(box);
    }
  }

  // ─── Summary click (on treemap box) ───
  async function onSummaryClick(
    btn: HTMLButtonElement,
    box: HTMLElement,
    node: TreemapNode,
    parentKey: string | null,
  ) {
    const origText = btn.textContent;
    btn.textContent = "\u23F3";
    btn.style.pointerEvents = "none";

    // Determine component + key for the API call
    const component = parentKey ?? node.key;
    const key = parentKey ? node.key : undefined;

    try {
      const params: any = { component, key };
      if (selectedCallIndex !== null) {
        params.callIndex = selectedCallIndex;
      }
      const sk = getSessionKey();
      if (sk) {
        params.sessionKey = sk;
      }
      const result = await reqFn("forensic.summarize", params);
      const summaryText = result?.summary ?? "(no summary)";

      // Show overlay on the box
      const overlay = document.createElement("div");
      overlay.className = "tm-summary-overlay";
      const closeBtn = document.createElement("button");
      closeBtn.className = "tm-summary-close";
      closeBtn.textContent = "\u2715";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        overlay.remove();
      });
      const textEl = document.createElement("div");
      textEl.className = "tm-summary-text";
      textEl.textContent = summaryText;
      overlay.appendChild(closeBtn);
      overlay.appendChild(textEl);
      overlay.addEventListener("click", (e) => e.stopPropagation());
      box.appendChild(overlay);
    } catch (e: any) {
      btn.textContent = "\u26A0";
      btn.title = e?.message ?? "Summary failed";
      btn.style.pointerEvents = "";
      setTimeout(() => {
        btn.textContent = origText!;
        btn.title = "Summarize";
      }, 3000);
      return;
    }
    btn.style.pointerEvents = "";
    btn.textContent = origText!;
  }

  // ─── Box click ───
  function onBoxClick(node: TreemapNode, parentKey: string | null) {
    if (level === 1) {
      // Drill to L2
      if (node.children && node.children.length > 0) {
        drillParent = node;
        level = 2;
        renderLevel();
      } else {
        // No children — show detail directly
        drillParent = node;
        drillChild = node;
        level = 3;
        showL3Preview(node.key, undefined);
      }
    } else if (level === 2 && drillParent) {
      // Drill to L3
      drillChild = node;
      level = 3;
      showL3Preview(drillParent.key, node.key);
    }
  }

  // ─── L3 preview ───
  async function showL3Preview(component: string, key: string | undefined) {
    renderBreadcrumb();
    // Use the node's chars (from schema_chars in the dump) — this is the reliable count
    const nodeChars = drillChild?.chars ?? 0;
    const estTokens = Math.ceil(nodeChars / 4);
    // Use the category color as background
    const bgKey = drillParent?.key ?? component;
    const bg = categoryHsl(bgKey, 30);

    container.innerHTML = `<div class="tm-preview" style="background:${bg}"><div class="tm-preview-meta">Loading...</div></div>`;

    try {
      const detailParams: any = { component, key };
      if (selectedCallIndex !== null) {
        detailParams.callIndex = selectedCallIndex;
      }
      const sk = getSessionKey();
      if (sk) {
        detailParams.sessionKey = sk;
      }
      const detail = await reqFn("forensic.getLiveDetail", detailParams);

      const text = detail?.text || JSON.stringify(detail, null, 2);

      const previewEl = document.createElement("div");
      previewEl.className = "tm-preview";
      previewEl.style.background = bg;

      const headerEl = document.createElement("div");
      headerEl.className = "tm-preview-header";
      headerEl.textContent = key ?? component;

      const metaEl = document.createElement("div");
      metaEl.className = "tm-preview-meta";
      metaEl.textContent = `${fmtChars(nodeChars)} chars \u00b7 ~${fmtChars(estTokens)} tokens \u00b7 ${component}`;

      const bodyEl = document.createElement("div");

      // Rich rendering for tools
      const richEl = component === "tools" && key ? renderToolDetail(text) : null;
      let viewMode: "rich" | "raw" | "summary" = richEl ? "rich" : "raw";

      function setBody(mode: "rich" | "raw" | "summary", summaryText?: string) {
        bodyEl.innerHTML = "";
        viewMode = mode;
        if (mode === "rich" && richEl) {
          bodyEl.appendChild(richEl);
        } else if (mode === "summary" && summaryText) {
          const s = document.createElement("div");
          s.className = "tm-tool-desc";
          s.textContent = summaryText;
          bodyEl.appendChild(s);
        } else {
          bodyEl.textContent = text;
        }
      }

      // Summarize button
      const sumBtn = document.createElement("button");
      sumBtn.className = "tm-preview-summary-btn";
      sumBtn.textContent = "\u2728 Summarize";
      sumBtn.addEventListener("click", async () => {
        if (viewMode === "summary") {
          setBody(richEl ? "rich" : "raw");
          sumBtn.textContent = "\u2728 Summarize";
          return;
        }
        sumBtn.textContent = "\u23F3 Summarizing\u2026";
        sumBtn.style.pointerEvents = "none";
        try {
          const sumParams: any = { component, key };
          if (selectedCallIndex !== null) {
            sumParams.callIndex = selectedCallIndex;
          }
          const sk = getSessionKey();
          if (sk) {
            sumParams.sessionKey = sk;
          }
          const result = await reqFn("forensic.summarize", sumParams);
          setBody("summary", result?.summary ?? "(no summary)");
          sumBtn.textContent = "\u{1F519} Back";
        } catch (e: any) {
          const msg = e?.message ?? (typeof e === "string" ? e : "Summary failed");
          sumBtn.textContent = "\u26A0 Failed";
          sumBtn.title = msg;
          setTimeout(() => {
            sumBtn.textContent = "\u2728 Summarize";
            sumBtn.title = "";
          }, 3000);
        } finally {
          sumBtn.style.pointerEvents = "";
        }
      });
      headerEl.appendChild(sumBtn);

      // Raw/Parsed toggle for rich views
      if (richEl) {
        const rawBtn = document.createElement("button");
        rawBtn.className = "tm-preview-summary-btn";
        rawBtn.textContent = "\u{1F4C4} Raw";
        rawBtn.style.marginLeft = "4px";
        rawBtn.addEventListener("click", () => {
          if (viewMode === "raw") {
            setBody("rich");
            rawBtn.textContent = "\u{1F4C4} Raw";
          } else {
            setBody("raw");
            rawBtn.textContent = "\u{1F527} Parsed";
          }
        });
        headerEl.appendChild(rawBtn);
      }

      // Initialize body
      setBody(richEl ? "rich" : "raw");

      previewEl.appendChild(headerEl);
      previewEl.appendChild(metaEl);
      previewEl.appendChild(bodyEl);

      container.innerHTML = "";
      container.appendChild(previewEl);
    } catch (e: any) {
      container.innerHTML = `<div class="tm-preview" style="background:${bg}"><div class="tm-preview-header">Error</div><div class="tm-preview-meta">${esc(e?.message ?? String(e))}</div></div>`;
    }
  }

  // ─── Render L0 boxes (call overview) ───
  function renderL0Boxes() {
    container.innerHTML = "";
    const totalChars = l0Nodes.reduce((s, n) => s + n.chars, 0);
    const bounds: Rect = { x: 0, y: 0, w: container.offsetWidth, h: container.offsetHeight };
    const rects = squarify(l0Nodes, bounds);

    for (const r of rects) {
      const box = document.createElement("div");
      box.className = "tm-box tm-l0-box";

      const idx = l0Nodes.indexOf(r.node);
      const call = currentRun?.calls?.[idx];
      const hue = L0_HUES[idx % L0_HUES.length];
      const bg = `hsl(${hue},55%,38%)`;

      box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${bg};`;

      if (r.w >= 40 && r.h >= 30) {
        const lbl = document.createElement("div");
        lbl.className = "tm-lbl";
        lbl.textContent = `#${idx}`;
        box.appendChild(lbl);

        if (r.w >= 60 && r.h >= 44) {
          const sub = document.createElement("div");
          sub.className = "tm-sub";
          const model = call?.model ?? "";
          const estTok = call?.estimatedTokens ?? Math.ceil(r.node.chars / 4);
          const delta = call?.deltaMsFromFirst ?? 0;
          const deltaStr = delta > 0 ? ` +${(delta / 1000).toFixed(1)}s` : "";
          sub.textContent = `${fmtChars(estTok)} tok · ${model}${deltaStr}`;
          box.appendChild(sub);
        }

        if (r.w >= 50 && r.h >= 36) {
          const pctEl = document.createElement("div");
          pctEl.className = "tm-sub";
          const cost = charsCost(r.node.chars, inputPricePerMTok);
          pctEl.textContent = `${pct(r.node.chars, totalChars)}  ${fmtUsd(cost)}`;
          box.appendChild(pctEl);
        }
      }

      box.addEventListener("click", () => onL0Click(idx));
      container.appendChild(box);
    }
  }

  // ─── L0 click → fetch call's slim dump, transition to L1 ───
  async function onL0Click(callIdx: number) {
    selectedCallIndex = callIdx;
    container.innerHTML = `<div class="tm-empty">Loading call #${callIdx}...</div>`;
    try {
      const sk = getSessionKey();
      const dump = await reqFn("forensic.getCallLive", {
        index: callIdx,
        sessionKey: sk || undefined,
      });
      currentDump = dump;
      if (dump._pricing) {
        inputPricePerMTok = dump._pricing.input ?? 3;
      }
      currentModel = dump.meta?.model ?? currentModel;
      l1Nodes = buildL1Nodes(dump);
      level = 1;
      renderLevel();
    } catch (e: any) {
      renderEmpty(`Failed to load call #${callIdx}`);
    }
  }

  // ─── Render current level ───
  function renderLevel() {
    renderBreadcrumb();

    if (level === 0) {
      if (!currentRun || l0Nodes.length === 0) {
        renderEmpty();
        return;
      }
      renderL0Boxes();
      const totalCost = charsCost(
        currentRun.totalChars ?? l0Nodes.reduce((s: number, n: TreemapNode) => s + n.chars, 0),
        inputPricePerMTok,
      );
      footerEl.textContent = `${currentRun.callCount} calls · ${fmtChars(currentRun.estimatedTokens)} est. tokens · ${fmtUsd(totalCost)}`;
      if (costEl) {
        costEl.textContent = fmtUsd(totalCost);
      }
      if (modelEl) {
        modelEl.textContent = currentModel ? `(${currentModel})` : "";
      }
      return;
    }

    if (!currentDump) {
      renderEmpty();
      return;
    }

    if (level === 1) {
      renderBoxes(l1Nodes, null);
      const t = currentDump.totals ?? {};
      const model = currentDump.meta?.model ?? "";
      const callLabel =
        selectedCallIndex !== null && currentRun?.callCount > 1
          ? `Call #${selectedCallIndex} · `
          : "";
      const totalCost = charsCost(t.chars ?? 0, inputPricePerMTok);
      footerEl.textContent = `${callLabel}${fmtChars(t.estimated_tokens ?? 0)} est. tokens · ${model} · ${fmtUsd(totalCost)}`;
      if (costEl && !(currentRun?.callCount > 1)) {
        costEl.textContent = fmtUsd(totalCost);
      }
      if (modelEl && !(currentRun?.callCount > 1)) {
        modelEl.textContent = currentModel ? `(${currentModel})` : "";
      }
    } else if (level === 2 && drillParent) {
      const children = drillParent.children ?? [];
      if (children.length === 0) {
        renderBoxes([drillParent], drillParent.key);
      } else {
        renderBoxes(children, drillParent.key);
      }
      const cost = charsCost(drillParent.chars, inputPricePerMTok);
      footerEl.textContent = `${drillParent.label} · ${fmtChars(drillParent.chars)} chars · ${fmtUsd(cost)}`;
    } else if (level === 3) {
      // L3 is handled by showL3Preview
    }
  }

  // ─── Load latest dump ───
  async function loadLatest() {
    container.innerHTML = `<div class="tm-empty">Loading...</div>`;
    try {
      const sk = getSessionKey();
      const dump = await reqFn("forensic.getLive", { sessionKey: sk || undefined });
      currentDump = dump;
      currentRun = dump._run ?? null;
      if (dump._pricing) {
        inputPricePerMTok = dump._pricing.input ?? 3;
      }
      currentModel = dump.meta?.model ?? "";
      l1Nodes = buildL1Nodes(dump);
      drillParent = null;
      drillChild = null;
      selectedCallIndex = null;

      // Multi-call run → start at L0; single-call → skip to L1
      if (currentRun && currentRun.callCount > 1) {
        l0Nodes = buildL0Nodes(currentRun);
        level = 0;
      } else {
        l0Nodes = [];
        level = 1;
      }
      renderLevel();
    } catch (e: any) {
      renderEmpty(`No context yet — send a message first`);
    }
  }

  // ─── Escape key handler ───
  const isMultiCall = () => currentRun && currentRun.callCount > 1;

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
      } else if (level === 1 && isMultiCall()) {
        level = 0;
        selectedCallIndex = null;
        drillParent = null;
        drillChild = null;
        renderLevel();
      }
    }
  });

  // ─── Public hooks ───
  (container as any).__treemapRefresh = loadLatest;
  (container as any).__treemapBack = () => {
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
    } else if (level === 1 && isMultiCall()) {
      level = 0;
      selectedCallIndex = null;
      drillParent = null;
      drillChild = null;
      renderLevel();
    }
  };
  (container as any).__treemapCanGoBack = () => {
    if (level > 1) {
      return true;
    }
    if (level === 1 && isMultiCall()) {
      return true;
    }
    return false;
  };
  (container as any).__treemapLevel = () => level;
  (container as any).__treemapTotalChars = () => l1Nodes.reduce((s, n) => s + n.chars, 0);

  // Initial state
  renderEmpty();
}
