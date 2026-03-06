import MarkdownIt from "markdown-it";
import { mountContextTimeline } from "./panels/context-timeline.js";
// Tinker UI — Command Center v0.3
import { mountContextTreemap } from "./panels/context-treemap.js";
import { mountOverseerGraph, type OverseerItem } from "./panels/overseer-graph.js";
import { mountResponseTreemap } from "./panels/response-treemap.js";

const mdParser = MarkdownIt({ html: false, linkify: true, breaks: true });

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
let currentTurnNumber = 0;
let expandedTools = new Set<string>();
let liveToolCalls = new Map<
  string,
  { name: string; args: any; toolCallId: string; isError: boolean; result: any }
>();
let initialized = false;
let budgetData: any = null;
let forensicMode = false;
let showOverseerChat = false;
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

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}

// ─── Persisted Error Messages ───
const ERROR_STORAGE_KEY = "tinker-errors";

function persistErrorMsg(sk: string, msg: any) {
  try {
    const all = JSON.parse(localStorage.getItem(ERROR_STORAGE_KEY) || "{}");
    if (!all[sk]) all[sk] = [];
    all[sk].push(msg);
    localStorage.setItem(ERROR_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota exceeded */
  }
}

function loadPersistedErrors(sk: string): any[] {
  try {
    const all = JSON.parse(localStorage.getItem(ERROR_STORAGE_KEY) || "{}");
    return all[sk] || [];
  } catch {
    return [];
  }
}

function clearPersistedErrors(sk: string) {
  try {
    const all = JSON.parse(localStorage.getItem(ERROR_STORAGE_KEY) || "{}");
    delete all[sk];
    localStorage.setItem(ERROR_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

// ─── Active Model Tracking ───
type ActiveRunInfo = { model: string; provider: string; authProfileId?: string; startedAt: number };
const activeRuns = new Map<string, ActiveRunInfo>();
const providerErrors = new Map<string, { error: string; reason: string; ts: number }>();
const collapsedModelSections = new Set<string>();
const ACTIVE_RUNS_STORAGE_KEY = "tinker-activeRuns";
const DRAFT_STORAGE_KEY = "tinker-draft";
// Runs restored from sessionStorage that haven't been confirmed by a lifecycle event yet
const unconfirmedRuns = new Set<string>();
// Pending delayed deletes for activeRuns — cancelled when a fallback model re-uses the same runId
const pendingRunDeletes = new Map<string, ReturnType<typeof setTimeout>>();

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
    sending = false;
    streamText = "";
    streamRunId = null;
    updateDots();
    updateBtn();
    updateChat();
    setTimeout(gwConnect, 2000);
  };
}

function onFrame(f: any) {
  if (f.type === "event") {
    if (f.event === "connect.challenge") {
      req("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "webchat-ui",
          displayName: "Tinker UI",
          version: "0.3",
          platform: "web",
          mode: "webchat",
        },
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
          updateBtn();
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

// ─── Health Poll (replaces 5-min auto-clear) ───
let healthPollInterval: ReturnType<typeof setInterval> | null = null;

function startHealthPoll() {
  if (healthPollInterval) return;
  healthPollInterval = setInterval(async () => {
    if (providerErrors.size === 0) {
      clearInterval(healthPollInterval!);
      healthPollInterval = null;
      return;
    }
    try {
      const res = await req("provider.health", {});
      if (!res?.health) return;
      let changed = false;
      for (const [provider, info] of Object.entries(res.health) as [string, any][]) {
        if (info.available) {
          if (providerErrors.has(provider)) {
            providerErrors.delete(provider);
            changed = true;
          }
          // Clear per-profile and per-model errors for this provider
          for (const k of providerErrors.keys()) {
            if (k.startsWith(provider + ":") || k.startsWith(provider + "/")) {
              providerErrors.delete(k);
              changed = true;
            }
          }
        }
      }
      if (changed) updateBudgetPanel();
    } catch {
      /* gateway disconnected */
    }
  }, 60_000);
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
      // Inject live tool calls as a synthetic message if the final doesn't include them
      if (liveToolCalls.size > 0) {
        const finalContent = Array.isArray(p.message?.content) ? p.message.content : [];
        const hasTool = finalContent.some(
          (b: any) => b.type === "tool_use" || b.type === "tool_result",
        );
        if (!hasTool) {
          const syntheticContent: any[] = [];
          for (const [, tc] of liveToolCalls) {
            syntheticContent.push({
              type: "tool_use",
              id: tc.toolCallId,
              name: tc.name,
              input: tc.args,
            });
            syntheticContent.push({
              type: "tool_result",
              tool_use_id: tc.toolCallId,
              content:
                tc.result != null
                  ? typeof tc.result === "string"
                    ? tc.result
                    : JSON.stringify(tc.result)
                  : "(completed)",
              is_error: tc.isError,
            });
          }
          messages.push({ role: "assistant", content: syntheticContent, _synthetic: true });
        }
        liveToolCalls.clear();
      }
      if (p.message) {
        messages.push(p.message);
      }
      if (p.state === "error" && p.errorMessage) {
        const errMsg = {
          role: "assistant",
          content: [{ type: "text", text: p.errorMessage }],
          _isError: true,
        };
        messages.push(errMsg);
        persistErrorMsg(sessionKey, errMsg);
      }
      if (p.state === "final") {
        // Successful response — clear persisted errors for this session
        clearPersistedErrors(sessionKey);
      }
      // During fallback the same runId gets a chat error for the failed model
      // then a new start+deltas for the fallback model. Only clear streaming
      // state on the FINAL event (final/aborted), not on intermediate errors.
      if (p.state !== "error") {
        streamText = "";
        streamRunId = null;
      }
      // Only clear sending when no active runs remain AND no pending fallback
      if (activeRuns.size === 0 && pendingRunDeletes.size === 0) {
        sending = false;
      }
      updateChat();
      updateBtn();
      if (p.state !== "error") {
        loadBudget();
        refreshTreemap();
        updateResponseMap();
      }
    }
  }
  if (evt.event === "agent") {
    const p = evt.payload;
    // ─── Live Tool Events ───
    // Capture tool-use/tool-result events and inject them as visible messages
    if (p?.stream === "tool" && p.sessionKey === sessionKey) {
      const d = p.data ?? {};
      if (d.phase === "start" && d.name && d.toolCallId) {
        // Store the tool call for live rendering
        liveToolCalls.set(d.toolCallId, {
          name: d.name,
          args: d.args ?? {},
          toolCallId: d.toolCallId,
          isError: false,
          result: null,
        });
        updateChat();
      } else if (d.phase === "result" && d.toolCallId) {
        const existing = liveToolCalls.get(d.toolCallId);
        if (existing) {
          existing.isError = Boolean(d.isError);
          existing.result = d.result ?? null;
        } else {
          liveToolCalls.set(d.toolCallId, {
            name: d.name ?? "tool",
            args: {},
            toolCallId: d.toolCallId,
            isError: Boolean(d.isError),
            result: d.result ?? null,
          });
        }
        updateChat();
      }
    }
    // Track provider failures from model fallback
    if (p?.stream === "lifecycle" && p.data?.phase === "fallback-error") {
      const fp = p.data.failedProvider as string | undefined;
      const fm = p.data.failedModel as string | undefined;
      const reason = (p.data.reason || "unknown") as string;
      const errMsg = (p.data.error || "") as string;
      const attempt = p.data.attempt as number | undefined;
      const total = p.data.total as number | undefined;
      // Key by profileId or model — NOT bare provider, to avoid bleeding
      // into other models from the same provider (e.g. opus error showing on sonnet/haiku).
      // fallback-profile-error already populates per-profile entries.
      const errKey = (p.data.failedProfileId as string) || fm || fp;
      if (errKey) {
        providerErrors.set(errKey, {
          error: (errMsg || reason || "failed") as string,
          reason,
          ts: Date.now(),
        });
        updateBudgetPanel();
        startHealthPoll();
      }
      // Show each fallback step as a chat message
      const profileId = (p.data.failedProfileId || "") as string;
      const stepLabel = attempt && total ? `[${attempt}/${total}]` : "";
      const modelLabel = fm || "unknown";
      const profileLabel = profileId ? ` (${profileId})` : "";
      const reasonLabel = describeError(reason, errMsg);
      // Mark timeline placeholder as failed
      if (p.runId) {
        timelineCtrl?.failPlaceholder(p.runId, reasonLabel);
      }
      const nextLabel =
        attempt && total && attempt < total ? " — jumping to backup" : " — all backups exhausted";
      const fallbackText = `⚠ ${stepLabel} ${modelLabel}${profileLabel} failed (${reasonLabel})${nextLabel}`;
      const fallbackMsg: any = {
        role: "assistant",
        content: [{ type: "text", text: fallbackText }],
        _isError: true,
        _retryProvider: fp || undefined,
      };
      messages.push(fallbackMsg);
      persistErrorMsg(sessionKey, fallbackMsg);
      updateChat();
    }
    // Show per-profile failure events (auth profile rotation within a provider)
    if (p?.stream === "lifecycle" && p.data?.phase === "fallback-profile-error") {
      const prov = (p.data.provider || "unknown") as string;
      const model = (p.data.model || "unknown") as string;
      const pid = (p.data.profileId || "") as string;
      const reason = (p.data.reason || "unknown") as string;
      const errMsg = (p.data.error || "") as string;
      const pIdx = p.data.profileIndex as number | undefined;
      const pTotal = (p.data.totalProfiles ?? p.data.profileTotal) as number | undefined;
      const reasonLabel = describeError(reason, errMsg);
      const profileStep = pIdx && pTotal ? ` [profile ${pIdx}/${pTotal}]` : "";
      const profileText = `↳ ${model} ${pid ? pid : prov}${profileStep} — ${reasonLabel}`;
      // Track per-profile error for model panel red labels
      if (pid) {
        providerErrors.set(pid, {
          error: (errMsg || reason || "failed") as string,
          reason,
          ts: Date.now(),
        });
        updateBudgetPanel();
        startHealthPoll();
      }
      const profileMsg: any = {
        role: "assistant",
        content: [{ type: "text", text: profileText }],
        _isError: true,
        _retryProvider: prov,
      };
      messages.push(profileMsg);
      persistErrorMsg(sessionKey, profileMsg);
      updateChat();
    }
    // Overseer periodic chat updates
    if (p?.stream === "lifecycle" && p.data?.phase === "overseer-update") {
      const mdText = p.data.markdown as string;
      if (mdText) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: mdText }],
          _isOverseer: true,
        });
        updateChat();
      }
    }
    if (p?.stream === "lifecycle" && p.data?.model) {
      // Ignore lifecycle events that don't belong to the current session (e.g. heartbeat)
      if (p.data.sessionKey && p.data.sessionKey !== sessionKey) return;
      // Any lifecycle event for a restored run confirms it's still active
      unconfirmedRuns.delete(p.runId);
      if (p.data.phase === "start") {
        const startProvider = p.data.modelProvider || providerOf(p.data.model);
        // Cancel any pending deletion for this runId (fallback reuses the same runId)
        const pendingTimeout = pendingRunDeletes.get(p.runId);
        if (pendingTimeout) {
          clearTimeout(pendingTimeout);
          pendingRunDeletes.delete(p.runId);
        }
        // Clear provider-level, per-profile, and per-model errors on successful start
        const startModel = p.data.model as string;
        providerErrors.delete(startProvider);
        providerErrors.delete(startModel);
        for (const k of providerErrors.keys()) {
          if (k.startsWith(startProvider + ":")) providerErrors.delete(k);
        }
        activeRuns.set(p.runId, {
          model: p.data.model,
          provider: startProvider,
          authProfileId: p.data.authProfileId,
          startedAt: Date.now(),
        });
        // Re-assert sending in case a chat error event cleared it during fallback
        sending = true;
        saveActiveRuns();
        updateBudgetPanel();
        updateChat();
        updateBtn();
        startThinkingTick();
        // Activate timeline placeholder with provider/model info
        timelineCtrl?.activatePlaceholder(p.runId, p.data.model, startProvider);
      } else if (p.data.phase === "end" || p.data.phase === "error") {
        const endRunId = p.runId;
        const timeoutId = setTimeout(() => {
          pendingRunDeletes.delete(endRunId);
          activeRuns.delete(endRunId);
          saveActiveRuns();
          // Clear sending once all runs are done
          if (activeRuns.size === 0) {
            sending = false;
          }
          updateBudgetPanel();
          updateChat();
          updateBtn();
        }, 3000);
        pendingRunDeletes.set(endRunId, timeoutId);
        // Poll anatomy API after turn completes — fetch recent events to capture fallback attempts
        const sk = sessionKey;
        const turnNum = currentTurnNumber;
        setTimeout(() => {
          if (sk && timelineCtrl) {
            const base = import.meta.env.DEV ? "http://localhost:18789" : "";
            fetch(`${base}/api/context-anatomy/${encodeURIComponent(sk)}?limit=10`)
              .then((r) => (r.ok ? r.json() : null))
              .then((body) => {
                const events: any[] = Array.isArray(body) ? body : (body?.events ?? []);
                if (events.length === 0) return;
                // Find events for the current turn
                const turnEvents = events.filter((ev: any) => ev.turn === turnNum);
                if (turnEvents.length > 0) {
                  timelineCtrl!.replacePlaceholders(turnNum, turnEvents);
                } else {
                  // Fallback: just use the latest event (backwards compat)
                  const latest = events[events.length - 1];
                  if (latest?.turn) {
                    timelineCtrl!.replacePlaceholders(latest.turn, [latest]);
                  }
                }
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
  liveToolCalls.clear();
  if (!sessionKey) {
    return;
  }
  const res = await req("chat.history", { sessionKey, limit: 200 }).catch(() => ({ messages: [] }));
  messages = res.messages ?? [];
  // Sync turn counter from loaded history
  const userMsgCount = messages.filter((m: any) => m.role === "user").length;
  currentTurnNumber = userMsgCount;
  // Restore persisted error messages (survive refresh)
  const storedErrors = loadPersistedErrors(sessionKey);
  if (storedErrors.length) {
    // Insert errors before the last assistant message (natural position),
    // or append at end if no assistant message follows.
    const lastAssistantIdx = findLastIndex(messages, (m: any) => m.role === "assistant");
    if (lastAssistantIdx >= 0) {
      messages.splice(lastAssistantIdx, 0, ...storedErrors);
    } else {
      messages.push(...storedErrors);
    }
  }
  updateChat();
  scrollChat();
  updateResponseMap();
}

async function send(text: string) {
  if (!text.trim() || !sessionKey) {
    return;
  }
  sending = true;
  currentTurnNumber++;
  messages.push({ role: "user", content: [{ type: "text", text }] });
  timelineCtrl?.pushPlaceholder(currentTurnNumber);
  updateChat();
  updateBtn();
  scrollChat();
  await req("chat.send", { sessionKey, message: text, idempotencyKey: uuid() }).catch((e) => {
    console.error(e);
    sending = false;
    updateBtn();
  });
}

function retryProvider(provider: string) {
  // Clear provider-level, per-profile, and per-model error state
  providerErrors.delete(provider);
  for (const k of providerErrors.keys()) {
    if (k.startsWith(provider + ":") || k.startsWith(provider + "/")) {
      providerErrors.delete(k);
    }
  }
  updateBudgetPanel();
  // Remove error messages from this provider and re-render
  messages = messages.filter((m) => !(m._isError && m._retryProvider === provider));
  clearPersistedErrors(sessionKey);
  // Find last user message and resend
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].role ?? "").toLowerCase() === "user") {
      const text = Array.isArray(messages[i].content)
        ? messages[i].content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n")
        : typeof messages[i].content === "string"
          ? messages[i].content
          : "";
      if (text.trim()) {
        // Remove the user message — send() will re-add it
        messages.splice(i, 1);
        send(text.trim());
        return;
      }
    }
  }
  // No user message found — just refresh
  updateChat();
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
  let h = mdParser.render(text);
  // Jarvis voice styling
  h = h.replace(
    /<strong>Jarvis:<\/strong>\s*<em>(.*?)<\/em>/gi,
    '<strong>Jarvis:</strong> <span class="jarvis-voice">$1</span>',
  );
  return h;
}

// ─── Smart Tool Summaries ───
function shortenPath(s: string): string {
  return s.replace(/\/home\/[^/]+/g, "~");
}

function fileName(p: string): string {
  return p.split("/").pop() ?? p;
}

function extractGrepTarget(cmd: string): string {
  // Extract the search pattern from grep commands
  const m = cmd.match(/grep\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

function extractGrepFiles(cmd: string): string {
  // Get the last path-like argument
  const parts = cmd.split(/\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes("/")) return fileName(shortenPath(parts[i]));
  }
  return "";
}

function editPreview(s: string): string {
  // Return first meaningful line of a string, trimmed
  const line = s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return line.length > 60 ? line.slice(0, 57) + "…" : line;
}

function toolSummary(name: string, input: any): string {
  const n = (name ?? "").toLowerCase();
  const a = input ?? {};
  switch (n) {
    case "exec": {
      const cmd = shortenPath(String(a.command ?? ""));
      if (cmd.match(/^grep\b/)) {
        const target = extractGrepTarget(cmd);
        return target
          ? `Looking for any mention of "${target}" across the code`
          : `Searching through the code for a specific pattern`;
      }
      if (cmd.match(/^find\b/)) {
        const nameM = cmd.match(
          /-name\s+"([^"]+)"|--name\s+"([^"]+)"|-name\s+'([^']+)'|-name\s+(\S+)/,
        );
        const what = nameM ? (nameM[1] ?? nameM[2] ?? nameM[3] ?? nameM[4]) : "something";
        return `Scanning the project to locate ${what}`;
      }
      if (cmd.startsWith("ls")) return `Checking what's inside a folder`;
      if (cmd.startsWith("cat")) return `Reading the contents of a file`;
      if (cmd.startsWith("kill")) return `Stopping something that was running`;
      if (cmd.includes("pnpm build") || cmd.includes("npm build"))
        return `Compiling all recent changes so they take effect`;
      if (cmd.includes("pnpm test") || cmd.includes("npm test"))
        return `Running automated checks to make sure nothing is broken`;
      if (cmd.includes("pnpm install") || cmd.includes("npm install"))
        return `Setting up the required software components`;
      if (cmd.match(/^curl\b/)) {
        const urlM = cmd.match(/https?:\/\/([^/\s"']+)/);
        return urlM
          ? `Requesting information from ${urlM[1]}`
          : `Requesting information from the internet`;
      }
      if (cmd.startsWith("jarvis")) {
        const textM = cmd.match(/jarvis\s+"([^"]+)"|jarvis\s+'([^']+)'/);
        const speech = textM ? (textM[1] ?? textM[2] ?? "").slice(0, 80) : "";
        return speech ? `Saying out loud: "${speech}"` : `Speaking a response out loud`;
      }
      if (cmd.startsWith("which")) {
        const bins = cmd.replace(/^which\s+/, "").trim();
        return `Checking whether ${bins} is available on this machine`;
      }
      if (cmd.startsWith("ps ")) return `Checking what programs are currently running`;
      if (cmd.startsWith("sed")) return `Making a quick text replacement in a file`;
      if (cmd.includes("git pull")) return `Downloading the latest version of the code`;
      if (cmd.includes("git push")) return `Uploading the changes so others can see them`;
      if (cmd.includes("git commit")) return `Saving the current changes as a named checkpoint`;
      if (cmd.includes("git diff")) return `Comparing what changed between two versions`;
      if (cmd.includes("git ")) return `Doing some version tracking housekeeping`;
      if (cmd.startsWith("echo")) return `Printing a note`;
      if (cmd.startsWith("sleep")) return `Pausing briefly before the next step`;
      if (cmd.startsWith("nohup") || cmd.startsWith("setsid"))
        return `Starting a long-running task in the background`;
      return `Performing a system operation`;
    }
    case "read":
      return `Reading a section of the code to understand how it works`;
    case "edit": {
      const oldStr = String(a.old_string ?? a.oldText ?? "");
      const newStr = String(a.new_string ?? a.newText ?? "");
      const oldP = editPreview(oldStr);
      const newP = editPreview(newStr);
      if (oldStr && !newStr) return `Removing: "${oldP}"`;
      if (!oldStr && newStr) return `Adding: "${newP}"`;
      return `Changing "${oldP}" to "${newP}"`;
    }
    case "write":
      return `Creating a new file with the necessary content`;
    case "process": {
      const act = a.action ?? "?";
      if (act === "poll") return `Waiting for a background task to finish`;
      if (act === "kill") return `Stopping a background task`;
      if (act === "log") return `Checking the output of a background task`;
      if (act === "list") return `Looking at what's running in the background`;
      return `Managing a background task`;
    }
    case "memory_search":
      return `Searching through past notes for "${a.query ?? ""}"`;
    case "memory_get":
      return `Pulling up a previous note from memory`;
    case "web_search":
      return `Looking up "${a.query ?? ""}" on the internet`;
    case "web_fetch": {
      const url = String(a.url ?? "");
      const domain = url.match(/https?:\/\/([^/]+)/)?.[1] ?? "";
      return domain ? `Reading a page from ${domain}` : `Reading a web page`;
    }
    case "message": {
      const act = a.action ?? "send";
      const target = a.target ?? a.to ?? "someone";
      if (act === "send") return `Sending a message to ${target}`;
      if (act === "react") return `Reacting to a message`;
      return `Performing a messaging action with ${target}`;
    }
    case "browser": {
      const act = a.action ?? "?";
      if (act === "screenshot") return `Taking a picture of what's on screen`;
      if (act === "snapshot") return `Reading the layout of the web page`;
      if (act === "open") return `Opening a web page in the browser`;
      if (act === "navigate") return `Going to a different web page`;
      if (act === "act") return `Clicking or typing something on the page`;
      return `Doing something in the browser`;
    }
    case "image":
      return a.prompt
        ? `Looking at an image to ${String(a.prompt).slice(0, 80)}`
        : `Examining an image`;
    case "whatsapp_history": {
      const act = a.action ?? "?";
      if (act === "search" && a.query) return `Searching WhatsApp messages for "${a.query}"`;
      if (act === "search" && a.chat) return `Reading a WhatsApp conversation`;
      if (act === "search") return `Going through recent WhatsApp messages`;
      if (act === "stats") return `Checking how many WhatsApp messages there are`;
      return `Doing something with WhatsApp`;
    }
    case "sessions_spawn":
      return `Starting a helper to work on: ${String(a.task ?? "").slice(0, 80)}`;
    case "subagents": {
      const act = a.action ?? "?";
      if (act === "list") return `Checking on helpers that are working in parallel`;
      if (act === "kill") return `Telling a helper to stop`;
      if (act === "steer") return `Giving new instructions to a helper`;
      return `Managing helpers`;
    }
    case "tts":
      return `Saying out loud: "${String(a.text ?? "").slice(0, 80)}"`;
    case "session_status":
      return `Checking how much time and resources this conversation has used`;
    case "pdf":
      return a.prompt
        ? `Reading a PDF document to ${String(a.prompt).slice(0, 80)}`
        : `Reading a PDF document`;
    default:
      return `Performing an action`;
  }
}

function toolExpandedDetail(name: string, input: any): string {
  const n = (name ?? "").toLowerCase();
  const a = input ?? {};
  const p = shortenPath(String(a.file_path ?? a.path ?? ""));
  switch (n) {
    case "exec":
      return `<div class="explanation">Ran shell command:</div><div class="code-block">${esc(String(a.command ?? ""))}</div>`;
    case "edit": {
      const oldStr = String(a.old_string ?? a.oldText ?? "");
      const newStr = String(a.new_string ?? a.newText ?? "");
      return `<div class="explanation">Edited ${p} — replaced ${oldStr.length} chars with ${newStr.length} chars:</div><del>${esc(oldStr)}</del><ins>${esc(newStr)}</ins>`;
    }
    case "read":
      return `<div class="explanation">Read ${p}${a.offset ? `, lines ${a.offset}–${(a.offset ?? 0) + (a.limit ?? 0)}` : ""}:</div>`;
    case "write":
      return `<div class="explanation">Wrote ${String(a.content ?? "").length} chars to ${p}:</div><div class="code-block">${esc(String(a.content ?? ""))}</div>`;
    case "memory_search":
      return `<div class="explanation">Searched memory for: "${esc(String(a.query ?? ""))}"</div>`;
    case "web_search":
      return `<div class="explanation">Web search: "${esc(String(a.query ?? ""))}"</div>`;
    case "web_fetch":
      return `<div class="explanation">Fetched URL: ${esc(String(a.url ?? ""))}</div>`;
    case "process":
      return `<div class="explanation">Process ${esc(String(a.action ?? "?"))} on session ${esc(String(a.sessionId ?? "?"))}${a.timeout ? ` (timeout: ${a.timeout}ms)` : ""}:</div>`;
    default: {
      // Formatted key-value pairs instead of raw JSON
      const entries = Object.entries(a);
      if (entries.length === 0)
        return `<div class="explanation">${esc(name ?? "tool")} (no parameters)</div>`;
      let out = `<div class="explanation">${esc(name ?? "tool")}:</div>`;
      for (const [k, v] of entries) {
        const vs = typeof v === "string" ? v : JSON.stringify(v);
        out += `<div><span class="kv-label">${esc(k)}:</span> ${esc(shortenPath(String(vs)))}</div>`;
      }
      return out;
    }
  }
}

function renderMsg(msg: any, idx: number): string {
  // Hide overseer-update messages unless toggled on
  if (msg._isOverseer && !showOverseerChat) return "";
  const role = (msg.role ?? "").toLowerCase();
  const content = Array.isArray(msg.content) ? msg.content : [];
  const texts = content.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "");
  const text = texts.join("\n") || (typeof msg.content === "string" ? msg.content : "");
  const tus = content.filter((b: any) => b.type === "tool_use");
  const trs = content.filter((b: any) => b.type === "tool_result");
  // Build result map for pairing
  const resultMap = new Map<string, { content: string; isError: boolean }>();
  for (const tr of trs) {
    const rt = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? "");
    resultMap.set(tr.tool_use_id ?? "", { content: rt, isError: tr.is_error === true });
  }
  let h = "";

  for (const tu of tus) {
    const a = tu.input ?? {};
    const d = toolSummary(tu.name, a);
    const tid = `t${idx}-${tu.id ?? tu.name}`;
    const exp = expandedTools.has(tid);
    const paired = resultMap.get(tu.id ?? "");
    const statusIcon = paired ? (paired.isError ? "✗" : "✓") : "⋯";
    const statusCls = paired ? (paired.isError ? "err" : "ok") : "run";
    h += `<div class="tool-row" data-tid="${tid}"><span class="status ${statusCls}">${statusIcon}</span><span class="detail">${esc(d)}</span></div>`;
    if (exp) {
      h += `<div class="tool-detail">${toolExpandedDetail(tu.name, a)}`;
      if (paired) {
        h += `<div class="tool-result-inline"><div class="explanation">${paired.isError ? "❌ Something went wrong:" : "What came back:"}</div><div class="code-block">${esc(paired.content)}</div></div>`;
      }
      h += `</div>`;
    }
  }
  // Render orphan results (no matching tool_use)
  const pairedIds = new Set(tus.map((tu: any) => tu.id ?? ""));
  for (const tr of trs) {
    const uid = tr.tool_use_id ?? "";
    if (pairedIds.has(uid)) continue;
    const rt = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? "");
    const err = tr.is_error === true;
    const tid = `r${idx}-${uid || "r"}`;
    const exp = expandedTools.has(tid);
    h += `<div class="tool-row" data-tid="${tid}"><span class="status ${err ? "err" : "ok"}">${err ? "✗" : "✓"}</span><span class="detail">${esc(rt.replace(/\n/g, " "))}</span></div>`;
    if (exp) {
      h += `<div class="tool-detail">${esc(rt)}</div>`;
    }
  }

  if (text.trim()) {
    if (role === "user") {
      h += `<div class="msg user" data-msg-idx="${idx}">${md(text)}</div>`;
    } else if (role === "assistant") {
      const errorClass = msg._isError ? " msg-error" : "";
      const retryBtn =
        msg._isError && msg._retryProvider
          ? ` <button class="retry-provider-btn" data-retry-provider="${esc(msg._retryProvider)}" title="Retry ${esc(msg._retryProvider)}">↻</button>`
          : "";
      h += `<div class="msg assistant${errorClass}">${md(text)}${retryBtn}</div>`;
    } else {
      const sid = `s${idx}`;
      const sysExp = expandedTools.has(sid);
      // Summarize system message: first sentence or first 120 chars
      const flat = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
      const firstSentence = flat.match(/^[^.!?\n]{10,120}[.!?]/)?.[0];
      const sysPreview = firstSentence ?? flat.slice(0, 120);
      const hasMore = text.length > sysPreview.length;
      h += `<div class="msg system" data-tid="${sid}">${sysExp ? "▾" : "▸"} ${esc(sysPreview)}${hasMore ? " …" : ""}</div>`;
      if (sysExp) {
        h += `<div class="tool-detail system-expanded">${md(text)}</div>`;
      }
    }
  }
  return h;
}

