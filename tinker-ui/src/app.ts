// Tinker UI — Command Center v0.3
import { mountContextTreemap } from "./panels/context-treemap.js";
import { mountResponseTreemap } from "./panels/response-treemap.js";

// Runtime config: injected by the tinker plugin into index.html, or via URL params
const __cfg = (window as any).__TINKER_CONFIG ?? {};
const TOKEN = __cfg.token ?? new URLSearchParams(window.location.search).get("token") ?? "";
const GW_WS = `ws${window.location.protocol === "https:" ? "s" : ""}://${window.location.host}`;
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
};
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
  let html = '<div class="model-list">';

  // Primary
  if (primary) {
    const alias = models?.[primary]?.alias;
    html += '<div class="model-group-label">PRIMARY</div>';
    html += renderModelRow(primary, alias, "\u{1F451}", true);
  }

  // Fallbacks
  if (fallbacks?.length) {
    const badges = ["\u2460", "\u2461", "\u2462", "\u2463", "\u2464"];
    html += '<div class="model-group-label">FALLBACK CHAIN</div>';
    for (let i = 0; i < fallbacks.length; i++) {
      const fb = fallbacks[i];
      const alias = models?.[fb]?.alias;
      html += renderModelRow(fb, alias, badges[i] || `${i + 1}`, false);
    }
  }

  // Other configured models (not primary or fallback)
  const fbSet = new Set(fallbacks || []);
  const otherIds = Object.keys(models || {}).filter((id) => id !== primary && !fbSet.has(id));
  if (otherIds.length) {
    html += '<div class="model-group-label">CONFIGURED</div>';
    for (const id of otherIds) {
      const alias = models[id]?.alias;
      html += renderModelRow(id, alias, "", false);
    }
  }

  // Provider auth summary
  const providers = new Set<string>();
  if (primary) {
    providers.add(providerOf(primary));
  }
  for (const fb of fallbacks || []) {
    providers.add(providerOf(fb));
  }
  for (const id of Object.keys(models || {})) {
    providers.add(providerOf(id));
  }

  html += '<div class="model-group-label" style="margin-top:8px">PROVIDERS</div>';
  for (const prov of providers) {
    const order: string[] = authOrder?.[prov] || [];
    const authDesc = order.length
      ? order
          .map((p: string) => {
            const mode = authProfiles?.[p]?.mode || "unknown";
            const label = p.split(":")[1] || p;
            return `${label}(${mode})`;
          })
          .join(" \u2192 ")
      : prov === "ollama"
        ? "local"
        : "default";
    html += `<div class="provider-row"><span class="provider-name">${esc(prov)}</span><span class="provider-auth">${esc(authDesc)}</span></div>`;
  }

  html += `</div><div class="budget-updated">Updated ${new Date().toLocaleTimeString()}</div>`;
  el.innerHTML = html;
}

function renderModelRow(
  id: string,
  alias: string | undefined,
  badge: string,
  isPrimary: boolean,
): string {
  const provider = providerOf(id);
  const name = modelName(id);
  const color = PROVIDER_COLORS[provider] || "#6b7280";
  const aliasBadge = alias ? `<span class="model-alias">${esc(alias)}</span>` : "";
  const tierBadge = badge ? `<span class="model-badge">${badge}</span>` : "";
  const activeClass = isPrimary ? " model-active" : "";
  const providerDot = `<span class="model-provider-dot" style="background:${color}"></span>`;

  return `<div class="model-row${activeClass}">
    ${providerDot}
    <span class="model-name">${esc(name)}</span>
    ${tierBadge}
    ${aliasBadge}
    <span class="model-provider-label">${esc(provider)}</span>
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
