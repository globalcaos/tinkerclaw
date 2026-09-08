#!/usr/bin/env node
/**
 * linkedin.mjs — LinkedIn Voyager crawl via browser session cookies
 *
 * Pattern mirrors teams-hack: borrow the session the browser already holds,
 * store it, call LinkedIn's own internal API (Voyager) with it.
 *
 * Subcommands:
 *   session extract-browser     Print JS to pull cookies/csrf from linkedin.com tab
 *   session store --li-at <v> --jsessionid <v> [--csrf-token <v>] [--bcookie <v>] [--bscookie <v>]
 *   session test
 *   session status
 *   me
 *   profile <vanity-or-urn> [--raw]
 *   search people "<query>" [--top N] [--network F|S|O]
 *   search companies "<query>" [--top N]
 *   connections [--top N] [--start N]
 *   conversations [--top N]
 *   messages <conversationUrn> [--top N]
 *   message-send <conversationUrn> --message <text>   # gated; needs --i-mean-it
 *   feed [--top N]
 *   notifications [--top N]
 *   company <vanity-or-id>
 *   posts <vanity> [--top N]
 *   activity show|bump <counter> [--by N]
 *
 * Zero external deps. Node 22+.
 */

import { execFileSync } from "child_process";
import { lookup as dnsLookup } from "dns/promises";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  unlinkSync,
  lstatSync,
} from "fs";
import { homedir, platform } from "os";
import { join, isAbsolute, sep } from "path";

const CREDS_DIR = join(homedir(), ".openclaw/credentials");
const TOKEN_FILE = join(CREDS_DIR, "linkedin-session.json");
const ACTIVITY_FILE = join(homedir(), ".openclaw/workspace/memory/linkedin-activity.json");
const VOYAGER = "https://www.linkedin.com/voyager/api";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const RELAY_CDP = process.env.LINKEDIN_CDP_URL || "ws://127.0.0.1:18792/cdp";
const RELAY_HTTP = process.env.LINKEDIN_RELAY_HTTP || "http://127.0.0.1:18792";

// Daily ceilings. These are published, conservative limits on how much this skill
// will do in a day; they exist so an agent cannot run up an unbounded amount of
// activity on your account without you noticing. They are a brake, not a disguise.
const DEFAULT_LIMITS = {
  messages_sent: 25,
  messages_read: 200,
  profile_views: 40,
  connections_sent: 15,
  likes: 40,
  sessions: 15,
  total_minutes: 90,
};

// Courtesy rate limiting: a fixed minimum interval between Voyager calls, so this
// skill cannot hammer LinkedIn. It is deliberately DETERMINISTIC and announced —
// there is no jitter, no randomised pause and no attempt to look like a person.
// LINKEDIN_PACE_MS only ever slows it down (floor 500ms, default 1500ms).
const PACE_BASE = Math.max(500, parseInt(process.env.LINKEDIN_PACE_MS || "1500", 10) || 1500);
let _lastVoyagerAt = 0;

// ─── Session store ───
// `li_at` is password-equivalent: whoever holds it is signed in as you, with no
// second factor and no per-request consent. So the ONLY store this skill will use
// on its own is the OS keychain. If there is no keychain, persistence FAILS CLOSED:
// nothing is written, and you are told to either install a keychain or run with
// LINKEDIN_TRANSPORT=browser, which needs no stored session at all.
//
// A 0600 file store still exists, but it is never reached by accident — it takes an
// explicit, per-run `--allow-plaintext-store` (or LINKEDIN_ALLOW_PLAINTEXT_STORE=1),
// it stores the minimum field set, and it self-expires after 24h.
// There is no switch that disables the keychain.
const KEYRING_SERVICE = "openclaw-linkedin-hack";
const KEYRING_ACCOUNT = "linkedin-session";
const KEYCHAIN_BIN = platform() === "darwin" ? "security" : "secret-tool";

// Stamped into every file this skill creates, so the delete guard below can prove a
// file is ours before removing it.
const MARKER = "openclaw-linkedin-hack";

// The plaintext fallback is opt-in and short-lived.
const FILE_STORE_TTL_MS = 24 * 3_600_000;
let _allowPlaintextFlag = false;
function plaintextStoreAllowed() {
  return _allowPlaintextFlag || process.env.LINKEDIN_ALLOW_PLAINTEXT_STORE === "1";
}