function renderMsgToolsOnly(msg: any, idx: number): string {
  const content = Array.isArray(msg.content) ? msg.content : [];
  const tus = content.filter((b: any) => b.type === "tool_use");
  const trs = content.filter((b: any) => b.type === "tool_result");
  const resultMap = new Map<string, { content: string; isError: boolean }>();
  for (const tr of trs) {
    const rt = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? "");
    resultMap.set(tr.tool_use_id ?? "", { content: rt, isError: tr.is_error === true });
  }
  let h = "";

  for (const tu of tus) {
    const a = tu.input ?? {};
    const d = toolSummary(tu.name, a);
    const tid = `t${idx}-${tu.id ?? tu.name}`;
    const exp = expandedTools.has(tid);
    const paired = resultMap.get(tu.id ?? "");
    const statusIcon = paired ? (paired.isError ? "✗" : "✓") : "⋯";
    const statusCls = paired ? (paired.isError ? "err" : "ok") : "run";
    h += `<div class="tool-row" data-tid="${tid}"><span class="status ${statusCls}">${statusIcon}</span><span class="detail">${esc(d)}</span></div>`;
    if (exp) {
      h += `<div class="tool-detail">${toolExpandedDetail(tu.name, a)}`;
      if (paired) {
        h += `<div class="tool-result-inline"><div class="explanation">${paired.isError ? "❌ Something went wrong:" : "What came back:"}</div><div class="code-block">${esc(paired.content)}</div></div>`;
      }
      h += `</div>`;
    }
  }
  const pairedIds = new Set(tus.map((tu: any) => tu.id ?? ""));
  for (const tr of trs) {
    const uid = tr.tool_use_id ?? "";
    if (pairedIds.has(uid)) continue;
    const rt = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? "");
    const err = tr.is_error === true;
    const tid = `r${idx}-${uid || "r"}`;
    const exp = expandedTools.has(tid);
    h += `<div class="tool-row" data-tid="${tid}"><span class="status ${err ? "err" : "ok"}">${err ? "✗" : "✓"}</span><span class="detail">${esc(rt.replace(/\n/g, " "))}</span></div>`;
    if (exp) {
      h += `<div class="tool-detail">${esc(rt)}</div>`;
    }
  }
  return h;
}

