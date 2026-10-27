// aria2-core.mjs — the download daemon's config, unit and RPC client, in one place.
//
// Dependency-free JS so both the plugin (index.ts) and the installer
// (scripts/downloader/setup.mjs) import the SAME template. Types: aria2-core.d.mts.
//
// Why the daemon is a systemd user unit and not a child of the gateway: a download
// must outlive the agent turn, a gateway restart and a reboot. A process spawned
// from a tool call is reaped with the turn (measured 2026-09-06: zero bytes).
//
// Why there is no `force-save`: with force-save=true aria2 writes FINISHED tasks
// into the session file too, and `input-file` replays them at every start. A user
// who deleted a finished film got it downloaded again after each reboot
// (2026-10-06, about 72 GB reappearing). Unfinished tasks still survive without it.

import os from "node:os";
import path from "node:path";

export const MANAGED_HEADER = "# Managed by tinkerclaw-downloader.";

/** Default file locations under a home directory. */
export function resolvePaths(home = os.homedir(), unitName = "torrent-scout-daemon") {
  const confDir = path.join(home, ".config", "aria2");
  return {
    confDir,
    conf: path.join(confDir, "aria2.conf"),
    session: path.join(confDir, "session.txt"),
    secret: path.join(confDir, "rpc-secret"),
    log: path.join(confDir, "aria2.log"),
    unitName,
    unit: path.join(home, ".config", "systemd", "user", `${unitName}.service`),
  };
}

/** Plugin config with defaults filled in. */
export function resolveOptions(raw = {}, home = os.homedir()) {
  return {
    downloadDir: raw.downloadDir || path.join(home, "Downloads", "torrent-scout"),
    rpcPort: Number.isInteger(raw.rpcPort) ? raw.rpcPort : 6800,
    maxConcurrentDownloads: Number.isInteger(raw.maxConcurrentDownloads)
      ? raw.maxConcurrentDownloads
      : 3,
    unitName: raw.unitName || "torrent-scout-daemon",
  };
}

/** The aria2.conf the plugin owns. */
export function renderConf({ downloadDir, rpcPort, maxConcurrentDownloads, secret, paths }) {
  return `${MANAGED_HEADER} Change the plugin config, not this file.
# Seeding is structurally off: seed-time=0 means there is no seeding phase at all.
enable-rpc=true
rpc-listen-all=false
rpc-listen-port=${rpcPort}
rpc-secret=${secret}
dir=${downloadDir}
continue=true
file-allocation=none
seed-time=0
seed-ratio=0.0
max-upload-limit=1K
enable-dht=true
bt-enable-lpd=true
bt-max-peers=100
max-concurrent-downloads=${maxConcurrentDownloads}
max-connection-per-server=8
split=8
# Unfinished tasks survive a restart. Finished ones must not: never add force-save.
save-session=${paths.session}
input-file=${paths.session}
save-session-interval=30
log-level=notice
log=${paths.log}
`;
}

/** The systemd user unit that runs aria2. */
export function renderUnit({ aria2cPath, paths }) {
  return `# Managed by tinkerclaw-downloader.
[Unit]
Description=Download daemon (aria2 RPC) for the torrent-scout skill
After=network-online.target

[Service]
Type=simple
ExecStart=${aria2cPath} --conf-path=${paths.conf}
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

function settings(confText) {
  const out = new Map();
  for (const line of confText.split("\n")) {
    const m = /^\s*([a-z0-9-]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (m) {
      out.set(m[1], m[2]);
    }
  }
  return out;
}

/** Problems in an aria2.conf that make the daemon misbehave. Empty = healthy. */
export function findProblems(confText) {
  const s = settings(confText);
  const problems = [];
  if (s.get("force-save") === "true") {
    problems.push(
      "force-save=true: finished downloads are replayed and re-downloaded at every start",
    );
  }
  if (s.has("seed-time") && s.get("seed-time") !== "0") {
    problems.push(`seed-time=${s.get("seed-time")}: the daemon seeds after finishing`);
  }
  if (s.get("enable-rpc") !== "true") {
    problems.push("enable-rpc is not true: the plugin and the skill cannot reach the daemon");
  }
  return problems;
}

/** The same config with the force-save setting removed (comments untouched). */
export function repairConf(confText) {
  return confText
    .split("\n")
    .filter((line) => !/^\s*force-save\s*=/.test(line))
    .join("\n");
}

/** Read one setting from a config text, or undefined. */
export function readSetting(confText, key) {
  return settings(confText).get(key);
}

/** Call aria2's JSON-RPC. Throws on transport or RPC error. */
export async function rpc({ port, secret, method, params = [], timeoutMs = 5000 }) {
  const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: String(Date.now()),
      method: `aria2.${method}`,
      params: [`token:${secret}`, ...params],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (j.error) {
    throw new Error(`aria2.${method}: ${j.error.message}`);
  }
  return j.result;
}

export const TASK_KEYS = [
  "gid",
  "status",
  "totalLength",
  "completedLength",
  "downloadSpeed",
  "errorMessage",
  "dir",
  "files",
  "bittorrent",
];

/** One readable row per aria2 task. */
export function summarizeTask(t) {
  const total = Number(t.totalLength || 0);
  const done = Number(t.completedLength || 0);
  const firstFile = t.files?.[0]?.path ? path.basename(t.files[0].path) : "";
  return {
    gid: t.gid,
    status: t.status,
    name: t.bittorrent?.info?.name || firstFile || t.files?.[0]?.uris?.[0]?.uri || t.gid,
    totalBytes: total,
    doneBytes: done,
    progress: total > 0 ? Math.round((done / total) * 1000) / 10 : 0,
    speedBytesPerSec: Number(t.downloadSpeed || 0),
    dir: t.dir,
    error: t.errorMessage || undefined,
  };
}
