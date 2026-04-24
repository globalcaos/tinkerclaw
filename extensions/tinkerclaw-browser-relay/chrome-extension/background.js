/**
 * FORK: Tinkerclaw Browser Relay — Chrome Extension background service worker.
 *
 * Adapted from upstream assets/chrome-extension/background.js with these changes:
 * - Tab group management: shared tabs grouped in "Tinker Shared" (grey color)
 * - Persistent tab sharing across service worker restarts (chrome.storage.local)
 * - Badge showing count of shared tabs (sandstone #c19a6b background)
 * - No new window/tab creation — only attaches to user-selected tabs
 * - Token-based auth to gateway relay on port 18792
 *
 * Protocol: connects to extension-relay.ts via WebSocket at ws://127.0.0.1:<port>/extension.
 * Relay sends forwardCDPCommand requests; extension forwards them via chrome.debugger API.
 * Extension sends forwardCDPEvent messages for debugger events back to relay.
 */

const DEFAULT_PORT = 18792;

const TAB_GROUP_NAME = "Tinker Shared";
const TAB_GROUP_COLOR = "grey"; // Chrome doesn't have brown — grey is closest earth tone

const BADGE = {
  on: { text: "ON", color: "#c19a6b" },
  off: { text: "", color: "#000000" },
  connecting: { text: "\u2026", color: "#F59E0B" },
  error: { text: "!", color: "#B91C1C" },
};

/** @type {WebSocket|null} */
let relayWs = null;
/** @type {Promise<void>|null} */
let relayConnectPromise = null;

let debuggerListenersInstalled = false;
let nextSession = 1;

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map();
/** @type {Map<string, number>} */
const tabBySession = new Map();
/** @type {Map<string, number>} */
const childSessionToTab = new Map();

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map();

// ---------------------------------------------------------------------------
// Relay port + auth token
// ---------------------------------------------------------------------------

async function getRelayPort() {
  const stored = await chrome.storage.local.get(["relayPort"]);
  const raw = stored.relayPort;
  const n = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    return DEFAULT_PORT;
  }
  return n;
}

async function getRelayToken() {
  // Try stored token first
  const stored = await chrome.storage.local.get(["relayToken"]);
  if (stored.relayToken) {return stored.relayToken;}

  // Auto-discover: probe the relay status endpoint (no auth needed for status)
  const port = await getRelayPort();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/extension/status`);
    if (resp.ok) {
      // Relay is up and doesn't require token for extension connections
      // (loopback + chrome-extension:// origin is sufficient)
      return "";
    }
  } catch {
    // Relay not reachable — will retry on connect
  }
  return "";
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function setBadge(tabId, kind) {
  const cfg = BADGE[kind];
  void chrome.action.setBadgeText({ tabId, text: cfg.text });
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color });
  void chrome.action.setBadgeTextColor({ tabId, color: "#FFFFFF" }).catch(() => {});
}

function updateGlobalBadge() {
  const count = tabs.size;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#c19a6b" });
  void chrome.action.setBadgeTextColor({ color: "#FFFFFF" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tab group management
// ---------------------------------------------------------------------------

async function ensureTabGroup() {
  try {
    const groups = await chrome.tabGroups.query({ title: TAB_GROUP_NAME });
    if (groups.length > 0) {
      return groups[0].id;
    }
  } catch {
    // tabGroups API may not be available in all contexts
  }
  return null;
}

async function addTabToGroup(tabId) {
  try {
    let groupId = await ensureTabGroup();
    if (groupId) {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, {
        title: TAB_GROUP_NAME,
        color: TAB_GROUP_COLOR,
      });
    }
    return groupId;
  } catch (err) {
    console.warn("Failed to add tab to group:", err);
    return null;
  }
}

async function removeTabFromGroup(tabId) {
  try {
    await chrome.tabs.ungroup(tabId);
  } catch {
    // Tab may already be ungrouped or closed
  }
}

// ---------------------------------------------------------------------------
// Persistence — shared tab IDs survive service worker restarts
// ---------------------------------------------------------------------------

async function saveSharedTabs() {
  const tabIds = Array.from(tabs.keys());
  await chrome.storage.local.set({ tinkerSharedTabs: tabIds });
}

async function restoreSharedTabs() {
  // Strategy 1: Try restoring by saved tab IDs (same browser session)
  const { tinkerSharedTabs } = await chrome.storage.local.get("tinkerSharedTabs");
  if (tinkerSharedTabs && Array.isArray(tinkerSharedTabs)) {
    for (const tabId of tinkerSharedTabs) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab) {
          await attachTab(tabId, { skipAttachedEvent: true });
          await addTabToGroup(tabId);
        }
      } catch {
        // Tab no longer exists — skip
      }
    }
  }

  // Strategy 2: Find tabs in existing "Tinker Shared" group (survives browser restart)
  try {
    const groups = await chrome.tabGroups.query({ title: TAB_GROUP_NAME });
    for (const group of groups) {
      const groupTabs = await chrome.tabs.query({ groupId: group.id });
      for (const tab of groupTabs) {
        if (tab.id && !tabs.has(tab.id)) {
          try {
            await attachTab(tab.id, { skipAttachedEvent: true });
          } catch {
            // Tab may not be attachable (chrome:// pages, etc.)
          }
        }
      }
    }
  } catch {
    // tabGroups API might not be available
  }

  await saveSharedTabs(); // Clean up stale IDs
  updateGlobalBadge();
}

// ---------------------------------------------------------------------------
// Relay port discovery
// ---------------------------------------------------------------------------

async function findRelayPort(basePort) {
  const candidates = [basePort, basePort + 1, basePort - 1];
  for (const port of candidates) {
    if (port <= 0 || port > 65535) {
      continue;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/extension/status`, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) {
        return port;
      }
    } catch {
      continue;
    }
  }
  return basePort;
}

