const PORT = 18792;
const statusEl = document.getElementById("status");
const connEl = document.getElementById("conn-status");
const tokenEl = document.getElementById("token");

function showStatus(el, cls, msg) {
  el.className = "status " + cls;
  el.textContent = msg;
  el.style.display = "block";
}

async function testConnection(_token) {
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      return { ok: true, msg: "Relay is running on port " + PORT };
    }
    return { ok: false, msg: "Relay responded with status " + resp.status };
  } catch {
    return { ok: false, msg: "Cannot reach relay on port " + PORT + ". Is the gateway running?" };
  }
}

document.getElementById("save-btn").addEventListener("click", async () => {
  const token = tokenEl.value.trim();
  if (!token) {
    showStatus(statusEl, "err", "✗ Token is empty. Paste your gateway token.");
    return;
  }
  showStatus(statusEl, "info", "Saving...");
  await chrome.storage.local.set({ relayToken: token, relayPort: PORT });
  showStatus(statusEl, "ok", "✓ Token saved!");

  const result = await testConnection(token);
  if (result.ok) {
    showStatus(
      statusEl,
      "ok",
      "✓ Token saved & relay reachable! Click the extension icon on any tab to share it.",
    );
  } else {
    showStatus(
      statusEl,
      "info",
      "✓ Token saved. " + result.msg + " — the extension will connect once the relay starts.",
    );
  }
});

document.getElementById("test-btn").addEventListener("click", async () => {
  showStatus(statusEl, "info", "Testing...");
  const token = tokenEl.value.trim();
  const result = await testConnection(token);
  showStatus(statusEl, result.ok ? "ok" : "err", result.ok ? "✓ " + result.msg : "✗ " + result.msg);
});

// Check connection on load
void (async () => {
  const data = await chrome.storage.local.get(["relayToken", "relayPort"]);
  if (data.relayToken) {
    tokenEl.value = data.relayToken;
  }

  const result = await testConnection(data.relayToken || "");
  if (result.ok) {
    showStatus(connEl, "ok", '<span class="indicator green"></span>Connected to relay');
    connEl.innerHTML = '<span class="indicator green"></span>Connected to relay on port ' + PORT;
  } else if (data.relayToken) {
    connEl.innerHTML = '<span class="indicator yellow"></span>Token configured. ' + result.msg;
    connEl.className = "status info";
  } else {
    connEl.innerHTML =
      '<span class="indicator red"></span>Not configured. Paste your gateway token below.';
    connEl.className = "status err";
  }
})();
