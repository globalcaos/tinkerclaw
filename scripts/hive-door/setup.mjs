#!/usr/bin/env node
/**
 * Turn on the hive door (multi-user mode) on this machine. Called by scripts/setup.sh when the installer
 * is told several people will use the agent; safe to run by hand and to re-run.
 *
 *   node scripts/hive-door/setup.mjs [--owner-id alice] [--owner-name Alice] [--title Name]
 *                                    [--port 18795] [--bind 127.0.0.1] [--no-service]
 *
 * What it does: creates the token table with the OWNER's first token (written to a private file, never
 * printed), seeds the seat names, and on Linux installs and starts a systemd user unit. Everyone then opens
 * the door's address, not the gateway's. Keep the gateway on loopback so the door is the only way in.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const home = os.homedir();
const stateDir = process.env.DOOR_STATE_DIR ?? path.join(home, ".openclaw", "data", "door");
const ownerId = opt("--owner-id", "owner");
const ownerName = opt("--owner-name", "Owner");
const title = opt("--title", "Agent");
const port = opt("--port", "18795");
const bind = opt("--bind", "127.0.0.1");
const tokens = path.join(here, "door-tokens.mjs");
const env = { ...process.env, DOOR_STATE_DIR: stateDir };
const run = (...a) => execFileSync(process.execPath, [tokens, ...a], { env, encoding: "utf8" });

let gatewayPort = "18789";
try {
  gatewayPort = String(
    JSON.parse(fs.readFileSync(path.join(home, ".openclaw", "openclaw.json"), "utf8"))?.gateway
      ?.port ?? gatewayPort,
  );
} catch {}

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const tokenFile = path.join(stateDir, `${ownerId}-first-token.txt`);
const existing = run("list");
if (existing.includes(`${ownerId} `) || existing.includes(`${ownerId}\t`)) {
  console.log(`token table already has "${ownerId}"; leaving it as is`);
} else {
  const out = run("add", ownerId, ownerName, "--admin");
  const token = (out.match(/token\s*:\s*(\S+)/) ?? [])[1];
  if (!token) throw new Error("could not create the first token");
  fs.writeFileSync(
    tokenFile,
    `Your first token for ${title}:\n${token}\n\nRead it, then delete this file. Lost it? Run: node ${tokens} rotate <tokenId>\n`,
    { mode: 0o600 },
  );
  console.log(`first token for ${ownerName} written to ${tokenFile} (mode 600, not printed)`);
}
run("seed-seats");

const doorJs = path.join(here, "door.mjs");
const envLines = [
  `DOOR_PORT=${port}`,
  `DOOR_BIND=${bind}`,
  `DOOR_UPSTREAM=127.0.0.1:${gatewayPort}`,
  `DOOR_TITLE=${title}`,
  `DOOR_STATE_DIR=${stateDir}`,
];
const hasSystemd =
  process.platform === "linux" && spawnSync("systemctl", ["--user", "--version"]).status === 0;
let running = false;
const startHint = `Start the door yourself:\n  ${envLines.join(" ")} node ${doorJs}`;
if (args.includes("--no-service") || !hasSystemd) {
  console.log(startHint);
} else {
  const unitDir = path.join(home, ".config", "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  const unit = `[Unit]\nDescription=Hive door: per-person tokens in front of the gateway\nAfter=network-online.target\n\n[Service]\nType=simple\n${envLines.map((l) => `Environment=${l}`).join("\n")}\nExecStart=${process.execPath} ${doorJs}\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
  fs.writeFileSync(path.join(unitDir, "hive-door.service"), unit);
  spawnSync("systemctl", ["--user", "daemon-reload"]);
  const r = spawnSync("systemctl", ["--user", "enable", "--now", "hive-door.service"], {
    encoding: "utf8",
  });
  running = r.status === 0;
  console.log(
    running
      ? "door service installed and started (hive-door.service)"
      : `service install failed: ${r.stderr.trim()}\n${startHint}`,
  );
}
console.log(
  `\nPeople open: http://<this-machine>:${port}/tinker/  (the door), never the gateway's own port.`,
);
console.log(`Add a person:  node ${tokens} add <id> <Name>   then   node ${tokens} seed-seats`);
// Exit code is the truth for the installer: 0 = door running as a service, 3 = configured but NOT running yet.
process.exit(running ? 0 : 3);