// ---------------------------------------------------------------------------
// WebSocket relay connection
// ---------------------------------------------------------------------------

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    return;
  }
  if (relayConnectPromise) {
    return await relayConnectPromise;
  }

  relayConnectPromise = (async () => {
    const basePort = await getRelayPort();
    const port = await findRelayPort(basePort);
    const token = await getRelayToken();
    const httpBase = `http://127.0.0.1:${port}`;
    const wsUrl = token
      ? `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(token)}`
      : `ws://127.0.0.1:${port}/extension`;

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, {
        method: "HEAD",
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`, { cause: err });
    }

    const ws = new WebSocket(wsUrl);
    relayWs = ws;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("WebSocket connect failed"));
      });
      ws.addEventListener("close", (ev) => {
        clearTimeout(t);
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || "no reason"})`));
      });
    });

    ws.addEventListener("message", (event) => void onRelayMessage(String(event.data || "")));
    ws.addEventListener("close", () => onRelayClosed("closed"));
    ws.addEventListener("error", () => onRelayClosed("error"));

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true;
      chrome.debugger.onEvent.addListener(onDebuggerEvent);
      chrome.debugger.onDetach.addListener(onDebuggerDetach);
    }
  })();

  try {
    await relayConnectPromise;
  } finally {
    relayConnectPromise = null;
  }
}

let reconnectTimer = null;

function onRelayClosed(reason) {
  relayWs = null;
  for (const [id, p] of pending.entries()) {
    pending.delete(id);
    p.reject(new Error(`Relay disconnected (${reason})`));
  }

  // Don't clear tabs — keep them attached for reconnect
  for (const tabId of tabs.keys()) {
    setBadge(tabId, "connecting");
  }
  updateGlobalBadge();

  // Auto-reconnect after 5 seconds if we have shared tabs
  if (tabs.size > 0 && !reconnectTimer) {
    console.log("Tinkerclaw: relay disconnected, reconnecting in 5s...");
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await ensureRelayConnection();
        console.log("Tinkerclaw: relay reconnected with", tabs.size, "tabs still attached");
      } catch (err) {
        console.warn("Tinkerclaw: reconnect failed:", err.message);
        // Try again
        onRelayClosed("reconnect_failed");
      }
    }, 5000);
  }
}

