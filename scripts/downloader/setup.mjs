#!/usr/bin/env node
// setup.mjs — install (or re-install) the download daemon for the tinkerclaw-downloader
// plugin and the torrent-scout skill. Re-runnable: it rewrites the managed config and
// unit, keeps the RPC secret, and keeps an existing download folder.
//
// Usage:
//   node scripts/downloader/setup.mjs [--dir <path>] [--port <n>] [--max <n>] [--no-enable]
//   node scripts/downloader/setup.mjs --check
//
// Exit codes: 0 running · 1 configured but NOT running · 2 cannot install here
// (no aria2c, not Linux) · 3 (--check only) not configured.

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MANAGED_HEADER,
  readSetting,
  renderConf,
  renderUnit,
  resolveOptions,
  resolvePaths,
  rpc,
} from "../../extensions/tinkerclaw-downloader/aria2-core.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const home = os.homedir();
const existing = (() => {
  try {
    return fs.readFileSync(resolvePaths(home).conf, "utf8");
  } catch {
    return undefined;
  }
})();
const opts = resolveOptions(
  {
    downloadDir: flag("--dir") || (existing && readSetting(existing, "dir")) || undefined,
    rpcPort: flag("--port") ? Number(flag("--port")) : undefined,
    maxConcurrentDownloads: flag("--max") ? Number(flag("--max")) : undefined,
  },
  home,
);
const paths = resolvePaths(home, opts.unitName);

function secret() {
  try {
    const s = fs.readFileSync(paths.secret, "utf8").trim();
    if (s) return s;
  } catch {}
  return (
    (existing && readSetting(existing, "rpc-secret")) ||
    crypto.randomBytes(16).toString("base64url")
  );
}

async function answering(s, tries) {
  for (let i = 0; i < tries; i++) {
    try {
      await rpc({ port: opts.rpcPort, secret: s, method: "getVersion", timeoutMs: 2000 });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

const notRunning = () => {
  console.error(`Download daemon is configured but NOT answering on 127.0.0.1:${opts.rpcPort}.`);
  console.error(`  systemctl --user status ${opts.unitName}.service`);
  console.error(`  journalctl --user -u ${opts.unitName}.service -n 30`);
  process.exit(1);
};

if (args.includes("--check")) {
  if (!existing) {
    console.error(
      `Not configured: ${paths.conf} does not exist. Run: node scripts/downloader/setup.mjs`,
    );
    process.exit(3);
  }
  if (await answering(secret(), 1)) {
    console.log(`Download daemon running on 127.0.0.1:${opts.rpcPort}.`);
    process.exit(0);
  }
  notRunning();
}

if (process.platform !== "linux") {
  console.error("The download daemon runs as a systemd user unit, which needs Linux.");
  process.exit(2);
}
const which = spawnSync("sh", ["-c", "command -v aria2c"], { encoding: "utf8" });
const aria2cPath =
  which.stdout.trim() || [path.join(home, ".local/bin/aria2c")].find((p) => fs.existsSync(p));
if (!aria2cPath) {
  console.error(
    "aria2c is not installed. Install it (Debian/Ubuntu: sudo apt install aria2), then re-run.",
  );
  process.exit(2);
}

const s = secret();
fs.mkdirSync(paths.confDir, { recursive: true });
fs.mkdirSync(path.dirname(paths.unit), { recursive: true });
fs.mkdirSync(opts.downloadDir, { recursive: true });
fs.writeFileSync(paths.secret, `${s}\n`, { mode: 0o600 });
if (existing && !existing.startsWith(MANAGED_HEADER)) {
  const bak = `${paths.conf}.bak-${new Date().toISOString().slice(0, 10)}`;
  fs.writeFileSync(bak, existing);
  console.log(`Kept your previous config as ${bak}`);
}
fs.writeFileSync(paths.conf, renderConf({ ...opts, secret: s, paths }));
if (!fs.existsSync(paths.session)) fs.writeFileSync(paths.session, "");
fs.writeFileSync(paths.unit, renderUnit({ aria2cPath, paths }));
console.log(`Wrote ${paths.conf} and ${paths.unit}`);

execFileSync("systemctl", ["--user", "daemon-reload"]);
execFileSync("systemctl", ["--user", "enable", `${opts.unitName}.service`], { stdio: "ignore" });
execFileSync("systemctl", ["--user", "restart", `${opts.unitName}.service`]);

if (!args.includes("--no-enable")) {
  const r = spawnSync("openclaw", ["plugins", "enable", "tinkerclaw-downloader"], {
    stdio: "inherit",
  });
  if (r.status !== 0)
    console.error(
      "Could not enable the plugin; run: openclaw plugins enable tinkerclaw-downloader",
    );
}

if (!(await answering(s, 10))) notRunning();
console.log(
  `Download daemon running on 127.0.0.1:${opts.rpcPort}; downloads go to ${opts.downloadDir}.`,
);
