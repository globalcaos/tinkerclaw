/**
 * Context Timeline — stacked bar chart of LLM call composition.
 * Ring buffer of last 40 calls. Colors from Mission Control anatomy page.
 */

// Type-only: call-timeline.ts imports this module's palette at RUNTIME, so a value import back
// would close a cycle. The column below reads the call timeline's record, never its code.
import type { TimelineCall } from "./call-timeline.js";
import { getRoutedLogoSvg } from "./provider-logos.js";

// ─── Segment palette (shared with treemap) ───
//
// FORK 2026-09-24 (B1, context-window-panel.md §5.8) — `moralCode` leads the table because it
// leads the BAR (P3: fixed order, moral code first, never truncated). The key order here IS the
// draw order, so this is not cosmetic.
//
// The hex was not picked by eye. context-cache.bar.test.ts measures the OKLab ΔE of this key
// against every other key, against RESPONSE_COLOR, against `--red` (the token the absent-moral-code
// slot is outlined in) and against both papers a segment sits on. Measured 2026-09-24: the nearest
// rival is RESPONSE_COLOR at 0.133, then `conversation` at 0.150 and `--red` at 0.145 — all above
// the 0.12 floor the test states, and better than two pairs the bar already ships (toolSchemas vs
// conversation, 0.104). Rejected with its number: fuchsia-400 #e879f9, 0.068 against RESPONSE_COLOR,
// i.e. under the 0.12 floor and under every pair the bar already draws — the magenta end is spent.
export const SEGMENT_COLORS: Record<string, string> = {
  moralCode: "#f472b6",
  systemPrompt: "#6366f1",
  injectedFiles: "#22c55e",
  skills: "#eab308",
  toolSchemas: "#f97316",
  conversation: "#ef4444",
  // FORK 2026-09-30 (the architect: "remove the purple from that graph ... this graph only is supposed to
  // visualize the input tokens"). Tool results ARE input: the tool's output, fed back to the model
  // in the prompt (context-anatomy.ts counts the `toolResult` messages). They were purple-500, one
  // shade from RESPONSE_COLOR (0.110 OKLab ΔE), so a fifth of the prompt read as the model's own
  // output. Lime-400 keeps them on the bar and leaves purple to mean output only: ΔE 0.405 against
  // RESPONSE_COLOR, 0.146 to its nearest key (injectedFiles), 0.62 to the paper.
  toolResults: "#a3e635",
  userMessage: "#94a3b8",
  // response segments
  responseThinking: "#06b6d4", // cyan-500  (thinking/reasoning)
  responseText: "#10b981", // emerald-500 (text output)
  responseToolCalls: "#f59e0b", // amber-500 (tool call inputs)
};

export const RESPONSE_COLOR = "#c084fc"; // purple-400 — LLM output

/**
 * The moral-code pack's wire marker — the ONE copy the UI is allowed to hold.
 *
 * FORK 2026-09-24 (B1). `src/moral-code/contract.ts` owns this string gateway-side (same name, so
 * one grep finds both), but the tinker-ui bundle has its own vite root and does not import from
 * `src/`, so the UI needs a mirror. It gets exactly one: this module already owns the segment's
 * identity (colour, label, draw order), which makes it the honest home for "what the pack looks
 * like on the wire" too.
 *
 * OWED, not done here: `tinker-ui/src/injected-context.ts` still declares MORAL_CODE_OPEN /
 * MORAL_CODE_CLOSE as a second literal copy. Re-pointing it at these two is a two-line delete; it
 * is left out only because that file belongs to another edit-unit. Two literals is how the chat's
 * recognition and the bar's accounting drift apart the day the envelope changes.
 */
export const MORAL_CODE_MARKER = '<moral_code source="tinkerclaw">';
export const MORAL_CODE_MARKER_CLOSE = "</moral_code>";

export const SEGMENT_LABELS: Record<string, string> = {
  moralCode: "Moral code",
  systemPrompt: "System",
  injectedFiles: "Files",
  skills: "Skills",
  toolSchemas: "Tools",
  conversation: "Conv",
  // "Results" alone read as the model's results. These are the TOOLS' results (2026-09-30).
  toolResults: "Tool results",
  userMessage: "User",
  // Not an anatomy component: the billed remainder the gateway could not break down. It gets a
  // LABEL here so the bar, its legend and the THIS CALL stat cannot drift on what to call it, and
  // deliberately NO entry in SEGMENT_COLORS — it is painted by .cache-seg--unitemised, a hatch
  // derived from --text, because "we could not attribute this" must not read as one more forensic
  // category with a colour of its own (context-window-panel.md §5.8).
  unitemised: "Unitemised",
  // response segments
  responseThinking: "Thinking",
  responseText: "Text Output",
  responseToolCalls: "Tool Calls",
};

