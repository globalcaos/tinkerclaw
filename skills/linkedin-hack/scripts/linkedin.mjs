#!/usr/bin/env node
/**
 * linkedin.mjs — LinkedIn Voyager crawl via browser session cookies
 *
 * The tab you shared is the only place the session ever lives. API calls are
 * fetch() executed INSIDE that tab against LinkedIn's own internal API (Voyager);
 * `search people` instead navigates that tab to a LinkedIn search URL and reads the
 * rendered page. Either way `li_at` is never extracted, stored or replayed from here. Every
 * target — request, navigation, tab pick — is pinned to the exact origin
 * https://www.linkedin.com.
 *
 * Subcommands:
 *   session check               Confirm the shared tab is a signed-in LinkedIn session
 *   session status              Where things stand; never prints a secret
 *   session logout              Purge local data + anything <=1.2.0 left behind
 *   me
 *   profile <vanity-or-urn> [--raw]
 *   search people "<query>" [--top N] [--network F|S|O]
 *   search companies "<query>" [--top N]
 *   connections [--top N] [--start N]
 *   conversations [--top N]
 *   messages <conversationUrn> [--top N]
 *   message-send <conversationUrn> --message <text> --i-mean-it <conversationUrn>
 *   feed [--top N]
 *   notifications [--top N]
 *   company <vanity-or-id>
 *   posts <vanity> [--top N]
 *   activity show|bump <counter> [--by N]
 *
 * Zero external deps. Node 22+.
 */

import { execFileSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  unlinkSync,
  lstatSync,
  openSync,
  closeSync,
  renameSync,
} from "fs";
import { isIPv4 } from "net";
import { homedir, platform } from "os";
import { join, isAbsolute, sep, resolve } from "path";
import { fileURLToPath } from "url";

const CREDS_DIR = join(homedir(), ".openclaw/credentials");
const TOKEN_FILE = join(CREDS_DIR, "linkedin-session.json");
const ACTIVITY_FILE = join(homedir(), ".openclaw/workspace/memory/linkedin-activity.json");
// The ONE origin this skill will talk to, navigate to, or run script in. It is
// compared with === against a parsed URL's `origin`, so a look-alike host
// (www.linkedin.com.evil.example), a bare `linkedin.com`, a plain-http URL and a
// non-default port all fail. No flag widens it.
const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const VOYAGER = `${LINKEDIN_ORIGIN}/voyager/api`;
const RELAY_CDP = process.env.LINKEDIN_CDP_URL || "ws://127.0.0.1:18792/cdp";
const RELAY_HTTP = process.env.LINKEDIN_RELAY_HTTP || "http://127.0.0.1:18792";

// Daily ceilings. These are published, conservative limits on how much this skill
// will do in a day; they exist so an agent cannot run up an unbounded amount of
// activity on your account without you noticing. They are a brake, not a disguise.
//
// What a counter counts: RECORDS REQUESTED from LinkedIn — the `count` a command asks
// for (its --top), or 1 for a single-entity lookup. The full amount is reserved BEFORE
// the first request goes out, a fallback request reuses that reservation, and a
// failed request is not refunded. The limits in linkedin-activity.json can only
// LOWER these numbers, never raise them.
const DEFAULT_LIMITS = {
  sessions: 15, // session check
  profile_views: 40, // me, profile, company, the profile lookup inside posts
  search_results: 100, // search people / search companies, charged --top per search
  connections_listed: 500, // connections, charged --top per call
  conversations_listed: 100, // conversations, charged --top per call
  messages_read: 200, // messages, charged --top per thread read
  feed_items: 100, // feed, charged --top
  notifications_read: 100, // notifications, charged --top
  posts_read: 100, // posts, charged --top
  messages_sent: 25, // message-send, 1 per send
};

// Hard per-call maximums for --top (and the other paging flags). A value outside the
// range is REJECTED, not clamped, so a caller always sees what it actually asked for.
const TOP_MAX = {
  search: 25,
  connections: 100,
  conversations: 50,
  messages: 50,
  feed: 25,
  notifications: 50,
  posts: 25,
};
const START_MAX = 10000;
const PAGE_MAX = 40;

