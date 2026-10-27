#!/usr/bin/env node
/**
 * Phone door — the one way in from the architect's phone to the Tinker page, over the tailnet.
 *
 * WHAT IT IS FOR: the phone (the Jarvis app's WebView and its native node) opens exactly what the
 * laptop browser opens: the same tinker-prod-ui, the same saved tab list, the same chats. The door
 * listens on the tailnet address only, lets in nothing without a DEVICE TOKEN (cookie
 * `jarvis_device` or header `X-Jarvis-Device`, kept as sha256 in devices.json), and then pipes the
 * request, HTTP and WebSocket alike, to the loopback tinker-prod-ui with Host/Origin/Referer made
 * to look like the laptop's own page and the device credential removed.
 * HOW IT WAS DERIVED: scripts/tinker-prod-ui.mjs (loopback, raw-pipes every upgrade to the gateway,
 * keeps seat-less tab state in ~/.openclaw/data/tinker-ui-state.json, guards some routes by
 * Host/Origin) and scripts/hive-door/door.mjs (token hash table, timing-safe compare, login page,
 * failure limiter). Standalone on purpose: nothing is imported from hive-door.
 * WHAT WOULD CHANGE IT: the gateway growing its own per-device auth, or the phone needing per-seat
 * state (then the door would add `x-tinker-seat` the way hive-door does).
 *
 * Routes: GET /door/health (open) · GET|POST /door/login · GET|POST /door/pair · GET /door/whoami ·
 * GET /door/app/latest.json · GET /door/app/<file>.apk · GET /door/app/pack.json ·
 * GET /door/app/pack-<version>.zip · GET /door/app/pack-installed · GET /door/backup/manifest ·
 * PUT /door/backup/file?path=<rel>&mtime=<ms> · GET /trip/ · GET /trip/trip.json ·
 * everything else (authenticated) -> upstream.
 *
 * Run: PHONE_DOOR_BIND=<tailnet ip> node door.mjs   (env: PHONE_DOOR_PORT=18794
 *      PHONE_DOOR_UPSTREAM=127.0.0.1:18793 PHONE_DOOR_DIR=~/.openclaw/data/phone-door
 *      TRIP_DIR=~/.openclaw/data/trip PHONE_DOOR_ALLOW_ANY=1 to permit 0.0.0.0 / ::
 *      PHONE_BACKUP_DIR=~/Pictures/phone-backup, one sub-folder per device id
 *      PHONE_DOOR_PUBLIC_ORIGIN=https://<host> the Funnel address serving /door/backup/ only)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createTerminal } from "./term.mjs";

export const DEVICE_COOKIE = "jarvis_device";
export const DEVICE_HEADER = "x-jarvis-device";
export const PAIR_TTL_MS = 15 * 60 * 1000;
const COOKIE_MAX_AGE = 31536000;
const FAIL_LIMIT = 8;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const SEEN_EVERY_MS = 60 * 1000;
const FIRST_BYTE_TIMEOUT_MS = 30_000;
const REVOKE_SWEEP_MS = 5_000;
const PAIR_PURGE_MS = 60_000;
const BODY_TIMEOUT_MS = 15_000;
const MAX_CONNECTIONS = 256;
const APK_RE = /^[A-Za-z0-9._-]+\.apk$/;
// 2026-10-23 (plan "phone app self-update"): the signed content pack beside the APK (pack.mjs).
const PACK_RE = /^pack-\d{1,12}\.zip$/;
// 2026-10-21 (the architect): the phone app backs its pictures up through the door, one file per PUT.
// A file is written beside its final name with this marker and renamed only once every byte came.
const BACKUP_PART_MARK = ".jarvis-part-";
const MAX_BACKUP_BYTES = 4 * 1024 ** 3;
const BACKUP_IDLE_MS = 60_000;
// Files the trip view may read from TRIP_DIR. trip-state.json is the live flight status beside them.
// A Map, so a path like /trip/constructor finds nothing instead of a prototype member.
const TRIP_FILES = new Map([
  ["", ["trip.html", "text/html; charset=utf-8"]],
  ["trip.json", ["trip.json", "application/json; charset=utf-8"]],
  ["trip-state.json", ["trip-state.json", "application/json; charset=utf-8"]],
]);

// ── pure helpers ────────────────────────────────────────────────────────────────────────────────

export function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

export function timingEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function newDeviceToken() {
  return "jd_" + crypto.randomBytes(32).toString("base64url");
}

export function newPairCodeString() {
  return crypto.randomBytes(12).toString("base64url");
}

/** "the architect's Flip 6" -> "oscar-s-flip-6"; never empty. */
export function slugify(name) {
  const s = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "device";
}

/** True for an address that listens on every interface (0.0.0.0, ::, ::ffff:0.0.0.0 ...). */
export function isAnyAddress(addr) {
  const a = String(addr ?? "").replace(/^\[|\]$/g, "");
  const fam = net.isIP(a);
  if (fam === 4) {
    return a === "0.0.0.0";
  }
  return fam === 6 && /^[0:]*$/.test(a.replace(/:ffff:0\.0\.0\.0$/i, ":"));
}

/**
 * Null when the address may be served; else the reason to refuse. Only an IP literal is taken, so
 * spellings like "0" or a name that resolves to every interface cannot slip past the wildcard rule
 * (the server checks the address it actually got after listen() as well).
 */
export function checkBind(bind, allowAny = false) {
  const b = String(bind ?? "").trim();
  if (!b) {
    return "PHONE_DOOR_BIND is not set (give the tailnet IP, e.g. 100.64.0.10)";
  }
  if (!net.isIP(b.replace(/^\[|\]$/g, ""))) {
    return `PHONE_DOOR_BIND must be an IP address, got "${b}"`;
  }
  if (isAnyAddress(b) && !allowAny) {
    return `refusing to bind ${b} (every interface); set PHONE_DOOR_ALLOW_ANY=1 if you mean it`;
  }
  return null;
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== "string") {
    return out;
  }
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/**
 * Every device credential a request presents: the cookie, then the header, without duplicates.
 * Both are judged, so a stale cookie left in a WebView cannot hide the valid header the app sends.
 */