function renderThinkingBlock(msgs: { msg: any; idx: number }[], blockId: string): string {
  const expanded = expandedTools.has(blockId);
  const chevron = expanded ? "▾" : "▸";
  let h = `<div class="thinking-block${expanded ? " expanded" : ""}" data-tid="${blockId}">`;
  h += `<div class="thinking-header">${chevron} Thinking (${msgs.length} step${msgs.length > 1 ? "s" : ""})</div>`;
  if (expanded) {
    h += `<div class="thinking-content">`;
    for (const { msg, idx } of msgs) {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const texts = content.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "");
      const text = texts.join("\n") || (typeof msg.content === "string" ? msg.content : "");
      if (text.trim()) {
        const errClass = msg._isError ? " thinking-step-error" : "";
        h += `<div class="thinking-step${errClass}">${md(text)}</div>`;
      }
    }
    h += `</div>`;
  }
  h += `</div>`;
  return h;
}

// ─── Thinking Indicator ───
let thinkingTickInterval: ReturnType<typeof setInterval> | null = null;

function renderThinkingIndicator(): string {
  if (activeRuns.size > 0) {
    let rows = "";
    for (const [runId, info] of activeRuns) {
      const color = PROVIDER_COLORS[info.provider] || "#6b7280";
      const elapsed = Math.floor((Date.now() - info.startedAt) / 1000);
      const name = modelName(info.model);
      rows += `<div class="thinking-run" data-run-id="${esc(runId)}" data-provider="${esc(info.provider)}" style="--thinking-dot-color:${color}">
  <div class="thinking-dots"><span></span><span></span><span></span></div>
  <span class="thinking-model">${providerIcon(info.provider)} ${esc(name)}</span>
  <span class="thinking-elapsed">${elapsed}s</span>
  <span class="thinking-stop">Stop</span>
</div>`;
    }
    return `<div class="thinking-indicator">${rows}</div>`;
  }
  if (sending) {
    return `<div class="thinking-indicator" data-state="pending"><div class="thinking-run thinking-pending" style="--thinking-dot-color:#6b7280">
  <div class="thinking-dots"><span></span><span></span><span></span></div>
  <span class="thinking-model">sending...</span>
</div></div>`;
  }
  return "";
}

