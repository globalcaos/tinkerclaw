#!/usr/bin/env node
/**
 * Phone door — the device table, from a terminal.
 *
 *   node devices.mjs add <name> [--door http://host:port]   new device: prints its token ONCE and a pairing URL
 *   node devices.mjs list                                   id, name, status, last seen (never a token)
 *   node devices.mjs revoke <id>                            stops the token now, cuts its open sockets within 5 s
 *   node devices.mjs pair-code <id> [--door ...]            one-time pairing URL, 15 min; using it rotates the token
 *
 * Env: PHONE_DOOR_DIR (default ~/.openclaw/data/phone-door). The pairing URL's origin comes from
 * --door, else PHONE_DOOR_PUBLIC_URL, else PHONE_DOOR_BIND:PHONE_DOOR_PORT, else `tailscale ip -4`.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  addDevice,
  appendAudit,
  devicesFile,
  issuePairCode,
  loadRows,
  revokeDevice,
} from "./door.mjs";

const dir =
  process.env.PHONE_DOOR_DIR ?? path.join(os.homedir(), ".openclaw", "data", "phone-door");

function doorOrigin(argv) {
  const i = argv.indexOf("--door");
  if (i >= 0 && argv[i + 1]) {
    return argv[i + 1].replace(/\/+$/, "");
  }
  if (process.env.PHONE_DOOR_PUBLIC_URL) {
    return process.env.PHONE_DOOR_PUBLIC_URL.replace(/\/+$/, "");
  }
  const port = process.env.PHONE_DOOR_PORT ?? "18794";
  if (process.env.PHONE_DOOR_BIND) {
    return `http://${process.env.PHONE_DOOR_BIND}:${port}`;
  }
  try {
    const ip = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 3000 })
      .trim()
      .split("\n")[0];
    if (ip) {
      return `http://${ip}:${port}`;
    }
  } catch {}
  return `http://127.0.0.1:${port}`;
}

function positional(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--door") {
      i++;
    } else {
      out.push(argv[i]);
    }
  }
  return out;
}

function pairUrl(argv, code) {
  return `${doorOrigin(argv)}/door/pair?code=${encodeURIComponent(code)}`;
}

/** The pairing URL is a tailnet address: a phone off the tailnet gets a blank page (2026-10-19). */
export function phoneOnlineWarning(status) {
  const phones = Object.values(status?.Peer ?? {}).filter((p) => /android|ios/i.test(p.OS ?? ""));
  if (phones.some((p) => p.Online)) {
    return null;
  }
  const names = phones.map((p) => p.HostName).join(", ") || "none known";
  return `warn     no phone is online on the tailnet (${names}): turn Tailscale on in the phone or the URL opens a blank page`;
}

function warnIfNoPhoneOnline() {
  try {
    const raw = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const w = phoneOnlineWarning(JSON.parse(raw));
    if (w) {
      console.log(w);
    }
  } catch {}
}

function main(argv) {
  const [cmd, ...rest] = positional(argv);
  if (cmd === "add") {
    const name = rest.join(" ").trim();
    if (!name) {
      throw new Error("usage: devices.mjs add <name>");
    }
    const { row, token } = addDevice(dir, name);
    const { code, expiresAt } = issuePairCode(dir, row.id, { token });
    appendAudit(dir, { ev: "device_added", deviceId: row.id });
    console.log(`device   ${row.id} (${row.name})`);
    console.log(`token    ${token}`);
    console.log("         shown once; it is stored only as a hash");
    console.log(`pair     ${pairUrl(argv, code)}`);
    warnIfNoPhoneOnline();
    console.log(`         one use, until ${expiresAt}`);
    return;
  }
  if (cmd === "list") {
    const rows = loadRows(devicesFile(dir));
    if (!rows.length) {
      console.log(`no devices in ${devicesFile(dir)}`);
      return;
    }
    for (const r of rows) {
      console.log(
        [
          r.id,
          r.status,
          r.name,
          `seen ${r.lastSeenAt ?? "never"}`,
          `paired ${r.pairedAt ?? "never"}`,
        ].join("\t"),
      );
    }
    return;
  }
  if (cmd === "revoke") {
    if (!rest[0]) {
      throw new Error("usage: devices.mjs revoke <id>");
    }
    const dev = revokeDevice(dir, rest[0]);
    // The running door rewrites devices.json for lastSeenAt. A write that read the file just before
    // ours would put the row back to active, so look again a few times and redo it if that happened.
    for (let i = 0; i < 3; i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      if (loadRows(devicesFile(dir)).find((r) => r.id === dev.id)?.status === "revoked") {
        break;
      }
      revokeDevice(dir, dev.id);
    }
    appendAudit(dir, { ev: "device_revoked", deviceId: dev.id });
    console.log(`revoked  ${dev.id} (${dev.name})`);
    return;
  }
  if (cmd === "pair-code") {
    if (!rest[0]) {
      throw new Error("usage: devices.mjs pair-code <id>");
    }
    const { code, expiresAt } = issuePairCode(dir, rest[0]);
    appendAudit(dir, { ev: "pair_code_issued", deviceId: rest[0] });
    console.log(`pair     ${pairUrl(argv, code)}`);
    warnIfNoPhoneOnline();
    console.log(`         one use, until ${expiresAt}; using it gives ${rest[0]} a new token`);
    return;
  }
  throw new Error(
    "usage: devices.mjs add <name> | list | revoke <id> | pair-code <id> [--door http://host:port]",
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`[devices] ${err.message}`);
    process.exit(1);
  }
