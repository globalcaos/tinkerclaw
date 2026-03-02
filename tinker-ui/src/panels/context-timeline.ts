/**
 * Context Timeline — stacked bar chart of LLM call composition.
 * Ring buffer of last 40 calls. Colors from Mission Control anatomy page.
 */

// ─── Segment palette (shared with treemap) ───
export const SEGMENT_COLORS: Record<string, string> = {
  systemPrompt: "#6366f1",
  injectedFiles: "#22c55e",
  skills: "#eab308",
  toolSchemas: "#f97316",
  conversation: "#ef4444",
  toolResults: "#a855f7",
  userMessage: "#94a3b8",
};

export const RESPONSE_COLOR = "#c084fc"; // purple-400 — LLM output

export const SEGMENT_LABELS: Record<string, string> = {
  systemPrompt: "System",
  injectedFiles: "Files",
  skills: "Skills",
  toolSchemas: "Tools",
  conversation: "Conv",
  toolResults: "Results",
  userMessage: "User",
};

// Ordered top-to-bottom in the stacked bar (rendered bottom-to-top via column-reverse)
const SEGMENT_ORDER = [
  "systemPrompt",
  "injectedFiles",
  "skills",
  "toolSchemas",
  "conversation",
  "toolResults",
  "userMessage",
];

export interface AnatomyEvent {
  turn?: number;
  model?: string;
  provider?: string;
  contextSent?: {
    systemPromptTokens?: number;
    injectedFiles?: Array<{ name: string; chars: number; tokens: number }>;
    injectedFilesTotalTokens?: number;
    skillsTokens?: number;
    toolSchemasTokens?: number;
    conversationHistoryTokens?: number;
    toolResultsTokens?: number;
    userMessageTokens?: number;
    totalTokens?: number;
    [k: string]: any;
  };
  contextWindow?: {
    maxTokens?: number;
    usedTokens?: number;
    utilizationPercent?: number;
  };
  responseTokens?: number;
  timestampMs?: number;
  timestamp?: string;
  [k: string]: any;
}

interface BufferEntry {
  event: AnatomyEvent;
  runId?: string;
  groupId: string;
}

interface TimelineController {
  pushEvent(event: AnatomyEvent, runId?: string): void;
  loadSession(sessionKey: string): void;
  clear(): void;
  getSelected(): AnatomyEvent | null;
}

const MAX_BUFFER = 60;
// Per-column chrome: provider icon (14+2) + timestamp (7+2) + group border-bottom (2+2) = 29px
const COLUMN_CHROME_PX = 29;

// Map our segment keys to the flat field names in contextSent
const SEGMENT_TOKEN_FIELDS: Record<string, string> = {
  systemPrompt: "systemPromptTokens",
  injectedFiles: "injectedFilesTotalTokens",
  skills: "skillsTokens",
  toolSchemas: "toolSchemasTokens",
  conversation: "conversationHistoryTokens",
  toolResults: "toolResultsTokens",
  userMessage: "userMessageTokens",
};

export type BarSelectMode = "context" | "response" | "context-summarize" | "response-summarize";