// Write a file that only this user can read, whether or not it already existed
// (the `mode` option is ignored for an existing file).
function writePrivate(file, data) {
  writeFileSync(file, data, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

// Each helper runs one fixed binary with a fixed argument list and no shell, and
// returns false/null rather than throwing when the keychain is simply absent.
//
// On BOTH platforms the secret travels over stdin and never appears in argv, so it
// cannot be read out of `ps`, an audit log, or a shell history. macOS `security`
// reads the password from stdin when -w is given with no value (it may ask twice,
// hence the doubled line). The write is then verified by reading it back — if the
// value did not land, this returns false and the caller fails closed rather than
// silently believing the session was sealed.
function keychainSet(value) {
  try {
    if (KEYCHAIN_BIN === "security") {
      execFileSync(
        "security",
        ["add-generic-password", "-U", "-s", KEYRING_SERVICE, "-a", KEYRING_ACCOUNT, "-w"],
        { input: `${value}\n${value}\n`, stdio: ["pipe", "ignore", "ignore"] },
      );
    } else {
      execFileSync(
        "secret-tool",
        [
          "store",
          "--label=OpenClaw LinkedIn session",
          "service",
          KEYRING_SERVICE,
          "account",
          KEYRING_ACCOUNT,
        ],
        { input: value, stdio: ["pipe", "ignore", "ignore"] },
      );
    }
  } catch {
    return false;
  }
  // Read-back verification: never report "sealed" on an unproven write.
  return keychainGet() === value;
}

function keychainGet() {
  try {
    const argv =
      KEYCHAIN_BIN === "security"
        ? ["find-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_ACCOUNT, "-w"]
        : ["lookup", "service", KEYRING_SERVICE, "account", KEYRING_ACCOUNT];
    const v = execFileSync(KEYCHAIN_BIN, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = String(v || "").replace(/\n$/, "");
    return trimmed || null;
  } catch {
    return null;
  }
}

function keychainDelete() {
  try {
    const argv =
      KEYCHAIN_BIN === "security"
        ? ["delete-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_ACCOUNT]
        : ["clear", "service", KEYRING_SERVICE, "account", KEYRING_ACCOUNT];
    execFileSync(KEYCHAIN_BIN, argv, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

// ─── Deletion guard ───
// Every path this skill deletes goes through here. The rules are deliberately
// paranoid, because a delete helper that takes a path is a delete helper someone
// will eventually point somewhere else: the target must be an ABSOLUTE path, INSIDE
// $HOME, a REGULAR FILE and never a SYMLINK (so it cannot be aimed elsewhere by
// swapping a link), and it must be one this skill actually created — proven by the
// MARKER it stamps into its own files.
const OWNED_FILES = new Set([TOKEN_FILE, ACTIVITY_FILE]); // CACHE_FILE added at its definition

function isOwnedFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  if (parsed && parsed._openclaw_skill === MARKER) return true;
  // Files written by <=1.1.0 predate the marker. Accept them only at this skill's own
  // three fixed paths, so the off switch keeps working for existing installs.
  return OWNED_FILES.has(file) && parsed !== null && typeof parsed === "object";
}

function safeUnlink(file) {
  const home = homedir();
  if (!isAbsolute(file)) throw new Error(`refusing to delete a relative path: ${file}`);
  if (!file.startsWith(home + sep)) throw new Error(`refusing to delete outside $HOME: ${file}`);
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return false; // already gone
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to delete a symlink: ${file}`);
  if (!st.isFile()) throw new Error(`refusing to delete a non-regular file: ${file}`);
  if (!isOwnedFile(file)) {
    throw new Error(
      `refusing to delete ${file}: it carries no ${MARKER} marker, so this skill did not create it`,
    );
  }
  unlinkSync(file);
  return true;
}

function loadCreds() {
  const sealed = keychainGet();
  if (sealed) {
    try {
      return JSON.parse(sealed);
    } catch {
      console.error("Keychain entry is not valid JSON — ignoring it.");
    }
  }
  if (!existsSync(TOKEN_FILE)) return {};
  try {
    const c = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    // The opt-in file store self-expires: an abandoned session file stops being a
    // usable credential after a day, and is removed on the first run that sees it.
    if (c.expires_at && Date.parse(c.expires_at) < Date.now()) {
      console.error(
        `The stored session in ${TOKEN_FILE} expired at ${c.expires_at} — deleting it.`,
      );
      try {
        safeUnlink(TOKEN_FILE);
      } catch (e) {
        console.error(`Could not remove the expired file: ${e.message}`);
      }
      return {};
    }
    return c;
  } catch {
    return {};
  }
}

// Returns 'keychain' or 'file' so callers can report where the secret landed.
// Throws — rather than quietly writing a plaintext file — when there is no keychain
// and the caller has not explicitly accepted the plaintext store.
function saveCreds(creds) {
  const blob = JSON.stringify({ ...creds, _openclaw_skill: MARKER }, null, 2);
  if (keychainSet(blob)) {
    // Never leave a second copy behind: an earlier run may have written the file.
    if (existsSync(TOKEN_FILE)) {
      try {
        safeUnlink(TOKEN_FILE);
      } catch (e) {
        console.error(`Note: could not remove the old file copy: ${e.message}`);
      }
    }
    console.error(
      `Session sealed in the OS keychain (${KEYCHAIN_BIN}: ${KEYRING_SERVICE}/${KEYRING_ACCOUNT}).`,
    );
    return "keychain";
  }

  if (!plaintextStoreAllowed()) {
    throw new Error(
      `No usable OS keychain (${KEYCHAIN_BIN} is missing, refused, or failed read-back), so NOTHING was saved.\n` +
        "Your LinkedIn session cookie is password-equivalent, and this skill will not write it to a plain\n" +
        "file unless you say so in the same breath. Pick one:\n" +
        "  1. Install a keychain — libsecret (secret-tool) on Linux, Keychain on macOS. Recommended.\n" +
        "  2. Do not persist at all — LINKEDIN_TRANSPORT=browser (the default) keeps the cookies inside\n" +
        "     the shared tab and needs no stored session.\n" +
        "  3. Accept the risk explicitly: re-run with --allow-plaintext-store (or set\n" +
        `     LINKEDIN_ALLOW_PLAINTEXT_STORE=1). That writes ${TOKEN_FILE} at mode 0600, keeps only the\n` +
        "     fields needed to make a request, and expires it after 24h.",
    );
  }

  // Explicitly accepted: keep the minimum field set, and stamp an expiry on it.
  const minimal = {
    li_at: creds.li_at,
    jsessionid: creds.jsessionid,
    csrf_token: creds.csrf_token,
    source: creds.source || "browser-session",
    updated_at: creds.updated_at || new Date().toISOString(),
    expires_at: new Date(Date.now() + FILE_STORE_TTL_MS).toISOString(),
    _openclaw_skill: MARKER,
  };
  mkdirSync(CREDS_DIR, { recursive: true });
  writePrivate(TOKEN_FILE, JSON.stringify(minimal, null, 2));
  console.error(
    `WARNING: no OS keychain available (${KEYCHAIN_BIN} not found or refused), and you passed\n` +
      "WARNING:   --allow-plaintext-store, so the session was written to disk.\n" +
      `WARNING: file: ${TOKEN_FILE} (mode 0600, expires ${minimal.expires_at}).\n` +
      "WARNING: that file is session-equivalent — anyone who reads it is signed in as you, with no\n" +
      'WARNING: password and no second factor. Backup and sync tools count as "anyone".\n' +
      "WARNING: run   linkedin session logout   as soon as you are done.",
  );
  return "file";
}

// The off switch. Clears BOTH stores and reports what was actually removed.
function clearCreds() {
  const removed = [];
  if (keychainDelete()) removed.push(`keychain:${KEYRING_SERVICE}/${KEYRING_ACCOUNT}`);
  if (existsSync(TOKEN_FILE)) {
    try {
      if (safeUnlink(TOKEN_FILE)) removed.push(TOKEN_FILE);
    } catch (e) {
      console.error(`Could not remove ${TOKEN_FILE}: ${e.message}`);
    }
  }
  return removed;
}

function requireSession() {
  const c = loadCreds();
  if (!c.li_at) {
    throw new Error(
      "No LinkedIn session. Sign in on linkedin.com/feed, share the tab, then:\n" +
        "  linkedin session extract-cdp --store",
    );
  }
  return c;
}

function cookieHeader(c) {
  const parts = [`li_at=${c.li_at}`];
  if (c.jsessionid) {
    // JSESSIONID often arrives already-quoted ("ajax:…")
    const j = c.jsessionid.startsWith('"') ? c.jsessionid : `"${c.jsessionid}"`;
    parts.push(`JSESSIONID=${j}`);
  }
  if (c.bcookie) parts.push(`bcookie=${c.bcookie.startsWith('"') ? c.bcookie : `"${c.bcookie}"`}`);
  if (c.bscookie)
    parts.push(`bscookie=${c.bscookie.startsWith('"') ? c.bscookie : `"${c.bscookie}"`}`);
  if (c.li_a) parts.push(`li_a=${c.li_a}`);
  if (c.lidc) parts.push(`lidc=${c.lidc}`);
  return parts.join("; ");
}

function csrfToken(c) {
  // Voyager CSRF is the JSESSIONID value without quotes, often "ajax:NNNN"
  if (c.csrf_token) return c.csrf_token.replace(/^"|"$/g, "");
  if (c.jsessionid) return c.jsessionid.replace(/^"|"$/g, "");
  throw new Error("Missing csrf/JSESSIONID");
}

// ─── Activity / rate guard ───
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function weekStartISO(d = new Date()) {
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day + 6) % 7; // Monday-start
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return mon.toISOString().slice(0, 10);
}

function loadActivity() {
  const blank = {
    lastSession: null,
    today: {
      date: todayISO(),
      messages_sent: 0,
      messages_read: 0,
      profile_views: 0,
      connections_sent: 0,
      likes: 0,
      sessions: 0,
      total_minutes: 0,
    },
    thisWeek: { weekStart: weekStartISO(), connections_sent: 0, messages_sent: 0 },
    warnings: [],
    securityChecks: [],
    limits: { ...DEFAULT_LIMITS },
  };
  if (!existsSync(ACTIVITY_FILE)) return blank;
  try {
    const a = JSON.parse(readFileSync(ACTIVITY_FILE, "utf8"));
    if (a.today?.date !== todayISO()) {
      a.today = { ...blank.today };
    }
    if (a.thisWeek?.weekStart !== weekStartISO()) {
      a.thisWeek = { ...blank.thisWeek };
    }
    a.limits = { ...DEFAULT_LIMITS, ...(a.limits || {}) };
    return a;
  } catch {
    return blank;
  }
}

function saveActivity(a) {
  mkdirSync(join(homedir(), ".openclaw/workspace/memory"), { recursive: true });
  writePrivate(ACTIVITY_FILE, JSON.stringify({ ...a, _openclaw_skill: MARKER }, null, 2));
}

function bumpActivity(counter, by = 1) {
  const a = loadActivity();
  a.lastSession = new Date().toISOString();
  if (a.today[counter] !== undefined) a.today[counter] += by;
  if (a.thisWeek[counter] !== undefined) a.thisWeek[counter] += by;
  saveActivity(a);
  return a;
}

function assertUnderLimit(counter, by = 1) {
  const a = loadActivity();
  const limit = a.limits?.[counter] ?? DEFAULT_LIMITS[counter];
  if (limit == null) return;
  const cur = a.today?.[counter] ?? 0;
  if (cur + by > limit) {
    throw new Error(
      `Rate guard: daily ${counter} would hit ${cur + by}/${limit}. ` +
        `Slow down. linkedin activity show`,
    );
  }
}

// ─── Local cache — re-crawls are free requests ───
const CACHE_FILE = join(homedir(), ".openclaw/workspace/memory/linkedin-cache.json");
OWNED_FILES.add(CACHE_FILE);
// Retention is configurable and now defaults to 12h (was 60h). Anything longer is
// your explicit choice, and it is capped at 7 days.
const CACHE_TTL_MS =
  Math.min(168, Math.max(1, parseInt(process.env.LINKEDIN_CACHE_TTL_H || "12", 10) || 12)) *
  3_600_000;
// The cache stores OTHER PEOPLE'S profile and company data on your disk. That is
// third-party personal data, so it is OFF unless you turn it on with LINKEDIN_CACHE=1.
// With it off nothing about the people you look up is ever written to disk; the only
// cost is that a repeated lookup spends a request instead of being free.
const CACHE_ENABLED = process.env.LINKEDIN_CACHE === "1";

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(c) {
  mkdirSync(join(homedir(), ".openclaw/workspace/memory"), { recursive: true });
  // Third-party profile data — owner-only, same as the credentials file.
  writePrivate(CACHE_FILE, JSON.stringify({ ...c, _openclaw_skill: MARKER }, null, 2));
}

function cacheGet(key) {
  if (!CACHE_ENABLED) return null;
  if (key === "_openclaw_skill") return null;
  const e = loadCache()[key];
  if (!e || Date.now() - e.at > CACHE_TTL_MS) return null;
  return e.data;
}

function cacheSet(key, data) {
  if (!CACHE_ENABLED) return;
  const c = loadCache();
  c[key] = { at: Date.now(), data };
  // Prune entries older than 7 days to keep the file small.
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const k of Object.keys(c)) {
    if (k === "_openclaw_skill") continue;
    if (!c[k] || typeof c[k].at !== "number" || c[k].at < cutoff) delete c[k];
  }
  saveCache(c);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pace() {
  // Fixed floor between calls. Nothing random: same input, same timing.
  const wait = PACE_BASE - (Date.now() - _lastVoyagerAt);
  if (wait > 0) await sleep(wait);
  _lastVoyagerAt = Date.now();
}

// Transport mode:
//   browser (default) — fetch inside the shared LinkedIn tab via CDP (factorial pattern).
//                       Cookies never leave the browser; survives LinkedIn's external-replay kill.
//   external          — cookie-jar replay from Node (fragile; often 302 after first success).
// Override: LINKEDIN_TRANSPORT=browser|external
const TRANSPORT = (process.env.LINKEDIN_TRANSPORT || "browser").toLowerCase();

function buildUrl(path, query) {
  let url = path.startsWith("http")
    ? path
    : `${VOYAGER}${path.startsWith("/") ? path : `/${path}`}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    url += (url.includes("?") ? "&" : "?") + qs.toString();
  }
  return url;
}

// ─── Voyager via in-tab fetch (preferred) ───
async function voyagerBrowser(path, { method = "GET", body = null, query = null } = {}) {
  const url = buildUrl(path, query);
  // Use path relative to linkedin origin when possible — same-origin cookies always attach.
  const rel = url.startsWith("https://www.linkedin.com")
    ? url.slice("https://www.linkedin.com".length)
    : url;

  await pace();
  const targetId = await findLinkedInTargetId();
  const ws = await openCdp();
  try {
    const attached = await cdpCall(ws, 1, "Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;

    // Sanity: not on login wall
    const loc = await cdpCall(
      ws,
      2,
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      sessionId,
    );
    const href = loc.result?.value || "";
    if (/\/login|\/uas\/login|checkpoint/i.test(href)) {
      throw new Error(
        `LinkedIn tab is on login/checkpoint (${href}). Sign in, open feed, re-share.`,
      );
    }

    const methodJs = JSON.stringify(method);
    const relJs = JSON.stringify(rel);
    const bodyJs = body != null ? JSON.stringify(JSON.stringify(body)) : "null";
    const expr = `async () => {
      const csrf = (document.cookie.match(/JSESSIONID=\"?([^;\"]+)/) || [])[1];
      if (!csrf) return { __err: 'no_jsessionid_csrf', href: location.href };
      const headers = {
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'csrf-token': csrf,
        'x-restli-protocol-version': '2.0.0',
        'x-li-lang': 'en_US',
      };
      const init = { method: ${methodJs}, credentials: 'include', headers };
      const bodyStr = ${bodyJs};
      if (bodyStr != null) {
        headers['content-type'] = 'application/json; charset=UTF-8';
        init.body = bodyStr;
      }
      const r = await fetch(${relJs}, init);
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
      return { status: r.status, data, href: location.href };
    }`;

    const ev = await cdpCall(
      ws,
      3,
      "Runtime.evaluate",
      { expression: `(${expr})()`, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (ev.exceptionDetails) {
      throw new Error(
        `in-tab evaluate failed: ${ev.exceptionDetails.text || JSON.stringify(ev.exceptionDetails)}`,
      );
    }
    const val = ev.result?.value;
    if (!val) throw new Error("in-tab evaluate returned empty");
    if (val.__err) throw new Error(`in-tab: ${val.__err} @ ${val.href || "?"}`);

    if (val.status === 429) {
      throw new Error("Voyager 429 rate limit (in-tab). Back off minutes, not seconds.");
    }
    if (val.status === 401 || val.status === 403) {
      throw new Error(
        `LinkedIn ${val.status} in-tab — session dead or challenge. Re-login on the shared feed tab.`,
      );
    }
    if (val.status < 200 || val.status >= 300) {
      const msg = val.data?.message || val.data?.status || JSON.stringify(val.data).slice(0, 200);
      throw new Error(`Voyager ${val.status} (in-tab): ${msg}`);
    }
    return val.data;
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

// ─── Voyager HTTP (external cookie replay — fragile) ───
async function voyagerExternal(path, { method = "GET", body = null, query = null } = {}) {
  const c = requireSession();
  const url = buildUrl(path, query);

  await pace();

  const headers = {
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": UA,
    "csrf-token": csrfToken(c),
    cookie: cookieHeader(c),
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    referer: "https://www.linkedin.com/feed/",
    origin: "https://www.linkedin.com",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
  if (body != null) headers["content-type"] = "application/json; charset=UTF-8";

  const resp = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });

  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get("location") || "";
    throw new Error(
      `LinkedIn ${resp.status} redirect → ${loc.slice(0, 120) || "(no location)"}. ` +
        `External cookie replay rejected. Prefer LINKEDIN_TRANSPORT=browser (default) with a shared feed tab.`,
    );
  }

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }

  if (resp.status === 429) {
    throw new Error("Voyager 429 rate limit. Back off (minutes, not seconds).");
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(
      `LinkedIn ${resp.status} external — jar dead. Use browser transport + live tab.`,
    );
  }
  if (!resp.ok) {
    const msg = data?.message || data?.status || text.slice(0, 300);
    throw new Error(`Voyager ${resp.status}: ${msg}`);
  }
  return data;
}

async function voyager(path, opts = {}) {
  if (TRANSPORT === "external") return voyagerExternal(path, opts);
  // browser default: try in-tab first; fall back to external only if no tab AND jar exists
  try {
    return await voyagerBrowser(path, opts);
  } catch (e) {
    const msg = e.message || String(e);
    const noTab =
      /No linkedin\.com tab|login wall|login\/checkpoint/i.test(msg) || /json\/list/i.test(msg);
    if (noTab && existsSync(TOKEN_FILE)) {
      const c = loadCreds();
      if (c.li_at) {
        console.error(`⚠ in-tab failed (${msg.slice(0, 80)}); trying external jar (fragile)…`);
        return voyagerExternal(path, opts);
      }
    }
    throw e;
  }
}

// ─── CDP helpers (OpenClaw extension relay) ───
function cdpCall(ws, id, method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout " + method)), 20000);
    function onMsg(ev) {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
    ws.addEventListener("message", onMsg);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
}

// ─── Relay guard ───
// RELAY_CDP / RELAY_HTTP are overridable, and they carry the most sensitive traffic
// this skill has: raw session cookies and full browser control. So before either is
// used, both must point at loopback. Hostnames are RESOLVED first — `evil.example`
// pointing at a public IP, or a name that only looks local, does not get through.
// LINKEDIN_ALLOW_REMOTE_RELAY=1 is the deliberate escape hatch, and it says so loudly.
const ALLOW_REMOTE_RELAY = process.env.LINKEDIN_ALLOW_REMOTE_RELAY === "1";
let _relayChecked = false;

function isLoopbackAddr(a) {
  return a === "::1" || a === "::ffff:127.0.0.1" || /^127\./.test(a);
}

async function assertRelayIsLocal() {
  if (_relayChecked) return;
  for (const [label, raw] of [
    ["LINKEDIN_CDP_URL", RELAY_CDP],
    ["LINKEDIN_RELAY_HTTP", RELAY_HTTP],
  ]) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`${label} is not a valid URL: ${raw}`);
    }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    let local = isLoopbackAddr(host);
    if (!local) {
      // Not a literal loopback IP: resolve it and require EVERY answer to be loopback.
      try {
        const addrs = await dnsLookup(host, { all: true });
        local = addrs.length > 0 && addrs.every((a) => isLoopbackAddr(a.address));
      } catch {
        local = false;
      }
    }
    if (local) continue;
    if (!ALLOW_REMOTE_RELAY) {
      throw new Error(
        `${label} points off loopback (${raw}). This channel carries your LinkedIn session\n` +
          "cookies and full control of your browser tab, so it is refused by default.\n" +
          "Use the local OpenClaw relay, or set LINKEDIN_ALLOW_REMOTE_RELAY=1 if you really do\n" +
          "run the relay on another host and the link between them is one you trust.",
      );
    }
    console.error(
      `WARNING: ${label} is remote (${raw}) and LINKEDIN_ALLOW_REMOTE_RELAY=1 is set.\n` +
        "WARNING: your session cookies and browser control will cross the network to that host.",
    );
  }
  _relayChecked = true;
}

// Only ever navigate the shared tab within LinkedIn. The tab belongs to the user, and
// a navigation helper that accepts any URL is one an agent can be talked into pointing
// anywhere — including at a page that reads the session it is carrying.
function assertLinkedInUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`refusing to navigate to an invalid URL: ${url}`);
  }
  if (u.protocol !== "https:" || !/^([a-z0-9-]+\.)?linkedin\.com$/.test(u.hostname)) {
    throw new Error(
      `refusing to navigate the shared tab outside https://www.linkedin.com (asked for ${url})`,
    );
  }
  return u.toString();
}

async function openCdp() {
  await assertRelayIsLocal();
  const ws = new WebSocket(RELAY_CDP);
  await new Promise((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", (e) => rej(e.error || e), { once: true });
  });
  return ws;
}

async function findLinkedInTargetId() {
  // Prefer explicit override
  if (process.env.LINKEDIN_TARGET_ID) return process.env.LINKEDIN_TARGET_ID;
  await assertRelayIsLocal();
  const r = await fetch(`${RELAY_HTTP}/json/list`);
  if (!r.ok) throw new Error(`relay /json/list ${r.status}`);
  const list = await r.json();
  const hit = (list || []).find(
    (t) =>
      (t.url || "").includes("linkedin.com") &&
      !(t.url || "").includes("/login") &&
      !(t.url || "").includes("/uas/login"),
  );
  if (!hit) {
    const any = (list || []).find((t) => (t.url || "").includes("linkedin.com"));
    if (any) {
      throw new Error(
        `LinkedIn tab is on login wall (${any.url}). Sign in again, open feed, re-share tab.`,
      );
    }
    throw new Error("No linkedin.com tab in relay. Share a Feed tab via the OpenClaw extension.");
  }
  return hit.id;
}

async function extractCookiesViaCdp() {
  const targetId = await findLinkedInTargetId();
  const ws = await openCdp();
  try {
    const attached = await cdpCall(ws, 1, "Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    await cdpCall(ws, 2, "Network.enable", {}, sessionId);
    let cookies = [];
    try {
      const all = await cdpCall(ws, 3, "Network.getAllCookies", {}, sessionId);
      cookies = (all.cookies || []).filter((c) => (c.domain || "").includes("linkedin"));
    } catch {
      const r = await cdpCall(
        ws,
        4,
        "Network.getCookies",
        { urls: ["https://www.linkedin.com", "https://www.linkedin.com/feed/"] },
        sessionId,
      );
      cookies = r.cookies || [];
    }
    const want = ["li_at", "JSESSIONID", "bcookie", "bscookie", "li_a", "lidc", "li_gc", "li_mc"];
    const jar = {};
    for (const c of cookies) {
      if (want.includes(c.name)) jar[c.name] = c.value;
    }
    return {
      targetId,
      jar,
      has_li_at: Boolean(jar.li_at),
      names: cookies.map((c) => c.name),
    };
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

// ─── Helpers ───
function parseArgs(argv) {
  const result = { _: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        result.flags[key] = argv[++i];
      } else {
        result.flags[key] = true;
      }
    } else {
      result._.push(argv[i]);
    }
    i++;
  }
  return result;
}

function out(data) {
  console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function pickProfile(p) {
  if (!p || typeof p !== "object") return null;
  return {
    urn: p.entityUrn || p.objectUrn,
    publicId: p.publicIdentifier,
    firstName: p.firstName,
    lastName: p.lastName,
    headline: p.headline,
    location: p.locationName || p.geoLocationName || p.location?.defaultLocalizedName,
    industry: p.industryName || p.industry,
    connection: p.networkDistance || p.distance?.value,
    trackingId: p.trackingId,
  };
}

// ─── Commands ───
async function cmdSessionExtractBrowser() {
  console.log(`// Prefer: linkedin session extract-cdp  (pulls httpOnly li_at via relay)
// Fallback evaluate on a shared https://www.linkedin.com/feed/ tab:
// (li_at is usually httpOnly — this often returns has_li_at:false)

(() => {
  const want = ['li_at', 'JSESSIONID', 'bcookie', 'bscookie', 'li_a', 'lidc', 'liap'];
  const jar = document.cookie.split(';').map(s => s.trim()).filter(Boolean);
  const cookies = {};
  for (const part of jar) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (want.includes(k)) cookies[k] = v;
  }
  const csrf =
    cookies.JSESSIONID?.replace(/^"|"$/g, '') ||
    (window.csrfToken || null);
  return {
    cookies,
    csrf,
    has_li_at: Boolean(cookies.li_at),
    note: cookies.li_at
      ? 'li_at present in document.cookie'
      : 'li_at is httpOnly — run: node linkedin.mjs session extract-cdp',
    href: location.href,
  };
})();`);
}

async function cmdSessionExtractCdp(args) {
  const doStore = Boolean(args.flags.store || args.flags["store"]);
  const doTest = Boolean(args.flags.test || args.flags["test"] || doStore);
  console.error("CDP extract via", RELAY_CDP, "…");
  const { targetId, jar, has_li_at, names } = await extractCookiesViaCdp();
  // Never print secrets — only presence / lengths.
  out({
    targetId,
    has_li_at,
    has_jsessionid: Boolean(jar.JSESSIONID),
    cookie_names: names,
    lengths: Object.fromEntries(Object.entries(jar).map(([k, v]) => [k, String(v || "").length])),
  });
  if (!has_li_at) {
    console.error(
      "No li_at in jar. If the tab is on /login, sign in first and open the feed. " +
        "If still missing, LinkedIn may have cleared the session — re-login manually.",
    );
    process.exit(1);
  }
  if (doStore) {
    const creds = {
      li_at: jar.li_at,
      jsessionid: jar.JSESSIONID,
      csrf_token: String(jar.JSESSIONID || "").replace(/^"|"$/g, ""),
      bcookie: jar.bcookie || null,
      bscookie: jar.bscookie || null,
      li_a: jar.li_a || null,
      lidc: jar.lidc || null,
      li_gc: jar.li_gc || null,
      source: "cdp-extract",
      transport_hint: "browser",
      updated_at: new Date().toISOString(),
    };
    const where = saveCreds(creds);
    console.error(
      `Session stored in the ${where === "keychain" ? "OS keychain" : "0600 file"} as a backup. ` +
        "Primary path is in-tab browser transport. Erase it with: linkedin session logout",
    );
  }
  // Always test via in-tab when possible — external /me after extract burns li_at (observed 2026-07-29).
  if (doTest || doStore) {
    console.error("Testing /me in-tab (browser transport)…");
    const prev = process.env.LINKEDIN_TRANSPORT;
    process.env.LINKEDIN_TRANSPORT = "browser";
    try {
      // re-read transport is const — call voyagerBrowser path via voyager with env already set at process start
      // So call voyagerBrowser directly:
      assertUnderLimit("sessions", 1);
      const data = await voyagerBrowser("/me");
      bumpActivity("sessions", 1);
      const mini =
        data?.included?.find((x) => (x.$type || "").includes("MiniProfile")) ||
        data?.included?.find((x) => x.publicIdentifier) ||
        data?.data ||
        data;
      out({
        status: "ok",
        transport: "browser",
        me: pickProfile(typeof mini === "object" ? mini : {}) || mini,
        jar_stored: doStore,
      });
    } finally {
      if (prev === undefined) delete process.env.LINKEDIN_TRANSPORT;
      else process.env.LINKEDIN_TRANSPORT = prev;
    }
  } else if (!doStore) {
    console.error("Dry extract only. Re-run with --store to save jar backup + in-tab test.");
  }
}

// Read the whole of stdin. Used so session material never has to be typed as an
// argument.
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// `session store` takes the cookies on STDIN as JSON, never as flags. A cookie passed
// as `--li-at <token>` ends up in your shell history, in `ps` output for every process
// on the machine, and in any terminal recording — and it is password-equivalent.
// Preferred route is still `session extract-cdp --store`, where it is never typed at all.
async function cmdSessionStore(args) {
  const raw = readStdin().trim();
  if (!raw) {
    console.error(
      "Usage: linkedin session store   — with the session on STDIN as JSON:\n" +
        '  echo \'{"li_at":"…","jsessionid":"ajax:…"}\' | linkedin session store\n' +
        "\n" +
        "Optional keys: csrf_token, bcookie, bscookie, li_a, lidc.\n" +
        "Cookies are NOT accepted as command-line flags: argv is visible to every process on\n" +
        "this machine and is kept in your shell history, and li_at is password-equivalent.\n" +
        "Easier and safer: linkedin session extract-cdp --store",
    );
    process.exit(1);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    console.error(`stdin is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const liAt = input.li_at || input["li-at"];
  const jsessionid = input.jsessionid || input.JSESSIONID;
  if (!liAt || !jsessionid) {
    console.error('stdin JSON must contain at least { "li_at": "…", "jsessionid": "ajax:…" }');
    process.exit(1);
  }
  const csrf = input.csrf_token || input.csrf || jsessionid;
  const creds = {
    li_at: liAt,
    jsessionid,
    csrf_token: String(csrf).replace(/^"|"$/g, ""),
    bcookie: input.bcookie || null,
    bscookie: input.bscookie || null,
    li_a: input.li_a || null,
    lidc: input.lidc || null,
    source: "browser-session",
    updated_at: new Date().toISOString(),
  };
  saveCreds(creds);
  console.error("Session saved. Testing…");
  try {
    await cmdSessionTest();
  } catch (e) {
    console.error(`FAIL ${e.message}`);
    process.exit(1);
  }
}

async function cmdSessionTest() {
  assertUnderLimit("sessions", 1);
  // Prefer in-tab; never force external /me right after extract (that burns li_at).
  const data = await voyager("/me");
  bumpActivity("sessions", 1);
  const mini =
    data?.included?.find((x) => (x.$type || "").includes("MiniProfile")) ||
    data?.included?.find((x) => x.publicIdentifier) ||
    data?.data ||
    data;
  const profile = pickProfile(typeof mini === "object" ? mini : {}) || mini;
  out({ status: "ok", transport: TRANSPORT, me: profile });
}

// LinkedIn's own "Where you're signed in" page. Clearing the local copy does not
// invalidate the cookie — only signing the session out here does.
const LINKEDIN_REVOKE_URL = "https://www.linkedin.com/psettings/sessions";

// `logout` erases everything this skill stored, and says plainly that it is LOCAL —
// the cookie itself stays valid at LinkedIn until you revoke it on their sessions page.
// Data purge is the DEFAULT; --keep-data opts back out of it.
async function cmdSessionLogout(args) {
  console.error(
    "Local logout: this erases what is on THIS machine. It does NOT sign the session out at\n" +
      `LinkedIn — anyone who already copied the cookie keeps access until you revoke it at\n  ${LINKEDIN_REVOKE_URL}`,
  );
  const removed = clearCreds();
  const keep = Boolean(args.flags["keep-data"]);
  const purged = [];
  if (!keep) {
    for (const f of [CACHE_FILE, ACTIVITY_FILE]) {
      if (!existsSync(f)) continue;
      try {
        if (safeUnlink(f)) purged.push(f);
      } catch (e) {
        console.error(`Could not remove ${f}: ${e.message}`);
      }
    }
  }
  out({
    status: "logged-out-locally",
    scope: "local only — the LinkedIn session itself is NOT revoked by this command",
    cleared: removed.length ? removed : ["nothing was stored"],
    local_data: keep
      ? ["kept on your explicit --keep-data"]
      : purged.length
        ? purged
        : ["nothing to purge"],
    next_step_to_actually_revoke: `Open ${LINKEDIN_REVOKE_URL} and sign the session out there.`,
    revoke_at: LINKEDIN_REVOKE_URL,
  });
}

async function cmdSessionStatus() {
  const c = loadCreds();
  const a = loadActivity();
  out({
    hasSession: Boolean(c.li_at),
    stored_in: keychainGet()
      ? `os-keychain (${KEYCHAIN_BIN})`
      : existsSync(TOKEN_FILE)
        ? `file ${TOKEN_FILE} (0600)`
        : "nothing stored",
    updated_at: c.updated_at || null,
    has_jsessionid: Boolean(c.jsessionid),
    activity: a.today,
    limits: a.limits || DEFAULT_LIMITS,
  });
}

async function cmdMe() {
  assertUnderLimit("profile_views", 1);
  const data = await voyager("/me");
  bumpActivity("profile_views", 1);
  const mini = data?.included?.find((x) => (x.$type || "").includes("MiniProfile")) || data?.data;
  out(pickProfile(mini) || data);
}

async function cmdProfile(args) {
  const id = args._[0];
  if (!id) {
    console.error("Usage: linkedin profile <vanity-or-urn> [--raw] [--no-cache]");
    process.exit(1);
  }
  // Cache check before the rate guard: a hit costs zero requests.
  if (!args.flags.raw && !args.flags["no-cache"]) {
    const hit = cacheGet(`profile:${id}`);
    if (hit) {
      out({ ...hit, cached: true });
      return;
    }
  }
  assertUnderLimit("profile_views", 1);

  let data;
  if (id.startsWith("urn:li:")) {
    data = await voyager(`/identity/profiles/${encodeURIComponent(id)}/profileView`).catch(() =>
      voyager(
        `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`,
      ),
    );
  } else {
    data = await voyager(
      `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`,
    ).catch(async () => voyager(`/identity/profiles/${encodeURIComponent(id)}/profileView`));
  }
  bumpActivity("profile_views", 1);

  if (args.flags.raw) return out(data);

  const profiles = (data.included || []).filter(
    (x) =>
      (x.$type || "").toLowerCase().includes("profile") &&
      (x.publicIdentifier || x.firstName || x.lastName),
  );
  const primary = profiles.find((p) => p.publicIdentifier === id) || profiles[0] || data.data;

  const positions = (data.included || [])
    .filter(
      (x) => (x.$type || "").includes("Position") || (x.$type || "").includes("profile.Position"),
    )
    .slice(0, 8)
    .map((p) => ({
      title: p.title,
      company: p.companyName || p.company?.name,
      dateRange: p.dateRange || p.timePeriod,
      location: p.locationName,
    }));

  const result = {
    profile: pickProfile(primary) || primary,
    positions,
    education: (data.included || [])
      .filter((x) => (x.$type || "").toLowerCase().includes("education"))
      .slice(0, 5)
      .map((e) => ({
        school: e.schoolName,
        degree: e.degreeName,
        field: e.fieldOfStudy,
      })),
  };
  if (!args.flags["no-cache"]) cacheSet(`profile:${id}`, result);
  out(result);
}

/**
 * People search via shared-tab navigation + DOM scrape.
 * Live 2026-07-29: LinkedIn search is SDUI; classic /voyager/api/search/* returns 404,
 * dash clusters return empty. The people results page still renders /in/ anchors.
 */
async function searchPeopleViaDom(query, top = 10, page = 1) {
  const targetId = await findLinkedInTargetId();
  const ws = await openCdp();
  try {
    const attached = await cdpCall(ws, 1, "Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    // Verify the tab is actually on LinkedIn — relay tab metadata can be stale,
    // and the relay blocks cross-site navigation on shared tabs.
    const loc = await cdpCall(
      ws,
      9,
      "Runtime.evaluate",
      { expression: "location.hostname", returnByValue: true },
      sessionId,
    );
    const host = loc.result?.value || "";
    if (!host.includes("linkedin.com")) {
      throw new Error(
        `Shared tab is on ${host || "?"}, not linkedin.com (relay metadata was stale). ` +
          `Navigate that tab back to linkedin.com/feed or share a LinkedIn tab, then retry.`,
      );
    }
    await cdpCall(ws, 2, "Page.enable", {}, sessionId);

    const searchUrl =
      "https://www.linkedin.com/search/results/people/?keywords=" +
      encodeURIComponent(query) +
      (page > 1 ? `&page=${page}` : "") +
      "&origin=GLOBAL_SEARCH_HEADER";
    await pace();
    await cdpCall(ws, 3, "Page.navigate", { url: assertLinkedInUrl(searchUrl) }, sessionId);
    // Wait for results to paint (SDUI is slow)
    await sleep(6500);

    const expr = `(() => {
      const people = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/in/"]')) {
        const m = a.href.match(/linkedin\\.com\\/in\\/([^/?#]+)/);
        if (!m) continue;
        let publicId;
        try { publicId = decodeURIComponent(m[1]); } catch { publicId = m[1]; }
        if (seen.has(publicId)) continue;
        // Take ONLY the first line: on some SDUI cards a.innerText carries the whole
        // card (name + degree + headline + location), which collapsed into a fake "name".
        let name = ((a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)[0] || '')
          .replace(/\\s*[•·]\\s*(1st|2nd|3rd\\+?)\\s*$/i, '')
          .replace(/\\s+/g, ' ')
          .trim();
        if (!name || name.length < 2 || name.length > 80) continue;
        if (/View|status|profile picture|Degree|connection/i.test(name) && name.length < 24) continue;
        seen.add(publicId);
        let headline = null;
        let location = null;
        const card = a.closest('li') || a.closest('div');
        if (card) {
          const lines = card.innerText.split('\\n').map(s => s.trim()).filter(Boolean);
          const candidates = lines.filter(l => l !== name && l.length > 8 && l.length < 180);
          // Location FIRST, so it can be excluded from headline candidates — otherwise a
          // card whose only long line is the location reports it as the job title.
          location = candidates.find(l =>
            !/connection/i.test(l) &&
            /Spain|Catalonia|Area|Remote|Madrid|Europe|United|France|Germany/i.test(l)
          ) || null;
          headline = candidates.find(l =>
            l !== location &&
            !/^(1st|2nd|3rd|•|Connect|Message|Follow|Pending|Mutual)/i.test(l) &&
            !/connection/i.test(l) &&
            !l.startsWith(name)
          ) || null;
          if (headline) {
            headline = headline
              .replace(/\\s*[•·]\\s*(1st|2nd|3rd\\+?)\\s*$/i, '')
              .trim();
            if (headline.startsWith(name)) headline = headline.slice(name.length).replace(/^[\\s•·]+/, '').trim();
          }
        }
        people.push({
          name,
          publicId,
          url: a.href.split('?')[0],
          headline,
          location,
        });
      }
      const noResults = /No results/i.test(document.body?.innerText || '');
      return {
        href: location.href,
        count: people.length,
        people,
        noResults,
        title: document.title,
      };
    })()`;

    const ev = await cdpCall(
      ws,
      4,
      "Runtime.evaluate",
      { expression: expr, returnByValue: true },
      sessionId,
    );
    if (ev.exceptionDetails) {
      throw new Error(
        `search DOM evaluate failed: ${ev.exceptionDetails.text || JSON.stringify(ev.exceptionDetails)}`,
      );
    }
    const val = ev.result?.value || { people: [], count: 0 };
    return {
      query,
      method: "dom-search-page",
      href: val.href,
      noResults: Boolean(val.noResults),
      count: Math.min(top, (val.people || []).length),
      people: (val.people || []).slice(0, top),
    };
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

async function cmdSearchPeople(args) {
  const query = args._[0];
  if (!query) {
    console.error('Usage: linkedin search people "<query>" [--top 10] [--network F|S|O]');
    process.exit(1);
  }
  const top = parseInt(args.flags.top, 10) || 10;
  const page = parseInt(args.flags.page, 10) || 1;
  assertUnderLimit("profile_views", Math.min(top, 5));

  // Browser/DOM path is the working search (2026-07-29). Network filter is UI-only for now.
  if (args.flags.network) {
    console.error("Note: --network is not applied on DOM search yet (LinkedIn SDUI).");
  }

  let result;
  try {
    result = await searchPeopleViaDom(query, top, page);
  } catch (e) {
    // Last-resort legacy Voyager (usually 404 / empty on current LinkedIn)
    console.error(`DOM search failed (${e.message}); trying legacy Voyager (often dead)…`);
    const keywords = encodeURIComponent(query);
    const path =
      `/search/dash/clusters?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-175` +
      `&origin=GLOBAL_SEARCH_HEADER&q=all&query=(keywords:${keywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:(resultType:List(PEOPLE)))&start=0&count=${top}`;
    const data = await voyager(path);
    const people = (data.included || [])
      .filter(
        (x) =>
          (x.$type || "").includes("EntityResultViewModel") ||
          (x.$type || "").includes("MiniProfile") ||
          (x.publicIdentifier && x.headline),
      )
      .map((x) => {
        if (x.publicIdentifier) return pickProfile(x);
        const title = x.title?.text || x.title;
        const subtitle = x.primarySubtitle?.text || x.headline;
        const nav = x.navigationUrl || x.navigationContext?.url;
        const vanity = nav?.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
        return { name: title, headline: subtitle, publicId: vanity, url: nav };
      })
      .filter((p) => p && (p.name || p.publicId || p.firstName))
      .slice(0, top);
    result = { query, method: "voyager-legacy", count: people.length, people };
  }

  bumpActivity("profile_views", 1);
  out(result);
}

async function cmdSearchCompanies(args) {
  const query = args._[0];
  if (!query) {
    console.error('Usage: linkedin search companies "<query>" [--top 10]');
    process.exit(1);
  }
  const top = parseInt(args.flags.top, 10) || 10;
  const keywords = encodeURIComponent(query);
  const path =
    `/search/dash/clusters?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-175` +
    `&origin=GLOBAL_SEARCH_HEADER&q=all&query=(keywords:${keywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:(resultType:List(COMPANIES)))&start=0&count=${top}`;

  let data;
  try {
    data = await voyager(path);
  } catch {
    data = await voyager(
      `/search/hits?count=${top}&filters=List(resultType-%3ECOMPANIES)&keywords=${keywords}&origin=SWITCH_SEARCH_VERTICAL&q=all`,
    );
  }

  const companies = (data.included || [])
    .filter(
      (x) =>
        (x.$type || "").includes("EntityResultViewModel") ||
        (x.$type || "").includes("Company") ||
        x.universalName,
    )
    .map((x) => {
      if (x.universalName) {
        return {
          name: x.name,
          universalName: x.universalName,
          urn: x.entityUrn,
          industry: x.industry,
          staffCount: x.staffCount,
        };
      }
      const title = x.title?.text || x.title;
      const nav = x.navigationUrl;
      const vanity = nav?.match(/linkedin\.com\/company\/([^/?#]+)/)?.[1];
      return {
        name: title,
        universalName: vanity,
        headline: x.primarySubtitle?.text,
        url: nav,
      };
    })
    .filter((c) => c && c.name)
    .slice(0, top);

  out({ query, count: companies.length, companies });
}

async function cmdConnections(args) {
  // Fat payload: one request, count up to 200 — fewer round-trips beats parallelism.
  const top = parseInt(args.flags.top, 10) || 100;
  const start = parseInt(args.flags.start, 10) || 0;
  assertUnderLimit("profile_views", 1);

  const data = await voyager(
    `/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-15&count=${top}&q=search&sortType=RECENTLY_ADDED&start=${start}`,
  ).catch(async () =>
    voyager(`/relationships/connections?count=${top}&sortType=RECENTLY_ADDED&start=${start}`),
  );

  bumpActivity("profile_views", 1);

  const people = (data.included || [])
    .filter((x) => (x.$type || "").includes("MiniProfile") || x.publicIdentifier)
    .map(pickProfile)
    .filter(Boolean)
    .slice(0, top);

  out({ count: people.length, start, people });
}

async function cmdConversations(args) {
  const top = parseInt(args.flags.top, 10) || 20;
  assertUnderLimit("messages_read", 1);

  const data = await voyager(
    `/messaging/conversations?keyVersion=LEGACY_INBOX&q=syncToken&count=${top}`,
  ).catch(async () => voyager(`/messaging/conversations?q=searchQuery&count=${top}`));

  bumpActivity("messages_read", 1);

  const convos = (data.included || data.elements || data.data?.elements || [])
    .filter(
      (x) => (x.$type || "").includes("Conversation") || x.entityUrn?.includes("conversation"),
    )
    .map((c) => ({
      urn: c.entityUrn || c["*elements"]?.[0],
      read: c.read,
      lastActivityAt: c.lastActivityAt ? new Date(c.lastActivityAt).toISOString() : null,
      participants: (c.participants || c["*participants"] || []).slice(0, 5),
      totalEventCount: c.totalEventCount,
    }));

  const minis = Object.fromEntries(
    (data.included || [])
      .filter((x) => x.publicIdentifier || (x.$type || "").includes("MiniProfile"))
      .map((m) => [m.entityUrn, pickProfile(m)]),
  );

  out({
    count: convos.length || (data.data?.elements || []).length,
    conversations: convos.length ? convos : data.data || data,
    profiles: Object.values(minis).filter(Boolean).slice(0, 30),
  });
}

async function cmdMessages(args) {
  const conv = args._[0];
  if (!conv) {
    console.error("Usage: linkedin messages <conversationUrn> [--top 30]");
    process.exit(1);
  }
  const top = parseInt(args.flags.top, 10) || 30;
  assertUnderLimit("messages_read", 1);

  const urn = encodeURIComponent(conv);
  const data = await voyager(
    `/messaging/conversations/${urn}/events?count=${top}&q=syncToken`,
  ).catch(async () => voyager(`/messaging/conversations/${urn}/events?count=${top}`));

  bumpActivity("messages_read", Math.min(top, 10));

  const events = (data.included || data.elements || [])
    .filter((x) => (x.$type || "").includes("Event") || x.eventContent || x.body)
    .map((e) => ({
      urn: e.entityUrn,
      at: e.createdAt ? new Date(e.createdAt).toISOString() : null,
      from: e.from || e["*from"],
      text:
        e.eventContent?.attributedBody?.text ||
        e.eventContent?.body?.text ||
        e.body?.text ||
        e.commentary?.text ||
        null,
      type: e.subtype || e.$type,
    }))
    .filter((e) => e.text)
    .slice(0, top);

  out({ conversation: conv, count: events.length, events: events.length ? events : data });
}

async function cmdMessageSend(args) {
  const conv = args._[0];
  const message = args.flags.message;
  if (!conv || !message) {
    console.error(
      'Usage: linkedin message-send <conversationUrn> --message "text" --i-mean-it\n' +
        "  Send is gated. Drafts/outreach should stay human-approved.",
    );
    process.exit(1);
  }
  if (!args.flags["i-mean-it"]) {
    console.error("Refusing to send without --i-mean-it. LinkedIn bans are not theoretical.");
    process.exit(2);
  }
  assertUnderLimit("messages_sent", 1);

  const urnEnc = encodeURIComponent(conv);
  let data;
  try {
    data = await voyager(`/messaging/conversations/${urnEnc}/events?action=create`, {
      method: "POST",
      body: {
        eventCreate: {
          value: {
            "com.linkedin.voyager.messaging.create.MessageCreate": {
              attributedBody: { text: message, attributes: [] },
              attachments: [],
            },
          },
        },
      },
    });
  } catch {
    data = await voyager(`/messaging/conversations/${urnEnc}/events`, {
      method: "POST",
      body: {
        rawBody: message,
        message: {
          body: { attributes: [], text: message },
          renderContentUnions: [],
          conversationUrn: conv,
        },
      },
    });
  }

  bumpActivity("messages_sent", 1);
  out({
    status: "sent",
    conversation: conv,
    preview: message.slice(0, 120),
    data: data?.data || data,
  });
}

async function cmdFeed(args) {
  const top = parseInt(args.flags.top, 10) || 10;
  const data = await voyager(
    `/feed/updatesV2?count=${top}&q=chronFeed&moduleKey=home-feed%3Adesktop`,
  ).catch(async () => voyager(`/feed/updates?count=${top}&q=followingFeed`));

  const posts = (data.included || [])
    .filter(
      (x) =>
        (x.$type || "").includes("Update") ||
        (x.$type || "").includes("FeedUpdate") ||
        x.commentary ||
        x.commentaryV2,
    )
    .map((p) => ({
      urn: p.entityUrn,
      text:
        p.commentary?.text?.text ||
        p.commentary?.text ||
        p.commentaryV2?.text ||
        p.summary?.text ||
        null,
      actor: p.actor?.name || p.actor?.entityUrn,
    }))
    .filter((p) => p.text)
    .slice(0, top);

  out({ count: posts.length, posts: posts.length ? posts : { note: "raw", data } });
}

async function cmdNotifications(args) {
  const top = parseInt(args.flags.top, 10) || 15;
  const data = await voyager(`/identity/notifications?count=${top}`).catch(async () =>
    voyager(`/notifications?count=${top}`),
  );
  out(data);
}

async function cmdCompany(args) {
  const id = args._[0];
  if (!id) {
    console.error("Usage: linkedin company <vanity-or-id> [--no-cache]");
    process.exit(1);
  }
  if (!args.flags.raw && !args.flags["no-cache"]) {
    const hit = cacheGet(`company:${id}`);
    if (hit) {
      out({ ...hit, cached: true });
      return;
    }
  }
  const data = await voyager(
    `/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=${encodeURIComponent(id)}`,
  ).catch(async () => voyager(`/organizations/${encodeURIComponent(id)}`));

  const company =
    (data.included || []).find((x) => x.universalName || (x.$type || "").includes("Company")) ||
    data.data ||
    data;
  const result = {
    name: company.name,
    universalName: company.universalName,
    urn: company.entityUrn,
    tagline: company.tagline || company.taglineV2,
    description: (company.description || company.descriptionV2 || "").toString().slice(0, 800),
    staffCount: company.staffCount,
    industries: company.industries || company.companyIndustries,
    website: company.companyPageUrl || company.websiteUrl,
    raw: args.flags.raw ? company : undefined,
  };
  if (!args.flags.raw && !args.flags["no-cache"]) cacheSet(`company:${id}`, result);
  out(result);
}

async function cmdPosts(args) {
  const vanity = args._[0];
  if (!vanity) {
    console.error("Usage: linkedin posts <vanity> [--top 10]");
    process.exit(1);
  }
  const top = parseInt(args.flags.top, 10) || 10;
  assertUnderLimit("profile_views", 1);
  const profileData = await voyager(
    `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`,
  ).catch(() => null);
  bumpActivity("profile_views", 1);

  const memberUrn =
    (profileData?.included || []).find(
      (x) => x.entityUrn?.includes("fsd_profile") || x.entityUrn?.includes("member"),
    )?.entityUrn || vanity;

  const data = await voyager(
    `/identity/profileUpdatesV2?count=${top}&moduleKey=member-shares%3Aphone&numComments=0&profileUrn=${encodeURIComponent(memberUrn)}&q=memberShareFeed&start=0`,
  ).catch(async () =>
    voyager(
      `/feed/updates?moduleKey=member-share&profileId=${encodeURIComponent(vanity)}&q=memberShareFeed&count=${top}`,
    ),
  );

  const posts = (data.included || [])
    .filter((x) => x.commentary || x.commentaryV2 || (x.$type || "").includes("Update"))
    .map((p) => ({
      urn: p.entityUrn,
      text: p.commentary?.text?.text || p.commentary?.text || p.commentaryV2?.text || null,
      numLikes: p.socialDetail?.totalSocialActivityCounts?.numLikes,
      numComments: p.socialDetail?.totalSocialActivityCounts?.numComments,
    }))
    .filter((p) => p.text)
    .slice(0, top);

  out({ vanity, count: posts.length, posts });
}

async function cmdActivity(args) {
  const sub = args._[0] || "show";
  if (sub === "show") {
    out(loadActivity());
    return;
  }
  if (sub === "bump") {
    const counter = args._[1];
    const by = parseInt(args.flags.by || args._[2] || "1", 10);
    if (!counter) {
      console.error("Usage: linkedin activity bump <counter> [--by N]");
      process.exit(1);
    }
    out(bumpActivity(counter, by));
    return;
  }
  console.error("Usage: linkedin activity [show|bump <counter>]");
  process.exit(1);
}

// ─── Router ───
const args = parseArgs(process.argv.slice(2));
const [cmd, sub, ...rest] = args._;
// Consent for the plaintext fallback is per-run and explicit: --store alone is NOT it.
_allowPlaintextFlag = Boolean(args.flags["allow-plaintext-store"]);

function subArgs(extra = []) {
  return { _: [...extra, ...rest], flags: args.flags };
}

try {
  switch (cmd) {
    case "session":
      if (sub === "extract-browser") await cmdSessionExtractBrowser();
      else if (sub === "extract-cdp") await cmdSessionExtractCdp({ _: rest, flags: args.flags });
      else if (sub === "store") await cmdSessionStore({ _: rest, flags: args.flags });
      else if (sub === "test") await cmdSessionTest();
      else if (sub === "status") await cmdSessionStatus();
      else if (sub === "logout" || sub === "revoke")
        await cmdSessionLogout({ _: rest, flags: args.flags });
      else
        console.error(
          "Usage: linkedin session [extract-cdp|extract-browser|store|test|status|logout]\n" +
            "  extract-cdp [--store] [--test]  pull httpOnly li_at via OpenClaw relay\n" +
            "  logout [--keep-data]            erase session + cached data (local only)",
        );
      break;
    case "me":
      await cmdMe();
      break;
    case "profile":
      await cmdProfile(subArgs(sub ? [sub] : []));
      break;
    case "search":
      if (sub === "people") await cmdSearchPeople(subArgs());
      else if (sub === "companies") await cmdSearchCompanies(subArgs());
      else console.error('Usage: linkedin search [people|companies] "<query>"');
      break;
    case "connections":
      await cmdConnections({ _: [], flags: args.flags });
      break;
    case "conversations":
      await cmdConversations({ _: [], flags: args.flags });
      break;
    case "messages":
      await cmdMessages(subArgs(sub ? [sub] : []));
      break;
    case "message-send":
      await cmdMessageSend(subArgs(sub ? [sub] : []));
      break;
    case "feed":
      await cmdFeed({ _: [], flags: args.flags });
      break;
    case "notifications":
      await cmdNotifications({ _: [], flags: args.flags });
      break;
    case "company":
      await cmdCompany(subArgs(sub ? [sub] : []));
      break;
    case "posts":
      await cmdPosts(subArgs(sub ? [sub] : []));
      break;
    case "activity":
      await cmdActivity(subArgs(sub ? [sub] : []));
      break;
    default: {
      // Unknown command must fail loudly: a typo in a caller script should not read as success.
      const unknown = cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h";
      const write = unknown ? console.error : console.log;
      if (unknown)
        write(`❌ Unknown command: ${cmd}
`);
      write(`linkedin — LinkedIn Voyager crawl via browser session

Session:
  session extract-cdp [--store]      Pull httpOnly li_at via OpenClaw relay (preferred)
  session extract-browser            Print JS fallback (often misses li_at)
  session store                      Read {"li_at":…,"jsessionid":…} as JSON on STDIN.
                                     Cookies are never accepted as flags — argv is
                                     world-readable and lands in shell history.
  session test                       Verify session (calls /voyager/api/me)
  session status                     Where the session is stored + daily counters
  session logout [--keep-data]       Erase the session from the keychain AND the file,
                                     AND delete the cached profiles and activity
                                     counters, then print LinkedIn's revoke URL.
                                     This is LOCAL ONLY: it does not sign the session
                                     out at LinkedIn — do that at the revoke URL.
                                     --keep-data keeps the cache and counters.

Identity & graph:
  me                                 Your mini-profile
  profile <vanity>                   Profile + positions
  search people "<q>" [--top N] [--network F|S|O]
  search companies "<q>" [--top N]
  connections [--top N] [--start N]
  company <vanity>
  posts <vanity> [--top N]

Messaging:
  conversations [--top N]
  messages <conversationUrn> [--top N]
  message-send <urn> --message "…" --i-mean-it

Feed:
  feed [--top N]
  notifications [--top N]

Rate guard:
  activity show
  activity bump <counter> [--by N]

Credentials: OS keychain only (secret-tool on Linux, security on macOS). The secret is
             passed over stdin, never on a command line, and the write is read back to
             confirm it landed. With no keychain, saving FAILS and nothing is written
             unless you pass --allow-plaintext-store, which writes
             ~/.openclaw/credentials/linkedin-session.json (0600, minimal fields, 24h expiry).
Activity:    ~/.openclaw/workspace/memory/linkedin-activity.json (0600)
Cache:       OFF by default. LINKEDIN_CACHE=1 enables caching other people's profile data
             at ~/.openclaw/workspace/memory/linkedin-cache.json (0600, 12h default TTL).
Relay:       must be on loopback; hostnames are resolved and checked.
             LINKEDIN_ALLOW_REMOTE_RELAY=1 to override, with a warning.
Off switch:  linkedin session logout   (then revoke at the URL it prints)
`);
      if (unknown) process.exit(2);
      break;
    }
  }
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
