import { mountContextTimeline } from "./panels/context-timeline.js";
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
let initialized = false;
let budgetData: any = null;
let forensicMode = false;
let timelineCtrl: ReturnType<typeof mountContextTimeline> | null = null;

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
  anthropic: `<svg width="14" height="14" viewBox="0 0 24 24"><polygon points="12,1 13.5,8.3 19.8,4.2 15.7,10.5 23,12 15.7,13.5 19.8,19.8 13.5,15.7 12,23 10.5,15.7 4.2,19.8 8.3,13.5 1,12 8.3,10.5 4.2,4.2 10.5,8.3" fill="#D97757"/></svg>`,
  google: `<svg width="14" height="14" viewBox="0 0 48 48"><path d="M43.6 20.5H42V20H24v8h11.3C33.6 33.4 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" fill="#FFC107"/><path d="M6.3 14.7l6.6 4.8C14.5 15.9 18.9 13 24 13c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" fill="#FF3D00"/><path d="M24 44c5.2 0 9.9-1.9 13.5-5l-6.2-5.3c-2 1.5-4.5 2.3-7.3 2.3-5.2 0-9.6-3.5-11.2-8.2l-6.5 5C9.5 39.6 16.2 44 24 44z" fill="#4CAF50"/><path d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4 5.7l6.2 5.3C37 39.4 44 34 44 24c0-1.2-.1-2.3-.4-3.5z" fill="#1976D2"/></svg>`,
  openai: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M22.28 9.37a5.88 5.88 0 0 0-.51-4.86 5.97 5.97 0 0 0-6.43-2.83A5.9 5.9 0 0 0 10.87 0a5.97 5.97 0 0 0-5.69 4.13 5.88 5.88 0 0 0-3.93 2.85 5.97 5.97 0 0 0 .74 6.99 5.88 5.88 0 0 0 .51 4.86 5.97 5.97 0 0 0 6.43 2.83A5.9 5.9 0 0 0 13.4 24a5.97 5.97 0 0 0 5.69-4.13 5.88 5.88 0 0 0 3.93-2.85 5.97 5.97 0 0 0-.74-6.99zM13.4 22.3a4.42 4.42 0 0 1-2.84-1.03l.14-.08 4.72-2.73a.77.77 0 0 0 .39-.67v-6.66l2 1.15a.07.07 0 0 1 .04.06v5.52a4.46 4.46 0 0 1-4.46 4.44zM3.48 18.2a4.42 4.42 0 0 1-.53-2.97l.14.08 4.72 2.73a.77.77 0 0 0 .77 0l5.76-3.33v2.31a.07.07 0 0 1-.03.06l-4.77 2.76a4.46 4.46 0 0 1-6.06-1.64zM2.2 7.87A4.42 4.42 0 0 1 4.52 5.9v5.62a.77.77 0 0 0 .39.67l5.76 3.33-2 1.15a.07.07 0 0 1-.07 0L3.83 13.9A4.46 4.46 0 0 1 2.2 7.87zm17.33 4.03l-5.76-3.33 2-1.15a.07.07 0 0 1 .07 0l4.77 2.76a4.46 4.46 0 0 1-.69 8.05v-5.66a.77.77 0 0 0-.39-.67zM21.5 9.7l-.14-.08-4.72-2.73a.77.77 0 0 0-.77 0L10.1 10.2V7.9a.07.07 0 0 1 .03-.06l4.77-2.76a4.46 4.46 0 0 1 6.6 4.62zM8.93 13.34l-2-1.15a.07.07 0 0 1-.04-.06V6.61a4.46 4.46 0 0 1 7.3-3.42l-.14.08-4.72 2.73a.77.77 0 0 0-.39.67zm1.08-2.34L12 9.77l1.99 1.15v2.3L12 14.36l-1.99-1.15z" fill="#10a37f"/></svg>`,
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
type ActiveRunInfo = { model: string; provider: string; authProfileId?: string; startedAt: number };
const activeRuns = new Map<string, ActiveRunInfo>();
const ACTIVE_RUNS_STORAGE_KEY = "tinker-activeRuns";
// Runs restored from sessionStorage that haven't been confirmed by a lifecycle event yet
const unconfirmedRuns = new Set<string>();