// Ordered top-to-bottom in the stacked bar (rendered bottom-to-top via column-reverse)
const SEGMENT_ORDER = [
  "moralCode",
  "systemPrompt",
  "injectedFiles",
  "skills",
  "toolSchemas",
  "conversation",
  "toolResults",
  "userMessage",
  "responseThinking",
  "responseText",
  "responseToolCalls",
];

export interface AnatomyEvent {
  turn?: number;
  roundNumber?: number; // which API call within the turn
  model?: string;
  provider?: string;
  contextSent?: {
    /** B1/A9 — tokens of the moral-code pack in this prompt. A NUMBER 0 means measured and ABSENT;
     *  the field MISSING means no producer reports it yet. P10: those are not the same state, and
     *  A9 must emit the zero rather than omit the key for the bar's absent slot to fire. */
    moralCodeTokens?: number;
    systemPromptTokens?: number;
    injectedFiles?: Array<{ name: string; chars: number; tokens: number }>;
    injectedFilesTotalTokens?: number;
    skillsTokens?: number;
    toolSchemasTokens?: number;
    conversationHistoryTokens?: number;
    toolResultsTokens?: number;
    userMessageTokens?: number;
    totalTokens?: number;
    [k: string]: unknown;
  };
  contextWindow?: {
    maxTokens?: number;
    usedTokens?: number;
    utilizationPercent?: number;
  };
  responseTokens?: number;
  durationMs?: number; // a call column: send → exact end; an anatomy row: the turn's
  stopReason?: string; // why the call ended
  /** B6 — a column built by callColumn from `stream:"call"`: ONE model call, a size and no
   *  composition (the run's anatomy column carries that). */
  callColumn?: boolean;
  /** B6, P5 — where a call column's size came from. */
  promptProvenance?: "exact" | "estimated" | "none";
  /** A9 — which composition an anatomy row holds: `pre-call` is the prompt as sent; `post-turn`
   *  also holds the turn's own replies and tool results (F5). */
  snapshot?: "pre-call" | "post-turn";
  toolsTriggered?: Array<{
    // tools called after this round
    name: string;
    toolCallId: string;
    inputChars?: number;
    outputChars?: number;
    durationMs?: number;
    isError?: boolean;
  }>;
  timestampMs?: number;
  timestamp?: string;
  // response breakdown
  runId?: string;
  sessionKey?: string;
  responseThinkingTokens?: number;
  responseTextTokens?: number;
  responseToolCallTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  responseContent?: {
    thinkingChars?: number;
    textChars?: number;
    toolCallChars?: number;
  };
  [k: string]: unknown;
}

interface BufferEntry {
  event: AnatomyEvent;
  runId?: string;
  groupId: string;
}

interface TimelineController {
  pushEvent(event: AnatomyEvent, runId?: string): void;
  /** B6 — upsert the column of ONE model call (built by callColumn). Never selects it. */
  pushCall(runId: string, column: AnatomyEvent): void;
  pushToolExec(
    runId: string,
    data: {
      roundNumber: number;
      phase: string;
      toolName: string;
      toolCallId: string;
      outputChars?: number;
      durationMs?: number;
      isError?: boolean;
      inputChars?: number;
    },
  ): void;
  loadSession(sessionKey: string): void;
  loadEvents(events: AnatomyEvent[]): void;
  clear(): void;
  getSelected(): AnatomyEvent | null;
  setFilterMode(mode: "session" | "all"): void;
  getFilterMode(): "session" | "all";
  loadAllSessions(sessionKeys?: string[]): void;
}

const MAX_BUFFER = 2000;
const BAR_WIDTH_PX = 35; // approximate width per bar including gaps
// Per-column chrome: provider icon (16) + timestamp 2-line (24) + group border (4) + legend (16) = 60px
const COLUMN_CHROME_PX = 60;

// Map our segment keys to the flat field names in contextSent (input) or top-level event (response)
const SEGMENT_TOKEN_FIELDS: Record<string, string> = {
  // A9 will carry the pack's size in `moralCodeTokens`. context-cache.ts spells the same field;
  // the `moral-code-first` gate in context-window-panel.md asserts the two agree, because a typo
  // here does not crash — it just reports "unknown" forever, which is the silent kind of wrong.
  moralCode: "moralCodeTokens",
  systemPrompt: "systemPromptTokens",
  injectedFiles: "injectedFilesTotalTokens",
  skills: "skillsTokens",
  toolSchemas: "toolSchemasTokens",
  conversation: "conversationHistoryTokens",
  toolResults: "toolResultsTokens",
  userMessage: "userMessageTokens",
  // response segments — read from top-level event fields
  responseThinking: "responseThinkingTokens",
  responseText: "responseTextTokens",
  responseToolCalls: "responseToolCallTokens",
};

