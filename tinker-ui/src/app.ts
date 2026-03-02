// Tinker UI — Command Center v0.3
import { mountContextTreemap } from "./panels/context-treemap.js";
import { mountResponseTreemap } from "./panels/response-treemap.js";

// Runtime config: injected by the tinker plugin into index.html, or via URL params
const __cfg = (window as any).__TINKER_CONFIG ?? {};
const TOKEN = __cfg.token ?? new URLSearchParams(window.location.search).get("token") ?? "";
// In dev mode (vite), connect WS directly to the gateway; in prod the plugin serves from the gateway itself
const GW_WS = import.meta.env.DEV
  ? `ws://localhost:18789`
  : `ws${window.location.protocol === "https:" ? "s" : ""}://${window.location.host}`;
const BASE = import.meta.env.BASE_URL ?? "/";

let ws: WebSocket | null = null;
let connected = false;
let pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
let sessionKey = "";
let sessions: any[] = [];
let messages: any[] = [];
let streamText = "";
let streamRunId: string | null = null;
let sending = false;
let expandedTools = new Set<string>();
let tokenUsage: any = null;
let costData: any = null;
let initialized = false;
let budgetData: any = null;
let forensicMode = false;

const $ = (id: string) => document.getElementById(id);
const app = $("app")!;

// ─── Provider Colors ───
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#7c3aed",
  google: "#16a34a",
  openai: "#6b7280",
  ollama: "#ca8a04",
  meta: "#0668E1",
  mistral: "#f97316",
  deepseek: "#4f8ff7",
};