export function mountContextTimeline(
  container: HTMLElement,
  onBarSelect: (event: AnatomyEvent, mode: BarSelectMode) => void,
  getSessionKey: () => string,
  getGatewayBase: () => string,
  providerIcons?: Record<string, string>,
  onGroupLineClick?: (groupIndex: number, firstEvent: AnatomyEvent) => void,
): TimelineController {
  const buffer: BufferEntry[] = [];
  let selectedIdx: number | null = null;
  let selectedMode: "context" | "response" = "context";
  let groupCounter = 0;
  let tooltipEl: HTMLElement | null = null;

  // ─── Tooltip ───
  function showTooltip(x: number, y: number, entry: BufferEntry) {
    removeTooltip();
    const ev = entry.event;
    const tip = document.createElement("div");
    tip.className = "ct-tooltip";
    const model = cleanModelName(ev.model ?? "unknown");
    const turn = ev.turn ?? "?";
    const total = totalTokensFor(ev);
    const max = maxTokensFor(ev);
    const util = ev.contextWindow?.utilizationPercent;
    const utilStr = util != null ? `${util.toFixed(0)}%` : "?";
    const respStr = ev.responseTokens ? ` · ${fmtK(ev.responseTokens)} out` : "";
    tip.textContent = `${model} · T${turn} · ${fmtK(total)}/${fmtK(max)} in · ${utilStr}${respStr}`;
    tip.style.left = `${x + 10}px`;
    tip.style.top = `${y - 28}px`;
    document.body.appendChild(tip);
    tooltipEl = tip;
  }

  function removeTooltip() {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  }

  // ─── Helpers ───
  function cleanModelName(model: string): string {
    return model.replace(/^claude-/, "");
  }

  function shortModelName(model: string): string {
    if (!model) return "";
    // Extract recognizable short name from model IDs like "claude-sonnet-4-6", "qwen3:14b-q4_K_M", "gemini-3-flash-preview"
    const m = model.toLowerCase();
    if (m.includes("opus")) return "opus";
    if (m.includes("sonnet")) return "sonnet";
    if (m.includes("haiku")) return "haiku";
    if (m.includes("qwen")) return model.split(":")[0]; // "qwen3"
    if (m.includes("gemini")) {
      const parts = model.replace("gemini-", "").split("-");
      return "gemini-" + parts.slice(0, 2).join("-"); // "gemini-3-flash"
    }
    if (m.includes("gpt-4")) return "gpt-4o";
    if (m.includes("gpt-3")) return "gpt-3.5";
    if (m.includes("deepseek")) return "deepseek";
    if (m.includes("llama")) return model.split(":")[0];
    if (m.includes("mistral")) return "mistral";
    // Fallback: first segment before colon or dash-number
    return model.split(":")[0].split(/-\d/)[0];
  }

  function fmtK(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
    return String(n);
  }

  function fmtTime(ev: AnatomyEvent): string {
    const ms = ev.timestampMs;
    if (ms) {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    if (ev.timestamp) {
      const d = new Date(ev.timestamp);
      if (!isNaN(d.getTime())) {
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      }
    }
    return "";
  }

  function getSegmentTokens(ev: AnatomyEvent): { key: string; tokens: number }[] {
    const cs = ev.contextSent;
    if (!cs) return [];
    const out: { key: string; tokens: number }[] = [];
    for (const key of SEGMENT_ORDER) {
      const field = SEGMENT_TOKEN_FIELDS[key];
      const tokens = cs[field] ?? 0;
      if (tokens > 0) out.push({ key, tokens });
    }
    return out;
  }

  function totalTokensFor(ev: AnatomyEvent): number {
    return ev.contextWindow?.usedTokens ?? ev.contextSent?.totalTokens ?? 0;
  }

  function maxTokensFor(ev: AnatomyEvent): number {
    return ev.contextWindow?.maxTokens ?? 200_000;
  }

  // ─── Grouping by turn number ───
  function getTimestampMs(ev: AnatomyEvent): number {
    return ev.timestampMs ?? (ev.timestamp ? new Date(ev.timestamp).getTime() : 0);
  }

  function assignGroupId(runId?: string, ev?: AnatomyEvent): string {
    if (runId) return `run-${runId}`;
    // Group by turn number: same turn = same prompt
    if (ev?.turn != null && buffer.length > 0) {
      const last = buffer[buffer.length - 1];
      if (last.event.turn === ev.turn) {
        return last.groupId;
      }
    }
    // Fallback: time-gap heuristic (60s)
    if (ev && buffer.length > 0) {
      const tsMs = getTimestampMs(ev);
      const last = buffer[buffer.length - 1];
      const lastTs = getTimestampMs(last.event);
      if (tsMs && lastTs && Math.abs(tsMs - lastTs) < 60_000) {
        return last.groupId;
      }
    }
    return `grp-${++groupCounter}`;
  }

  // ─── Buffer operations ───
  function push(entry: BufferEntry) {
    if (buffer.length >= MAX_BUFFER) {
      buffer.shift();
      if (selectedIdx !== null) {
        selectedIdx--;
        if (selectedIdx < 0) selectedIdx = null;
      }
    }
    buffer.push(entry);
  }

  // ─── Render ───
  function render() {
    container.innerHTML = "";

    if (buffer.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ct-empty";
      empty.textContent = "No LLM calls yet";
      container.appendChild(empty);
      return;
    }

    // Compute available bar height: clientHeight includes padding, so subtract it
    const containerH = container.clientHeight || 200;
    const cs = getComputedStyle(container);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    const contentH = containerH - padTop - padBot;
    const maxBarHeight = Math.max(20, contentH - COLUMN_CHROME_PX);

    // Find global max tokens across all bars for uniform scaling
    let globalMax = 0;
    for (const entry of buffer) {
      const m = maxTokensFor(entry.event);
      if (m > globalMax) globalMax = m;
    }
    if (globalMax <= 0) globalMax = 200_000;

    // Pre-compute response tokens for independent scaling
    const respTokensArr: number[] = [];
    for (const entry of buffer) {
      const ev = entry.event;
      const sent = ev.contextSent?.totalTokens ?? 0;
      respTokensArr.push(
        ev.responseTokens ?? (sent > 0 ? Math.max(500, Math.round(sent * 0.12)) : 0),
      );
    }
    let maxRespTokens = 0;
    for (const r of respTokensArr) {
      if (r > maxRespTokens) maxRespTokens = r;
    }
    if (maxRespTokens <= 0) maxRespTokens = 1;

    // Legend (sticky right)
    const legend = document.createElement("div");
    legend.className = "ct-legend";
    for (const key of SEGMENT_ORDER) {
      const item = document.createElement("span");
      item.className = "ct-legend-item";
      const swatch = document.createElement("span");
      swatch.className = "ct-legend-swatch";
      swatch.style.background = SEGMENT_COLORS[key];
      item.appendChild(swatch);
      const lbl = document.createTextNode(SEGMENT_LABELS[key]);
      item.appendChild(lbl);
      legend.appendChild(item);
    }
    // Response legend entry
    const respItem = document.createElement("span");
    respItem.className = "ct-legend-item";
    const respSwatch = document.createElement("span");
    respSwatch.className = "ct-legend-swatch";
    respSwatch.style.background = RESPONSE_COLOR;
    respItem.appendChild(respSwatch);
    respItem.appendChild(document.createTextNode("Response"));
    legend.appendChild(respItem);
    container.appendChild(legend);

    // Group entries and render
    let currentGroupId: string | null = null;
    let groupEl: HTMLElement | null = null;
    let groupIndex = -1;

    for (let i = 0; i < buffer.length; i++) {
      const entry = buffer[i];

      // Start new group?
      if (entry.groupId !== currentGroupId) {
        groupEl = document.createElement("div");
        groupEl.className = "ct-group";
        groupIndex++;

        // Vertical blue line at group start — click scrolls to matching prompt
        if (onGroupLineClick) {
          const line = document.createElement("div");
          line.className = "ct-group-line";
          line.title = "Scroll to prompt";
          const gi = groupIndex;
          const firstEv = entry.event;
          line.addEventListener("click", () => onGroupLineClick(gi, firstEv));
          groupEl.appendChild(line);
        }

        container.appendChild(groupEl);
        currentGroupId = entry.groupId;
      }

      const ev = entry.event;
      const total = totalTokensFor(ev);
      const max = maxTokensFor(ev);

      // Column wrapper: icon + bar-area + timestamp
      const col = document.createElement("div");
      col.className = "ct-col";

      // Bar area: uniform height for all bars, acts as the chart canvas
      const barArea = document.createElement("div");
      barArea.className = "ct-bar-area";
      barArea.style.height = `${maxBarHeight}px`;

      // Provider icon + short model label — inside bar-area so it sits just above the bar
      const iconEl = document.createElement("div");
      iconEl.className = "ct-provider";
      const provider = ev.provider ?? "";
      if (providerIcons && providerIcons[provider]) {
        iconEl.innerHTML = providerIcons[provider];
      } else if (provider) {
        iconEl.textContent = provider[0].toUpperCase();
        iconEl.style.fontSize = "9px";
        iconEl.style.fontWeight = "700";
        iconEl.style.color = "var(--muted)";
      }
      // Short model label: "opus", "sonnet", "qwen3", "gemini", etc.
      const modelShort = shortModelName(ev.model ?? "");
      if (modelShort) {
        iconEl.title = `${provider}/${cleanModelName(ev.model ?? "")}`;
      }
      barArea.appendChild(iconEl);

      // Bar: scaled to usedTokens / globalMax, grows from bottom
      const barHeight = Math.max(4, (total / globalMax) * maxBarHeight);
      const bar = document.createElement("div");
      bar.className =
        "ct-bar" + (i === selectedIdx && selectedMode === "context" ? " ct-selected" : "");
      bar.style.height = `${barHeight}px`;

      // Build segments
      const segments = getSegmentTokens(ev);
      const segTotal = segments.reduce((s, seg) => s + seg.tokens, 0);

      for (const seg of segments) {
        const el = document.createElement("div");
        el.className = "ct-segment";
        const pct = segTotal > 0 ? (seg.tokens / segTotal) * 100 : 0;
        el.style.height = `${pct}%`;
        el.style.background = SEGMENT_COLORS[seg.key];
        bar.appendChild(el);
      }

      // Click — select; re-click triggers auto-summary
      const idx = i;
      bar.addEventListener("click", () => {
        const isReclick = selectedIdx === idx && selectedMode === "context";
        selectedIdx = idx;
        selectedMode = "context";
        onBarSelect(buffer[idx].event, isReclick ? "context-summarize" : "context");
        render();
      });

      // Hover
      bar.addEventListener("mouseenter", (e) => {
        showTooltip(e.clientX, e.clientY, entry);
      });
      bar.addEventListener("mousemove", (e) => {
        if (tooltipEl) {
          tooltipEl.style.left = `${e.clientX + 10}px`;
          tooltipEl.style.top = `${e.clientY - 28}px`;
        }
      });
      bar.addEventListener("mouseleave", removeTooltip);

      barArea.appendChild(bar);

      // Max-token line: this model's context window within the uniform canvas
      const maxLinePx = (max / globalMax) * maxBarHeight;
      const maxLine = document.createElement("div");
      maxLine.className = "ct-maxline";
      maxLine.style.bottom = `${maxLinePx}px`;
      barArea.appendChild(maxLine);

      col.appendChild(barArea);

      // Timestamp below bar
      const tsEl = document.createElement("div");
      tsEl.className = "ct-ts";
      tsEl.textContent = fmtTime(ev);
      col.appendChild(tsEl);

      groupEl!.appendChild(col);

      // Response bar — purple bar showing output tokens, scaled independently
      const respTokens = respTokensArr[i];
      const respEstimated = !ev.responseTokens && respTokens > 0;
      if (respTokens > 0) {
        const respCol = document.createElement("div");
        respCol.className = "ct-col ct-resp-col";

        const respBarArea = document.createElement("div");
        respBarArea.className = "ct-bar-area";
        respBarArea.style.height = `${maxBarHeight}px`;

        // Independent scale: biggest response = 75% of bar area, rest proportional
        const respHeight = Math.max(4, (respTokens / maxRespTokens) * maxBarHeight * 0.75);
        const respBar = document.createElement("div");
        respBar.className =
          "ct-resp-bar" + (i === selectedIdx && selectedMode === "response" ? " ct-selected" : "");
        respBar.style.height = `${respHeight}px`;
        respBar.style.background = RESPONSE_COLOR;

        // Hover tooltip for response bar
        respBar.addEventListener("mouseenter", (e) => {
          removeTooltip();
          const tip = document.createElement("div");
          tip.className = "ct-tooltip";
          tip.textContent = `Response · ${respEstimated ? "~" : ""}${fmtK(respTokens)} output tokens${respEstimated ? " (est)" : ""}`;
          tip.style.left = `${e.clientX + 10}px`;
          tip.style.top = `${e.clientY - 28}px`;
          document.body.appendChild(tip);
          tooltipEl = tip;
        });
        respBar.addEventListener("mousemove", (e) => {
          if (tooltipEl) {
            tooltipEl.style.left = `${e.clientX + 10}px`;
            tooltipEl.style.top = `${e.clientY - 28}px`;
          }
        });
        respBar.addEventListener("mouseleave", removeTooltip);

        // Click selects same call, switches to response tab; re-click triggers auto-summary
        respBar.addEventListener("click", () => {
          const isReclick = selectedIdx === idx && selectedMode === "response";
          selectedIdx = idx;
          selectedMode = "response";
          onBarSelect(buffer[idx].event, isReclick ? "response-summarize" : "response");
          render();
        });

        respBarArea.appendChild(respBar);
        respCol.appendChild(respBarArea);

        // Empty timestamp placeholder for alignment
        const respTs = document.createElement("div");
        respTs.className = "ct-ts";
        respCol.appendChild(respTs);

        groupEl!.appendChild(respCol);
      }
    }

    // No scroll needed — flex-end keeps newest bars on the right,
    // older bars overflow off the left edge.
  }

  // ─── Controller ───
  const ctrl: TimelineController = {
    pushEvent(event: AnatomyEvent, runId?: string) {
      const groupId = assignGroupId(runId, event);
      push({ event, runId, groupId });
      // Auto-select latest
      selectedIdx = buffer.length - 1;
      render();
      onBarSelect(event, "context");
    },

    async loadSession(sessionKey: string) {
      buffer.length = 0;
      selectedIdx = null;
      groupCounter = 0;

      if (!sessionKey) {
        render();
        return;
      }

      const base = getGatewayBase();
      try {
        const resp = await fetch(
          `${base}/api/context-anatomy/${encodeURIComponent(sessionKey)}?limit=${MAX_BUFFER}`,
        );
        if (!resp.ok) {
          render();
          return;
        }
        const body = await resp.json();
        // API returns { sessionKey, count, events: [...] }
        const events: AnatomyEvent[] = Array.isArray(body) ? body : (body?.events ?? []);
        if (events.length === 0) {
          render();
          return;
        }

        // Backfill with turn-based grouping
        for (const ev of events) {
          const groupId = assignGroupId(undefined, ev);
          push({ event: ev, groupId });
        }

        // Auto-select latest
        if (buffer.length > 0) {
          selectedIdx = buffer.length - 1;
          onBarSelect(buffer[selectedIdx].event, "context");
        }
      } catch {
        // API not available — show empty
      }
      render();
    },

    clear() {
      buffer.length = 0;
      selectedIdx = null;
      groupCounter = 0;
      render();
    },

    getSelected() {
      if (selectedIdx !== null && selectedIdx < buffer.length) {
        return buffer[selectedIdx].event;
      }
      return null;
    },
  };

  // Initial render
  render();

  return ctrl;
}