function startThinkingTick() {
  if (thinkingTickInterval) return;
  thinkingTickInterval = setInterval(() => {
    if (activeRuns.size === 0) {
      clearInterval(thinkingTickInterval!);
      thinkingTickInterval = null;
      return;
    }
    document.querySelectorAll(".thinking-run[data-run-id]").forEach((el) => {
      const runId = el.getAttribute("data-run-id");
      if (!runId) return;
      const info = activeRuns.get(runId);
      if (!info) return;
      const elapsed = Math.floor((Date.now() - info.startedAt) / 1000);
      const span = el.querySelector(".thinking-elapsed");
      if (span) span.textContent = `${elapsed}s`;
    });
  }, 1000);
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

function renderWithThinkingGroups(): string {
  let h = "";
  // Split messages into runs (bounded by user messages)
  let runStart = 0;
  for (let i = 0; i <= messages.length; i++) {
    const isUserOrEnd = i === messages.length || (messages[i].role ?? "").toLowerCase() === "user";
    if (!isUserOrEnd) continue;

    // Process the run from runStart to i-1
    // Find assistant messages with text in this run
    const assistantTextIndices: number[] = [];
    for (let j = runStart; j < i; j++) {
      const m = messages[j];
      if ((m.role ?? "").toLowerCase() !== "assistant") continue;
      const content = Array.isArray(m.content) ? m.content : [];
      const hasText = content.some((b: any) => b.type === "text" && (b.text ?? "").trim());
      const plainText = typeof m.content === "string" && m.content.trim();
      if (hasText || plainText) assistantTextIndices.push(j);
    }

    if (assistantTextIndices.length >= 2) {
      // We have a thinking group: all-but-last are intermediate
      const thinkingIndices = new Set(assistantTextIndices.slice(0, -1));
      const blockId = `tk-${assistantTextIndices[0]}`;
      const thinkingMsgs: { msg: any; idx: number }[] = [];
      let blockInserted = false;

      for (let j = runStart; j < i; j++) {
        if (thinkingIndices.has(j)) {
          thinkingMsgs.push({ msg: messages[j], idx: j });
          // Render tool rows from this message even though text goes to thinking block
          h += renderMsgToolsOnly(messages[j], j);
          if (!blockInserted && j === assistantTextIndices[assistantTextIndices.length - 2]) {
            // Insert the thinking block after the last intermediate message
            h += renderThinkingBlock(thinkingMsgs, blockId);
            blockInserted = true;
          }
        } else {
          h += renderMsg(messages[j], j);
        }
      }
    } else {
      // No grouping needed — render normally
      for (let j = runStart; j < i; j++) {
        h += renderMsg(messages[j], j);
      }
    }

    // Render the user message that ends this run (if not end-of-array)
    if (i < messages.length) {
      h += renderMsg(messages[i], i);
    }
    runStart = i + 1;
  }
  return h;
}

function renderLiveWithThinking(): string {
  let h = "";
  // Find the last user message to identify the current run
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].role ?? "").toLowerCase() === "user") {
      lastUserIdx = i;
      break;
    }
  }
  // Render prior messages (before current run) normally
  for (let i = 0; i <= lastUserIdx; i++) {
    h += renderMsg(messages[i], i);
  }

  // Current run: ALL assistant text messages are intermediate reasoning
  // (the live answer is in streamText, rendered separately by updateChat).
  // Tool rows render normally; assistant text goes to thinking steps.
  const currentRunStart = lastUserIdx + 1;
  let liveThinkingSteps = "";
  for (let j = currentRunStart; j < messages.length; j++) {
    const m = messages[j];
    const role = (m.role ?? "").toLowerCase();
    if (role === "assistant") {
      // Tool rows render normally in the chat flow
      h += renderMsgToolsOnly(m, j);
      // Assistant text → live thinking step (stacks, never replaced)
      const content = Array.isArray(m.content) ? m.content : [];
      const texts = content.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "");
      const text = texts.join("\n") || (typeof m.content === "string" ? m.content : "");
      if (text.trim()) {
        const errClass = m._isError ? " thinking-step-error" : "";
        liveThinkingSteps += `<div class="thinking-step live${errClass}">${md(text)}</div>`;
      }
    } else {
      // System / other messages render normally
      h += renderMsg(m, j);
    }
  }
  // Show accumulated reasoning as an always-open block
  if (liveThinkingSteps) {
    h += `<div class="thinking-block expanded live-thinking">`;
    h += `<div class="thinking-header">▾ Reasoning…</div>`;
    h += `<div class="thinking-content">${liveThinkingSteps}</div>`;
    h += `</div>`;
  }
  return h;
}