/**
 * B6 (context-window-panel.md §6.2) — the ctx-timeline column of ONE model call, built from the
 * call timeline's record of it (CallTimelineStore.applyCall) rather than from the wire: the `call`
 * stream has one reader (parseCallFrame) and one interpreter (that store), and both widgets show
 * what they decided. It replaces the per-round lifecycle pair, whose producers never had a caller
 * (F9), so until now no call ever drew a column here.
 *
 * P5 — only what the call itself measured: the prompt size is exact once usage landed, else the
 * producer's own pre-call estimate (flagged), else absent; output only when EXACT (an apportioned
 * turn total is not a call's output); duration only from an exact end. No composition: a call
 * column carries a size, the run's anatomy column carries the breakdown, and a stand-in painted
 * here would read as this call's own (F5).
 */
export function callColumn(
  c: Pick<
    TimelineCall,
    | "index"
    | "sendAt"
    | "endAt"
    | "endProvenance"
    | "model"
    | "prompt"
    | "outFinal"
    | "outProvenance"
    | "stopReason"
  >,
  meta: { runId: string; sessionKey?: string; maxWindow?: number },
): AnatomyEvent {
  const exact = c.prompt.exact;
  const estimate = c.prompt.estimate;
  const ev: AnatomyEvent = {
    callColumn: true,
    runId: meta.runId,
    roundNumber: c.index,
    timestampMs: c.sendAt,
    promptProvenance: exact !== undefined ? "exact" : estimate !== undefined ? "estimated" : "none",
    contextSent: { totalTokens: exact ?? estimate ?? 0 },
  };
  if (meta.sessionKey) {
    ev.sessionKey = meta.sessionKey;
  }
  if (c.model) {
    ev.model = c.model;
  }
  if (meta.maxWindow !== undefined && meta.maxWindow > 0) {
    ev.contextWindow = { maxTokens: meta.maxWindow };
  }
  if (c.prompt.cacheRead !== undefined) {
    ev.cacheReadTokens = c.prompt.cacheRead;
  }
  if (c.prompt.cacheWrite !== undefined) {
    ev.cacheCreationTokens = c.prompt.cacheWrite;
  }
  if (c.outProvenance === "exact" && c.outFinal !== undefined) {
    ev.responseTokens = c.outFinal;
  }
  if (c.endProvenance === "exact" && c.endAt !== undefined) {
    ev.durationMs = c.endAt - c.sendAt;
  }
  if (c.stopReason) {
    ev.stopReason = c.stopReason;
  }
  return ev;
}

export type BarSelectMode = "context" | "response" | "context-summarize" | "response-summarize";

