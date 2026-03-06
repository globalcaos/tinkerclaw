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
  placeholder?: "pending" | "active" | "failed";
  failReason?: string;
}

interface TimelineController {
  pushEvent(event: AnatomyEvent, runId?: string): void;
  loadSession(sessionKey: string): void;
  clear(): void;
  getSelected(): AnatomyEvent | null;
  pushPlaceholder(turn: number): void;
  activatePlaceholder(runId: string, model: string, provider: string): void;
  failPlaceholder(runId: string, reason: string): void;
  replacePlaceholders(turn: number, realEvents: AnatomyEvent[]): void;
  setFilterMode(mode: "session" | "all"): void;
  getFilterMode(): "session" | "all";
  loadAllSessions(sessionKeys: string[]): void;
}

const MAX_BUFFER = 200;
// Per-column chrome: provider icon (16) + timestamp 2-line (24) + group border (4) + legend (16) = 60px
const COLUMN_CHROME_PX = 60;

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
  providerColors?: Record<string, string>,
  onFilterModeChange?: (mode: "session" | "all") => void,
): TimelineController {
  const buffer: BufferEntry[] = [];
  let selectedIdx: number | null = null;
  let selectedMode: "context" | "response" = "context";
  let groupCounter = 0;
  let tooltipEl: HTMLElement | null = null;
  let filterMode: "session" | "all" = "session";

  // ─── Tooltip ───
  function showTooltip(x: number, y: number, entry: BufferEntry) {
    removeTooltip();
    const ev = entry.event;
    const tip = document.createElement("div");
    tip.className = "ct-tooltip";
    if (entry.placeholder === "pending") {
      tip.textContent = "Sending prompt...";
    } else if (entry.placeholder === "active") {
      const model = cleanModelName(ev.model ?? "unknown");
      tip.textContent = `${model} — processing...`;
    } else if (entry.placeholder === "failed") {
      const model = cleanModelName(ev.model ?? "unknown");
      tip.textContent = `${model} — ${entry.failReason || "failed"}`;
    } else {
      const model = cleanModelName(ev.model ?? "unknown");
      const turn = ev.turn ?? "?";
      const total = totalTokensFor(ev);
      const max = maxTokensFor(ev);
      const util = ev.contextWindow?.utilizationPercent;
      const utilStr = util != null ? `${util.toFixed(0)}%` : "?";
      const respStr = ev.responseTokens ? ` · ${fmtK(ev.responseTokens)} out` : "";
      tip.textContent = `${model} · T${turn} · ${fmtK(total)}/${fmtK(max)} in · ${utilStr}${respStr}`;
    }
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

  const SHORT_MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  function fmtTime(ev: AnatomyEvent): { date: string; time: string } | null {
    let d: Date | null = null;
    const ms = ev.timestampMs;
    if (ms) {
      d = new Date(ms);
    } else if (ev.timestamp) {
      const parsed = new Date(ev.timestamp);
      if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d) return null;
    const date = `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return { date, time };
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
    // Filter mode toggle switch
    const switchWrap = document.createElement("span");
    switchWrap.className = "ct-switch";

    const lblSession = document.createElement("span");
    lblSession.className =
      "ct-switch-label" + (filterMode === "session" ? " ct-switch-label--active" : "");
    lblSession.textContent = "Session";
    switchWrap.appendChild(lblSession);

    const track = document.createElement("span");
    track.className = "ct-switch-track" + (filterMode === "all" ? " ct-switch-track--on" : "");
    const thumb = document.createElement("span");
    thumb.className = "ct-switch-thumb";
    track.appendChild(thumb);
    switchWrap.appendChild(track);

    const lblAll = document.createElement("span");
    lblAll.className = "ct-switch-label" + (filterMode === "all" ? " ct-switch-label--active" : "");
    lblAll.textContent = "All";
    switchWrap.appendChild(lblAll);

    switchWrap.addEventListener("click", () => {
      const newMode = filterMode === "session" ? "all" : "session";
      filterMode = newMode;
      if (onFilterModeChange) onFilterModeChange(newMode);
      render();
    });
    legend.appendChild(switchWrap);
    // Wrap legend in a zero-width sticky anchor so it stays visible without inflating scroll width
    const legendAnchor = document.createElement("div");
    legendAnchor.className = "ct-legend-anchor";
    legendAnchor.appendChild(legend);
    container.appendChild(legendAnchor);

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

        // Vertical blue lollipop at group start — click scrolls to matching prompt
        if (onGroupLineClick) {
          const line = document.createElement("div");
          line.className = "ct-group-line";
          line.style.height = `${Math.round(maxBarHeight * 0.75)}px`;
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
      const isPlaceholder = !!entry.placeholder;
      const isFailed = entry.placeholder === "failed";

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
      if (isFailed) {
        const badge = document.createElement("span");
        badge.className = "ct-fail-badge";
        badge.textContent = "\u2717";
        iconEl.appendChild(badge);
        iconEl.title = entry.failReason || "Failed";
      }
      barArea.appendChild(iconEl);

      // Bar: scaled to usedTokens / globalMax, grows from bottom
      const barHeight = isPlaceholder
        ? maxBarHeight
        : Math.max(4, (total / globalMax) * maxBarHeight);
      const bar = document.createElement("div");
      bar.className =
        "ct-bar" +
        (i === selectedIdx && selectedMode === "context" ? " ct-selected" : "") +
        (entry.placeholder === "pending" ? " ct-placeholder" : "") +
        (entry.placeholder === "active" ? " ct-placeholder ct-placeholder-active" : "") +
        (isFailed ? " ct-failed" : "");
      bar.style.height = `${barHeight}px`;

      if (isPlaceholder && !isFailed) {
        const phColor = providerColors?.[ev.provider ?? ""] || "#6b7280";
        bar.style.setProperty("--ct-placeholder-color", phColor);
        const seg = document.createElement("div");
        seg.className = "ct-segment";
        seg.style.height = "100%";
        seg.style.background = entry.placeholder === "active" ? phColor : "#6b7280";
        seg.style.opacity = "0.4";
        bar.appendChild(seg);
      } else {
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
      }

      // Click — select; re-click triggers auto-summary
      const idx = i;
      if (!isPlaceholder) {
        bar.addEventListener("click", () => {
          const isReclick = selectedIdx === idx && selectedMode === "context";
          selectedIdx = idx;
          selectedMode = "context";
          onBarSelect(buffer[idx].event, isReclick ? "context-summarize" : "context");
          render();
        });
      }

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

      // Bars row: context bar + response bar side by side, above the date
      const barsRow = document.createElement("div");
      barsRow.className = "ct-bars-row";

      barArea.appendChild(bar);

      // Per-model max-token line within the uniform canvas
      const maxLinePx = (max / globalMax) * maxBarHeight;
      const maxLine = document.createElement("div");
      maxLine.className = "ct-maxline";
      maxLine.style.bottom = `${maxLinePx}px`;
      barArea.appendChild(maxLine);

      barsRow.appendChild(barArea);

      // Response bar — side by side with context bar
      const respTokens = respTokensArr[i];
      const respEstimated = !ev.responseTokens && respTokens > 0;
      if (respTokens > 0 && !isPlaceholder) {
        const respBarArea = document.createElement("div");
        respBarArea.className = "ct-bar-area ct-resp-bar-area";
        respBarArea.style.height = `${maxBarHeight}px`;

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
        barsRow.appendChild(respBarArea);
      }

      col.appendChild(barsRow);

      // Timestamp below both bars (two lines: date + time)
      const tsEl = document.createElement("div");
      tsEl.className = "ct-ts";
      // Show timestamp for all entries — placeholders use current time
      const ts = fmtTime(ev);
      if (ts) {
        const dateLine = document.createElement("div");
        dateLine.textContent = ts.date;
        const timeLine = document.createElement("div");
        timeLine.textContent = ts.time;
        tsEl.appendChild(dateLine);
        tsEl.appendChild(timeLine);
      }
      col.appendChild(tsEl);

      groupEl!.appendChild(col);
    }

    // 100% capacity line — spans full scrollable width, positioned at top of bar areas
    const capLine = document.createElement("div");
    capLine.className = "ct-capacity-line";
    container.appendChild(capLine);
    // Position after layout: find first bar-area and align to its top edge
    requestAnimationFrame(() => {
      const firstBarArea = container.querySelector(".ct-bar-area") as HTMLElement | null;
      if (firstBarArea && container.contains(capLine)) {
        const containerRect = container.getBoundingClientRect();
        const barRect = firstBarArea.getBoundingClientRect();
        capLine.style.top = `${barRect.top - containerRect.top + container.scrollTop}px`;
        capLine.style.width = `${container.scrollWidth}px`;
      }
    });

    // Scroll to rightmost (newest) bars
    container.scrollLeft = container.scrollWidth;
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

    pushPlaceholder(turn: number) {
      // Synthetic pending entry — no real anatomy data
      const event: AnatomyEvent = { turn, timestampMs: Date.now() };
      const groupId = assignGroupId(undefined, event);
      push({ event, groupId, placeholder: "pending" });
      selectedIdx = buffer.length - 1;
      render();
    },

    activatePlaceholder(runId: string, model: string, provider: string) {
      // Find the latest pending placeholder and upgrade it to active
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].placeholder === "pending") {
          buffer[i].placeholder = "active";
          buffer[i].runId = runId;
          buffer[i].event.model = model;
          buffer[i].event.provider = provider;
          render();
          return;
        }
      }
      // No pending placeholder found — create a new active one
      const event: AnatomyEvent = { turn: undefined, model, provider, timestampMs: Date.now() };
      const groupId = assignGroupId(runId, event);
      push({ event, runId, groupId, placeholder: "active" });
      selectedIdx = buffer.length - 1;
      render();
    },

    failPlaceholder(runId: string, reason: string) {
      // Mark the active placeholder as failed, then add a new pending one for the next attempt
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].placeholder === "active" && buffer[i].runId === runId) {
          buffer[i].placeholder = "failed";
          buffer[i].failReason = reason;
          // Add a new pending placeholder in the same group for the next attempt
          const newEntry: BufferEntry = {
            event: { turn: buffer[i].event.turn, timestampMs: Date.now() },
            groupId: buffer[i].groupId,
            placeholder: "pending",
          };
          push(newEntry);
          selectedIdx = buffer.length - 1;
          render();
          return;
        }
      }
    },

    replacePlaceholders(turn: number, realEvents: AnatomyEvent[]) {
      // Remove all placeholder entries for this turn
      let groupId: string | null = null;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].placeholder && buffer[i].event.turn === turn) {
          if (!groupId) groupId = buffer[i].groupId;
          buffer.splice(i, 1);
          if (selectedIdx !== null && selectedIdx >= i) {
            selectedIdx = Math.max(0, selectedIdx - 1);
          }
        }
      }
      // Push real events, reusing the placeholder's groupId
      for (const ev of realEvents) {
        const gid = groupId ?? assignGroupId(undefined, ev);
        push({ event: ev, groupId: gid });
      }
      if (buffer.length > 0) {
        selectedIdx = buffer.length - 1;
      }
      render();
    },

    setFilterMode(mode: "session" | "all") {
      filterMode = mode;
      // Re-render will pick up the new toggle state
      render();
    },

    getFilterMode() {
      return filterMode;
    },

    async loadAllSessions(sessionKeys: string[]) {
      buffer.length = 0;
      selectedIdx = null;
      groupCounter = 0;
      const base = getGatewayBase();
      const allEvents: AnatomyEvent[] = [];
      await Promise.all(
        sessionKeys.map(async (sk) => {
          try {
            const resp = await fetch(
              `${base}/api/context-anatomy/${encodeURIComponent(sk)}?limit=${MAX_BUFFER}`,
            );
            if (!resp.ok) return;
            const body = await resp.json();
            const events: AnatomyEvent[] = Array.isArray(body) ? body : (body?.events ?? []);
            allEvents.push(...events);
          } catch {}
        }),
      );
      // Sort by timestamp ascending
      allEvents.sort((a, b) => {
        const ta = a.timestampMs ?? (a.timestamp ? new Date(a.timestamp).getTime() : 0);
        const tb = b.timestampMs ?? (b.timestamp ? new Date(b.timestamp).getTime() : 0);
        return ta - tb;
      });
      for (const ev of allEvents) {
        const groupId = assignGroupId(undefined, ev);
        push({ event: ev, groupId });
      }
      if (buffer.length > 0) {
        selectedIdx = buffer.length - 1;
        onBarSelect(buffer[selectedIdx].event, "context");
      }
      render();
    },
  };

  // Initial render
  render();

  return ctrl;
}