// ─── Targeted Updates ───
function updateChat(skipScroll = false) {
  const el = $("messages");
  if (!el) {
    return;
  }
  const runActive = !!(streamText || sending || activeRuns.size > 0);
  let h = "";

  if (runActive) {
    // Live mode: render messages but show intermediate assistant texts as
    // live thinking steps so they stack instead of being replaced
    h = renderLiveWithThinking();
  } else {
    // Complete mode: group intermediate assistant texts into thinking blocks
    h = renderWithThinkingGroups();
  }

  // Always show thinking indicator when a run is active
  // Show live tool calls as they happen
  if (liveToolCalls.size > 0) {
    const liveIdx = messages.length + 9000; // offset to avoid id collisions
    let i = 0;
    for (const [, tc] of liveToolCalls) {
      const d = toolSummary(tc.name, tc.args);
      const tid = `live-${liveIdx}-${i++}`;
      const done = tc.result != null;
      const statusIcon = done ? (tc.isError ? "✗" : "✓") : "⋯";
      const statusCls = done ? (tc.isError ? "err" : "ok") : "run";
      h += `<div class="tool-row" data-tid="${tid}"><span class="status ${statusCls}">${statusIcon}</span><span class="detail">${esc(d)}</span></div>`;
      if (expandedTools.has(tid)) {
        h += `<div class="tool-detail">${toolExpandedDetail(tc.name, tc.args)}`;
        if (done) {
          const rt = typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result ?? "");
          h += `<div class="tool-result-inline"><div class="explanation">${tc.isError ? "❌ Something went wrong:" : "What came back:"}</div><div class="code-block">${esc(rt)}</div></div>`;
        }
        h += `</div>`;
      }
    }
  }
  if (activeRuns.size > 0 || sending) {
    h += renderThinkingIndicator();
  }
  // Show streaming text below indicator
  if (streamText) {
    h += `<div class="msg assistant streaming">${md(streamText)}</div>`;
  }
  el.innerHTML = h;
  el.querySelectorAll("[data-tid]").forEach((r) =>
    r.addEventListener("click", () => {
      const id = r.getAttribute("data-tid")!;
      expandedTools.has(id) ? expandedTools.delete(id) : expandedTools.add(id);
      // Re-render without scrolling, then restore clicked element into view
      const clickedRect = (r as HTMLElement).getBoundingClientRect();
      const scrollContainer = $("messages");
      const prevScroll = scrollContainer ? scrollContainer.scrollTop : 0;
      updateChat(true);
      // Find the same element after re-render and adjust scroll so it stays put
      const after = el.querySelector(`[data-tid="${id}"]`) as HTMLElement | null;
      if (after && scrollContainer) {
        const afterRect = after.getBoundingClientRect();
        scrollContainer.scrollTop = prevScroll + (afterRect.top - clickedRect.top);
      }
    }),
  );
  el.querySelectorAll(".thinking-run[data-run-id]").forEach((r) =>
    r.addEventListener("click", () => abort()),
  );
  el.querySelectorAll(".retry-provider-btn").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const prov = (btn as HTMLElement).getAttribute("data-retry-provider");
      if (prov) retryProvider(prov);
    }),
  );
  if (!skipScroll) scrollChat();
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
  if (sending || streamRunId || activeRuns.size > 0) {
    btn.className = "queue";
    btn.textContent = "Queue";
    btn.disabled = !connected;
  } else {
    btn.className = "";
    btn.textContent = "Send";
    btn.disabled = !connected;
  }
}