export function mountContextTimeline(
  container: HTMLElement,
  onBarSelect: (event: AnatomyEvent, mode: BarSelectMode) => void,
  getSessionKey: () => string,
  getGatewayBase: () => string,
  providerIcons?: Record<string, string>,
  onGroupLineClick?: (groupIndex: number, firstEvent: AnatomyEvent) => void,
  onFilterModeChange?: (mode: "session" | "all") => void,
  getAuthHeaders?: () => Record<string, string>,
  reqFn?: (method: string, params?: unknown) => Promise<unknown>,
  // FORK (2026-04-21): optional lookup — in "All" mode, the timeline shows a
  // per-call session badge so you can see which session each tool call came
  // from. Returns the short title/emoji for a session key, or null if unknown.
  getSessionLabel?: (sessionKey: string) => string | null,
): TimelineController {
  const buffer: BufferEntry[] = [];
  let selectedIdx: number | null = null;
  let selectedMode: "context" | "response" = "context";
  let groupCounter = 0;
  let tooltipEl: HTMLElement | null = null;
  let filterMode: "session" | "all" = "session";
  let _currentGlobalMax = 200_000;
  let hasMoreHistory = false;
  let loadingMore = false;
  // B6 — a call column changes up to three times per model call (send, usage, end), and render()
  // rebuilds every column. Those repaints are coalesced to one per animation frame; an anatomy
  // push still paints at once, because it also selects its bar and drives the treemap.
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) {
      return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  /** Fetch timeline data via WS (preferred) or HTTP fallback. */
  async function fetchAnatomy(method: string, params: unknown): Promise<unknown> {
    if (reqFn) {
      return reqFn(method, params);
    }
    // HTTP fallback (prod mode where same-origin works)
    const base = getGatewayBase();
    const headers = getAuthHeaders?.() ?? {};
    let url: string;
    if (method === "anatomy.recent") {
      url = `${base}/tinker/api/context-anatomy/recent?hours=${params.hours}&limit=${params.limit}`;
    } else if (method === "anatomy.before") {
      url = `${base}/tinker/api/context-anatomy/before?ts=${params.beforeMs}&limit=${params.limit}`;
    } else if (method === "anatomy.session") {
      url = `${base}/tinker/api/context-anatomy/${encodeURIComponent(params.sessionKey)}?limit=${params.limit}`;
    } else {
      throw new Error(`Unknown anatomy method: ${method}`);
    }
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return resp.json();
  }

  /** Append events to buffer with session-boundary group detection. Events must be in ASC order. */
  function appendEvents(events: AnatomyEvent[]) {
    for (const ev of events) {
      const prevEntry = buffer[buffer.length - 1];
      const prevSession = prevEntry?.event?.sessionKey;
      const curSession = ev.sessionKey;
      let groupId: string;
      if (prevSession && curSession && prevSession !== curSession) {
        groupId = `grp-${++groupCounter}`;
      } else {
        groupId = assignGroupId(ev.runId, ev);
      }
      push({ event: ev, runId: ev.runId, groupId });
    }
  }

  /** Prepend older events to the front of the buffer. Events must be in ASC order. */
  function prependEvents(events: AnatomyEvent[]) {
    if (events.length === 0) {
      return;
    }
    const oldEntries: BufferEntry[] = [];
    let prevSession: string | undefined;
    let prependGroupCounter = 0;
    for (const ev of events) {
      const curSession = ev.sessionKey;
      let groupId: string;
      if (prevSession && curSession && prevSession !== curSession) {
        groupId = `pre-grp-${++prependGroupCounter}`;
      } else {
        groupId = assignGroupId(ev.runId, ev);
      }
      oldEntries.push({ event: ev, runId: ev.runId, groupId });
      prevSession = curSession;
    }
    // Fix group boundary between prepended and existing buffer
    if (buffer.length > 0 && oldEntries.length > 0) {
      const lastPrepended = oldEntries[oldEntries.length - 1];
      const firstExisting = buffer[0];
      if (lastPrepended.event.sessionKey !== firstExisting.event.sessionKey) {
        firstExisting.groupId = `grp-${++groupCounter}`;
      }
    }
    if (selectedIdx !== null) {
      selectedIdx += oldEntries.length;
    }
    buffer.unshift(...oldEntries);
  }

  /** Load older events before the oldest entry in the buffer. */
  async function loadOlderPage() {
    if (loadingMore || !hasMoreHistory || buffer.length === 0) {
      return;
    }
    loadingMore = true;
    const oldestTs = buffer[0].event.timestampMs ?? (buffer[0].event as unknown).timestamp_ms;
    if (!oldestTs) {
      loadingMore = false;
      return;
    }
    const pageSize = Math.max(30, Math.ceil(container.clientWidth / BAR_WIDTH_PX));
    try {
      const body = await fetchAnatomy("anatomy.before", { beforeMs: oldestTs, limit: pageSize });
      const events: AnatomyEvent[] = Array.isArray(body) ? body : (body?.events ?? []);
      hasMoreHistory = events.length >= pageSize;
      if (events.length > 0) {
        const oldScrollWidth = container.scrollWidth;
        const oldScrollLeft = container.scrollLeft;
        prependEvents(events);
        render();
        // Preserve scroll position after prepending
        const newScrollWidth = container.scrollWidth;
        container.scrollLeft = oldScrollLeft + (newScrollWidth - oldScrollWidth);
      }
    } catch {
      /* ignore */
    }
    loadingMore = false;
  }

  // Scroll-left lazy loading
  container.addEventListener("scroll", () => {
    if (filterMode === "all" && container.scrollLeft < 100 && hasMoreHistory && !loadingMore) {
      loadOlderPage();
    }
  });

  // ─── Tooltip ───
  function showTooltip(x: number, y: number, entry: BufferEntry) {
    removeTooltip();
    const ev = entry.event;
    const tip = document.createElement("div");
    tip.className = "ct-tooltip";
    const model = cleanModelName(ev.model ?? "unknown");
    const total = totalTokensFor(ev);
    const resp = ev.responseTokens;
    const dur = ev.durationMs;
    const tools = ev.toolsTriggered?.length ?? 0;
    const round = ev.roundNumber;

    let text = model;
    if (round) {
      text = `R${round} · ${text}`;
    }
    text += ` · ${fmtK(total)} in`;
    if (ev.callColumn === true && ev.promptProvenance !== "exact") {
      // P5 — a call column's size is exact only once the call's usage landed.
      text += ev.promptProvenance === "estimated" ? " (estimated)" : " (size not reported yet)";
    }
    if (resp) {
      text += ` · ${fmtK(resp)} out`;
    }
    if (dur) {
      text += ` · ${(dur / 1000).toFixed(1)}s`;
    }
    if (tools > 0) {
      text += ` · ${tools} tool${tools !== 1 ? "s" : ""}`;
    }

    tip.textContent = text;
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
    if (!model) {
      return "";
    }
    // Extract recognizable short name from model IDs like "claude-sonnet-4-6", "qwen3:14b-q4_K_M", "gemini-3-flash-preview"
    const m = model.toLowerCase();
    if (m.includes("opus")) {
      return "opus";
    }
    if (m.includes("sonnet")) {
      return "sonnet";
    }
    if (m.includes("haiku")) {
      return "haiku";
    }
    if (m.includes("qwen")) {
      return model.split(":")[0];
    } // "qwen3"
    if (m.includes("gemini")) {
      const parts = model.replace("gemini-", "").split("-");
      return "gemini-" + parts.slice(0, 2).join("-"); // "gemini-3-flash"
    }
    if (m.includes("gpt-4")) {
      return "gpt-4o";
    }
    if (m.includes("gpt-3")) {
      return "gpt-3.5";
    }
    if (m.includes("deepseek")) {
      return "deepseek";
    }
    if (m.includes("llama")) {
      return model.split(":")[0];
    }
    if (m.includes("mistral")) {
      return "mistral";
    }
    // Fallback: first segment before colon or dash-number
    return model.split(":")[0].split(/-\d/)[0];
  }

  function fmtK(n: number): string {
    if (n >= 1_000_000) {
      return (n / 1_000_000).toFixed(1) + "M";
    }
    if (n >= 1_000) {
      return (n / 1_000).toFixed(1) + "k";
    }
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
      if (!isNaN(parsed.getTime())) {
        d = parsed;
      }
    }
    if (!d) {
      return null;
    }
    const date = `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return { date, time };
  }

  function getSegmentTokens(ev: AnatomyEvent): { key: string; tokens: number }[] {
    const cs = ev.contextSent;
    const out: { key: string; tokens: number }[] = [];
    for (const key of SEGMENT_ORDER) {
      const field = SEGMENT_TOKEN_FIELDS[key];
      // Input segments come from contextSent, response segments from top-level event
      const tokens = cs?.[field] ?? (ev as unknown)[field] ?? 0;
      if (tokens > 0) {
        out.push({ key, tokens });
      }
    }
    return out;
  }

  function totalTokensFor(ev: AnatomyEvent): number {
    // FORK 2026-07-28 — `contextWindow.usedTokens` is a TURN-AGGREGATE counter, not this turn's
    // context size. app.ts:342-345 already states the rule verbatim ("NEVER from
    // anatomy.contextWindow.usedTokens or anatomy.utilizationPercent"); this reader predated it.
    // The producer ALWAYS sets usedTokens, so the honest `contextSent.totalTokens` fallback below
    // could never fire — and the value is compared against the window on two axes here (bar
    // height, and the per-model window marker), so a bar routinely rendered ABOVE the line
    // marking the model's own limit. Measured live: usedTokens 6,448,106 against maxTokens
    // 1,000,000, where the real context was 52,116.
    //
    // Historic rows persisted before the producer-side fix still carry poisoned values, so this
    // guard stays even though `context-anatomy.ts` now rejects implausible figures at source.
    const used = ev.contextWindow?.usedTokens;
    const max = ev.contextWindow?.maxTokens;
    const usedIsPlausible =
      typeof used === "number" &&
      Number.isFinite(used) &&
      used > 0 &&
      (typeof max !== "number" || max <= 0 || used <= max);
    if (usedIsPlausible) {
      return used as number;
    }
    return ev.contextSent?.totalTokens ?? 0;
  }

  function maxTokensFor(ev: AnatomyEvent): number {
    return ev.contextWindow?.maxTokens ?? 200_000;
  }

  // ─── Grouping by turn number ───
  function getTimestampMs(ev: AnatomyEvent): number {
    return ev.timestampMs ?? (ev.timestamp ? new Date(ev.timestamp).getTime() : 0);
  }

  function assignGroupId(runId?: string, ev?: AnatomyEvent): string {
    if (runId) {
      return `run-${runId}`;
    }
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
        if (selectedIdx < 0) {
          selectedIdx = null;
        }
      }
    }
    buffer.push(entry);
  }

  // ─── Render ───
  function render() {
    container.innerHTML = "";
    // Legend anchor is now inside the container — cleared by innerHTML = "" above.
    // The parentElement query below handles any old-state anchor that might linger outside.
    container.parentElement?.querySelector(".ct-legend-anchor")?.remove();

    // Legend (sticky right) — always rendered so the Session/All toggle is accessible
    // even when the buffer is empty (new session with no calls yet)
    const legend = document.createElement("div");
    legend.className = "ct-legend";
    const INPUT_LEGEND_KEYS = SEGMENT_ORDER.filter((k) => !k.startsWith("response"));
    for (const key of INPUT_LEGEND_KEYS) {
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
      // Update toggle visuals immediately without full re-render
      lblSession.className =
        "ct-switch-label" + (newMode === "session" ? " ct-switch-label--active" : "");
      lblAll.className = "ct-switch-label" + (newMode === "all" ? " ct-switch-label--active" : "");
      track.className = "ct-switch-track" + (newMode === "all" ? " ct-switch-track--on" : "");
      // Async load will call render() when data arrives
      if (onFilterModeChange) {
        onFilterModeChange(newMode);
      }
    });
    legend.appendChild(switchWrap);
    // Legend lives INSIDE the timeline container — position:sticky keeps it at the right edge
    const legendAnchor = document.createElement("div");
    legendAnchor.className = "ct-legend-anchor";
    legendAnchor.appendChild(legend);
    // Always inside the timeline container — positioned with sticky so it never scrolls away
    container.appendChild(legendAnchor);

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
      if (m > globalMax) {
        globalMax = m;
      }
    }
    if (globalMax <= 0) {
      globalMax = 200_000;
    }
    _currentGlobalMax = globalMax;

    // Pre-compute response tokens for independent scaling
    const respTokensArr: number[] = [];
    for (const entry of buffer) {
      respTokensArr.push(entry.event.responseTokens ?? 0);
    }
    let maxRespTokens = 0;
    for (const r of respTokensArr) {
      if (r > maxRespTokens) {
        maxRespTokens = r;
      }
    }
    if (maxRespTokens <= 0) {
      maxRespTokens = 1;
    }

    // Spacer pushes bars right when content doesn't overflow; shrinks to 0 when it does
    const spacer = document.createElement("div");
    spacer.style.flex = "1 1 auto";
    spacer.style.minWidth = "0";
    container.appendChild(spacer);

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

        // Vertical brown lollipop at group start — click shows prompt in context map + scrolls webchat
        if (onGroupLineClick) {
          const line = document.createElement("div");
          line.className = "ct-group-line";
          line.style.height = `${Math.round(maxBarHeight * 0.75)}px`;
          line.title = "Show prompt context";
          const gi = groupIndex;
          const gid = entry.groupId;
          const firstEv = entry.event;
          line.addEventListener("click", (e) => {
            e.stopPropagation();
            // B6 — a run's group now opens with its CALL columns, which carry a size and no
            // composition; the prompt's context is the run's anatomy column, which lands at the
            // end of the turn. So: the group's first non-call column, looked up at click time.
            const withComposition = buffer.find(
              (b) => b.groupId === gid && b.event.callColumn !== true,
            );
            const ev = withComposition?.event ?? firstEv;
            console.log("[timeline] lollipop click group=%d event=", gi, ev);
            onGroupLineClick(gi, ev);
          });
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

      // Logo from MODEL id, not provider key. OpenRouter GLM/Qwen/Kimi all report
      // provider "openrouter", which is in no icon table — that was the blank circle
      // on the forensic bars (the architect 2026-09-09). Same resolver as the models panel.
      const iconEl = document.createElement("div");
      iconEl.className = "ct-provider";
      const provider = ev.provider ?? "";
      const modelId = ev.model ?? "";
      const routed = getRoutedLogoSvg(modelId, provider);
      if (routed) {
        iconEl.innerHTML = routed;
      } else if (providerIcons && providerIcons[provider]) {
        iconEl.innerHTML = providerIcons[provider];
      } else if (provider) {
        iconEl.textContent = provider[0].toUpperCase();
        iconEl.style.fontSize = "9px";
        iconEl.style.fontWeight = "700";
        iconEl.style.color = "var(--muted)";
      }
      const modelShort = shortModelName(modelId);
      if (modelShort) {
        iconEl.title = `${provider}/${cleanModelName(modelId)}`;
      }
      barArea.appendChild(iconEl);

      // Bar: scaled to usedTokens / globalMax, grows from bottom
      const barHeight = Math.max(4, (total / globalMax) * maxBarHeight);
      const bar = document.createElement("div");
      bar.className =
        "ct-bar" + (i === selectedIdx && selectedMode === "context" ? " ct-selected" : "");
      bar.style.height = `${barHeight}px`;

      const segments = getSegmentTokens(ev);
      const segTotal = segments.reduce((s, seg) => s + seg.tokens, 0);

      if (segments.length === 0 && total > 0) {
        // No breakdown: a call column (B6) carries its size, and the run's anatomy column carries
        // the composition. A neutral fill, never a guessed split.
        bar.style.background = "rgba(148,163,184,0.35)";
      }
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
      if (respTokens > 0) {
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
          const dur = ev.durationMs;
          const tools = ev.toolsTriggered?.length ?? 0;
          let text = `Response · ${fmtK(respTokens)} out`;
          if (dur) {
            text += ` · ${(dur / 1000).toFixed(1)}s`;
          }
          if (tools > 0) {
            text += ` · ${tools} tool${tools !== 1 ? "s" : ""}`;
          }
          if (ev.stopReason) {
            text += ` · ${ev.stopReason}`;
          }
          tip.textContent = text;
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

      // FORK (2026-04-21): session badge — only in "All" mode, to distinguish
      // which session each tool call came from. Shows the session's emoji
      // prefix (first grapheme from the tab title) + a short label on hover.
      if (filterMode === "all" && getSessionLabel && ev.sessionKey) {
        const rawLabel = getSessionLabel(ev.sessionKey);
        if (rawLabel) {
          const badge = document.createElement("div");
          badge.className = "ct-session-badge";
          const emojiMatch = rawLabel.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)/u);
          badge.textContent = emojiMatch ? emojiMatch[0] : rawLabel.slice(0, 2);
          badge.title = rawLabel;
          col.appendChild(badge);
        }
      }

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
      // If this event has a runId + roundNumber, try to enrich an existing bar
      if (runId && event.roundNumber != null) {
        for (let i = buffer.length - 1; i >= 0; i--) {
          const entry = buffer[i];
          if (
            entry.runId === runId &&
            entry.event.callColumn !== true &&
            entry.event.roundNumber === event.roundNumber
          ) {
            // Merge: overlay the newer row, except the composition. The anatomy DB's own upsert
            // (context-anatomy-db.ts insertAnatomyEvent), mirrored so the live bar is the bar a
            // reload paints: a PRE-CALL composition survives a post-turn row for the same
            // (run, round), because only it itemises the prompt that was actually sent (F5). A
            // call column (B6) is never a merge target: it is a different record of the call.
            const kept =
              entry.event.snapshot === "pre-call" && event.snapshot === "post-turn"
                ? {
                    contextSent: entry.event.contextSent,
                    snapshot: entry.event.snapshot,
                    timestampMs: entry.event.timestampMs,
                    turn: entry.event.turn,
                  }
                : {};
            Object.assign(entry.event, event, kept);
            selectedIdx = i;
            render();
            onBarSelect(entry.event, "context");
            return;
          }
        }
      }
      const groupId = assignGroupId(runId, event);
      push({ event, runId, groupId });
      // Auto-select latest
      selectedIdx = buffer.length - 1;
      render();
      onBarSelect(event, "context");
    },

    pushCall(runId: string, column: AnatomyEvent) {
      // One column per model call: the `call` stream's send, usage and end all land on the column
      // for (runId, roundNumber = the call timeline's own 1-based index). Only call columns match;
      // an anatomy row is a different record and never merges into one (see pushEvent).
      for (let i = buffer.length - 1; i >= 0; i--) {
        const entry = buffer[i];
        if (
          entry.runId === runId &&
          entry.event.callColumn === true &&
          entry.event.roundNumber === column.roundNumber
        ) {
          // Assign, not swap: the tools pushToolExec attached live on the same event.
          Object.assign(entry.event, column);
          scheduleRender();
          return;
        }
      }
      push({ event: column, runId, groupId: assignGroupId(runId, column) });
      scheduleRender();
    },

    pushToolExec(
      runId: string,
      data: {
        roundNumber: number;
        phase: string;
        toolName: string;
        toolCallId: string;
        outputChars?: number;
        durationMs?: number;
        isError?: boolean;
        inputChars?: number;
      },
    ) {
      // Find the matching buffer entry — use runId primarily, fallback to latest
      let target: BufferEntry | null = null;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].runId === runId) {
          target = buffer[i];
          break;
        }
      }
      if (!target) {
        return;
      }

      if (!target.event.toolsTriggered) {
        target.event.toolsTriggered = [];
      }

      if (data.phase === "tool-exec-start") {
        target.event.toolsTriggered.push({
          name: data.toolName,
          toolCallId: data.toolCallId,
          inputChars: data.inputChars,
        });
      } else if (data.phase === "tool-exec-complete") {
        // Find and update the matching tool entry
        const existing = target.event.toolsTriggered.find((t) => t.toolCallId === data.toolCallId);
        if (existing) {
          existing.outputChars = data.outputChars;
          existing.durationMs = data.durationMs;
          existing.isError = data.isError;
        } else {
          target.event.toolsTriggered.push({
            name: data.toolName,
            toolCallId: data.toolCallId,
            outputChars: data.outputChars,
            durationMs: data.durationMs,
            isError: data.isError,
          });
        }
      }
      // Coalesced like pushCall: tool events now find their run's call column (B6) and repaint.
      scheduleRender();
    },

    async loadSession(sessionKey: string) {
      if (!sessionKey) {
        buffer.length = 0;
        selectedIdx = null;
        groupCounter = 0;
        render();
        return;
      }

      try {
        const body = await fetchAnatomy("anatomy.session", { sessionKey, limit: MAX_BUFFER });
        const events: AnatomyEvent[] = Array.isArray(body) ? body : (body?.events ?? []);

        buffer.length = 0;
        selectedIdx = null;
        groupCounter = 0;

        if (events.length > 0) {
          // WS/API returns newest-first (DESC); reverse to chronological for display
          events.reverse();
          for (const ev of events) {
            const groupId = assignGroupId(undefined, ev);
            push({ event: ev, groupId });
          }
          selectedIdx = buffer.length - 1;
          onBarSelect(buffer[selectedIdx].event, "context");
        }
      } catch {
        return;
      }
      render();
    },

    loadEvents(events: AnatomyEvent[]): void {
      buffer.length = 0;
      selectedIdx = null;
      groupCounter = 0;

      for (const event of events) {
        // Detect session boundary — force new group when sessionKey changes
        const prevEntry = buffer[buffer.length - 1];
        const prevSession = prevEntry?.event?.sessionKey;
        const curSession = event.sessionKey;

        let groupId: string;
        if (prevSession && curSession && prevSession !== curSession) {
          // Session boundary — assign a fresh group id, bypassing time-gap heuristic
          groupId = `grp-${++groupCounter}`;
        } else {
          // Use existing logic (turn-based + time-gap)
          groupId = assignGroupId(event.runId, event);
        }

        push({ event, runId: event.runId, groupId });
      }

      if (buffer.length > 0) {
        selectedIdx = buffer.length - 1;
        onBarSelect(buffer[selectedIdx].event, "context");
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

    setFilterMode(mode: "session" | "all") {
      filterMode = mode;
      // Re-render will pick up the new toggle state
      render();
    },

    getFilterMode() {
      return filterMode;
    },

    async loadAllSessions(_sessionKeys?: string[]) {
      const screenBars = Math.max(20, Math.ceil(container.clientWidth / BAR_WIDTH_PX));
      const initialLimit = screenBars + 10;
      console.log("[timeline] loadAllSessions called, limit=", initialLimit);
      try {
        const body = await fetchAnatomy("anatomy.recent", { hours: 8760, limit: initialLimit });
        console.log(
          "[timeline] loadAllSessions got",
          body?.count ?? body?.events?.length ?? 0,
          "events",
        );
        const allEvents: AnatomyEvent[] = Array.isArray(body) ? body : (body?.events ?? []);

        buffer.length = 0;
        selectedIdx = null;
        groupCounter = 0;
        hasMoreHistory = allEvents.length >= initialLimit;

        appendEvents(allEvents);
        if (buffer.length > 0) {
          selectedIdx = buffer.length - 1;
          onBarSelect(buffer[selectedIdx].event, "context");
        }
      } catch (e: unknown) {
        console.error("[timeline] loadAllSessions failed:", e?.message ?? e);
        return;
      }
      render();
    },
  };

  // Initial render
  render();

  return ctrl;
}
