#!/usr/bin/env node
// daemon.mjs — talk to the detached download daemon.
//
// WHY A DAEMON AND NOT A BACKGROUND PROCESS: a process spawned from an agent
// tool call does NOT survive the turn. Measured 2026-09-06 — an aria2 launched
// with setsid+nohup was reaped with zero content bytes downloaded while the
// agent reported it "running in the background". A systemd user unit survives
// the turn, the session and a reboot, and its state is queryable at any time by
// anyone. Never promise a long transfer to a process you cannot outlive.
//
// Usage:
//   node scripts/daemon.mjs add <n | magnet | url> [--dir <path>]
//   node scripts/daemon.mjs status [--json]
//   node scripts/daemon.mjs board            # html-render dashboard
//   node scripts/daemon.mjs pause|resume|remove <gid>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderBoard } from "../lib/board.mjs";
import { loadSearch } from "../lib/config.mjs";

const RPC = process.env.ARIA2_RPC || "http://127.0.0.1:6800/jsonrpc";
const SECRET_PATH = path.join(os.homedir(), ".config/aria2/rpc-secret");
const secret = fs.existsSync(SECRET_PATH) ? fs.readFileSync(SECRET_PATH, "utf8").trim() : "";

async function rpc(method, params = []) {
  const body = {
    jsonrpc: "2.0",
    id: String(Date.now()),
    method: `aria2.${method}`,
    params: [`token:${secret}`, ...params],
  };
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const KEYS = [
  "gid",
  "status",
  "totalLength",
  "completedLength",
  "downloadSpeed",
  "uploadLength",
  "connections",
  "numSeeders",
  "errorMessage",
  "files",
  "bittorrent",
  "dir",
];

async function allTasks() {
  const [active, waiting, stopped] = await Promise.all([
    rpc("tellActive", [KEYS]),
    rpc("tellWaiting", [0, 50, KEYS]),
    rpc("tellStopped", [0, 50, KEYS]),
  ]);
  return [...active, ...waiting, ...stopped];
}

const name = (t) =>
  t.bittorrent?.info?.name || (t.files?.[0]?.path || "").split("/").pop() || t.gid;
const fmt = (b) => {
  b = Number(b || 0);
  return b >= 1024 ** 3
    ? `${(b / 1024 ** 3).toFixed(2)} GB`
    : b >= 1024 ** 2
      ? `${(b / 1024 ** 2).toFixed(0)} MB`
      : `${(b / 1024).toFixed(0)} KB`;
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = rest.filter((a) => !a.startsWith("--"));

  if (!cmd || cmd === "status" || cmd === "board") {
    const tasks = await allTasks();
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }
    if (cmd === "board") {
      console.log("```html-render");
      console.log(renderBoard(tasks));
      console.log("```");
      return;
    }
    if (!tasks.length) {
      console.log("no tasks. add one:  daemon.mjs add <n|magnet>");
      return;
    }
    for (const t of tasks) {
      const pct = Number(t.totalLength)
        ? ((Number(t.completedLength) / Number(t.totalLength)) * 100).toFixed(1)
        : "0.0";
      console.log(`  [${t.status}] ${name(t).slice(0, 58)}`);
      console.log(
        `      ${pct}%  ${fmt(t.completedLength)} / ${fmt(t.totalLength)}  ↓${fmt(t.downloadSpeed)}/s  peers ${t.connections}  seeders ${t.numSeeders ?? "?"}  ↑${fmt(t.uploadLength)}`,
      );
      if (t.errorMessage) console.log(`      ⚠ ${t.errorMessage}`);
      console.log(`      gid ${t.gid}`);
    }
    return;
  }

  if (cmd === "add") {
    let uri = args[0];
    if (/^\d+$/.test(uri || "")) {
      const state = loadSearch();
      const cand = state?.kept?.[Number(uri) - 1];
      if (!cand) throw new Error(`no candidate #${uri} in the last search`);
      uri = cand.magnet || cand.torrentUrl;
      if (!uri)
        throw new Error(
          `candidate #${args[0]} has neither magnet nor .torrent — run swarm-check first, it resolves the infohash from the listing page`,
        );
      console.log(`queueing #${args[0]}: ${cand.title.slice(0, 64)}`);
    }
    if (!uri) throw new Error("usage: daemon.mjs add <n|magnet|url>");
    const dirIdx = process.argv.indexOf("--dir");
    const opts = dirIdx > -1 ? { dir: process.argv[dirIdx + 1] } : {};
    const gid = await rpc("addUri", [[uri], opts]);
    console.log(`queued. gid=${gid}`);
    console.log("watch it:  node scripts/daemon.mjs status   (or `board` for the visual)");
    return;
  }

  if (["pause", "resume", "remove"].includes(cmd)) {
    const m = { pause: "pause", resume: "unpause", remove: "remove" }[cmd];
    console.log(await rpc(m, [args[0]]));
    return;
  }

  console.error("commands: add <n|uri> | status | board | pause|resume|remove <gid>");
  process.exit(2);
}

main().catch((e) => {
  console.error(e.message);
  if (/fetch failed|ECONNREFUSED/.test(e.message)) {
    console.error("\nThe daemon is not answering. Check it:");
    console.error("  systemctl --user status torrent-scout-daemon.service");
    console.error("  systemctl --user restart torrent-scout-daemon.service");
  }
  process.exit(1);
});