// ─── Error Description ───
// Extract actionable detail from raw LLM error messages instead of showing generic labels
function describeError(reason: string, errMsg: string): string {
  const e = errMsg.toLowerCase();

  if (reason === "billing") {
    // Extract reset date from "regain access on 2026-04-01 at 00:00 UTC"
    const resetMatch = errMsg.match(/regain access on (\d{4}-\d{2}-\d{2}(?: at [^.]+)?)/i);
    if (resetMatch) return `billing cap — resets ${resetMatch[1]}`;
    if (/credit|payment/i.test(errMsg)) return "billing — no credits";
    return "billing cap reached";
  }

  if (reason === "auth" || reason === "auth_permanent") {
    if (/refresh token.*(?:not found|invalid|revoked|expired)/i.test(errMsg))
      return "OAuth token revoked — needs re-login";
    if (/OAuth token refresh failed/i.test(errMsg)) return "OAuth refresh failed — needs re-login";
    if (/token.*expired/i.test(errMsg)) return "token expired";
    if (/invalid.*key|invalid.*api/i.test(errMsg)) return "invalid API key";
    if (/unauthorized|forbidden|permission/i.test(errMsg)) return "access denied";
    return reason === "auth_permanent" ? "auth permanently failed" : "auth error";
  }

  if (reason === "rate_limit") {
    if (/retry.after.*(\d+)/i.test(errMsg)) {
      const secs = errMsg.match(/retry.after.*?(\d+)/i);
      return secs ? `rate limited — retry in ${secs[1]}s` : "rate limited";
    }
    if (/tokens? per minute|tpm/i.test(errMsg)) return "TPM limit hit";
    if (/requests? per minute|rpm/i.test(errMsg)) return "RPM limit hit";
    if (/quota/i.test(errMsg)) return "quota exceeded";
    return "rate limited";
  }

  if (reason === "timeout") return "timeout";
  if (reason === "model_not_found") return "model not found";
  if (reason === "session_expired") return "session expired";
  if (reason === "format") return "request format rejected";
  if (reason === "cooldown") return "in cooldown";
  if (reason === "overloaded" || /overloaded|503|capacity/i.test(e)) return "overloaded";

  // Fallback: show truncated raw message if we have one, otherwise the reason code
  if (errMsg && errMsg.length > 0) {
    // Try to extract just the message field from JSON error responses
    const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]{1,80})"/);
    if (msgMatch) return msgMatch[1];
    return errMsg.slice(0, 80);
  }
  return reason || "unknown error";
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
        providerErrors.get(keyId || modelId),
      );
    } else {
      // Multiple keys — one compact row per key with model name inline
      // Lifecycle events may lack authProfileId, so count is stored under modelId.
      // Fall back to model-level count so all rows glow when the model is active.
      const modelCount = counts.get(modelId) || 0;
      for (let ki = 0; ki < keys.length; ki++) {
        const keyId = keys[ki];
        const prof = authProfiles?.[keyId] || {};
        const keyLabel = prof.label || keyId.split(":")[1] || keyId;
        html += renderAuthKeyRow(
          keyId,
          keyLabel,
          provider,
          name,
          badge,
          counts.get(keyId) || modelCount,
          providerErrors.get(keyId) || providerErrors.get(modelId),
        );
      }
    }
  }

  // Fallback chain: primary + fallbacks
  const chain: string[] = [];
  if (primary) chain.push(primary);
  if (fallbacks?.length) chain.push(...fallbacks);

  if (chain.length) {
    const open = !collapsedModelSections.has("fallback");
    const badges = [
      "\u{1F451}",
      "\u2461",
      "\u2462",
      "\u2463",
      "\u2464",
      "\u2465",
      "\u2466",
      "\u2467",
    ];
    html += `<div class="model-group${open ? " open" : ""}" data-section="fallback">`;
    html += '<div class="model-group-label">FALLBACK CHAIN</div>';
    html += '<div class="model-group-body">';
    for (let i = 0; i < chain.length; i++) {
      renderAuthKeyRows(chain[i], badges[i] || `${i + 1}`);
    }
    html += "</div></div>";
  }

  // Other configured models (not in fallback chain), sorted by performance tier
  const chainSet = new Set(chain);
  const otherIds = Object.keys(models || {}).filter((id) => !chainSet.has(id));
  if (otherIds.length) {
    const open = !collapsedModelSections.has("configured");
    otherIds.sort((a, b) => modelPerfRank(a) - modelPerfRank(b));
    html += `<div class="model-group${open ? " open" : ""}" data-section="configured">`;
    html += '<div class="model-group-label">CONFIGURED</div>';
    html += '<div class="model-group-body">';
    for (const id of otherIds) {
      renderAuthKeyRows(id, "");
    }
    html += "</div></div>";
  }

  html += `</div><div class="budget-updated">Updated ${new Date().toLocaleTimeString()}</div>`;
  el.innerHTML = html;

  // Bind collapse toggles
  el.querySelectorAll<HTMLElement>(".model-group-label").forEach((label) => {
    label.addEventListener("click", () => {
      const group = label.parentElement;
      if (!group) return;
      const section = group.dataset.section;
      if (!section) return;
      group.classList.toggle("open");
      if (group.classList.contains("open")) {
        collapsedModelSections.delete(section);
      } else {
        collapsedModelSections.add(section);
      }
    });
  });

  // Sync overseer pills with the same data
  updateOverseerPanel();
}