function sendToRelay(payload) {
  const ws = relayWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Relay not connected");
  }
  ws.send(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Relay message handling
// ---------------------------------------------------------------------------

async function onRelayMessage(text) {
  /** @type {any} */
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  // Ping/pong keepalive
  if (msg && msg.method === "ping") {
    try {
      sendToRelay({ method: "pong" });
    } catch {
      // ignore
    }
    return;
  }

  // Response to our request
  if (msg && typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) {
      return;
    }
    pending.delete(msg.id);
    if (msg.error) {
      p.reject(new Error(String(msg.error)));
    } else {
      p.resolve(msg.result);
    }
    return;
  }

  // CDP command from relay to forward via chrome.debugger
  if (msg && typeof msg.id === "number" && msg.method === "forwardCDPCommand") {
    try {
      const result = await handleForwardCdpCommand(msg);
      sendToRelay({ id: msg.id, result });
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// Tab/session lookups
// ---------------------------------------------------------------------------

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId);
  if (direct) {
    return { tabId: direct, kind: "main" };
  }
  const child = childSessionToTab.get(sessionId);
  if (child) {
    return { tabId: child, kind: "child" };
  }
  return null;
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) {
      return tabId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Attach / detach tabs
// ---------------------------------------------------------------------------

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  await chrome.debugger.sendCommand(debuggee, "Page.enable").catch(() => {});

  const info = /** @type {any} */ (
    await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo")
  );
  const targetInfo = info?.targetInfo;
  const targetId = String(targetInfo?.targetId || "").trim();
  if (!targetId) {
    throw new Error("Target.getTargetInfo returned no targetId");
  }

  const sessionId = `tc-tab-${nextSession++}`;
  const attachOrder = nextSession;

  tabs.set(tabId, { state: "connected", sessionId, targetId, attachOrder });
  tabBySession.set(sessionId, tabId);
  void chrome.action.setTitle({
    tabId,
    title: "Tinkerclaw Browser Relay: shared (click to unshare)",
  });

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: "forwardCDPEvent",
      params: {
        method: "Target.attachedToTarget",
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    });
  }

  setBadge(tabId, "on");
  return { sessionId, targetId };
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId);
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      });
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) {
    tabBySession.delete(tab.sessionId);
  }
  tabs.delete(tabId);

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) {
      childSessionToTab.delete(childSessionId);
    }
  }

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignore
  }

  setBadge(tabId, "off");
  void chrome.action.setTitle({
    tabId,
    title: "Tinkerclaw Browser Relay (click to share)",
  });
}

// ---------------------------------------------------------------------------
// CDP command handler — relay asks us to forward to chrome.debugger
// ---------------------------------------------------------------------------

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || "").trim();
  const params = msg?.params?.params || undefined;
  const sessionId = typeof msg?.params?.sessionId === "string" ? msg.params.sessionId : undefined;

  // Map command to tab
  const bySession = sessionId ? getTabBySessionId(sessionId) : null;
  const targetId = typeof params?.targetId === "string" ? params.targetId : undefined;
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      // No sessionId: pick the first connected tab
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === "connected") {
          return id;
        }
      }
      return null;
    })();

  if (!tabId) {
    throw new Error(`No attached tab for method ${method}`);
  }

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId };

  // Runtime.enable: disable first to avoid stale contexts
  if (method === "Runtime.enable") {
    try {
      await chrome.debugger.sendCommand(debuggee, "Runtime.disable");
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, "Runtime.enable", params);
  }

  // FORK: Block new tab/window creation — only user-shared tabs are accessible
  if (method === "Target.createTarget") {
    throw new Error("Tinkerclaw: creating new tabs is disabled. Share an existing tab instead.");
  }

  // Target.closeTarget — only close tabs we have attached
  if (method === "Target.closeTarget") {
    const target = typeof params?.targetId === "string" ? params.targetId : "";
    const toClose = target ? getTabByTargetId(target) : tabId;
    if (!toClose) {
      return { success: false };
    }
    if (!tabs.has(toClose)) {
      throw new Error("Tinkerclaw: cannot close a tab that is not shared.");
    }
    try {
      await removeTabFromGroup(toClose);
      await detachTab(toClose, "closed");
      await saveSharedTabs();
      updateGlobalBadge();
      await chrome.tabs.remove(toClose);
    } catch {
      return { success: false };
    }
    return { success: true };
  }

  // Target.activateTarget — focus the shared tab
  if (method === "Target.activateTarget") {
    const target = typeof params?.targetId === "string" ? params.targetId : "";
    const toActivate = target ? getTabByTargetId(target) : tabId;
    if (!toActivate) {
      return {};
    }
    const tab = await chrome.tabs.get(toActivate).catch(() => null);
    if (!tab) {
      return {};
    }
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {});
    return {};
  }

  // Default: forward to chrome.debugger
  const tabState = tabs.get(tabId);
  const mainSessionId = tabState?.sessionId;
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee;

  return await chrome.debugger.sendCommand(debuggerSession, method, params);
}