// Strict integer flag parser: digits only, inside [min, max]. `--top 1e9`, `--top -5`,
// `--top 2.5`, `--top abc`, a bare `--top` and anything above max all fail loudly.
function parseCount(flags, name, def, max, min = 1) {
  const raw = flags[name];
  if (raw === undefined) return def;
  const str = String(raw);
  if (raw === true || !/^[0-9]{1,6}$/.test(str)) {
    throw new Error(
      `--${name} must be an integer between ${min} and ${max} (got ${raw === true ? "no value" : str}).`,
    );
  }
  const n = Number(str);
  if (n < min || n > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max} (got ${n}).`);
  }
  return n;
}

// Courtesy rate limiting: a fixed minimum interval between Voyager calls, so this
// skill cannot hammer LinkedIn. It is deliberately DETERMINISTIC and announced —
// there is no jitter, no randomised pause and no attempt to look like a person.
// LINKEDIN_PACE_MS only ever slows it down (floor 500ms, default 1500ms).
const PACE_BASE = Math.max(500, parseInt(process.env.LINKEDIN_PACE_MS || "1500", 10) || 1500);
let _lastVoyagerAt = 0;

// ─── No credential store ───
// This skill does not extract, store or replay your LinkedIn cookies. Every request
// runs inside the tab you shared, so `li_at` never leaves the browser and there is
// nothing at rest for a backup tool, a sync client or another process to pick up.
//
// Consequences worth stating plainly:
//   * there is no plaintext file store, and no flag that creates one;
//   * there is no external replay path, so a stolen jar would have nothing to drive.
//
// The one keychain helper below is DELETE-ONLY. It exists so `session logout` can
// clean up an entry left behind by version <= 1.2.0, which did store a session. There
// is no keychain lookup anywhere in this file: no code path asks the keychain for a
// value, so a legacy secret is never copied into this process. Nothing in this
// version writes a credential anywhere.
const KEYRING_SERVICE = "openclaw-linkedin-hack";
const KEYRING_ACCOUNT = "linkedin-session";
const KEYCHAIN_BIN = platform() === "darwin" ? "security" : "secret-tool";

// Stamped into every file this skill creates, so the delete guard below can prove a
// file is ours before removing it.
const MARKER = "openclaw-linkedin-hack";

// Write a file that only this user can read. The bytes go to a sibling temp file
// (created 0600) that is then renamed over the target, so a reader never sees a
// half-written file and the target always ends up 0600.
function writePrivate(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, file);
}

// Runs one fixed binary with a fixed argument list and no shell. Its output is
// discarded (stdio ignored) — delete prints no secret, and none is captured anyway.
// Returns false rather than throwing when the keychain or the entry is simply absent.
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
//
// One exception to the marker rule: the legacy session file at the fixed path
// TOKEN_FILE. That file holds a password-equivalent cookie, so its contents are
// never opened — not even to look for the marker. It is deleted on the structural
// checks alone (absolute, inside $HOME, regular file, not a symlink), which is safe
// because the path is a constant this skill owns, not something a caller supplies.
const ACTIVITY_LOCK = `${ACTIVITY_FILE}.lock`;
const OWNED_FILES = new Set([ACTIVITY_FILE, ACTIVITY_LOCK]); // CACHE_FILE added at its definition

function isOwnedFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  if (parsed && parsed._openclaw_skill === MARKER) return true;
  // Files written by <=1.1.0 predate the marker. Accept them only at this skill's own
  // fixed paths, so the off switch keeps working for existing installs.
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
  // TOKEN_FILE is the fixed legacy credential path: deleted without reading it.
  if (file !== TOKEN_FILE && !isOwnedFile(file)) {
    throw new Error(
      `refusing to delete ${file}: it carries no ${MARKER} marker, so this skill did not create it`,
    );
  }
  unlinkSync(file);
  return true;
}

// The off switch for anything an older version left on this machine.
function clearLegacyCreds() {
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

// True when the legacy session FILE written by version <= 1.2.0 is still on disk — an
// existsSync on a fixed path, the file is not opened. The legacy KEYCHAIN entry is
// deliberately not checked: the platform CLIs (`secret-tool lookup`,
// `security find-generic-password -w`) answer "does it exist" by returning the secret
// itself, so status reports the keychain as not checked and `session logout` deletes
// the fixed entry unconditionally (a no-op when it is absent).
function legacyFilePresent() {
  return existsSync(TOKEN_FILE);
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
      ...Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((k) => [k, 0])),
    },
    thisWeek: { weekStart: weekStartISO(), messages_sent: 0 },
    warnings: [],
    securityChecks: [],
    limits: { ...DEFAULT_LIMITS },
  };
  if (!existsSync(ACTIVITY_FILE)) return blank;
  try {
    const a = JSON.parse(readFileSync(ACTIVITY_FILE, "utf8"));
    // Same day: keep today's counts, but make sure every current counter exists and is a
    // non-negative number — a file from an older version lacking a counter must not
    // leave that counter un-incrementable (and therefore unlimited).
    a.today = a.today?.date === todayISO() ? { ...blank.today, ...a.today } : { ...blank.today };
    a.thisWeek =
      a.thisWeek?.weekStart === weekStartISO()
        ? { ...blank.thisWeek, ...a.thisWeek }
        : { ...blank.thisWeek };
    for (const k of Object.keys(DEFAULT_LIMITS)) {
      const v = a.today[k];
      a.today[k] = Number.isFinite(v) && v > 0 ? v : 0;
    }
    // Limits in the file may only LOWER a published ceiling, never raise it.
    const fileLimits = a.limits && typeof a.limits === "object" ? a.limits : {};
    a.limits = Object.fromEntries(
      Object.entries(DEFAULT_LIMITS).map(([k, def]) => {
        const v = fileLimits[k];
        return [k, Number.isSafeInteger(v) && v >= 0 ? Math.min(v, def) : def];
      }),
    );
    return a;
  } catch {
    return blank;
  }
}

function saveActivity(a) {
  mkdirSync(join(homedir(), ".openclaw/workspace/memory"), { recursive: true });
  writePrivate(ACTIVITY_FILE, JSON.stringify({ ...a, _openclaw_skill: MARKER }, null, 2));
}

// Serialise every read-modify-write of the counters across processes. The lock is an
// exclusive-create (O_EXCL) file next to the counters; a lock older than
// ACTIVITY_LOCK_STALE_MS is treated as left behind by a crashed run and removed
// through the same guarded delete helper. Waits up to ACTIVITY_LOCK_WAIT_MS, then
// refuses the call rather than booking without the lock.
const ACTIVITY_LOCK_WAIT_MS = 5000;
const ACTIVITY_LOCK_STALE_MS = 30000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withActivityLock(fn) {
  mkdirSync(join(homedir(), ".openclaw/workspace/memory"), { recursive: true });
  const deadline = Date.now() + ACTIVITY_LOCK_WAIT_MS;
  for (;;) {
    let fd;
    try {
      fd = openSync(ACTIVITY_LOCK, "wx", 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - lstatSync(ACTIVITY_LOCK).mtimeMs > ACTIVITY_LOCK_STALE_MS) {
          safeUnlink(ACTIVITY_LOCK);
          continue;
        }
      } catch {}
      if (Date.now() > deadline) {
        throw new Error(
          `Rate guard: counters are locked by another run (${ACTIVITY_LOCK}); try again`,
        );
      }
      sleepSync(25);
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify({ _openclaw_skill: MARKER, pid: process.pid }));
      closeSync(fd);
      return fn();
    } finally {
      try {
        safeUnlink(ACTIVITY_LOCK);
      } catch {}
    }
  }
}

function bumpActivity(counter, by = 1) {
  return withActivityLock(() => {
    const a = loadActivity();
    a.lastSession = new Date().toISOString();
    if (a.today[counter] !== undefined) a.today[counter] += by;
    if (a.thisWeek[counter] !== undefined) a.thisWeek[counter] += by;
    saveActivity(a);
    return a;
  });
}

// Reserve the FULL requested amount on one or more counters before any request is
// made. All counters are checked first and only then booked, in one read-modify-write
// held under the cross-process counter lock and written by atomic rename, so two runs
// at once cannot both pass the check and overshoot a ceiling, and a refused
// reservation books nothing. The reservation is not refunded if the request then
// fails, and a fallback request runs under the same reservation.
function reserve(amounts) {
  withActivityLock(() => reserveLocked(amounts));
}

function reserveLocked(amounts) {
  const a = loadActivity();
  for (const [counter, by] of Object.entries(amounts)) {
    const limit = a.limits[counter];
    if (limit == null) throw new Error(`Rate guard: unknown counter ${counter}`);
    const cur = a.today[counter] ?? 0;
    if (cur + by > limit) {
      throw new Error(
        `Rate guard: daily ${counter} would hit ${cur + by}/${limit}. ` +
          `Slow down. linkedin activity show`,
      );
    }
  }
  for (const [counter, by] of Object.entries(amounts)) {
    a.today[counter] = (a.today[counter] ?? 0) + by;
    if (a.thisWeek[counter] !== undefined) a.thisWeek[counter] += by;
  }
  a.lastSession = new Date().toISOString();
  saveActivity(a);
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

// Transport: in-tab only.
// Every Voyager call is a fetch() executed inside the linkedin.com tab you shared, so
// the cookies stay in the browser and the request is same-origin by construction.
// The external cookie-replay transport older versions shipped is GONE: it required a
// stored password-equivalent cookie, LinkedIn answered it with a 302 in practice, and
// it was the one path that could have carried your session to another host. There is
// no LINKEDIN_TRANSPORT switch and no automatic fallback to fail over to.

// Resolves a request target and CHECKS it, so a caller cannot smuggle an absolute URL
// for another host into a request that runs with your LinkedIn session. Returns the
// same-origin RELATIVE path the in-tab fetch will use — an absolute cross-origin URL
// is never handed to fetch().
function buildUrl(path, query) {
  const raw = String(path ?? "");
  let url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    // An absolute URL was passed: allowed only on the exact LinkedIn origin.
    url = assertLinkedInUrl(raw);
  } else {
    url = `${VOYAGER}${raw.startsWith("/") ? raw : `/${raw}`}`;
  }
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    url += (url.includes("?") ? "&" : "?") + qs.toString();
  }
  // Re-check once the query is attached, and keep the call inside the Voyager API.
  const checked = new URL(assertLinkedInUrl(url));
  if (!checked.pathname.startsWith("/voyager/api/")) {
    throw new Error(`refusing a request target outside /voyager/api/: ${checked.pathname}`);
  }
  return { url: checked.toString(), rel: `${checked.pathname}${checked.search}` };
}

// ─── Voyager via in-tab fetch (preferred) ───
async function voyagerBrowser(path, { method = "GET", body = null, query = null } = {}) {
  // buildUrl already refused anything that is not exactly on the LinkedIn origin and
  // inside /voyager/api/, and it hands back the relative form.
  const { rel } = buildUrl(path, query);

  await pace();
  const targetId = await findLinkedInTargetId();
  const ws = await openCdp();
  try {
    const attached = await cdpCall(ws, 1, "Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;

    // The relay's target list can be stale, so the origin is re-checked from INSIDE the
    // tab immediately before any script runs there. This is the check that stops a tab
    // which has navigated away from having your Voyager headers built inside it.
    const loc = await cdpCall(
      ws,
      2,
      "Runtime.evaluate",
      { expression: 'location.origin + "|" + location.pathname', returnByValue: true },
      sessionId,
    );
    const [tabOrigin, tabPath] = String(loc.result?.value ?? "|").split("|");
    if (tabOrigin !== LINKEDIN_ORIGIN) {
      throw new Error(
        `Shared tab is on ${tabOrigin || "?"}, not ${LINKEDIN_ORIGIN}. Refusing to run in it.`,
      );
    }
    if (/^\/(login|uas\/login|checkpoint)/i.test(tabPath || "")) {
      throw new Error(
        `LinkedIn tab is on login/checkpoint (${tabPath}). Sign in, open the feed, re-share.`,
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
      const init = { method: ${methodJs}, credentials: 'same-origin', headers };
      const bodyStr = ${bodyJs};
      if (bodyStr != null) {
        headers['content-type'] = 'application/json; charset=UTF-8';
        init.body = bodyStr;
      }
      // Last line of defence, inside the page: resolve the target and refuse anything
      // that is not this exact origin, so nothing built here can carry the csrf-token
      // above to another host.
      const target = new URL(${relJs}, location.origin);
      if (target.origin !== location.origin) return { __err: 'cross_origin_target', href: location.href };
      const r = await fetch(target.pathname + target.search, init);
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

// Single entry point. In-tab only: there is no second transport, so there is nothing
// to silently fall back to when the tab is missing — the call fails and says why.
async function voyager(path, opts = {}) {
  return voyagerBrowser(path, opts);
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
// RELAY_CDP / RELAY_HTTP are overridable, and they carry the most sensitive channel
// this skill has: full control of the browser tab that is signed in to LinkedIn. So
// both MUST name a LITERAL loopback IP address (127.0.0.0/8 or [::1]). Hostnames —
// `localhost` included — are refused rather than resolved: a name can resolve to
// loopback when checked and to another address when the socket opens (DNS
// rebinding), while a literal IP is connected to exactly as written. There is NO
// override: the old LINKEDIN_ALLOW_REMOTE_RELAY escape hatch has been removed.
function isLoopbackAddr(a) {
  const s = String(a);
  if (isIPv4(s)) return s.split(".")[0] === "127";
  const v6 = s.toLowerCase();
  if (v6 === "::1") return true;
  const mapped = v6.match(/^::ffff:(.+)$/);
  if (!mapped) return false;
  if (isIPv4(mapped[1])) return mapped[1].split(".")[0] === "127";
  // WHATWG URL normalises [::ffff:127.0.0.1] to [::ffff:7f00:1].
  return /^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(mapped[1]);
}

function assertRelayIsLocal() {
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
    if (isLoopbackAddr(host)) continue;
    throw new Error(
      `${label} points off loopback (${raw}). That channel carries full control of the\n` +
        "browser tab holding your LinkedIn session, so it must be a literal loopback IP\n" +
        "(e.g. 127.0.0.1) — hostnames, localhost included, are not resolved. Run the\n" +
        "OpenClaw relay on this machine; there is no flag that permits a remote one.",
    );
  }
}

// THE origin check. Everything with a URL goes through here — Voyager targets, tab
// navigation, and the relay's own target list. Exact-origin, so `https://linkedin.com`,
// `https://www.linkedin.com.evil.example`, `http://www.linkedin.com` and
// `https://www.linkedin.com:8443` are all refused.
function assertLinkedInUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`refusing an invalid URL: ${url}`);
  }
  if (u.origin !== LINKEDIN_ORIGIN) {
    throw new Error(`refusing a target outside ${LINKEDIN_ORIGIN} (asked for ${url})`);
  }
  return u.toString();
}