function shortErrorLabel(reason: string): string {
  switch (reason) {
    case "billing":
      return "billing cap";
    case "rate_limit":
      return "rate limited";
    case "overloaded":
      return "overloaded";
    case "auth":
    case "auth_permanent":
      return "auth error";
    case "timeout":
      return "timeout";
    default:
      return "error";
  }
}

function renderModelRow(
  id: string,
  provider: string,
  name: string,
  badge: string,
  suffix: string,
  count: number,
  errorInfo?: { error: string; reason: string },
): string {
  const color = PROVIDER_COLORS[provider] || "#6b7280";
  const liveClass = count > 0 ? " model-live" : "";
  const errorClass = errorInfo ? " model-errored" : "";
  const glowStyle =
    count > 0
      ? ` style="--glow-color:${color}80;--glow-bg:${color}18;--glow-bg2:${color}30;--glow-border:${color}50"`
      : "";
  const countBadge = count > 0 ? `<span class="model-agent-count">${count}</span>` : "";
  const errorBadge = errorInfo
    ? `<span class="model-error-badge" title="${esc(errorInfo.error)}">${shortErrorLabel(errorInfo.reason)}</span>`
    : "";

  return `<div class="model-row${liveClass}${errorClass}"${glowStyle}>
    ${providerIcon(provider)}
    <span class="model-name">${esc(name)}</span>
    ${badge ? `<span class="model-badge">${badge}</span>` : ""}
    ${suffix ? `<span class="model-auth-suffix">${esc(suffix)}</span>` : ""}
    ${errorBadge}
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
  errorInfo?: { error: string; reason: string },
): string {
  const color = PROVIDER_COLORS[provider] || "#6b7280";
  const liveClass = count > 0 ? " model-live" : "";
  const errorClass = errorInfo ? " model-errored" : "";
  const glowStyle =
    count > 0
      ? ` style="--glow-color:${color}80;--glow-bg:${color}18;--glow-bg2:${color}30;--glow-border:${color}50"`
      : "";
  const countBadge = count > 0 ? `<span class="model-agent-count">${count}</span>` : "";
  const errorBadge = errorInfo
    ? `<span class="model-error-badge" title="${esc(errorInfo.error)}">${shortErrorLabel(errorInfo.reason)}</span>`
    : "";

  return `<div class="model-row auth-key-row${liveClass}${errorClass}"${glowStyle}>
    ${providerIcon(provider)}
    <span class="model-name">${esc(name)}</span>
    ${badge ? `<span class="model-badge">${badge}</span>` : ""}
    <span class="auth-key-sep">\u00b7</span>
    <span class="auth-key-label">${esc(label)}</span>
    ${errorBadge}
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

  // Wire session delete buttons
  el.querySelectorAll(".session-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn as HTMLElement).dataset.deleteKey;
      if (!key) return;
      try {
        await req("sessions.delete", { key });
        // Reload from server to get authoritative list
        await loadSessions();
      } catch (err) {
        console.error("Failed to delete session:", err);
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
    <button class="session-delete-btn" data-delete-key="${esc(s.key)}" title="Delete session">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>
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
      <div class="chat-header"><button id="toggle-overseer-chat" class="panel-toggle" title="Show/hide system messages">Sys</button></div>
      <div class="messages" id="messages"><div class="msg system">Connecting to gateway...</div></div>
      <div class="chat-input">
        <textarea id="chat-textarea" placeholder="Message..." rows="1"></textarea>
        <button id="action-btn" disabled>Send</button>
      </div>
    </div>
    <div class="right-panels">
      <div class="rpanel budget-panel-wrapper">
        <div class="rpanel-header">🎛️ Models <button id="budget-refresh" class="budget-refresh-btn" title="Refresh">↻</button></div>
        <div id="budget-panel" class="rpanel-body">Loading...</div>
      </div>
      <div class="rpanel" id="sessions-panel">
        <div class="rpanel-header">📋 Sessions <span id="sessions-count" class="sessions-count"></span></div>
        <div id="sessions-list" class="rpanel-body">Loading...</div>
      </div>
      <div class="rpanel" id="overseer-panel">
        <div class="rpanel-header">🔭 Overseer <span id="overseer-count" class="sessions-count"></span></div>
        <div id="overseer-graph" class="rpanel-body overseer-graph-container"></div>
      </div>
    </div>
    <div class="context-timeline" id="context-timeline"></div>
    <div class="bottom-right-panel" id="bottom-right-panel">
      <div class="brp-views">
        <div class="brp-view brp-view-active" id="brp-view-context">
          <div id="treemap-canvas" style="position:absolute;inset:0"></div>
          <button class="brp-back-btn" id="brp-back-context" title="Back" style="display:none">\u25C0</button>
        </div>
        <div class="brp-view" id="brp-view-response">
          <div id="response-canvas" style="position:absolute;inset:0;overflow:hidden"></div>
          <button class="brp-back-btn" id="brp-back-response" title="Back" style="display:none">\u25C0</button>
        </div>
      </div>
      <div id="treemap-footer" class="treemap-footer"><span id="brp-footer-text"></span><span id="brp-meta" class="brp-meta"></span></div>
    </div>
  `;

  const ta = $("chat-textarea") as HTMLTextAreaElement;
  try {
    ta.value = localStorage.getItem(DRAFT_STORAGE_KEY) || "";
  } catch {}
  ta.addEventListener("input", () => {
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, ta.value);
    } catch {}
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (ta.value.trim()) {
        send(ta.value);
        ta.value = "";
        try {
          localStorage.removeItem(DRAFT_STORAGE_KEY);
        } catch {}
      }
    }
  });
  $("action-btn")!.addEventListener("click", () => {
    if (ta.value.trim()) {
      send(ta.value);
      ta.value = "";
      try {
        localStorage.removeItem(DRAFT_STORAGE_KEY);
      } catch {}
      ta.focus();
    }
  });
  $("session-select")!.addEventListener("change", (e) => {
    sessionKey = (e.target as HTMLSelectElement).value;
    messages = [];
    updateChat();
    loadChat();
    if (timelineCtrl?.getFilterMode() === "all") {
      timelineCtrl.loadAllSessions(sessions.map((s: any) => s.key));
    } else {
      timelineCtrl?.loadSession(sessionKey);
    }
  });
  $("budget-refresh")!.addEventListener("click", () => {
    loadBudget();
  });
  $("new-session-btn")!.addEventListener("click", async () => {
    if (!connected || !sessionKey) {
      return;
    }
    // Clear UI immediately so the user sees a fresh slate
    messages.length = 0;
    liveToolCalls.clear();
    streamText = "";
    streamRunId = null;
    sending = false;
    clearPersistedErrors(sessionKey);
    updateChat();
    updateBtn();
    // Abort any active run before creating a new session
    if (activeRuns.size > 0 || pendingRunDeletes.size > 0) {
      await abort();
    }
    send("/new");
  });
  $("toggle-overseer-chat")!.addEventListener("click", () => {
    showOverseerChat = !showOverseerChat;
    const btn = $("toggle-overseer-chat")!;
    btn.classList.toggle("panel-toggle--active", showOverseerChat);
    updateChat();
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

  // Back buttons — siblings of canvas, survive innerHTML wipes
  const backCtx = $("brp-back-context");
  const backResp = $("brp-back-response");

  function updateBackButtons() {
    const ctxBack = !!(tmCanvas as any).__treemapCanGoBack?.() || !!(tmCanvas as any).__hasOverlay;
    const respBack =
      !!(respCanvas as any).__responseCanGoBack?.() || !!(respCanvas as any).__hasOverlay;
    if (backCtx) backCtx.style.display = ctxBack ? "" : "none";
    if (backResp) backResp.style.display = respBack ? "" : "none";

    // Check for scrollbars and adjust back button position to avoid overlap
    const checkScroll = (canvas: HTMLElement, viewId: string) => {
      const preview = canvas.querySelector(".tm-preview");
      const view = document.getElementById(viewId);
      if (preview && view) {
        if (preview.scrollHeight > preview.clientHeight) {
          view.classList.add("is-scrolling");
        } else {
          view.classList.remove("is-scrolling");
        }
      } else if (view) {
        view.classList.remove("is-scrolling");
      }
    };
    checkScroll(tmCanvas, "brp-view-context");
    checkScroll(respCanvas, "brp-view-response");
  }

  backCtx?.addEventListener("click", () => {
    if ((tmCanvas as any).__treemapCanGoBack?.()) {
      (tmCanvas as any).__treemapBack?.();
    } else {
      // We're in an overlay (auto-summary) — clear overlay and refresh back to L1 treemap
      (tmCanvas as any).__hasOverlay = false;
      (tmCanvas as any).__treemapRefresh?.();
    }
    updateBackButtons();
  });
  backResp?.addEventListener("click", () => {
    if ((respCanvas as any).__responseCanGoBack?.()) {
      (respCanvas as any).__responseBack?.();
    } else {
      (respCanvas as any).__hasOverlay = false;
      (respCanvas as any).__responseRefresh?.();
    }
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
      // Mark overlay so updateBackButtons() shows the back button
      (panel as any).__hasOverlay = true;
      // Give DOM a tick to render before checking scroll
      setTimeout(updateBackButtons, 10);
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
    PROVIDER_COLORS,
    (mode) => {
      if (mode === "all") {
        timelineCtrl?.loadAllSessions(sessions.map((s: any) => s.key));
      } else {
        timelineCtrl?.loadSession(sessionKey);
      }
    },
  );
}

// ─── Overseer Graph ───
let overseerCtrl: ReturnType<typeof mountOverseerGraph> | null = null;

function updateOverseerPanel(): void {
  if (!overseerCtrl) return;
  if (activeRuns.size === 0) {
    overseerCtrl.update([]);
    const countEl = document.getElementById("overseer-count");
    if (countEl) countEl.textContent = "";
    return;
  }

  const authProfiles = modelConfigData?.authProfiles ?? {};
  const items: OverseerItem[] = [];

  for (const [runId, info] of activeRuns) {
    const authLabel = info.authProfileId
      ? authProfiles[info.authProfileId]?.label ||
        info.authProfileId.split(":")[1] ||
        info.authProfileId
      : "";
    items.push({
      id: runId,
      provider: info.provider,
      modelName: modelName(info.model),
      authLabel,
      badge: "",
      count: 1,
    });
  }

  overseerCtrl.update(items);
  const countEl = document.getElementById("overseer-count");
  if (countEl) {
    countEl.textContent = `(${items.length})`;
  }
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
// Mount overseer graph AFTER init() creates the DOM
const overseerContainer = document.getElementById("overseer-graph");
if (overseerContainer) {
  overseerCtrl = mountOverseerGraph(overseerContainer, {
    providerIcons: PROVIDER_ICONS,
  });
}
updateForensicBtn(); // set initial dot indicator
gwConnect();
setInterval(() => {
  if (connected) {
    loadBudget();
  }
}, 300_000);