export function presentedTokens(headers) {
  const out = [];
  const c = parseCookies(headers.cookie)[DEVICE_COOKIE];
  if (c) {
    try {
      out.push(decodeURIComponent(c));
    } catch {
      out.push(c);
    }
  }
  const h = headers[DEVICE_HEADER];
  if (typeof h === "string" && h.trim() && !out.includes(h.trim())) {
    out.push(h.trim());
  }
  return out;
}

/**
 * True when a browser says the request comes from a page that is not the door itself. Cookies are
 * not port-scoped, so a page on another port of the same tailnet IP is "same-site" and carries the
 * SameSite=Lax device cookie; and upstreamHeaders() rewrites Origin into the loopback one, which
 * would launder that page past prod-ui's own Origin checks. So the door compares first. A missing
 * Origin is fine (the native node and curl send none). Origin "null" passes for GET/HEAD only, never
 * for writes or upgrades. With no Origin on a write, a Referer, when sent, must be the door too.
 */
export function foreignOrigin(headers, method, { upgrade = false } = {}) {
  let own;
  try {
    own = new URL(`http://${String(headers.host ?? "")}`).host.toLowerCase();
  } catch {
    return true;
  }
  const same = (u) => {
    try {
      return new URL(String(u)).host.toLowerCase() === own;
    } catch {
      return false;
    }
  };
  const read = !upgrade && (method === "GET" || method === "HEAD");
  const origin = headers.origin;
  if (typeof origin === "string" && origin) {
    return origin === "null" ? !read : !same(origin);
  }
  const referer = headers.referer;
  if (!read && typeof referer === "string" && referer) {
    return !same(referer);
  }
  return false;
}

/** The ACTIVE row whose hash matches the token. Compares every row, no early exit. */
export function findDevice(rows, token) {
  if (typeof token !== "string" || token.length < 8 || token.length > 300) {
    return null;
  }
  const h = sha256Hex(token);
  let hit = null;
  for (const r of rows) {
    if (r?.status === "active" && typeof r.hash === "string" && timingEq(r.hash, h) && !hit) {
      hit = r;
    }
  }
  return hit;
}

/** Remove the device credential from a cookie header. Undefined when nothing is left. */
export function stripDeviceCookie(cookieHeader) {
  if (typeof cookieHeader !== "string") {
    return undefined;
  }
  const kept = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && p.split("=")[0].trim() !== DEVICE_COOKIE);
  return kept.length ? kept.join("; ") : undefined;
}

/**
 * Headers sent upstream: Host/Origin/Referer as the laptop's own page would send them (prod-ui and
 * the gateway check them), the device cookie and header gone, everything else untouched.
 */
export function upstreamHeaders(reqHeaders, upstreamHost) {
  const origin = `http://${upstreamHost}`;
  const h = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v === undefined) {
      continue;
    }
    const l = k.toLowerCase();
    if (l === "host" || l === DEVICE_HEADER) {
      continue;
    }
    if (l === "cookie") {
      const c = stripDeviceCookie(Array.isArray(v) ? v.join("; ") : v);
      if (c) {
        h[k] = c;
      }
      continue;
    }
    if (l === "origin") {
      h[k] = origin;
      continue;
    }
    if (l === "referer") {
      let rest = "/";
      try {
        const u = new URL(String(v));
        rest = u.pathname + u.search;
      } catch {}
      h[k] = origin + rest;
      continue;
    }
    h[k] = v;
  }
  h.host = upstreamHost;
  return h;
}

/**
 * The phone's own relative path (MediaStore RELATIVE_PATH + DISPLAY_NAME, e.g. "DCIM/Camera/x.jpg"),
 * made safe to join under the device's backup folder; null when it could escape or is not a file name.
 */
export function backupRelPath(raw) {
  const s = String(raw ?? "");
  if (!s || s.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(s) || s.includes(BACKUP_PART_MARK)) {
    return null;
  }
  const parts = s.split("/").filter((x) => x !== "");
  if (!parts.length || parts.some((x) => x === "." || x === ".." || Buffer.byteLength(x) > 255)) {
    return null;
  }
  return parts.join("/");
}

/** [relPath, size] for every finished file under root (unfinished uploads are skipped). */
export function listBackup(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        stack.push(r);
      } else if (e.isFile() && !e.name.includes(BACKUP_PART_MARK)) {
        try {
          out.push([r, fs.statSync(path.join(root, r)).size]);
        } catch {}
      }
    }
  }
  return out;
}

export function apkNameOk(name) {
  return typeof name === "string" && APK_RE.test(name);
}

export function packNameOk(name) {
  return typeof name === "string" && PACK_RE.test(name);
}

export function pairDeepLink({ door, device, gw }) {
  const q = new URLSearchParams({ door, device, gw: gw ?? "" });
  return `jarvis://pair?${q.toString().replace(/\+/g, "%20")}`;
}

export function deviceCookie(token) {
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}