// ─── Provider Icons (14px inline SVGs) ───
const PROVIDER_ICONS: Record<string, string> = {
  anthropic: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M13.827 3.52l5.932 16.96h-3.828L10.06 3.52h3.767zm-7.404 0l5.932 16.96H8.527L2.595 3.52h3.828z" fill="#D97757"/></svg>`,
  google: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="7" cy="7" r="3" fill="#4285F4"/><circle cx="17" cy="7" r="3" fill="#EA4335"/><circle cx="7" cy="17" r="3" fill="#34A853"/><circle cx="17" cy="17" r="3" fill="#FBBC05"/></svg>`,
  openai: `<svg width="14" height="14" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3.5a6.5 6.5 0 0 1 0 13 6.5 6.5 0 0 1 0-13z" fill="#10a37f"/><path d="M12 7v10M7 12h10" stroke="#10a37f" stroke-width="1.5" fill="none"/></svg>`,
  ollama: `<svg width="14" height="14" viewBox="0 0 24 24"><text x="3" y="17" font-size="14" font-weight="bold" fill="#ca8a04">O</text></svg>`,
  meta: `<svg width="14" height="14" viewBox="0 0 24 24"><path d="M4 12c0-3 1.5-6 4-6s4 3 4 6-1.5 6-4 6-4-3-4-6zm8 0c0-3 1.5-6 4-6s4 3 4 6-1.5 6-4 6-4-3-4-6z" stroke="#0668E1" stroke-width="2" fill="none"/></svg>`,
  mistral: `<svg width="14" height="14" viewBox="0 0 24 24"><rect x="2" y="3" width="5" height="5" fill="#f97316"/><rect x="10" y="3" width="5" height="5" fill="#f97316"/><rect x="17" y="3" width="5" height="5" fill="#f97316"/><rect x="2" y="10" width="5" height="5" fill="#f97316"/><rect x="10" y="10" width="5" height="5" fill="#f97316"/><rect x="2" y="17" width="5" height="5" fill="#f97316"/><rect x="17" y="17" width="5" height="5" fill="#f97316"/></svg>`,
  deepseek: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="#4f8ff7" stroke-width="2" fill="none"/><path d="M8 12l3 3 5-6" stroke="#4f8ff7" stroke-width="2" fill="none"/></svg>`,
};

function providerIcon(provider: string): string {
  if (PROVIDER_ICONS[provider]) {
    return `<span class="model-provider-icon">${PROVIDER_ICONS[provider]}</span>`;
  }
  const color = PROVIDER_COLORS[provider] || "#6b7280";
  return `<span class="model-provider-dot" style="background:${color}"></span>`;
}

// ─── Active Model Tracking ───
const activeRuns = new Map<
  string,
  { model: string; provider: string; authProfileId?: string; startedAt: number }
>();
const STALE_RUN_MS = 5 * 60_000;

function pruneStaleRuns() {
  const now = Date.now();
  for (const [id, info] of activeRuns) {
    if (now - info.startedAt > STALE_RUN_MS) activeRuns.delete(id);
  }
}

function getAuthKeyCounts(): Map<string, number> {
  pruneStaleRuns();
  const counts = new Map<string, number>();
  for (const info of activeRuns.values()) {
    const key = info.authProfileId || info.model;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

let modelConfigData: any = null;

// ─── Gateway ───
function uuid() {
  return crypto.randomUUID();
}

function gwConnect() {
  ws = new WebSocket(GW_WS);
  ws.onmessage = (ev) => onFrame(JSON.parse(ev.data));
  ws.onclose = () => {
    connected = false;
    updateDots();
    setTimeout(gwConnect, 2000);
  };
}

function onFrame(f: any) {
  if (f.type === "event") {
    if (f.event === "connect.challenge") {
      req("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "webchat-ui", version: "0.3", platform: "web", mode: "webchat" },
        role: "operator",
        scopes: ["operator.admin"],
        caps: ["tool-events"],
        auth: { token: TOKEN },
      })
        .then((hello: any) => {
          connected = true;
          const defs = hello?.snapshot?.sessionDefaults;
          if (defs?.mainSessionKey) {
            sessionKey = defs.mainSessionKey;
          }
          updateDots();
          loadSessions();
          loadTokens();
          loadBudget();
          refreshTreemap();
          req("forensic.getMode", {})
            .then((res: any) => {
              forensicMode = res?.enabled ?? false;
              updateForensicBtn();
            })
            .catch(() => {});
        })
        .catch((e) => console.error("connect:", e));
      return;
    }
    onEvent(f);
    return;
  }
  if (f.type === "res") {
    const p = pending.get(f.id);
    if (p) {
      pending.delete(f.id);
      f.ok ? p.resolve(f.payload) : p.reject(f.error);
    }
  }
}

function req<T = any>(method: string, params?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject("disconnected");
    }
    const id = uuid();
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

function onEvent(evt: any) {
  if (evt.event === "chat") {
    const p = evt.payload;
    if (p.sessionKey !== sessionKey) {
      return;
    }
    if (p.state === "delta") {
      streamRunId = p.runId;
      streamText = p.message?.content?.[0]?.text ?? streamText;
      updateChat();
    } else if (p.state === "final" || p.state === "error" || p.state === "aborted") {
      if (p.message) {
        messages.push(p.message);
      }
      streamText = "";
      streamRunId = null;
      sending = false;
      updateChat();
      updateBtn();
      loadTokens();
      loadBudget();
      refreshTreemap();
      updateResponseMap();
    }
  }
  if (evt.event === "agent") {
    const p = evt.payload;
    if (p?.stream === "lifecycle" && p.data?.model) {
      if (p.data.phase === "start") {
        activeRuns.set(p.runId, {
          model: p.data.model,
          provider: p.data.modelProvider || providerOf(p.data.model),
          authProfileId: p.data.authProfileId,
          startedAt: Date.now(),
        });
        updateBudgetPanel();
      } else if (p.data.phase === "end" || p.data.phase === "error") {
        const endRunId = p.runId;
        setTimeout(() => {
          activeRuns.delete(endRunId);
          updateBudgetPanel();
        }, 3000);
      }
    }
  }
}

// ─── API ───
async function loadSessions() {
  const res = await req("sessions.list", {}).catch(() => ({ sessions: [] }));
  sessions = res.sessions ?? [];
  if (!sessionKey && sessions.length) {
    sessionKey = sessions[0].key;
  }
  updateSelect();
  updateSessionsPanel();
  loadChat();
}

async function loadChat() {
  if (!sessionKey) {
    return;
  }
  const res = await req("chat.history", { sessionKey, limit: 200 }).catch(() => ({ messages: [] }));
  messages = res.messages ?? [];
  updateChat();
  scrollChat();
  updateResponseMap();
}

async function send(text: string) {
  if (!text.trim() || !sessionKey || sending) {
    return;
  }
  sending = true;
  messages.push({ role: "user", content: [{ type: "text", text }] });
  updateChat();
  updateBtn();
  scrollChat();
  await req("chat.send", { sessionKey, message: text, idempotencyKey: uuid() }).catch((e) => {
    console.error(e);
    sending = false;
    updateBtn();
  });
}

async function abort() {
  await req("chat.abort", { sessionKey }).catch(() => {});
  sending = false;
  streamText = "";
  streamRunId = null;
  updateChat();
  updateBtn();
}

async function loadTokens() {
  const today = new Date().toISOString().slice(0, 10);
  const [u, c] = await Promise.all([
    req("sessions.usage", { startDate: today, endDate: today }).catch(() => null),
    req("usage.cost", { startDate: today, endDate: today }).catch(() => null),
  ]);
  tokenUsage = u;
  costData = c;
  updateTokens();
}

async function loadBudget() {
  const [b, s, mc] = await Promise.all([
    req("usage.budget", {}).catch(() => null),
    req("budget.status", {}).catch(() => null),
    req("config.models", {}).catch(() => null),
  ]);
  budgetData = { budget: b, status: s };
  if (mc) {
    modelConfigData = mc;
  }
  updateBudgetPanel();
}

// ─── Render Helpers ───
function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function md(text: string): string {
  let h = esc(text);
  h = h.replace(/```[\w]*\n([\s\S]*?)```/g, "<pre>$1</pre>");
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*(.+?)\*/g, "<em>$1</em>");
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\n/g, "<br>");
  h = h.replace(
    /<strong>Jarvis:<\/strong>\s*<em>(.*?)<\/em>/gi,
    '<strong>Jarvis:</strong> <span class="jarvis-voice">$1</span>',
  );
  return h;
}

function renderMsg(msg: any, idx: number): string {
  const role = (msg.role ?? "").toLowerCase();
  const content = Array.isArray(msg.content) ? msg.content : [];
  const texts = content.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "");
  const text = texts.join("\n") || (typeof msg.content === "string" ? msg.content : "");
  const tus = content.filter((b: any) => b.type === "tool_use");
  const trs = content.filter((b: any) => b.type === "tool_result");
  let h = "";

  for (const tu of tus) {
    const a = tu.input ?? {};
    const d = String(a.command ?? a.file_path ?? a.path ?? a.query ?? a.url ?? "")
      .replace(/\/home\/[^/]+/g, "~")
      .slice(0, 90);
    const tid = `t${idx}-${tu.id ?? tu.name}`;
    const exp = expandedTools.has(tid);
    h += `<div class="tool-row" data-tid="${tid}"><span class="status run">⋯</span><span class="name">${esc(tu.name ?? "tool")}</span><span class="detail">${esc(d)}</span></div>`;
    if (exp) {
      h += `<div class="tool-detail">${esc(JSON.stringify(a, null, 2))}</div>`;
    }
  }
  for (const tr of trs) {
    const rt = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? "");
    const err = tr.is_error === true;
    const tid = `r${idx}-${tr.tool_use_id ?? "r"}`;
    const exp = expandedTools.has(tid);
    h += `<div class="tool-row" data-tid="${tid}"><span class="status ${err ? "err" : "ok"}">${err ? "✗" : "✓"}</span><span class="name">result</span><span class="detail">${esc(rt.slice(0, 60).replace(/\n/g, " "))}${rt.length > 60 ? "…" : ""}</span></div>`;
    if (exp) {
      h += `<div class="tool-detail">${esc(rt.slice(0, 2000))}</div>`;
    }
  }

  if (text.trim()) {
    if (role === "user") {
      h += `<div class="msg user">${md(text)}</div>`;
    } else if (role === "assistant") {
      h += `<div class="msg assistant">${md(text)}</div>`;
    } else {
      const sid = `s${idx}`;
      h += `<div class="msg system" data-tid="${sid}">${esc(text.slice(0, 80).replace(/\n/g, " "))}${text.length > 80 ? "…" : ""}</div>`;
      if (expandedTools.has(sid)) {
        h += `<div class="tool-detail">${esc(text)}</div>`;
      }
    }
  }
  return h;
}

// ─── Budget Helpers ───
function budgetColor(pct: number) {
  if (pct >= 100) {
    return "#ef4444";
  }
  if (pct >= 90) {
    return "#f97316";
  }
  if (pct >= 70) {
    return "#ca8a04";
  }
  if (pct >= 50) {
    return "#6b7280";
  }
  return "#16a34a";
}

function formatNum(n: number) {
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1) + "M";
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + "K";
  }
  return n.toString();
}

// ─── Targeted Updates ───
function updateChat() {
  const el = $("messages");
  if (!el) {
    return;
  }
  let h = messages.map((m, i) => renderMsg(m, i)).join("");
  if (streamText) {
    h += `<div class="msg assistant">${md(streamText)}</div>`;
  } else if (sending) {
    h += `<div class="streaming"><span class="dots"><span>●</span><span>●</span><span>●</span></span> thinking...</div>`;
  }
  el.innerHTML = h;
  el.querySelectorAll("[data-tid]").forEach((r) =>
    r.addEventListener("click", () => {
      const id = r.getAttribute("data-tid")!;
      expandedTools.has(id) ? expandedTools.delete(id) : expandedTools.add(id);
      updateChat();
    }),
  );
  scrollChat();
}

function updateDots() {
  document
    .querySelectorAll(".gw-dot")
    .forEach((d) => (d.className = `status-dot gw-dot ${connected ? "dot-green" : "dot-red"}`));
  const l = $("gw-label");
  if (l) {
    l.textContent = connected ? "Connected" : "Disconnected";
  }
}

function updateSelect() {
  const s = $("session-select") as HTMLSelectElement | null;
  if (!s) {
    return;
  }
  s.innerHTML = sessions
    .map(
      (x) =>
        `<option value="${x.key}" ${x.key === sessionKey ? "selected" : ""}>${x.label || x.key.slice(0, 16)}</option>`,
    )
    .join("");
}

function updateBtn() {
  const btn = $("action-btn") as HTMLButtonElement | null;
  if (!btn) {
    return;
  }
  const ta = $("chat-textarea") as HTMLTextAreaElement | null;
  if (sending || streamRunId) {
    btn.className = "abort";
    btn.textContent = "Stop";
  } else {
    btn.className = "";
    btn.textContent = "Send";
    btn.disabled = !connected;
  }
  if (ta) {
    ta.disabled = sending;
  }
}

function updateTokens() {
  const el = $("token-monitor");
  if (!el) {
    return;
  }
  if (!tokenUsage) {
    el.innerHTML = `<div class="tm-card"><div class="label">Loading tokens...</div></div>`;
    return;
  }
  const t = tokenUsage.totals ?? {};
  const inp = t.inputTokens ?? 0,
    out = t.outputTokens ?? 0,
    tot = inp + out;
  const cost = t.estimatedCostUSD ?? costData?.daily?.[0]?.totalCostUSD ?? 0;
  const sc = tokenUsage.sessions?.length ?? 0;
  const lim = 200000,
    pct = Math.min(100, (out / lim) * 100);
  const fc = pct > 80 ? "fill-red" : pct > 50 ? "fill-yellow" : "fill-green";
  el.innerHTML = `
    <div class="tm-card"><div class="label">Tokens Today</div><div class="value">${(tot / 1000).toFixed(1)}k</div><div class="sub">${(inp / 1000).toFixed(1)}k in · ${(out / 1000).toFixed(1)}k out</div></div>
    <div class="tm-card"><div class="label">Est. Cost</div><div class="value">$${cost.toFixed(2)}</div><div class="sub">${sc} session${sc !== 1 ? "s" : ""}</div></div>
    <div class="tm-card"><div class="label">5h Window</div><div class="value">${pct.toFixed(0)}%</div><div class="progress-bar"><div class="fill ${fc}" style="width:${pct}%"></div></div><div class="sub">${(out / 1000).toFixed(0)}k / ${lim / 1000}k</div></div>
  `;
}

function modelName(id: string): string {
  return id.split("/").slice(1).join("/") || id;
}

function providerOf(id: string): string {
  return id.split("/")[0] || "unknown";
}

function updateBudgetPanel() {
  const el = $("budget-panel");
  if (!el) {
    return;
  }
  if (!modelConfigData) {
    el.innerHTML =
      '<div style="padding:8px;color:var(--muted);font-size:11px">Loading config...</div>';
    return;
  }

  const { primary, fallbacks, models, authProfiles, authOrder } = modelConfigData;
  const counts = getAuthKeyCounts();
  let html = '<div class="model-list">';

  // Helper: render auth key rows for a model's provider
  function renderAuthKeyRows(modelId: string, badge: string) {
    const provider = providerOf(modelId);
    const name = modelName(modelId);
    const keys: string[] = authOrder?.[provider] || [];
    if (keys.length <= 1) {
      // Single key or no keys — show one row with model name
      const keyId = keys[0];
      const keyLabel = keyId ? authProfiles?.[keyId]?.label || keyId.split(":")[1] || keyId : "";
      const mode = keyId ? authProfiles?.[keyId]?.mode || "" : "";
      const suffix = keyLabel && mode ? ` \u00b7 ${keyLabel} (${mode})` : "";
      html += renderModelRow(
        modelId,
        provider,
        name,
        badge,
        suffix,
        counts.get(keyId || modelId) || 0,
      );
    } else {
      // Multiple keys — show model header + one row per key
      html += `<div class="model-group-header">${providerIcon(provider)} <span class="model-name">${esc(name)}</span> ${badge ? `<span class="model-badge">${badge}</span>` : ""}</div>`;
      for (const keyId of keys) {
        const prof = authProfiles?.[keyId] || {};
        const keyLabel = prof.label || keyId.split(":")[1] || keyId;
        const mode = prof.mode || "unknown";
        html += renderAuthKeyRow(keyId, keyLabel, mode, provider, counts.get(keyId) || 0);
      }
    }
  }

  // Primary
  if (primary) {
    html += '<div class="model-group-label">PRIMARY</div>';
    renderAuthKeyRows(primary, "\u{1F451}");
  }

  // Fallbacks
  if (fallbacks?.length) {
    const badges = ["\u2460", "\u2461", "\u2462", "\u2463", "\u2464"];
    html += '<div class="model-group-label">FALLBACK CHAIN</div>';
    for (let i = 0; i < fallbacks.length; i++) {
      renderAuthKeyRows(fallbacks[i], badges[i] || `${i + 1}`);
    }
  }

  // Other configured models (not primary or fallback)
  const fbSet = new Set(fallbacks || []);
  const otherIds = Object.keys(models || {}).filter((id) => id !== primary && !fbSet.has(id));
  if (otherIds.length) {
    html += '<div class="model-group-label">CONFIGURED</div>';
    for (const id of otherIds) {
      renderAuthKeyRows(id, "");
    }
  }

  html += `</div><div class="budget-updated">Updated ${new Date().toLocaleTimeString()}</div>`;
  el.innerHTML = html;
}

function renderModelRow(
  id: string,
  provider: string,
  name: string,
  badge: string,
  suffix: string,
  count: number,
): string {
  const color = PROVIDER_COLORS[provider] || "#6b7280";
  const liveClass = count > 0 ? " model-live" : "";
  const glowStyle =
    count > 0
      ? ` style="--glow-color:${color}80;--glow-bg:${color}18;--glow-bg2:${color}30;--glow-border:${color}50"`
      : "";
  const countBadge = count > 0 ? `<span class="model-agent-count">${count}</span>` : "";

  return `<div class="model-row${liveClass}"${glowStyle}>
    ${providerIcon(provider)}
    <span class="model-name">${esc(name)}</span>
    ${badge ? `<span class="model-badge">${badge}</span>` : ""}
    ${suffix ? `<span class="model-auth-suffix">${esc(suffix)}</span>` : ""}
    ${countBadge}
  </div>`;
}

function renderAuthKeyRow(
  keyId: string,
  label: string,
  mode: string,
  provider: string,
  count: number,
): string {
  const color = PROVIDER_COLORS[provider] || "#6b7280";
  const liveClass = count > 0 ? " model-live" : "";
  const glowStyle =
    count > 0
      ? ` style="--glow-color:${color}80;--glow-bg:${color}18;--glow-bg2:${color}30;--glow-border:${color}50"`
      : "";
  const countBadge = count > 0 ? `<span class="model-agent-count">${count}</span>` : "";
  const modeTag = `<span class="auth-mode-tag auth-mode-${mode}">${esc(mode)}</span>`;

  return `<div class="model-row auth-key-row${liveClass}"${glowStyle}>
    <span class="auth-key-indent"></span>
    <span class="auth-key-label">${esc(label)}</span>
    ${modeTag}
    ${countBadge}
  </div>`;
}

function refreshTreemap() {
  const tmCanvas = $("treemap-canvas");
  if (tmCanvas) {
    (tmCanvas as any).__treemapRefresh?.();
  }
}

// ─── Response map ───
function updateResponseMap() {
  const canvas = $("response-canvas");
  if (canvas) {
    (canvas as any).__responseRefresh?.();
  }
}

function updateTreemapBackBtn() {
  const btn = $("treemap-back");
  const tmCanvas = $("treemap-canvas");
  if (!btn || !tmCanvas) {
    return;
  }
  const canGoBack = (tmCanvas as any).__treemapCanGoBack?.() ?? false;
  btn.style.display = canGoBack ? "" : "none";
}

function updateResponseBackBtn() {
  const btn = $("response-back");
  const canvas = $("response-canvas");
  if (!btn || !canvas) {
    return;
  }
  const canGoBack = (canvas as any).__responseCanGoBack?.() ?? false;
  btn.style.display = canGoBack ? "" : "none";
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) {
    return "now";
  }
  if (diff < 3600000) {
    return Math.floor(diff / 60000) + "m";
  }
  if (diff < 86400000) {
    return Math.floor(diff / 3600000) + "h";
  }
  return Math.floor(diff / 86400000) + "d";
}

function updateSessionsPanel() {
  const el = $("sessions-list");
  if (!el) {
    return;
  }
  const countEl = $("sessions-count");
  if (countEl) {
    countEl.textContent = `(${sessions.length})`;
  }

  if (!sessions.length) {
    el.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:11px">No sessions</div>';
    return;
  }

  let html = '<div class="session-list">';
  for (const s of sessions) {
    const isActive = s.key === sessionKey;
    const label = s.label || s.displayName || s.key.slice(0, 24);
    const tokens = s.totalTokens ? formatNum(s.totalTokens) + " tok" : "";
    const age = s.updatedAt ? timeAgo(s.updatedAt) : "";
    const channel = s.channel ? `<span style="opacity:.5">${esc(s.channel)}</span>` : "";
    html += `<div class="session-row${isActive ? " session-active" : ""}" data-session-key="${esc(s.key)}">
      <span class="session-label">${esc(label)} ${channel}</span>
      <span class="session-stats">${tokens}${tokens && age ? " · " : ""}${age}</span>
    </div>`;
  }
  html += "</div>";
  el.innerHTML = html;

  el.querySelectorAll(".session-row").forEach((row) => {
    row.addEventListener("click", () => {
      const key = (row as HTMLElement).dataset.sessionKey;
      if (key && key !== sessionKey) {
        sessionKey = key;
        messages = [];
        updateChat();
        updateSelect();
        loadChat();
        updateSessionsPanel();
        const tmCanvas = $("treemap-canvas");
        if (tmCanvas) {
          (tmCanvas as any).__treemapRefresh?.();
        }
      }
    });
  });
}

function scrollChat() {
  requestAnimationFrame(() => {
    const el = $("messages");
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  });
}

// ─── Init Layout ───
function init() {
  if (initialized) {
    return;
  }
  initialized = true;
  app.innerHTML = `
    <nav class="sidebar">
      <div class="logo" id="new-session-btn" title="New session"><img src="${BASE}icon.png?v=3" alt="T" style="width:48px;height:48px;border-radius:6px"></div>
      <button class="active" title="Chat">💬</button>
      <button title="Tokens">📊</button>
      <button title="Context">🧠</button>
      <button id="forensic-btn" title="Forensic Mode">🛡️</button>
      <button title="Metrics">📈</button>
    </nav>
    <div class="topbar">
      <span class="status-dot gw-dot dot-red"></span>
      <span id="gw-label" style="font-weight:600;font-size:12px">Connecting...</span>
      <select id="session-select" style="margin-left:8px"></select>
      <span style="flex:1"></span>
      <span style="color:var(--muted);font-size:11px"><span class="status-dot gw-dot dot-red"></span> Gateway</span>
    </div>
    <div class="chat-area">
      <div class="messages" id="messages"><div class="msg system">Connecting to gateway...</div></div>
      <div class="chat-input">
        <textarea id="chat-textarea" placeholder="Message..." rows="1"></textarea>
        <button id="action-btn" disabled>Send</button>
      </div>
    </div>
    <div class="right-panels">
      <div class="rpanel budget-panel-wrapper">
        <div class="rpanel-header">🎛️ Models & Resources <button id="budget-refresh" class="budget-refresh-btn" title="Refresh">↻</button></div>
        <div id="budget-panel" class="rpanel-body">Loading...</div>
      </div>
      <div class="rpanel" id="context-map-panel">
        <div class="rpanel-header"><span id="treemap-icon" class="panel-icon" data-hint="Refresh" data-hint-right>🔬</span> Context Map <span id="context-cost" class="panel-cost"></span><span id="context-model" class="panel-model"></span><span id="treemap-breadcrumb"></span><button id="treemap-back" class="panel-back-btn" data-hint="Back" style="display:none">◀</button></div>
        <div id="treemap-canvas" style="height:260px;position:relative"></div>
        <div id="treemap-footer" class="treemap-footer"></div>
      </div>
      <div class="rpanel" id="response-map-panel">
        <div class="rpanel-header"><span id="response-icon" class="panel-icon" data-hint="Refresh" data-hint-right>📤</span> Response <span id="response-cost" class="panel-cost"></span><span id="response-model" class="panel-model"></span><span id="response-breadcrumb"></span><button id="response-back" class="panel-back-btn" data-hint="Back" style="display:none">◀</button></div>
        <div id="response-canvas" style="height:260px;position:relative;overflow:hidden;border-radius:4px;background:#111"></div>
        <div id="response-footer" class="treemap-footer"></div>
      </div>
      <div class="rpanel" id="sessions-panel">
        <div class="rpanel-header">📋 Sessions <span id="sessions-count" class="sessions-count"></span></div>
        <div id="sessions-list" class="rpanel-body">Loading...</div>
      </div>
    </div>
    <div class="token-monitor" id="token-monitor"><div class="tm-card"><div class="label">Connecting...</div></div></div>
  `;

  const ta = $("chat-textarea") as HTMLTextAreaElement;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (ta.value.trim() && !sending) {
        send(ta.value);
        ta.value = "";
      }
    }
  });
  $("action-btn")!.addEventListener("click", () => {
    if (sending || streamRunId) {
      abort();
    } else if (ta.value.trim()) {
      send(ta.value);
      ta.value = "";
      ta.focus();
    }
  });
  $("session-select")!.addEventListener("change", (e) => {
    sessionKey = (e.target as HTMLSelectElement).value;
    messages = [];
    updateChat();
    loadChat();
  });
  $("budget-refresh")!.addEventListener("click", () => {
    loadBudget();
  });
  $("new-session-btn")!.addEventListener("click", () => {
    if (!connected || !sessionKey) {
      return;
    }
    send("/new");
  });
  $("forensic-btn")!.addEventListener("click", () => {
    const next = !forensicMode;
    req("forensic.setMode", { enabled: next })
      .then((res: any) => {
        forensicMode = res?.enabled ?? next;
        updateForensicBtn();
      })
      .catch((e) => console.error("forensic toggle:", e));
  });

  // Mount context treemap
  const tmCanvas = $("treemap-canvas")!;
  const tmFooter = $("treemap-footer")!;
  const tmBreadcrumb = $("treemap-breadcrumb")!;
  const tmCost = $("context-cost")!;
  const tmModel = $("context-model")!;
  mountContextTreemap(tmCanvas, tmFooter, tmBreadcrumb, req, () => sessionKey, tmCost, tmModel);

  $("treemap-back")!.addEventListener("click", () => {
    (tmCanvas as any).__treemapBack?.();
    updateTreemapBackBtn();
  });
  // Update back button visibility after any treemap interaction
  tmCanvas.addEventListener("click", () => {
    setTimeout(updateTreemapBackBtn, 50);
  });
  $("treemap-icon")!.addEventListener("click", () => {
    refreshTreemap();
  });

  // Mount response treemap
  const respCanvas = $("response-canvas")!;
  const respFooter = $("response-footer")!;
  const respBreadcrumb = $("response-breadcrumb")!;
  const respCost = $("response-cost")!;
  const respModel = $("response-model")!;
  mountResponseTreemap(
    respCanvas,
    respFooter,
    respBreadcrumb,
    req,
    () => sessionKey,
    respCost,
    respModel,
  );
  respCanvas.addEventListener("click", () => {
    setTimeout(updateResponseBackBtn, 50);
  });
  $("response-back")!.addEventListener("click", () => {
    (respCanvas as any).__responseBack?.();
    updateResponseBackBtn();
  });
  $("response-icon")!.addEventListener("click", () => {
    updateResponseMap();
  });
}

function updateForensicBtn() {
  const btn = $("forensic-btn");
  if (!btn) {
    return;
  }
  if (forensicMode) {
    btn.classList.add("active", "forensic-active");
    btn.innerHTML = "🛡️<span class='forensic-dot forensic-on'></span>";
    btn.title = "Forensic Mode ON — click to disable (prompts dumped to disk, no LLM calls)";
  } else {
    btn.classList.remove("active", "forensic-active");
    btn.innerHTML = "🛡️<span class='forensic-dot'></span>";
    btn.title = "Forensic Mode OFF — click to enable";
  }
}

// ─── Boot ───
init();
updateForensicBtn(); // set initial dot indicator
gwConnect();
setInterval(() => {
  if (connected) {
    loadTokens();
    loadBudget();
  }
}, 300_000);