function isLinkedInUrl(url) {
  try {
    return new URL(url).origin === LINKEDIN_ORIGIN;
  } catch {
    return false;
  }
}

async function openCdp() {
  assertRelayIsLocal();
  const ws = new WebSocket(RELAY_CDP);
  await new Promise((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", (e) => rej(e.error || e), { once: true });
  });
  return ws;
}

async function relayTargets() {
  assertRelayIsLocal();
  // No redirects: a 3xx from the relay must not move the request off loopback.
  const r = await fetch(`${RELAY_HTTP}/json/list`, { redirect: "error" });
  if (!r.ok) throw new Error(`relay /json/list ${r.status}`);
  return (await r.json()) || [];
}

// Picks the tab to run in — and LINKEDIN_TARGET_ID goes through exactly the same check
// as the automatic pick. It used to be trusted blind, which meant an id naming any
// other tab got script execution and that page's cookies. Now the id must appear in
// the relay's own list AND that target must be on the exact LinkedIn origin. The
// automatic pick is exact-origin too: a substring match on 'linkedin.com' would have
// accepted https://www.linkedin.com.evil.example/feed.
async function findLinkedInTargetId() {
  const list = await relayTargets();
  const wanted = process.env.LINKEDIN_TARGET_ID;
  if (wanted) {
    const t = list.find((x) => x && x.id === wanted);
    if (!t) {
      throw new Error(`LINKEDIN_TARGET_ID ${wanted} is not a tab this relay is sharing.`);
    }
    if (!isLinkedInUrl(t.url)) {
      throw new Error(
        `LINKEDIN_TARGET_ID ${wanted} points at ${t.url || "?"}, not ${LINKEDIN_ORIGIN}. Refusing.`,
      );
    }
    return t.id;
  }
  const onLinkedIn = list.filter((t) => t && isLinkedInUrl(t.url));
  const hit = onLinkedIn.find(
    (t) => !/^\/(login|uas\/login|checkpoint)/i.test(new URL(t.url).pathname),
  );
  if (hit) return hit.id;
  if (onLinkedIn.length) {
    throw new Error(
      `LinkedIn tab is on a login wall (${onLinkedIn[0].url}). Sign in, open the feed, re-share the tab.`,
    );
  }
  throw new Error(
    `No ${LINKEDIN_ORIGIN} tab in the relay. Share a Feed tab via the OpenClaw extension.`,
  );
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

// Confirms the shared tab really is a signed-in LinkedIn session — WITHOUT extracting
// anything. It just runs /me inside the tab and reports who you came back as.
async function cmdSessionCheck() {
  reserve({ sessions: 1 });
  const data = await voyager("/me");
  const mini =
    data?.included?.find((x) => (x.$type || "").includes("MiniProfile")) ||
    data?.included?.find((x) => x.publicIdentifier) ||
    data?.data ||
    data;
  const profile = pickProfile(typeof mini === "object" ? mini : {}) || mini;
  out({ status: "ok", transport: "in-tab (browser)", origin: LINKEDIN_ORIGIN, me: profile });
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
  const removed = clearLegacyCreds();
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
    cleared: removed.length
      ? removed
      : ["nothing was stored — this version never stores a session"],
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
  const a = loadActivity();
  const legacyFile = legacyFilePresent();
  out({
    transport: "in-tab only — your cookies never leave the browser",
    origin: LINKEDIN_ORIGIN,
    relay: { cdp: RELAY_CDP, http: RELAY_HTTP, must_be_loopback: true },
    stored_credentials: "none — this version never writes one",
    legacy_session_file_found: legacyFile,
    legacy_keychain_entry:
      "not checked — looking it up would read the secret; `linkedin session logout` deletes it if present",
    legacy_note: legacyFile
      ? "A session file stored by version <= 1.2.0 is still on this machine. Remove it with: linkedin session logout"
      : "If you ever ran version <= 1.2.0, run `linkedin session logout` once to delete any keychain entry it left.",
    activity: a.today,
    limits: a.limits,
  });
}

async function cmdMe() {
  reserve({ profile_views: 1 });
  const data = await voyager("/me");
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
  reserve({ profile_views: 1 });

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
    // Verify from INSIDE the tab that it is on the exact LinkedIn origin — relay tab
    // metadata can be stale, and this script is about to navigate the tab and read the
    // rendered page. A substring test on 'linkedin.com' would have accepted
    // https://www.linkedin.com.evil.example/, so the check is origin equality.
    const loc = await cdpCall(
      ws,
      9,
      "Runtime.evaluate",
      { expression: "location.origin", returnByValue: true },
      sessionId,
    );
    const tabOrigin = loc.result?.value || "";
    if (tabOrigin !== LINKEDIN_ORIGIN) {
      throw new Error(
        `Shared tab is on ${tabOrigin || "?"}, not ${LINKEDIN_ORIGIN} (relay metadata was stale). ` +
          `Navigate that tab back to ${LINKEDIN_ORIGIN}/feed/ or share a LinkedIn tab, then retry.`,
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
  const top = parseCount(args.flags, "top", 10, TOP_MAX.search);
  const page = parseCount(args.flags, "page", 1, PAGE_MAX);
  reserve({ search_results: top });

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

  out(result);
}

async function cmdSearchCompanies(args) {
  const query = args._[0];
  if (!query) {
    console.error('Usage: linkedin search companies "<query>" [--top 10]');
    process.exit(1);
  }
  const top = parseCount(args.flags, "top", 10, TOP_MAX.search);
  reserve({ search_results: top });
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
  // Fat payload: one request, count up to 100 — fewer round-trips beats parallelism.
  const top = parseCount(args.flags, "top", 100, TOP_MAX.connections);
  const start = parseCount(args.flags, "start", 0, START_MAX, 0);
  reserve({ connections_listed: top });

  const data = await voyager(
    `/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-15&count=${top}&q=search&sortType=RECENTLY_ADDED&start=${start}`,
  ).catch(async () =>
    voyager(`/relationships/connections?count=${top}&sortType=RECENTLY_ADDED&start=${start}`),
  );

  const people = (data.included || [])
    .filter((x) => (x.$type || "").includes("MiniProfile") || x.publicIdentifier)
    .map(pickProfile)
    .filter(Boolean)
    .slice(0, top);

  out({ count: people.length, start, people });
}

async function cmdConversations(args) {
  const top = parseCount(args.flags, "top", 20, TOP_MAX.conversations);
  reserve({ conversations_listed: top });

  const data = await voyager(
    `/messaging/conversations?keyVersion=LEGACY_INBOX&q=syncToken&count=${top}`,
  ).catch(async () => voyager(`/messaging/conversations?q=searchQuery&count=${top}`));

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
  const top = parseCount(args.flags, "top", 30, TOP_MAX.messages);
  reserve({ messages_read: top });

  const urn = encodeURIComponent(conv);
  const data = await voyager(
    `/messaging/conversations/${urn}/events?count=${top}&q=syncToken`,
  ).catch(async () => voyager(`/messaging/conversations/${urn}/events?count=${top}`));

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
      'Usage: linkedin message-send <conversationUrn> --message "text" --i-mean-it <conversationUrn>\n' +
        "  Sending is the only write this skill can perform, and consent is PER ACTION:\n" +
        "  --i-mean-it must repeat the exact conversation URN you are writing to.",
    );
    process.exit(1);
  }
  // Per-action consent. A bare --i-mean-it is NOT accepted: the flag has to name the
  // exact conversation being written to, so one approved send cannot be carried over
  // onto a different recipient by reusing the same command with a new URN.
  // Without it this is a DRAFT: the message is printed and nothing is sent.
  const consent = args.flags["i-mean-it"];
  if (consent !== conv) {
    out({
      status: "draft-only",
      sent: false,
      would_send_to: conv,
      message,
      why:
        consent === undefined || consent === true
          ? "No per-action consent: --i-mean-it must carry the exact conversation URN."
          : `Consent names a different conversation (${consent}) than the target (${conv}).`,
      to_actually_send: `linkedin message-send ${conv} --message "…" --i-mean-it ${conv}`,
    });
    process.exit(2);
  }
  reserve({ messages_sent: 1 });

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

  out({
    status: "sent",
    conversation: conv,
    preview: message.slice(0, 120),
    data: data?.data || data,
  });
}

async function cmdFeed(args) {
  const top = parseCount(args.flags, "top", 10, TOP_MAX.feed);
  reserve({ feed_items: top });
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
  const top = parseCount(args.flags, "top", 15, TOP_MAX.notifications);
  reserve({ notifications_read: top });
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
  reserve({ profile_views: 1 });
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
  const top = parseCount(args.flags, "top", 10, TOP_MAX.posts);
  reserve({ profile_views: 1, posts_read: top });
  const profileData = await voyager(
    `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`,
  ).catch(() => null);

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
    const rawBy = String(args.flags.by ?? args._[2] ?? "1");
    const by = /^[0-9]{1,6}$/.test(rawBy) ? Number(rawBy) : NaN;
    if (!counter) {
      console.error("Usage: linkedin activity bump <counter> [--by N]");
      process.exit(1);
    }
    // Counters only ever go UP. A negative bump would wind the daily rate guard
    // backwards, which is the single thing the guard exists to prevent.
    if (!Number.isFinite(by) || by < 1) {
      console.error(
        "Usage: linkedin activity bump <counter> [--by N] — N must be a positive integer.",
      );
      process.exit(1);
    }
    out(bumpActivity(counter, by));
    return;
  }
  console.error("Usage: linkedin activity [show|bump <counter>]");
  process.exit(1);
}

