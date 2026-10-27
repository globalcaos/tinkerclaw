// FORK 2026-10-15 (the architect: files open in "the right local app" and Jarvis speaks from this machine,
// through the browser plugin). The Tinker page cannot reach a native app; this content script
// carries its requests to the background worker, which asks the local helper
// (native-host/tinkerclaw_local.py), and posts the answer back. Only the page's own window is
// listened to, and only messages marked __tinkerLocal.
window.addEventListener("message", (ev) => {
  if (ev.source !== window || !ev.data || ev.data.__tinkerLocal !== "req") return;
  const { id, msg } = ev.data;
  chrome.runtime.sendMessage({ tinkerLocal: msg }, (res) => {
    const err = chrome.runtime.lastError;
    window.postMessage(
      { __tinkerLocal: "res", id, res: err ? { ok: false, error: err.message } : res },
      window.location.origin,
    );
  });
});
window.postMessage({ __tinkerLocal: "ready" }, window.location.origin);