function saveActiveRuns() {
  try {
    const entries = Array.from(activeRuns.entries());
    sessionStorage.setItem(ACTIVE_RUNS_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* quota exceeded — ignore */
  }
}

function restoreActiveRuns() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_RUNS_STORAGE_KEY);
    if (!raw) return;
    const entries: [string, ActiveRunInfo][] = JSON.parse(raw);
    for (const [id, info] of entries) {
      activeRuns.set(id, info);
      unconfirmedRuns.add(id);
    }
  } catch {
    /* parse error — ignore */
  }
}

/** After reconnect, clear restored runs that no lifecycle event confirmed. */
function scheduleUnconfirmedPrune() {
  if (unconfirmedRuns.size === 0) return;
  setTimeout(() => {
    let changed = false;
    for (const id of unconfirmedRuns) {
      activeRuns.delete(id);
      changed = true;
    }
    unconfirmedRuns.clear();
    if (changed) {
      saveActiveRuns();
      updateBudgetPanel();
    }
  }, 5000);
}

// Restore on load
restoreActiveRuns();

function getAuthKeyCounts(forModel?: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const info of activeRuns.values()) {
    if (forModel && info.model !== forModel) continue;
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
          loadBudget();
          refreshTreemap();
          timelineCtrl?.loadSession(sessionKey);
          scheduleUnconfirmedPrune();
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
      loadBudget();
      refreshTreemap();
      updateResponseMap();
    }
  }
  if (evt.event === "agent") {
    const p = evt.payload;
    if (p?.stream === "lifecycle" && p.data?.model) {
      // Any lifecycle event for a restored run confirms it's still active
      unconfirmedRuns.delete(p.runId);
      if (p.data.phase === "start") {
        activeRuns.set(p.runId, {
          model: p.data.model,
          provider: p.data.modelProvider || providerOf(p.data.model),
          authProfileId: p.data.authProfileId,
          startedAt: Date.now(),
        });
        saveActiveRuns();
        updateBudgetPanel();
      } else if (p.data.phase === "end" || p.data.phase === "error") {
        const endRunId = p.runId;
        setTimeout(() => {
          activeRuns.delete(endRunId);
          saveActiveRuns();
          updateBudgetPanel();
        }, 3000);
        // Poll anatomy API after turn completes
        const sk = sessionKey;
        const rid = p.runId;
        setTimeout(() => {
          if (sk && timelineCtrl) {
            const base = import.meta.env.DEV ? "http://localhost:18789" : "";
            fetch(`${base}/api/context-anatomy/${encodeURIComponent(sk)}/latest`)
              .then((r) => (r.ok ? r.json() : null))
              .then((ev) => {
                if (ev?.turn) timelineCtrl!.pushEvent(ev, rid);
              })
              .catch(() => {});
          }
        }, 500);
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
      h += `<div class="msg user" data-msg-idx="${idx}">${md(text)}</div>`;
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

function modelName(id: string): string {
  const name = id.split("/").slice(1).join("/") || id;
  return name.replace(/^claude-/, "");
}

function providerOf(id: string): string {
  return id.split("/")[0] || "unknown";
}

// Performance ranking for sorting configured models (lower = more performant).
// Uses keyword matching against the model name portion of the ID.
function modelPerfRank(id: string): number {
  const lo = id.toLowerCase();
  // Tier 0: frontier reasoning (opus, pro-preview, o1)
  if (lo.includes("opus") || lo.includes("pro-preview") || lo.includes("-o1")) return 0;
  // Tier 1: strong general (sonnet, pro, gpt-4o)
  if (
    lo.includes("sonnet") ||
    (lo.includes("pro") && !lo.includes("preview")) ||
    lo.includes("gpt-4o")
  )
    return 1;
  // Tier 2: balanced (flash non-lite, haiku)
  if (lo.includes("flash") && !lo.includes("lite")) return 2;
  if (lo.includes("haiku")) return 3;
  // Tier 3: lightweight / local
  if (lo.includes("lite") || lo.includes("mini") || lo.includes("nano")) return 4;
  return 5;
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

  // Helper: render auth key rows for a model's provider
  function renderAuthKeyRows(modelId: string, badge: string) {
    const provider = providerOf(modelId);
    const name = modelName(modelId);
    const keys: string[] = authOrder?.[provider] || [];
    // Get counts filtered to THIS model only (prevents cross-model glow)
    const counts = getAuthKeyCounts(modelId);
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
      // Multiple keys — one compact row per key with model name inline
      for (const keyId of keys) {
        const prof = authProfiles?.[keyId] || {};
        const keyLabel = prof.label || keyId.split(":")[1] || keyId;
        html += renderAuthKeyRow(keyId, keyLabel, provider, name, badge, counts.get(keyId) || 0);
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

  // Other configured models (not primary or fallback), sorted by performance tier
  const fbSet = new Set(fallbacks || []);
  const otherIds = Object.keys(models || {}).filter((id) => id !== primary && !fbSet.has(id));
  if (otherIds.length) {
    otherIds.sort((a, b) => modelPerfRank(a) - modelPerfRank(b));
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
  provider: string,
  name: string,
  badge: string,
  count: number,
): string {
  const color = PROVIDER_COLORS[provider] || "#6b7280";
  const liveClass = count > 0 ? " model-live" : "";
  const glowStyle =
    count > 0
      ? ` style="--glow-color:${color}80;--glow-bg:${color}18;--glow-bg2:${color}30;--glow-border:${color}50"`
      : "";
  const countBadge = count > 0 ? `<span class="model-agent-count">${count}</span>` : "";

  return `<div class="model-row auth-key-row${liveClass}"${glowStyle}>
    ${providerIcon(provider)}
    <span class="model-name">${esc(name)}</span>
    ${badge ? `<span class="model-badge">${badge}</span>` : ""}
    <span class="auth-key-sep">\u00b7</span>
    <span class="auth-key-label">${esc(label)}</span>
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

// ─── Bottom-right panel tab switching ───
function switchBrpTab(tab: "context" | "response") {
  const tabs = document.querySelectorAll(".brp-tab");
  const views = document.querySelectorAll(".brp-view");
  tabs.forEach((t) => t.classList.toggle("brp-tab-active", t.id === `brp-tab-${tab}`));
  views.forEach((v) => v.classList.toggle("brp-view-active", v.id === `brp-view-${tab}`));
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

// Track which session groups are collapsed (all collapsed by default)
const collapsedGroups = new Set<string>(["cron", "subagent", "whatsapp", "other"]);

function classifySession(key: string): { group: string; shortLabel: string } {
  // agent:main:cron:<uuid>
  if (/:cron:/.test(key)) {
    const uuid = key.split(":cron:")[1] ?? "";
    return { group: "cron", shortLabel: uuid.slice(0, 8) };
  }
  // agent:main:subagent:<uuid>
  if (/:subagent:/.test(key)) {
    const uuid = key.split(":subagent:")[1] ?? "";
    return { group: "subagent", shortLabel: uuid.slice(0, 8) };
  }
  // agent:main:whatsapp:group:<id> or agent:main:whatsapp:direct:<phone>
  if (/:whatsapp:/.test(key)) {
    const tail = key.split(":whatsapp:")[1] ?? "";
    return { group: "whatsapp", shortLabel: tail.replace(/@g\.us$/, "") };
  }
  // agent:main:heartbeat
  if (/:heartbeat/.test(key)) {
    return { group: "pinned", shortLabel: "heartbeat" };
  }
  // agent:main:main
  if (/:main$/.test(key)) {
    return { group: "pinned", shortLabel: "main" };
  }
  return { group: "other", shortLabel: key.slice(0, 24) };
}

const GROUP_LABELS: Record<string, string> = {
  pinned: "",
  cron: "Cron Jobs",
  subagent: "Subagents",
  whatsapp: "WhatsApp",
  other: "Other",
};

const GROUP_ORDER = ["pinned", "whatsapp", "cron", "subagent", "other"];

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

  // Group sessions
  const groups = new Map<string, Array<{ session: any; shortLabel: string }>>();
  for (const s of sessions) {
    const { group, shortLabel } = classifySession(s.key);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ session: s, shortLabel });
  }

  let html = '<div class="session-list">';

  for (const groupKey of GROUP_ORDER) {
    const items = groups.get(groupKey);
    if (!items || items.length === 0) continue;

    if (groupKey === "pinned") {
      // Pinned sessions render directly, no group header
      for (const { session: s, shortLabel } of items) {
        html += renderSessionRow(s, shortLabel);
      }
    } else {
      const label = GROUP_LABELS[groupKey] ?? groupKey;
      const collapsed = collapsedGroups.has(groupKey);
      const hasActive = items.some((i) => i.session.key === sessionKey);
      const arrow = collapsed ? "\u25B8" : "\u25BE";
      html += `<div class="session-group-header${hasActive ? " session-group-has-active" : ""}" data-group="${esc(groupKey)}">
        <span class="session-group-arrow">${arrow}</span>
        <span class="session-group-label">${esc(label)}</span>
        <span class="session-group-count">${items.length}</span>
      </div>`;
      if (!collapsed) {
        for (const { session: s, shortLabel } of items) {
          html += renderSessionRow(s, shortLabel);
        }
      }
    }
  }

  html += "</div>";
  el.innerHTML = html;

  // Wire session row clicks
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
        timelineCtrl?.loadSession(key);
      }
    });
  });

  // Wire group header clicks (toggle collapse)
  el.querySelectorAll(".session-group-header").forEach((hdr) => {
    hdr.addEventListener("click", () => {
      const group = (hdr as HTMLElement).dataset.group!;
      if (collapsedGroups.has(group)) {
        collapsedGroups.delete(group);
      } else {
        collapsedGroups.add(group);
      }
      updateSessionsPanel();
    });
  });
}

function renderSessionRow(s: any, shortLabel: string): string {
  const isActive = s.key === sessionKey;
  const label = s.label || s.displayName || shortLabel;
  const tokens = s.totalTokens ? formatNum(s.totalTokens) + " tok" : "";
  const age = s.updatedAt ? timeAgo(s.updatedAt) : "";
  const channel = s.channel ? `<span style="opacity:.5">${esc(s.channel)}</span>` : "";
  return `<div class="session-row${isActive ? " session-active" : ""}" data-session-key="${esc(s.key)}">
    <span class="session-label">${esc(label)} ${channel}</span>
    <span class="session-stats">${tokens}${tokens && age ? " · " : ""}${age}</span>
  </div>`;
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
      <div class="rpanel" id="sessions-panel">
        <div class="rpanel-header">📋 Sessions <span id="sessions-count" class="sessions-count"></span></div>
        <div id="sessions-list" class="rpanel-body">Loading...</div>
      </div>
    </div>
    <div class="context-timeline" id="context-timeline"></div>
    <div class="bottom-right-panel" id="bottom-right-panel">
      <div class="brp-views">
        <div class="brp-view brp-view-active" id="brp-view-context">
          <div id="treemap-canvas" style="width:100%;height:100%;position:relative"></div>
          <button class="brp-back-btn" id="brp-back-context" title="Back" style="display:none">\u25C0</button>
        </div>
        <div class="brp-view" id="brp-view-response">
          <div id="response-canvas" style="width:100%;height:100%;position:relative;overflow:hidden"></div>
          <button class="brp-back-btn" id="brp-back-response" title="Back" style="display:none">\u25C0</button>
        </div>
      </div>
      <div id="treemap-footer" class="treemap-footer"><span id="brp-footer-text"></span><span id="brp-meta" class="brp-meta"></span></div>
    </div>
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
    timelineCtrl?.loadSession(sessionKey);
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

  // Mount context treemap into bottom-right panel
  const tmCanvas = $("treemap-canvas")!;
  const tmFooter = $("treemap-footer")!;
  const brpMeta = $("brp-meta")!;
  mountContextTreemap(tmCanvas, tmFooter, brpMeta, req, () => sessionKey, brpMeta);

  // Mount response treemap into bottom-right panel
  const respCanvas = $("response-canvas")!;
  mountResponseTreemap(respCanvas, tmFooter, brpMeta, req, () => sessionKey, brpMeta);

  // Back buttons
  const backCtx = $("brp-back-context")!;
  const backResp = $("brp-back-response")!;

  function updateBackButtons() {
    backCtx.style.display = (tmCanvas as any).__treemapCanGoBack?.() ? "" : "none";
    backResp.style.display = (respCanvas as any).__responseCanGoBack?.() ? "" : "none";
  }

  backCtx.addEventListener("click", () => {
    (tmCanvas as any).__treemapBack?.();
    updateBackButtons();
  });
  backResp.addEventListener("click", () => {
    (respCanvas as any).__responseBack?.();
    updateBackButtons();
  });

  // Observe treemap re-renders to update back button visibility
  const backObserver = new MutationObserver(updateBackButtons);
  backObserver.observe(tmCanvas, { childList: true, subtree: true });
  backObserver.observe(respCanvas, { childList: true, subtree: true });

  // Also expose direct callback for level changes (catches async updates the observer might miss)
  (tmCanvas as any).__onLevelChange = updateBackButtons;
  (respCanvas as any).__onLevelChange = updateBackButtons;

  // ─── Auto-summary on bar re-click ───
  async function triggerAutoSummary(event: any, type: "context" | "response") {
    const panel = type === "context" ? tmCanvas : respCanvas;
    const ts = event.timestampMs ?? (event.timestamp ? new Date(event.timestamp).getTime() : null);
    panel.innerHTML = '<div class="tm-empty">Summarizing\u2026</div>';
    try {
      const params: any = {
        component: type === "context" ? "current_prompt" : "response",
        sessionKey: sessionKey || undefined,
      };
      if (ts) params.timestamp = ts;
      const result = await req("forensic.summarize", params);
      const summary = result?.summary ?? "(no summary)";
      panel.innerHTML = "";
      const div = document.createElement("div");
      div.className = "tm-preview";
      div.style.background = "rgba(20,20,40,0.95)";
      const hdr = document.createElement("div");
      hdr.className = "tm-preview-header";
      hdr.textContent = type === "context" ? "Prompt Summary" : "Response Summary";
      const body = document.createElement("div");
      body.className = "tm-text-block";
      body.textContent = summary;
      div.appendChild(hdr);
      div.appendChild(body);
      panel.appendChild(div);
      (panel as any).__onLevelChange?.();
    } catch (e: any) {
      panel.innerHTML = `<div class="tm-empty">Summary failed: ${esc(e?.message ?? "unknown")}</div>`;
    }
  }

  // Mount context timeline (bottom bar)
  const timelineContainer = $("context-timeline")!;
  timelineCtrl = mountContextTimeline(
    timelineContainer,
    (event, mode) => {
      if (mode === "response-summarize") {
        switchBrpTab("response");
        triggerAutoSummary(event, "response");
      } else if (mode === "context-summarize") {
        triggerAutoSummary(event, "context");
      } else if (mode === "response") {
        switchBrpTab("response");
        updateResponseMap();
      } else {
        switchBrpTab("context");
        (tmCanvas as any).__treemapShowAnatomy?.(event);
      }
      updateBackButtons();
    },
    () => sessionKey,
    () => (import.meta.env.DEV ? "http://localhost:18789" : ""),
    PROVIDER_ICONS,
    (groupIndex) => {
      // Scroll webchat to the Nth user message matching this group
      const container = $("messages");
      if (!container) return;
      const userMsgs = container.querySelectorAll(".msg.user");
      if (groupIndex >= userMsgs.length) return;
      const target = userMsgs[groupIndex] as HTMLElement;
      // Manual smooth scroll within the .messages container
      const targetTop = target.offsetTop - container.offsetTop;
      const dest = targetTop - container.clientHeight / 2 + target.offsetHeight / 2;
      const start = container.scrollTop;
      const delta = dest - start;
      const duration = 350;
      let t0: number | null = null;
      function step(ts: number) {
        if (!t0) t0 = ts;
        const elapsed = ts - t0;
        const progress = Math.min(elapsed / duration, 1);
        // ease-out cubic
        const ease = 1 - Math.pow(1 - progress, 3);
        container!.scrollTop = start + delta * ease;
        if (progress < 1) requestAnimationFrame(step);
        else {
          target.classList.add("scroll-highlight");
          setTimeout(() => target.classList.remove("scroll-highlight"), 900);
        }
      }
      requestAnimationFrame(step);
    },
  );
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
    loadBudget();
  }
}, 300_000);