const CLEAR_COOKIE = `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

function esc(s) {
  return String(s ?? "").replace(
    /[<&>"']/g,
    (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// ── the store: devices.json, pair-codes.json, audit.jsonl ───────────────────────────────────────
// A device row: { id, name, hash, status: "active"|"revoked", createdAt, pairedAt?, lastSeenAt?, revokedAt? }.
// A pair-code row: { codeHash, deviceId, token, createdAt, expiresAt }. `token` is the device token the
// code hands out; it lives here (0600) only until the code is used or expires, then the row is deleted.

export const devicesFile = (dir) => path.join(dir, "devices.json");
export const pairCodesFile = (dir) => path.join(dir, "pair-codes.json");

/**
 * The rows in a store file; [] when the file does not exist. A file that exists but does not parse
 * THROWS: read as [], the next write would replace every device with one row.
 */
export function loadRows(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) {
    throw new Error(`${file} is not a JSON array`);
  }
  return rows;
}

export function saveRows(file, rows) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function appendAudit(dir, ev) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, "audit.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...ev }) + "\n",
      { mode: 0o600 },
    );
  } catch (err) {
    console.error("[phone-door] audit write failed", err.message);
  }
}

/** New device with a fresh token. Returns { row, token }. */
export function addDevice(dir, name, now = Date.now()) {
  const label = String(name ?? "")
    .trim()
    .slice(0, 60);
  if (!label) {
    throw new Error("a device name is required");
  }
  const rows = loadRows(devicesFile(dir));
  const base = slugify(label);
  let id = base;
  for (let n = 2; rows.some((r) => r.id === id); n++) {
    id = `${base}-${n}`;
  }
  const token = newDeviceToken();
  const row = {
    id,
    name: label,
    hash: sha256Hex(token),
    status: "active",
    createdAt: new Date(now).toISOString(),
  };
  saveRows(devicesFile(dir), [...rows, row]);
  return { row, token };
}

/**
 * A one-time pairing code for a device. With `token` (right after `add`) the code hands out that
 * token. Without it a fresh token is minted and becomes the device's token when the code is used
 * (re-pairing rotates the device; the old token stops then, not before).
 */
export function issuePairCode(
  dir,
  deviceId,
  { token, now = Date.now(), ttlMs = PAIR_TTL_MS } = {},
) {
  const dev = loadRows(devicesFile(dir)).find((r) => r.id === deviceId);
  if (!dev) {
    throw new Error(`no device "${deviceId}"`);
  }
  if (dev.status !== "active") {
    throw new Error(`device "${deviceId}" is ${dev.status}`);
  }
  const code = newPairCodeString();
  const rows = loadRows(pairCodesFile(dir)).filter((r) => Date.parse(r.expiresAt) > now);
  rows.push({
    codeHash: sha256Hex(code),
    deviceId,
    token: token ?? newDeviceToken(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  });
  saveRows(pairCodesFile(dir), rows);
  return { code, expiresAt: new Date(now + ttlMs).toISOString() };
}

function findPairRow(rows, code) {
  const h = sha256Hex(code);
  let hit = null;
  for (const r of rows) {
    if (typeof r.codeHash === "string" && timingEq(r.codeHash, h) && !hit) {
      hit = r;
    }
  }
  return hit;
}

const pairCodeShapeOk = (code) =>
  typeof code === "string" && code.length >= 8 && code.length <= 100;

/** The device a live pairing code would pair, without spending the code. Null when it would fail. */
export function peekPairCode(dir, code, now = Date.now()) {
  if (!pairCodeShapeOk(code)) {
    return null;
  }
  const hit = findPairRow(loadRows(pairCodesFile(dir)), code);
  if (!hit || !(Date.parse(hit.expiresAt) > now)) {
    return null;
  }
  const dev = loadRows(devicesFile(dir)).find((r) => r.id === hit.deviceId);
  return dev?.status === "active" ? dev : null;
}

/** Drop expired codes (each holds a raw token). Returns how many went. */
export function purgeExpiredPairCodes(dir, now = Date.now()) {
  const all = loadRows(pairCodesFile(dir));
  const keep = all.filter((r) => Date.parse(r.expiresAt) > now);
  if (keep.length !== all.length) {
    saveRows(pairCodesFile(dir), keep);
  }
  return all.length - keep.length;
}

/** Spend a pairing code. Returns { device, token } or null (unknown, used, expired, device revoked). */
export function usePairCode(dir, code, now = Date.now()) {
  if (!pairCodeShapeOk(code)) {
    return null;
  }
  const all = loadRows(pairCodesFile(dir));
  const hit = findPairRow(all, code);
  const keep = all.filter((r) => r !== hit && Date.parse(r.expiresAt) > now);
  if (keep.length !== all.length) {
    saveRows(pairCodesFile(dir), keep);
  }
  if (!hit || !(Date.parse(hit.expiresAt) > now)) {
    return null;
  }
  const devs = loadRows(devicesFile(dir));
  const dev = devs.find((r) => r.id === hit.deviceId);
  if (!dev || dev.status !== "active") {
    return null;
  }
  dev.hash = sha256Hex(hit.token);
  dev.pairedAt = new Date(now).toISOString();
  saveRows(devicesFile(dir), devs);
  return { device: dev, token: hit.token };
}

export function revokeDevice(dir, deviceId, now = Date.now()) {
  const devs = loadRows(devicesFile(dir));
  const dev = devs.find((r) => r.id === deviceId);
  if (!dev) {
    throw new Error(`no device "${deviceId}"`);
  }
  dev.status = "revoked";
  dev.revokedAt = new Date(now).toISOString();
  saveRows(devicesFile(dir), devs);
  const codes = loadRows(pairCodesFile(dir));
  const keep = codes.filter((r) => r.deviceId !== deviceId);
  if (keep.length !== codes.length) {
    saveRows(pairCodesFile(dir), keep);
  }
  return dev;
}

export function readGatewayTokenFromConfig(home = os.homedir()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, ".openclaw", "openclaw.json"), "utf8"));
    return cfg?.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  } catch {
    return process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  }
}

// ── pages ───────────────────────────────────────────────────────────────────────────────────────

const STYLE = `body{font-family:system-ui;background:#f5ecd9;color:#3b2a1a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff8ea;border:1px solid #b08a5a;border-radius:10px;padding:26px 28px;width:320px;max-width:calc(100vw - 40px);box-sizing:border-box}h1{margin:0 0 14px;font-size:20px}
input{width:100%;box-sizing:border-box;padding:9px;margin:6px 0 12px;border:1px solid #b08a5a;border-radius:6px;font-size:15px}
button,.btn{display:block;width:100%;box-sizing:border-box;padding:11px;border:0;border-radius:6px;background:#7a4e2a;color:#fff;font-size:15px;cursor:pointer;text-align:center;text-decoration:none;margin:10px 0}
.btn.alt{background:#b08a5a}.m{color:#8a2a1a;margin:0 0 10px;font-size:14px}.n{font-size:13px;color:#6b5236;margin:8px 0}`;

function page(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${esc(title)}</title>
<style>${STYLE}</style></head><body>${inner}</body></html>`;
}

export function loginPage(msg = "") {
  return page(
    "Jarvis",
    `<form class="card" method="post" action="/door/login"><h1>Jarvis</h1>${msg ? `<p class="m">${esc(msg)}</p>` : ""}
<label>Device token</label><input name="token" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Enter</button></form>`,
  );
}

function pairPage({ deviceName, apk, deepLink }) {
  const download = apk
    ? `<a class="btn" href="/door/app/${esc(apk.file)}" download>Download the Jarvis app${apk.versionName ? ` (${esc(apk.versionName)})` : ""}</a>`
    : `<p class="n">No app build has been published to this door yet. The page still works in the browser.</p>`;
  return page(
    "Jarvis · paired",
    `<div class="card"><h1>Paired: ${esc(deviceName)}</h1>
<p class="n">This browser is now signed in. To use the app, install it, then come back here and open it.</p>
${download}
<a class="btn alt" href="${esc(deepLink)}">Open in the Jarvis app</a>
<a class="btn alt" href="/tinker/">Continue in the browser</a></div>`,
  );
}

/**
 * What a GET of the pairing link shows: the code is NOT spent yet. The form posts it, by script at
 * once and by the button without script, so a link-preview fetcher (WhatsApp Web on the laptop, the
 * gateway's own preview) that only GETs the URL cannot use up the code before the phone opens it.
 */
function pairConfirmPage({ deviceName, code }) {
  return page(
    "Jarvis · pair",
    `<form class="card" method="post" action="/door/pair"><h1>Pair ${esc(deviceName)}</h1>
<input type="hidden" name="code" value="${esc(code)}">
<p class="n">Signing this phone in…</p><button type="submit">Pair this phone</button></form>
<script>document.forms[0].submit()</script>`,
  );
}

function messagePage(title, msg) {
  return page(title, `<div class="card"><h1>${esc(title)}</h1><p class="n">${esc(msg)}</p></div>`);
}

// ── the server ──────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.dir               devices.json, pair-codes.json, audit.jsonl, app/
 * @param {string} opts.upstream          "host:port" of tinker-prod-ui
 * @param {string} opts.tripDir
 * @param {() => string} [opts.readGatewayToken]  read on every pair page, never cached
 * @param {number} [opts.firstByteTimeoutMs]
 * @param {number} [opts.revokeSweepMs]     how often open streams are checked against devices.json
 */
export function createDoor(opts) {
  const dir = opts.dir;
  const [upHost, upPortStr] = String(opts.upstream).split(":");
  const upPort = Number(upPortStr);
  const upstreamHost = `${upHost}:${upPort}`;
  const tripDir = opts.tripDir;
  const backupDir = opts.backupDir ?? path.join(os.homedir(), "Pictures", "phone-backup");
  // The public HTTPS address (Tailscale Funnel) that forwards /door/backup/ ONLY. The phone learns it
  // here over the tailnet and uses it for the backup when Tailscale is off. Local setting, never in git.
  const publicOrigin = /^https:\/\/[A-Za-z0-9.-]+$/.test(opts.publicOrigin ?? "")
    ? opts.publicOrigin
    : null;
  const readGw = opts.readGatewayToken ?? (() => readGatewayTokenFromConfig());
  const firstByteMs = opts.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const sweepMs = opts.revokeSweepMs ?? REVOKE_SWEEP_MS;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const audit = (ev) => appendAudit(dir, ev);

  // devices.json is re-read whenever it changes (rename gives a new inode): a revoke from the CLI
  // refuses the very next request, and the sweep below cuts what is already open.
  let cache = { key: "", rows: [] };
  function devices() {
    try {
      const st = fs.statSync(devicesFile(dir));
      const key = `${st.ino}:${st.mtimeMs}:${st.size}`;
      if (key !== cache.key) {
        cache = { key, rows: loadRows(devicesFile(dir)) };
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("[phone-door] devices.json unreadable, refusing everyone:", err.message);
      }
      cache = { key: "", rows: [] };
    }
    return cache.rows;
  }
  const seenWritten = new Map();
  function noteSeen(dev) {
    const now = Date.now();
    const last = seenWritten.get(dev.id) ?? Date.parse(dev.lastSeenAt ?? "") ?? 0;
    if (now - (Number.isFinite(last) ? last : 0) < SEEN_EVERY_MS) {
      return;
    }
    seenWritten.set(dev.id, now);
    try {
      const rows = loadRows(devicesFile(dir));
      const r = rows.find((x) => x.id === dev.id);
      // Never write back a row the CLI has just revoked or re-keyed.
      if (!r || r.status !== "active" || r.hash !== dev.hash) {
        return;
      }
      r.lastSeenAt = new Date(now).toISOString();
      saveRows(devicesFile(dir), rows);
    } catch (err) {
      console.error("[phone-door] lastSeenAt write failed", err.message);
    }
  }

  // The limiter counts DISTINCT bad credentials per address, so an app replaying one stale token
  // after a re-pair counts once, not once per reconnect. A valid credential is never limited: the
  // tokens are 256-bit, a guess that hits is already a full compromise, and blocking it would only
  // let one stale cookie lock the phone out.
  const fails = new Map(); // ip -> { bad: Set<sha256>, resetAt, audited }
  function retryAfter(ip) {
    const f = fails.get(ip);
    if (!f || f.resetAt <= Date.now() || f.bad.size < FAIL_LIMIT) {
      return 0;
    }
    return Math.max(1, Math.ceil((f.resetAt - Date.now()) / 1000));
  }
  function noteFail(ip, cred) {
    let f = fails.get(ip);
    if (!f || f.resetAt <= Date.now()) {
      f = { bad: new Set(), resetAt: Date.now() + FAIL_WINDOW_MS, audited: false };
      fails.set(ip, f);
    }
    if (f.bad.size < FAIL_LIMIT) {
      f.bad.add(sha256Hex(String(cred ?? "")));
    }
    if (fails.size > 10_000) {
      for (const [k, v] of fails) {
        if (v.resetAt <= Date.now()) {
          fails.delete(k);
        }
      }
    }
  }
  /** One rate_limited audit line per address per window, however many requests it makes. */
  function auditLimited(ip, where) {
    const f = fails.get(ip);
    if (f && !f.audited) {
      f.audited = true;
      audit({ ev: "rate_limited", ip, where });
    }
  }

  /**
   * { dev, presented, token }: dev is the active device or null; presented says a credential came
   * along. The request passes when ANY credential it carries matches; a failure is noted only when
   * every one of them is wrong.
   */
  function authOf(req, ip) {
    const tokens = presentedTokens(req.headers);
    if (!tokens.length) {
      return { dev: null, presented: false };
    }
    const rows = devices();
    for (const token of tokens) {
      const dev = findDevice(rows, token);
      if (dev) {
        noteSeen(dev);
        return { dev, presented: true, token };
      }
    }
    for (const token of tokens) {
      noteFail(ip, token);
    }
    return { dev: null, presented: true };
  }

  const json = (res, code, body, extra = {}) =>
    res
      .writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...extra,
      })
      .end(JSON.stringify(body));
  const html = (res, code, body, extra = {}) =>
    res
      .writeHead(code, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // same-origin, not no-referrer: with no-referrer a browser sends "Origin: null" on the form
        // POSTs, which the Origin check refuses. Off-door (the jarvis:// link) nothing is sent.
        "Referrer-Policy": "same-origin",
        ...extra,
      })
      .end(body);
  function tooMany(res, ip, wait, where) {
    auditLimited(ip, where);
    json(res, 429, { error: "too many failed attempts" }, { "Retry-After": String(wait) });
  }

  /** A small form body. Size-capped, and time-capped so nobody can hold a socket by trickling it. */
  async function readBody(req, limit = 8192) {
    const timer = setTimeout(() => req.destroy(new Error("body too slow")), BODY_TIMEOUT_MS);
    const chunks = [];
    let size = 0;
    try {
      for await (const ch of req) {
        size += ch.length;
        if (size > limit) {
          throw new Error("body too large");
        }
        chunks.push(ch);
      }
    } finally {
      clearTimeout(timer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function latestApp() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, "app", "latest.json"), "utf8"));
      return j && apkNameOk(j.file) ? j : null;
    } catch {
      return null;
    }
  }

  /** The origin the phone used to reach us. Only a plain host[:port] is trusted into a link. */
  function doorOrigin(req) {
    const host = String(req.headers.host ?? "");
    if (/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)) {
      return `http://${host}`;
    }
    const a = req.socket.localAddress ?? "127.0.0.1";
    return `http://${net.isIPv6(a) ? `[${a}]` : a}:${req.socket.localPort}`;
  }

  function sendFile(res, file, ctype, extra = {}) {
    let st;
    try {
      st = fs.statSync(file);
      if (!st.isFile()) {
        throw new Error("not a file");
      }
    } catch {
      return false;
    }
    res.writeHead(200, { "Content-Type": ctype, "Content-Length": String(st.size), ...extra });
    const s = fs.createReadStream(file);
    s.on("error", () => res.destroy());
    s.pipe(res);
    return true;
  }

  /** PUT /door/backup/file: stream one picture to <backupDir>/<device id>/<path>. */
  async function receiveBackup(req, res, dev, url) {
    const rel = backupRelPath(url.searchParams.get("path"));
    if (!rel) {
      return json(res, 400, { error: "bad path" });
    }
    const len = Number(req.headers["content-length"]);
    if (!Number.isSafeInteger(len) || len < 0) {
      return json(res, 411, { error: "content-length required" });
    }
    if (len > MAX_BACKUP_BYTES) {
      return json(res, 413, { error: "too large" });
    }
    const dest = path.join(backupDir, path.basename(dev.id), rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}${BACKUP_PART_MARK}${crypto.randomBytes(4).toString("hex")}`;
    let got = 0;
    req.setTimeout(BACKUP_IDLE_MS, () => req.destroy(new Error("upload idle")));
    try {
      await pipeline(
        req,
        async function* (src) {
          for await (const ch of src) {
            got += ch.length;
            if (got > len) {
              throw new Error("body longer than content-length");
            }
            yield ch;
          }
        },
        fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
      );
      if (got !== len) {
        throw new Error(`short body ${got}/${len}`);
      }
      const mtime = Number(url.searchParams.get("mtime"));
      if (Number.isFinite(mtime) && mtime > 0) {
        fs.utimesSync(tmp, mtime / 1000, mtime / 1000);
      }
      fs.renameSync(tmp, dest);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      console.error(`[phone-door] backup ${dev.id} ${rel}: ${err.message}`);
      if (!res.headersSent && !req.destroyed) {
        json(res, 400, { error: "upload failed" });
      }
      return;
    }
    return json(res, 200, { ok: true, path: rel, size: got });
  }

  // Everything open on behalf of a device, WebSockets and proxied HTTP responses alike (an event
  // stream like /api/ui-events stays open for hours), so a revoke or re-pair also cuts those.
  const live = new Set();

  function proxy(req, res, dev) {
    let firstByte = null;
    const up = http.request(
      {
        host: upHost,
        port: upPort,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req.headers, upstreamHost),
      },
      (ur) => {
        clearTimeout(firstByte);
        const headers = { ...ur.headers };
        // An absolute redirect to the loopback page would send the phone to its own 127.0.0.1.
        const loc = headers.location;
        if (typeof loc === "string" && loc.startsWith(`http://${upstreamHost}`)) {
          headers.location = loc.slice(`http://${upstreamHost}`.length) || "/";
        }
        res.writeHead(ur.statusCode ?? 502, headers);
        res.flushHeaders(); // event streams (/api/ui-events) must see their headers now
        ur.pipe(res);
        ur.on("error", () => res.destroy());
      },
    );
    const conn = {
      id: dev.id,
      hash: dev.hash,
      kind: "http",
      close() {
        live.delete(conn);
        res.destroy();
        up.destroy();
      },
    };
    live.add(conn);
    // The clock starts once the request body is fully sent: a photo trickling up over roaming
    // cellular may take minutes, and that is the phone's time, not Tinker's.
    up.on("finish", () => {
      if (up.destroyed || res.writableEnded) {
        return;
      }
      firstByte = setTimeout(() => {
        if (!res.headersSent) {
          res.writeHead(504, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end(`Tinker did not answer within ${firstByteMs} ms`);
        up.destroy();
      }, firstByteMs);
    });
    up.on("error", (err) => {
      clearTimeout(firstByte);
      if (res.writableEnded) {
        return;
      }
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end(`Tinker unavailable: ${err.message}`);
    });
    res.on("close", () => {
      live.delete(conn);
      clearTimeout(firstByte);
      if (!res.writableFinished) {
        up.destroy();
      }
    });
    req.pipe(up);
  }

  function pairInvalid(res) {
    return html(
      res,
      404,
      messagePage(
        "Pairing link not valid",
        "This pairing link is used, expired or unknown. Make a new one on the laptop: node scripts/phone-door/devices.mjs pair-code <device id>",
      ),
    );
  }

  /** The paired page: sets the cookie and hands over the deep link. */
  function pairedPage(req, res, dev, token) {
    const deepLink = pairDeepLink({ door: doorOrigin(req), device: token, gw: readGw() });
    return html(res, 200, pairPage({ deviceName: dev.name, apk: latestApp(), deepLink }), {
      "Set-Cookie": deviceCookie(token),
    });
  }

  async function handle(req, res) {
    const ip = req.socket.remoteAddress ?? "?";
    const url = new URL(req.url ?? "/", "http://door");
    const p = url.pathname;

    if (p === "/door/health" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("ok");
      return;
    }
    if (foreignOrigin(req.headers, req.method)) {
      audit({ ev: "origin_refused", ip, where: p });
      return json(res, 403, { error: "foreign origin" });
    }

    if (p === "/door/login" || p === "/door/login/") {
      if (req.method === "GET") {
        const { dev, presented } = authOf(req, ip);
        if (dev) {
          return void res.writeHead(303, { Location: "/tinker/" }).end();
        }
        const wait = retryAfter(ip);
        if (wait) {
          return tooMany(res, ip, wait, p);
        }
        return html(res, 200, loginPage(), presented ? { "Set-Cookie": CLEAR_COOKIE } : {});
      }
      if (req.method !== "POST") {
        return void res.writeHead(405, { Allow: "GET, POST" }).end();
      }
      let token = "";
      try {
        const raw = await readBody(req);
        token = (new URLSearchParams(raw).get("token") ?? "").trim();
      } catch {
        return html(res, 413, loginPage("That was too long."));
      }
      const dev = findDevice(devices(), token);
      if (!dev) {
        const wait = retryAfter(ip);
        if (wait) {
          return tooMany(res, ip, wait, p);
        }
        noteFail(ip, token);
        audit({ ev: "login_fail", ip });
        return html(res, 401, loginPage("That token does not open this door."));
      }
      audit({ ev: "login_ok", ip, deviceId: dev.id });
      noteSeen(dev);
      return void res
        .writeHead(303, { Location: "/tinker/", "Set-Cookie": deviceCookie(token) })
        .end();
    }

    if (p === "/door/pair" || p === "/door/pair/") {
      if (req.method !== "GET" && req.method !== "POST") {
        return void res.writeHead(405, { Allow: "GET, POST" }).end();
      }
      let code = url.searchParams.get("code") ?? "";
      if (req.method === "POST") {
        try {
          code = new URLSearchParams(await readBody(req)).get("code") ?? "";
        } catch {
          return pairInvalid(res);
        }
        const used = code ? usePairCode(dir, code) : null;
        if (used) {
          audit({ ev: "pair_used", ip, deviceId: used.device.id });
          cache.key = ""; // the device's hash has just changed
          return pairedPage(req, res, used.device, used.token);
        }
      } else if (code) {
        // GET only shows what the code would pair; the POST spends it.
        const dev = peekPairCode(dir, code);
        if (dev) {
          return html(res, 200, pairConfirmPage({ deviceName: dev.name, code }));
        }
      }
      // Reloading the page after the code is spent: a valid cookie is enough to show it again.
      const auth = authOf(req, ip);
      if (auth.dev) {
        return pairedPage(req, res, auth.dev, auth.token);
      }
      const wait = retryAfter(ip);
      if (wait) {
        return tooMany(res, ip, wait, p);
      }
      if (code) {
        noteFail(ip, `pair:${code}`);
      }
      audit({ ev: "pair_fail", ip });
      return pairInvalid(res);
    }

    const auth = authOf(req, ip);
    if (!auth.dev) {
      const wait = retryAfter(ip);
      if (wait) {
        return tooMany(res, ip, wait, p);
      }
      const extra = auth.presented ? { "Set-Cookie": CLEAR_COOKIE } : {};
      const wantsHtml =
        (req.method === "GET" || req.method === "HEAD") &&
        String(req.headers.accept ?? "").includes("text/html");
      if (wantsHtml) {
        return void res.writeHead(302, { Location: "/door/login", ...extra }).end();
      }
      return json(res, 401, { error: "unauthorized" }, extra);
    }
    const dev = auth.dev;

    if (p === "/door/whoami") {
      return json(res, 200, {
        id: dev.id,
        name: dev.name,
        createdAt: dev.createdAt ?? null,
        pairedAt: dev.pairedAt ?? null,
        lastSeenAt: dev.lastSeenAt ?? null,
        publicOrigin,
      });
    }
    // The app reports each build it starts once, so the Pi can prove an update landed (the architect 2026-10-22).
    if (p === "/door/app/installed") {
      const vc = Number(url.searchParams.get("versionCode"));
      if (!Number.isSafeInteger(vc) || vc <= 0) {
        return json(res, 400, { error: "versionCode required" });
      }
      // 2026-10-23: installer of record + update owner, to see why Android still asks for a tap.
      const tag = (k) => String(url.searchParams.get(k) ?? "").slice(0, 120);
      audit({
        event: "app-installed",
        device: dev.id,
        versionCode: vc,
        installer: tag("installer"),
        owner: tag("owner"),
      });
      return json(res, 200, { ok: true });
    }
    // 2026-10-26 (the architect: "the Jarvis app keeps stopping"): one crash or abnormal-exit report per POST.
    // The full text lands in <dir>/crashes/, the audit gets kind + headline.
    if (p === "/door/app/crash" && req.method === "POST") {
      let text;
      try {
        text = await readBody(req, 64 * 1024);
      } catch {
        return json(res, 413, { error: "report too large or too slow" });
      }
      const field = (k) => (text.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1] ?? "").slice(0, 300);
      const at = Number(field("at")) || Date.now();
      const kind = field("kind").replace(/[^a-z0-9-]/g, "") || "unknown";
      const crashDir = path.join(dir, "crashes");
      fs.mkdirSync(crashDir, { recursive: true, mode: 0o700 });
      const file = `${new Date(at).toISOString().replace(/[:.]/g, "-")}-${kind}.txt`;
      fs.writeFileSync(path.join(crashDir, file), text, { mode: 0o600 });
      audit({
        event: "app-crash",
        device: dev.id,
        kind,
        crashedAt: new Date(at).toISOString(),
        app: field("app"),
        headline: field("headline"),
        file,
      });
      return json(res, 200, { ok: true });
    }
    // 2026-10-23: the app reports each content-pack outcome (active, rolled-back, rejected, skipped).
    if (p === "/door/app/pack-installed") {
      const v = Number(url.searchParams.get("version"));
      if (!Number.isSafeInteger(v) || v < 0) {
        return json(res, 400, { error: "version required" });
      }
      const tag = (k, n = 40) => String(url.searchParams.get(k) ?? "").slice(0, n);
      audit({
        event: "pack-installed",
        device: dev.id,
        version: v,
        status: tag("status"),
        engine: tag("engine"),
        app: tag("app"),
        detail: tag("detail", 200),
      });
      return json(res, 200, { ok: true });
    }
    if (p === "/door/app/pack.json") {
      let j = null;
      try {
        j = JSON.parse(fs.readFileSync(path.join(dir, "app", "pack.json"), "utf8"));
      } catch {
        j = null;
      }
      if (!j || !packNameOk(j.file)) {
        return json(res, 404, { error: "no pack published" });
      }
      return json(res, 200, j, { "Cache-Control": "no-cache" });
    }
    if (p.startsWith("/door/app/pack-")) {
      const name = p.slice("/door/app/".length);
      if (
        !packNameOk(name) ||
        !sendFile(res, path.join(dir, "app", name), "application/zip", {
          "Cache-Control": "no-cache",
        })
      ) {
        json(res, 404, { error: "not found" });
      }
      return;
    }
    if (p === "/door/app/latest.json") {
      const j = latestApp();
      if (!j) {
        return json(res, 404, { error: "no app published" });
      }
      return json(res, 200, j, { "Cache-Control": "no-cache" });
    }
    if (p.startsWith("/door/app/")) {
      const name = p.slice("/door/app/".length);
      if (!apkNameOk(name)) {
        return json(res, 404, { error: "not found" });
      }
      const ok = sendFile(
        res,
        path.join(dir, "app", name),
        "application/vnd.android.package-archive",
        {
          "Cache-Control": "no-cache",
          "Content-Disposition": `attachment; filename="${name}"`,
        },
      );
      if (!ok) {
        json(res, 404, { error: "not found" });
      }
      return;
    }
    if (p === "/door/backup/manifest" && req.method === "GET") {
      const files = listBackup(path.join(backupDir, path.basename(dev.id)));
      audit({ ev: "backup_manifest", deviceId: dev.id, files: files.length });
      return json(res, 200, { files });
    }
    if (p === "/door/backup/file") {
      if (req.method !== "PUT") {
        return void res.writeHead(405, { Allow: "PUT" }).end();
      }
      return receiveBackup(req, res, dev, url);
    }
    // 2026-10-20 (the architect): a terminal on the Pi that still opens when the gateway hangs (term.mjs).
    if (p.startsWith("/door/term") && term.handleHttp(p, res)) {
      return;
    }
    if (p.startsWith("/door/")) {
      return json(res, 404, { error: "unknown door route" });
    }
    if (p === "/trip") {
      return void res.writeHead(301, { Location: "/trip/" }).end();
    }
    if (p.startsWith("/trip/")) {
      const t = TRIP_FILES.get(p.slice("/trip/".length));
      const ok =
        t && sendFile(res, path.join(tripDir, t[0]), t[1], { "Cache-Control": "no-cache" });
      if (!ok) {
        html(
          res,
          404,
          messagePage(
            "No trip yet",
            "Nothing has been rendered here yet (trip-render.mjs writes it).",
          ),
          { "Cache-Control": "no-cache" },
        );
      }
      return;
    }
    proxy(req, res, dev);
  }

  const term = createTerminal({ audit, live });
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[phone-door] request error", err);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  // Long uploads to Tinker are fine (the first-byte timer starts after the body); the only body the
  // door reads itself, a login or pair form, has its own 15 s deadline in readBody().
  server.requestTimeout = 0;
  server.maxConnections = MAX_CONNECTIONS;

  const sweep = setInterval(() => {
    if (!live.size) {
      return;
    }
    const active = new Set(
      devices()
        .filter((r) => r.status === "active")
        .map((r) => r.hash),
    );
    for (const c of live) {
      if (!active.has(c.hash)) {
        audit({ ev: "stream_closed_revoked", deviceId: c.id, kind: c.kind });
        c.close();
      }
    }
  }, sweepMs);
  sweep.unref();
  // An unused code still holds a raw token; it goes from disk within a minute of expiring.
  const purgePairCodes = () => {
    try {
      purgeExpiredPairCodes(dir);
    } catch (err) {
      console.error("[phone-door] pair-codes purge failed", err.message);
    }
  };
  purgePairCodes();
  const purge = setInterval(purgePairCodes, PAIR_PURGE_MS);
  purge.unref();
  server.on("close", () => {
    clearInterval(sweep);
    clearInterval(purge);
  });

  server.on("upgrade", (req, socket, head) => {
    const ip = req.socket.remoteAddress ?? "?";
    const refuse = (status, extra = "") => {
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`,
        () => socket.destroy(),
      );
    };
    socket.on("error", () => socket.destroy());
    if (foreignOrigin(req.headers, req.method, { upgrade: true })) {
      audit({ ev: "origin_refused", ip, where: "upgrade" });
      return refuse("403 Forbidden");
    }
    const { dev } = authOf(req, ip);
    if (!dev) {
      const wait = retryAfter(ip);
      if (wait) {
        auditLimited(ip, "upgrade");
        return refuse("429 Too Many Requests", `Retry-After: ${wait}\r\n`);
      }
      return refuse("401 Unauthorized");
    }
    if (term.handleUpgrade(req, socket, head, dev)) {
      audit({ ev: "term_open", ip, deviceId: dev.id });
      return;
    }
    const up = net.connect(upPort, upHost);
    const conn = {
      id: dev.id,
      hash: dev.hash,
      kind: "ws",
      close() {
        live.delete(conn);
        socket.destroy();
        up.destroy();
      },
    };
    live.add(conn);
    up.on("connect", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(upstreamHeaders(req.headers, upstreamHost))) {
        lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      }
      lines.push("", "");
      up.write(lines.join("\r\n"));
      if (head?.length) {
        up.write(head);
      }
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", conn.close);
    socket.on("error", conn.close);
    up.on("close", conn.close);
    socket.on("close", conn.close);
    // The HTTP server's sockets allow half-open, so a phone that hangs up would only half-close the
    // upstream leg and both would linger. A WebSocket has no use for half-open: when either side
    // ends, flush what is left to the other side, then close both.
    socket.on("end", () => up.end(conn.close));
    up.on("end", () => socket.end(conn.close));
  });

  return { server, devices, audit, liveSockets: () => live.size };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const home = os.homedir();
  const bind = process.env.PHONE_DOOR_BIND ?? "";
  const allowAny = process.env.PHONE_DOOR_ALLOW_ANY === "1";
  const why = checkBind(bind, allowAny);
  if (why) {
    console.error(`[phone-door] ${why}`);
    process.exit(1);
  }
  const port = Number(process.env.PHONE_DOOR_PORT ?? 18794);
  const upstream = process.env.PHONE_DOOR_UPSTREAM ?? "127.0.0.1:18793";
  const dir = process.env.PHONE_DOOR_DIR ?? path.join(home, ".openclaw", "data", "phone-door");
  const tripDir = process.env.TRIP_DIR ?? path.join(home, ".openclaw", "data", "trip");
  const backupDir = process.env.PHONE_BACKUP_DIR ?? path.join(home, "Pictures", "phone-backup");
  const publicOrigin = process.env.PHONE_DOOR_PUBLIC_ORIGIN ?? "";
  const { server } = createDoor({ dir, upstream, tripDir, backupDir, publicOrigin });
  server.on("error", (err) => {
    console.error(`[phone-door] cannot listen on ${bind}:${port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, bind.replace(/^\[|\]$/g, ""), () => {
    // Belt and braces for checkBind: judge the address the kernel actually gave us.
    const got = server.address()?.address;
    if (isAnyAddress(got) && !allowAny) {
      console.error(`[phone-door] ${bind} listens on every interface (${got}); refusing`);
      process.exit(1);
    }
    console.log(`[phone-door] ${bind}:${port} -> ${upstream}, state ${dir}, trip ${tripDir}`);
  });
}