// ─── Router ───
// The checks above are exported and the CLI is guarded, so a test can import
// assertLinkedInUrl / buildUrl and exercise them without running a command.
export { LINKEDIN_ORIGIN, assertLinkedInUrl, isLinkedInUrl, buildUrl, isLoopbackAddr };

const _isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (_isMain) {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...rest] = args._;

  function subArgs(extra = []) {
    return { _: [...extra, ...rest], flags: args.flags };
  }

  try {
    switch (cmd) {
      case "session":
        // `test` kept as an alias for `check` so existing scripts keep working.
        if (sub === "check" || sub === "test") await cmdSessionCheck();
        else if (sub === "status") await cmdSessionStatus();
        else if (sub === "logout" || sub === "revoke")
          await cmdSessionLogout({ _: rest, flags: args.flags });
        else {
          // A removed subcommand must fail loudly rather than exit 0 doing nothing: a
          // caller still running `session store` needs to SEE that it no longer exists.
          console.error(
            "Usage: linkedin session [check|status|logout]\n" +
              "  check                 confirm the shared tab is a signed-in LinkedIn session\n" +
              "  status                posture + daily counters (never prints a secret)\n" +
              "  logout [--keep-data]  purge local data, and anything <=1.2.0 stored\n" +
              "\n" +
              "REMOVED in 1.2.1: extract-cdp, extract-browser, store. This skill no longer\n" +
              "extracts, stores or replays your LinkedIn cookies — every call runs inside the\n" +
              "tab you shared, so there is nothing to save.",
          );
          process.exit(2);
        }
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
  session check                      Confirm the shared tab is a signed-in LinkedIn
                                     session (runs /voyager/api/me inside the tab).
  session status                     Posture + daily counters. Prints no secret.
  session logout [--keep-data]       Delete the cached profiles and activity counters,
                                     and purge any session a version <=1.2.0 stored,
                                     then print LinkedIn's revoke URL. This is LOCAL
                                     ONLY: it does not sign the session out at
                                     LinkedIn — do that at the revoke URL.
                                     --keep-data keeps the cache and counters.

Identity & graph:
  me                                 Your mini-profile
  profile <vanity>                   Profile + positions
  search people "<q>" [--top N<=25] [--page N<=40] [--network F|S|O]
  search companies "<q>" [--top N<=25]
  connections [--top N<=100] [--start N<=10000]
  company <vanity>
  posts <vanity> [--top N<=25]

Messaging:
  conversations [--top N<=50]
  messages <conversationUrn> [--top N<=50]
  message-send <urn> --message "…" --i-mean-it <urn>
                                     The only write. Consent is per action: --i-mean-it
                                     must repeat the exact URN. Without it you get the
                                     draft on stdout and nothing is sent.

Feed:
  feed [--top N<=25]
  notifications [--top N<=50]

Rate guard:
  activity show
  activity bump <counter> [--by N]
  Daily ceilings count RECORDS REQUESTED (--top, or 1 per lookup), reserved in full
  before the request. An out-of-range --top is rejected, not clamped. Limits in the
  activity file can only lower a ceiling.

Credentials: NONE stored. Every call is a fetch() run inside the linkedin.com tab you
             shared, so your cookies never leave the browser. There is no external
             replay, no plaintext file store, and no flag that creates either.
Origin:      every request, navigation and tab pick is pinned to exactly
             https://www.linkedin.com. A look-alike host or a non-https URL is refused.
Activity:    ~/.openclaw/workspace/memory/linkedin-activity.json (0600)
Cache:       OFF by default. LINKEDIN_CACHE=1 enables caching other people's profile data
             at ~/.openclaw/workspace/memory/linkedin-cache.json (0600, 12h default TTL).
Relay:       must be a literal loopback IP (127.0.0.1 or [::1]); hostnames, localhost
             included, are refused rather than resolved. There is no override.
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
}
