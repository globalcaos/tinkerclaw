const PORT = 18792;
const DEFAULT_HOST = "127.0.0.1";
const statusEl = document.getElementById("status");
const connEl = document.getElementById("conn-status");
const tokenEl = document.getElementById("token");
const hostEl = document.getElementById("host");

function showStatus(el, cls, msg) {
  el.className = "status " + cls;
  el.textContent = msg;
  el.style.display = "block";
}

/**
 * Status line with a coloured dot. Built from text nodes, never innerHTML: the host is
 * user-supplied and this page runs with extension privileges.
 */
function showIndicator(el, cls, dot, msg) {
  el.className = "status " + cls;
  el.replaceChildren();
  const span = document.createElement("span");
  span.className = "indicator " + dot;
  el.append(span, document.createTextNode(msg));
  el.style.display = "block";
}

function isLoopbackHostName(host) {
  const h = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1" || /^127\./.test(h);
}

function readHost() {
  return (hostEl.value || "").trim() || DEFAULT_HOST;
}

/**
 * Ask for the host permission the relay fetches need. Loopback is already covered by the
 * manifest, so this never prompts for the default; a remote host prompts once (and resolves
 * immediately if a broad host_permissions grant already covers it).
 */
async function ensureHostPermission(host) {
  if (isLoopbackHostName(host)) {
    return true;
  }
  const origins = [`http://${host}/*`, `https://${host}/*`];
  try {
    if (await chrome.permissions.contains({ origins })) {
      return true;
    }
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

async function testConnection(host) {
  try {
    const resp = await fetch(`http://${host}:${PORT}/`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      return { ok: true, msg: `Relay is running at ${host}:${PORT}` };
    }
    return { ok: false, msg: "Relay responded with status " + resp.status };
  } catch {
    return {
      ok: false,
      msg: `Cannot reach relay at ${host}:${PORT}. Is the gateway running and the port reachable?`,
    };
  }
}

document.getElementById("save-btn").addEventListener("click", async () => {
  const token = tokenEl.value.trim();
  const host = readHost();

  if (!token && !isLoopbackHostName(host)) {
    showStatus(statusEl, "err", `✗ Host ${host} is not loopback, so the relay requires a token.`);
    return;
  }
  if (!token) {
    showStatus(statusEl, "err", "✗ Token is empty. Paste your gateway token.");
    return;
  }

  if (!(await ensureHostPermission(host))) {
    showStatus(statusEl, "err", `✗ Permission to reach ${host} was denied.`);
    return;
  }

  showStatus(statusEl, "info", "Saving...");
  await chrome.storage.local.set({ relayToken: token, relayPort: PORT, relayHost: host });
  showStatus(statusEl, "ok", "✓ Saved!");

  const result = await testConnection(host);
  if (result.ok) {
    showStatus(
      statusEl,
      "ok",
      "✓ Saved & relay reachable! Click the extension icon on any tab to share it.",
    );
  } else {
    showStatus(
      statusEl,
      "info",
      "✓ Saved. " + result.msg + " — the extension will connect once the relay starts.",
    );
  }
});

document.getElementById("test-btn").addEventListener("click", async () => {
  showStatus(statusEl, "info", "Testing...");
  const host = readHost();
  if (!(await ensureHostPermission(host))) {
    showStatus(statusEl, "err", `✗ Permission to reach ${host} was denied.`);
    return;
  }
  const result = await testConnection(host);
  showStatus(statusEl, result.ok ? "ok" : "err", result.ok ? "✓ " + result.msg : "✗ " + result.msg);
});

// Check connection on load
void (async () => {
  const data = await chrome.storage.local.get(["relayToken", "relayPort", "relayHost"]);
  if (data.relayToken) {
    tokenEl.value = data.relayToken;
  }
  hostEl.value = data.relayHost || DEFAULT_HOST;
  const host = readHost();

  const result = await testConnection(host);
  if (result.ok) {
    showIndicator(connEl, "ok", "green", `Connected to relay at ${host}:${PORT}`);
  } else if (data.relayToken) {
    showIndicator(connEl, "info", "yellow", "Token configured. " + result.msg);
  } else {
    showIndicator(connEl, "err", "red", "Not configured. Paste your gateway token below.");
  }
})();
