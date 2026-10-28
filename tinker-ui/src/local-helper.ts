// FORK 2026-10-15: the browser relay opens files with the right local app, and plays the voice
// locally too. When the gateway runs on another
// machine, the page asks the Browser Relay plugin (content script tinker-bridge.js), which asks the
// local helper on THIS machine (native-host/tinkerclaw_local.py) to open a file with its own app or
// play a spoken line on this speaker. Without the plugin or the helper every call returns null and
// the caller falls back to showing the file in the browser.

export type HelperReply = {
  ok?: boolean;
  missing?: boolean;
  error?: string;
  noHelper?: boolean;
  [k: string]: unknown;
};

type Post = (data: unknown) => void;

let seq = 0;
const pending = new Map<string, (r: HelperReply) => void>();
let listening = false;

function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as { __tinkerLocal?: string; id?: string; res?: HelperReply } | null;
    if (ev.source !== window || !d || d.__tinkerLocal !== "res" || !d.id) return;
    const done = pending.get(d.id);
    if (done) {
      pending.delete(d.id);
      done(d.res ?? { ok: false, error: "empty reply" });
    }
  });
}

/** One request to the helper; null when nothing answers in time (no plugin on this browser). */
export function callLocalHelper(
  msg: Record<string, unknown>,
  timeoutMs = 4000,
  post: Post = (data) => window.postMessage(data, window.location.origin),
): Promise<HelperReply | null> {
  listen();
  const id = `tl${Date.now()}-${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    post({ __tinkerLocal: "req", id, msg });
  });
}

let available: Promise<boolean> | null = null;

/** Whether plugin + helper answer on this browser. Asked once per page; a click reads the answer. */
export function localHelperAvailable(): Promise<boolean> {
  available ??= callLocalHelper({ action: "ping" }, 1500).then((r) => !!r?.ok);
  return available;
}

/** Test-only: forget the cached answer and pending calls. */
export function __resetLocalHelperForTest(): void {
  available = null;
  pending.clear();
}

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Open a file with this machine's own app. Asks by path first (the laptop usually has the same
 * file); only when it is missing here are the bytes fetched from the gateway and sent along.
 */
export async function openWithLocalApp(
  path: string,
  readRemote: () => Promise<{ ok?: boolean; name?: string; base64?: string; error?: string }>,
): Promise<HelperReply> {
  const first = await callLocalHelper({ action: "open", path });
  if (!first) return { ok: false, error: "local helper did not answer", noHelper: true };
  if (!first.missing) return first;
  const remote = await readRemote();
  if (!remote?.ok || !remote.base64) return { ok: false, error: remote?.error ?? "read failed" };
  const second = await callLocalHelper(
    { action: "open", path, name: remote.name, base64: remote.base64 },
    30_000,
  );
  return second ?? { ok: false, error: "local helper did not answer", noHelper: true };
}

/** Play one WAV (fetched from the gateway) on this machine's speaker. */
export async function playWithLocalHelper(url: string): Promise<boolean> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) return false;
  const res = await callLocalHelper({
    action: "play",
    base64: bytesToBase64(await r.arrayBuffer()),
  });
  return !!res?.ok;
}