// ---------------------------------------------------------------------------
// Debugger event listeners
// ---------------------------------------------------------------------------

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId;
  if (!tabId) {
    return;
  }
  const tab = tabs.get(tabId);
  if (!tab?.sessionId) {
    return;
  }

  if (method === "Target.attachedToTarget" && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId);
  }

  if (method === "Target.detachedFromTarget" && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId));
  }

  try {
    sendToRelay({
      method: "forwardCDPEvent",
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    });
  } catch {
    // ignore
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId;
  if (!tabId) {
    return;
  }
  if (!tabs.has(tabId)) {
    return;
  }
  void (async () => {
    await removeTabFromGroup(tabId);
    await detachTab(tabId, reason);
    await saveSharedTabs();
    updateGlobalBadge();
  })();
}

// ---------------------------------------------------------------------------
// Action click — toggle sharing for the active tab
// ---------------------------------------------------------------------------

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = active?.id;
  if (!tabId) {
    return;
  }

  const existing = tabs.get(tabId);
  if (existing?.state === "connected") {
    // Unshare
    await removeTabFromGroup(tabId);
    await detachTab(tabId, "toggle");
    await saveSharedTabs();
    updateGlobalBadge();
    return;
  }

  // Share
  tabs.set(tabId, { state: "connecting" });
  setBadge(tabId, "connecting");
  void chrome.action.setTitle({
    tabId,
    title: "Tinkerclaw Browser Relay: connecting to relay\u2026",
  });

  try {
    await ensureRelayConnection();
    await attachTab(tabId);
    await addTabToGroup(tabId);
    await saveSharedTabs();
    updateGlobalBadge();
  } catch (err) {
    tabs.delete(tabId);
    setBadge(tabId, "error");
    void chrome.action.setTitle({
      tabId,
      title: "Tinkerclaw Browser Relay: relay not running",
    });
    const message = err instanceof Error ? err.message : String(err);
    console.warn("Tinkerclaw attach failed:", message);
  }
}

chrome.action.onClicked.addListener(() => void connectOrToggleForActiveTab());

// ---------------------------------------------------------------------------
// Tab removal cleanup — if user closes a shared tab
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!tabs.has(tabId)) {
    return;
  }
  void (async () => {
    await detachTab(tabId, "tab_closed");
    await saveSharedTabs();
    updateGlobalBadge();
  })();
});

// ---------------------------------------------------------------------------
// Service worker startup — restore previously shared tabs
// ---------------------------------------------------------------------------

restoreSharedTabs().then(() => {
  updateGlobalBadge();
  // Try to reconnect to relay if we have shared tabs
  if (tabs.size > 0) {
    ensureRelayConnection().catch((err) => {
      console.warn("Tinkerclaw: relay reconnect on startup failed:", err.message);
    });
  }
});
