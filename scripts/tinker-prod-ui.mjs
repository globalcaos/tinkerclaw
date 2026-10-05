#!/usr/bin/env node
/**
 * Loopback production Tinker UI — no Vite, no HMR reset.
 *
 * Serves tinker-ui/dist, injects __TINKER_CONFIG, proxies /tinker/api and
 * WebSocket to the gateway with Bearer, and hosts the Vite-only local APIs
 * the built client still calls at /api/* (ui-state, kit-content, save-file).
 * Bind is loopback-only. Default: http://127.0.0.1:18793/tinker/
 */
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { checkoutDrift } from "./lib/checkout-drift.mjs";

const PORT = Number(process.env.TINKER_PROD_PORT || 18793);
const GW_HOST = process.env.TINKER_GATEWAY_HOST || "127.0.0.1";
const GW_PORT = Number(process.env.TINKER_GATEWAY_PORT || 18789);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "tinker-ui", "dist");
const HOME = os.homedir();
const LEGACY_STATE_FILE = path.join(HOME, ".openclaw", "data", "tinker-ui-state.json");
const TINKERCLAW_ROOT = path.resolve(HOME, "src/tinkerclaw");
const WORKSPACE_KITS = path.join(HOME, ".openclaw/workspace/kits");
const MAX_UI_STATE_BODY = 256 * 1024;
const MAX_TABS = 200;
const NODE_BIN_DIR = path.dirname(process.execPath);
const MAX_REBUILD_LOG = 80;
const rebuildJobs = {
  fe: {
    child: null,
    status: "idle",
    startedAt: 0,
    finishedAt: 0,
    lastOutputAt: 0,
    error: "",
    log: [],
    phase: "",
  },
  be: {
    child: null,
    status: "idle",
    startedAt: 0,
    finishedAt: 0,
    lastOutputAt: 0,
    error: "",
    log: [],
    phase: "",
  },
};

function readGatewayToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, ".openclaw", "openclaw.json"), "utf8"));
    return cfg?.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  } catch {
    return process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  }
}

const TOKEN = readGatewayToken();
if (!TOKEN) {
  console.error("[tinker-prod-ui] no gateway token in openclaw.json — refusing to start");
  process.exit(1);
}
if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(
    `[tinker-prod-ui] missing ${DIST}/index.html — run: cd tinker-ui && npx vite build`,
  );
  process.exit(1);
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickTyped(src, kind) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === kind) out[k] = v;
  }
  return out;
}

function pickTabs(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return [];
  return v.filter(isPlainObject).slice(0, MAX_TABS);
}

// FORK 2026-09-21 — closed-tab tombstones (tab id → closedAt ms). The one section that is
// UNIONED instead of replaced: tab ids are never reused, so a tombstone is always right, and
// union is what stops a stale writer (second window, old bundle, lost debounce) from
// resurrecting a closed tab. Mirrors unionClosedTabs in tinker-ui/src/panels/ui-state.ts.
const MAX_CLOSED_TABS = 500;
function unionClosedTabs(...maps) {
  const all = Object.create(null);
  for (const map of maps) {
    if (!isPlainObject(map)) continue;
    for (const [id, at] of Object.entries(map)) {
      if (typeof at === "number" && Number.isFinite(at)) all[id] = Math.max(all[id] ?? 0, at);
    }
  }
  const newest = Object.entries(all)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CLOSED_TABS);
  return Object.fromEntries(newest);
}
function withoutClosedTabs(tabs, closed) {
  return tabs.filter(
    (t) => typeof t.id !== "string" || t.id === "tab-main" || typeof closed[t.id] !== "number",
  );
}

// FORK 2026-09-21 — tab-resurrection tracing (the architect: closed tabs came back after a rebuild).
// One journal line per POST that changes the durable tab list: which tabs it added or removed,
// which the tombstones dropped, and which bundle sent it (X-Tinker-Build). A write-back from a
// stale window or an old bundle shows up here as an "added" tab from an older build.
// Read with: journalctl --user -u tinker-prod-ui | grep ui-state
function logTabChange(req, before, sent, written) {
  const label = (t) => `${t.id}(${String(t.title ?? "").slice(0, 24)})`;
  const ids = (list) => new Set((list ?? []).map((t) => t.id));
  const had = ids(before);
  const now = ids(written);
  const added = (written ?? []).filter((t) => !had.has(t.id)).map(label);
  const removed = (before ?? []).filter((t) => !now.has(t.id)).map(label);
  const dropped = (sent ?? []).filter((t) => !now.has(t.id)).map(label);
  if (added.length === 0 && removed.length === 0 && dropped.length === 0) return;
  const build = req.headers["x-tinker-build"] ?? "pre-trace-bundle";
  console.log(
    `[ui-state] tabs ${had.size}→${now.size} build=${build}` +
      (added.length ? ` +[${added.join(", ")}]` : "") +
      (removed.length ? ` -[${removed.join(", ")}]` : "") +
      (dropped.length ? ` tombstone-dropped=[${dropped.join(", ")}]` : ""),
  );
}

function sanitize(src) {
  const tabs = pickTabs(src.tabs);
  return {
    ...(isPlainObject(src.closedTabs) ? { closedTabs: unionClosedTabs(src.closedTabs) } : {}),
    collapsed: pickTyped(isPlainObject(src.collapsed) ? src.collapsed : {}, "boolean"),
    flags: pickTyped(isPlainObject(src.flags) ? src.flags : {}, "boolean"),
    choices: pickTyped(isPlainObject(src.choices) ? src.choices : {}, "string"),
    ...(tabs === undefined ? {} : { tabs }),
  };
}

function emptyState() {
  return sanitize({});
}

function seatIdFromReq(req) {
  const raw = req.headers["x-tinker-seat"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || typeof v !== "string") return null;
  const id = v.trim();
  if (!id || id.length > 80) return null;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  return id;
}

function stateFileForSeat(seatId) {
  return path.join(HOME, ".openclaw", "data", "seats", seatId, "tinker-ui-state.json");
}

function readState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err?.code === "ENOENT") return { status: "absent", state: emptyState() };
    return { status: "unreadable", state: emptyState(), error: err };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { status: "malformed", state: emptyState() };
    return { status: "ok", state: sanitize(parsed) };
  } catch {
    return { status: "malformed", state: emptyState() };
  }
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (chunk) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        reject(Object.assign(new Error("too large"), { code: "OVERFLOW" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) return;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

// FORK 2026-09-10 (the architect: "upon restart, in the production tinker ui, the tabs open before
// turning off don't appear open"). A request with NO seat lands on the OWNER DESK — the
// single-operator file this laptop has always used (LEGACY_STATE_FILE) — unless the process
// runs in hive mode (TINKER_REQUIRE_SEAT=1), where the plan's "missing seat → 400, never the
// shared file" rule applies. The 12:22 hivemind draft made that 400 unconditional on a machine
// where no door assigns a seat yet: every hydrate failed, the client stopped mirroring, and
// the 17:52 reboot came back with one tab while nine sat in the file (mtime 09:33).
const REQUIRE_SEAT = process.env.TINKER_REQUIRE_SEAT === "1";

function stateFileFor(seatId) {
  return seatId ? stateFileForSeat(seatId) : LEGACY_STATE_FILE;
}

async function handleUiState(req, res) {
  const seatId = seatIdFromReq(req);
  if (!seatId && REQUIRE_SEAT) {
    json(res, 400, { error: "X-Tinker-Seat required" });
    return true;
  }
  const STATE_FILE = stateFileFor(seatId);
  if (req.method === "GET") {
    const { status, state } = readState(STATE_FILE);
    json(res, 200, status === "unreadable" ? { ...state, degraded: true } : state);
    return true;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return true;
  }
  let buf;
  try {
    buf = await readRequestBody(req, MAX_UI_STATE_BODY);
  } catch (err) {
    if (err?.code === "OVERFLOW") {
      json(res, 413, { error: "Snapshot too large" });
      return true;
    }
    json(res, 400, { error: "Invalid request" });
    return true;
  }
  let parsed;
  try {
    parsed = JSON.parse(buf.toString("utf-8"));
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return true;
  }
  if (!isPlainObject(parsed)) {
    json(res, 400, { error: "Snapshot must be an object" });
    return true;
  }
  for (const key of ["collapsed", "flags", "choices"]) {
    if (parsed[key] !== undefined && !isPlainObject(parsed[key])) {
      json(res, 400, { error: `${key} must be an object` });
      return true;
    }
  }
  if (parsed.tabs !== undefined && !Array.isArray(parsed.tabs)) {
    json(res, 400, { error: "tabs must be an array" });
    return true;
  }
  const current = readState(STATE_FILE);
  if (current.status === "unreadable") {
    json(res, 500, {
      error: `Refusing to overwrite unreadable store: ${current.error?.message ?? "read failed"}`,
    });
    return true;
  }
  const snapshot = sanitize(parsed);
  if (snapshot.tabs === undefined && current.state.tabs !== undefined) {
    snapshot.tabs = current.state.tabs;
  }
  const closedTabs = unionClosedTabs(current.state.closedTabs, snapshot.closedTabs);
  const sentTabs = snapshot.tabs;
  if (Object.keys(closedTabs).length > 0) {
    snapshot.closedTabs = closedTabs;
    if (snapshot.tabs !== undefined) snapshot.tabs = withoutClosedTabs(snapshot.tabs, closedTabs);
  }
  logTabChange(req, current.state.tabs, sentTabs, snapshot.tabs);
  // FORK 2026-09-24 — a POST that dies in the browser never reaches this handler, so the trace
  // above is blind to it (that blindness hid the keepalive-budget freeze for seven weeks). The
  // client counts its failed mirrors and names the streak on the first write that gets through.
  const failedBefore = Number(req.headers["x-tinker-mirror-failures"] ?? 0);
  if (failedBefore > 0) {
    console.log(
      `[ui-state] mirror landed after ${failedBefore} failed POST(s) build=${req.headers["x-tinker-build"] ?? "?"}`,
    );
  }
  const tmpPath = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot), "utf-8");
    fs.renameSync(tmpPath, STATE_FILE);
    json(res, 200, { ok: true });
  } catch (writeErr) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    json(res, 500, { error: writeErr.message ?? "Write failed" });
  }
  return true;
}

async function handleOpenFile(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return true;
  }
  let parsed;
  try {
    parsed = JSON.parse((await readRequestBody(req, 64 * 1024)).toString("utf-8"));
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return true;
  }
  const filePath = parsed?.path;
  if (!filePath || typeof filePath !== "string") {
    json(res, 400, { error: "Missing path" });
    return true;
  }
  const resolved = path.resolve(TINKERCLAW_ROOT, filePath);
  if (!resolved.startsWith(TINKERCLAW_ROOT + path.sep) && resolved !== TINKERCLAW_ROOT) {
    json(res, 403, { error: "Path outside project" });
    return true;
  }
  if (!fs.existsSync(resolved)) {
    json(res, 404, { error: "File not found" });
    return true;
  }
  execFile("xdg-open", [resolved], (err) => {
    if (err) console.error(`[tinker-prod-ui] xdg-open failed: ${err.message}`);
  });
  json(res, 200, { ok: true, path: resolved });
  return true;
}

// FORK 2026-10-05 (the architect: "a dedicated tab to visualize [the gantt] … between master and slave …
// attached to the master … connected in real time to the ongoing process"). A chain master gets
// its plan registered by skill build-gantt (`gantt.py render` from a Tinker chat, or `attach`) in
// ~/.openclaw/data/gantt-boards.json. The tab bar reads /api/gantt/boards; the Gantt tab's iframe
// loads /api/gantt/view, which fetches /api/gantt/chart again every 15 s, and its drawer asks
// /api/gantt/agent for one unit. gantt.py derives from the workflow journals IN MEMORY: the plan
// file is the master's and is never written from here.
const GANTT_PY = path.join(ROOT, "skills", "build-gantt", "scripts", "gantt.py");
const GANTT_BOARDS_FILE = path.join(HOME, ".openclaw", "data", "gantt-boards.json");
const GANTT_CACHE_MS = 8_000;
const ganttRuns = new Map();

const ganttKeysMatch = (a, b) => a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`);

function readGanttBoards() {
  let boards;
  try {
    boards = JSON.parse(fs.readFileSync(GANTT_BOARDS_FILE, "utf-8"))?.boards;
  } catch {
    return [];
  }
  if (!isPlainObject(boards)) return [];
  return Object.entries(boards)
    .filter(([, b]) => isPlainObject(b) && typeof b.plan === "string" && fs.existsSync(b.plan))
    .map(([session, b]) => ({
      session,
      plan: b.plan,
      title: typeof b.title === "string" ? b.title : "",
      at: typeof b.at === "string" ? b.at : null,
    }));
}

function runGanttPy(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      "python3",
      [GANTT_PY, ...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          stdout: String(stdout ?? ""),
          stderr: String(stderr || err?.message || ""),
        }),
    );
  });
}

/** One gantt.py run per plan and mode every GANTT_CACHE_MS, shared by every page that asks. */
function ganttRender(plan, mode) {
  const key = `${mode}:${plan}`;
  const hit = ganttRuns.get(key);
  if (hit && Date.now() - hit.at < GANTT_CACHE_MS) return hit.promise;
  const promise = runGanttPy(["live", plan, ...(mode === "chart" ? ["--fragment"] : [])], 60_000);
  ganttRuns.set(key, { at: Date.now(), promise });
  return promise;
}

function sendCompressed(req, res, status, type, body) {
  const headers = { "Content-Type": type, "Cache-Control": "no-store" };
  let out = Buffer.from(body, "utf-8");
  if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    out = zlib.gzipSync(out);
    headers["Content-Encoding"] = "gzip";
  }
  res.writeHead(status, headers);
  res.end(out);
}

const GANTT_EMPTY_PAGE = (msg) =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;background:#1a140e;color:#b8a888;font:13px ui-sans-serif,system-ui,sans-serif">${msg}</body>`;

async function handleGantt(sub, url, req, res) {
  if (sub === "boards") {
    if (req.method === "DELETE") {
      const session = url.searchParams.get("session") || "";
      if (!session) return json(res, 400, { error: "Missing session" });
      const r = await runGanttPy(["detach", "--session", session], 15_000);
      return json(res, r.ok ? 200 : 500, { ok: r.ok, detail: (r.ok ? r.stdout : r.stderr).trim() });
    }
    return json(res, 200, { boards: readGanttBoards() });
  }
  if (sub === "agent") {
    const wf = url.searchParams.get("wf") || "";
    const agent = url.searchParams.get("agent") || "";
    if (!/^wf_[A-Za-z0-9_-]{1,64}$/.test(wf) || !/^[A-Za-z0-9]{1,64}$/.test(agent)) {
      return json(res, 400, { error: "bad workflow or agent id" });
    }
    const r = await runGanttPy(["agent", wf, agent], 20_000);
    let body;
    try {
      body = JSON.parse(r.stdout);
    } catch {
      body = { error: r.stderr.trim().slice(-300) || "gantt.py printed nothing" };
    }
    return json(res, body.error ? 404 : 200, body);
  }
  if (sub === "view" || sub === "chart") {
    const session = url.searchParams.get("session") || "";
    const board = session
      ? readGanttBoards().find((b) => ganttKeysMatch(b.session, session))
      : null;
    if (!board) {
      const msg = "No Gantt plan is attached to this chat.";
      return sendCompressed(
        req,
        res,
        404,
        "text/html; charset=utf-8",
        sub === "view" ? GANTT_EMPTY_PAGE(msg) : msg,
      );
    }
    const r = await ganttRender(board.plan, sub);
    if (!r.ok) {
      console.error(
        `[tinker-prod-ui] gantt.py live ${board.plan} failed: ${r.stderr.trim().slice(-500)}`,
      );
      const msg = `The chart could not be drawn: ${r.stderr.trim().split("\n").pop() || "gantt.py failed"}`;
      return sendCompressed(
        req,
        res,
        500,
        "text/html; charset=utf-8",
        sub === "view" ? GANTT_EMPTY_PAGE(msg) : msg,
      );
    }
    return sendCompressed(req, res, 200, "text/html; charset=utf-8", r.stdout);
  }
  json(res, 404, { error: "Unknown gantt route" });
}

// FORK 2026-09-30 (the architect: "deploy them hot, from now on") — a deploy is live only when open pages
// run it, and when this server runs its own new code too.
//   - servedBundle(): the Tinker bundle dist/index.html names now (/api/ui-build).
//   - SERVER_SOURCE_HASH: this file as it was loaded. After a rebuild that succeeds, a different
//     file on disk means the server itself changed: it restarts a few seconds later
//     (restartSelfIfChanged), after the job's result is on disk (rebuild-<kind>.json), so the
//     button still ends green once the page reconnects.
function servedBundle() {
  try {
    return (
      fs
        .readFileSync(path.join(DIST, "index.html"), "utf8")
        .match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
    );
  } catch {
    return null;
  }
}

// FORK 2026-09-30 (the architect: "bake a refresh into the skill whenever a front-end feature changes so I
// can see it without having to refresh manually"). Every open page holds an event stream here
// (/api/ui-events?have=<the bundle it runs>). The moment dist/index.html names another bundle, each
// page is told and reloads through its own safety rules (never mid-reply, never mid-typing). The
// streams also say which build each open page runs, so the skill can confirm a change is on his
// screen, not just on this server (/api/ui-build → pages).
const uiPages = new Set();

// FORK 2026-10-03: the event also names the rebuild behind the bundle (null when it was built
// outside the rebuild job), so the reload it triggers can be pinned on whoever asked for it.
function uiBuildEvent(bundle, cause = null) {
  return `event: ui-build\ndata: ${JSON.stringify({ bundle, cause })}\n\n`;
}

function pageCensus() {
  const bundle = servedBundle();
  const runs = [...uiPages].map((p) => p.have);
  return {
    open: runs.length,
    onServed: runs.filter((h) => h === bundle).length,
    stale: runs.filter((h) => h !== bundle),
  };
}

function handleUiEvents(req, res) {
  const have = new URL(req.url ?? "/", "http://x").searchParams.get("have") ?? "";
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  const page = { res, have: have.slice(0, 120), since: Date.now() };
  uiPages.add(page);
  // FORK 2026-10-03: a page that connects after a push still learns its cause, but only for the
  // build that push announced; for any other build the honest answer is "unknown" (null).
  const served = servedBundle();
  const cause = lastPush && lastPush.bundle === served ? lastPush.cause : null;
  res.write(`retry: 3000\n${uiBuildEvent(served, cause)}`);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    uiPages.delete(page);
  });
}

let lastServedBundle = null;
// FORK 2026-10-03: the last build pushed to open pages ({bundle, at, cause}). /api/ui-build shows
// it, and a page that connects a moment later still gets its cause.
let lastPush = null;

// FORK 2026-10-03: who caused the build that is about to reload every open page, for the
// disruption ledger. The rebuild running now (a vite build swaps dist/ while it runs), else the one
// that ended in the last 10 s (the watch and the 3 s poll can see the swap just after the job
// closed), else null: a build made outside this server, the very reload nobody could explain before.
// The window was 5 min on the first day; live, a vite build run by hand 33 s after a full rebuild
// ended was booked to that rebuild and its requester.
const PUSH_CAUSE_WINDOW_MS = 10_000;
function pushCause() {
  const describe = (kind) => ({
    kind,
    by: rebuildJobs[kind].by ?? "",
    requester: rebuildJobs[kind].requester || "(not recorded)",
    reason: rebuildJobs[kind].reason ?? "",
  });
  const running = runningRebuild();
  if (running) {
    return describe(running);
  }
  const recent = ["fe", "be"]
    .filter((kind) => {
      const ended = rebuildJobs[kind].finishedAt;
      return ended > 0 && Date.now() - ended <= PUSH_CAUSE_WINDOW_MS;
    })
    .toSorted((a, b) => rebuildJobs[b].finishedAt - rebuildJobs[a].finishedAt)[0];
  return recent ? describe(recent) : null;
}

function announceIfNewBundle() {
  const now = servedBundle();
  if (!now || now === lastServedBundle) return;
  const before = lastServedBundle;
  lastServedBundle = now;
  if (before === null) return; // first read at startup: nothing changed
  const cause = pushCause();
  lastPush = { bundle: now, at: Date.now(), cause };
  recordDisruption("build-push", { bundle: now, pages: uiPages.size, cause });
  console.log(
    `[tinker-prod-ui] new Tinker build ${now}: telling ${uiPages.size} open page(s)` +
      (cause
        ? ` (${cause.kind} rebuild by ${cause.requester}: ${cause.reason})`
        : " (no rebuild job: built outside tinker-prod-ui)"),
  );
  for (const p of uiPages) p.res.write(uiBuildEvent(now, cause));
}

function watchServedBundle() {
  announceIfNewBundle();
  try {
    fs.watch(DIST, { persistent: false }, (_event, name) => {
      if (name === "index.html") setTimeout(announceIfNewBundle, 300);
    }).on("error", () => undefined);
  } catch {
    // the poll below still catches every swap
  }
  // A vite build empties dist/ and a staged swap copies over it; the watch can miss either.
  setInterval(announceIfNewBundle, 3000).unref();
}

function sha256OfFile(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

const SELF_FILE = fileURLToPath(import.meta.url);
const SERVER_SOURCE_HASH = sha256OfFile(SELF_FILE);
const REBUILD_STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(HOME, ".local/state"),
  "tinkerclaw",
);

// FORK 2026-10-03: the DISRUPTION LEDGER. 2026-10-01/02 saw 29 gateway restarts and 43 page
// reloads in 48 h, many of them with nobody's name on them. One JSON line per rebuild (start and
// end), per build pushed to open pages and per page load a page reports, each naming who asked and
// why. freeze_thaw.py appends its gateway-restart and gateway-restart-refused lines to the same
// file in the same shape ({at, event, ...fields}). Read it with `tinker_rebuild.py why`.
const DISRUPTIONS_FILE = path.join(REBUILD_STATE_DIR, "disruptions.jsonl");
const DISRUPTIONS_MAX_BYTES = 5 * 1024 * 1024;

function recordDisruption(event, fields) {
  try {
    fs.mkdirSync(REBUILD_STATE_DIR, { recursive: true });
    // One older generation is kept (.1), so the ledger cannot grow without bound.
    const size = fs.statSync(DISRUPTIONS_FILE, { throwIfNoEntry: false })?.size ?? 0;
    if (size > DISRUPTIONS_MAX_BYTES) {
      fs.renameSync(DISRUPTIONS_FILE, `${DISRUPTIONS_FILE}.1`);
    }
    fs.appendFileSync(
      DISRUPTIONS_FILE,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    // Evidence, never a dependency: a ledger write must not fail a rebuild or a request.
    console.error(`[tinker-prod-ui] disruption ledger not written (${event}): ${err.message}`);
  }
}

function persistRebuildResult(kind) {
  try {
    fs.mkdirSync(REBUILD_STATE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(REBUILD_STATE_DIR, `rebuild-${kind}.json`),
      JSON.stringify({ ...rebuildSnapshot(kind), now: undefined }),
    );
  } catch (err) {
    console.error(`[tinker-prod-ui] could not persist the ${kind} rebuild result: ${err.message}`);
  }
}

function restoreRebuildResults() {
  for (const kind of ["fe", "be"]) {
    const saved = readJsonFile(path.join(REBUILD_STATE_DIR, `rebuild-${kind}.json`));
    if (!saved || (saved.status !== "ok" && saved.status !== "error")) continue;
    Object.assign(rebuildJobs[kind], {
      status: saved.status,
      startedAt: saved.startedAt ?? 0,
      finishedAt: saved.finishedAt ?? 0,
      lastOutputAt: saved.lastOutputAt ?? 0,
      error: saved.error ?? "",
      phase: saved.phase ?? "",
      by: saved.by ?? "",
      origin: saved.origin ?? "",
      requester: saved.requester ?? "",
      reason: saved.reason ?? "",
      log: Array.isArray(saved.log) ? saved.log : [],
    });
  }
}

function restartSelfIfChanged(kind) {
  const onDisk = sha256OfFile(SELF_FILE);
  if (!onDisk || onDisk === SERVER_SOURCE_HASH) return;
  appendRebuildLog(
    kind,
    "tinker-prod-ui changed on disk: restarting it in 4 s so it runs the new code",
  );
  persistRebuildResult(kind);
  const unit = process.env.TINKER_PROD_UI_UNIT || "tinker-prod-ui.service";
  execFile(
    "systemd-run",
    ["--user", "--on-active=4", "--collect", "--quiet", "systemctl", "--user", "restart", unit],
    (err) => {
      if (err) console.error(`[tinker-prod-ui] self-restart not scheduled: ${err.message}`);
    },
  );
}

function appendRebuildLog(kind, line) {
  const job = rebuildJobs[kind];
  const text = String(line).replace(/\r/g, "").trimEnd();
  if (!text) return;
  job.lastOutputAt = Date.now();
  for (const part of text.split("\n")) {
    job.log.push(part);
    // FORK 2026-09-23: deploy-worktree.sh announces "── phase N: … ──"; keep the latest so
    // the button's hover can say WHERE a slow or failed backend rebuild is, not just its tail.
    const phase = part.match(/── (phase \d+: .*?) ──/);
    if (phase) job.phase = phase[1];
  }
  if (job.log.length > MAX_REBUILD_LOG) {
    job.log = job.log.slice(-MAX_REBUILD_LOG);
  }
}

function runningRebuild() {
  if (rebuildJobs.fe.status === "running") return "fe";
  if (rebuildJobs.be.status === "running") return "be";
  return null;
}

function startRebuild(kind, opts = {}) {
  const job = rebuildJobs[kind];
  // FORK 2026-09-30: one rebuild at a time, and the refusal names the job that holds the lock.
  // It used to answer with the snapshot of the kind asked for, so a frontend click during a full
  // rebuild followed the finished frontend job and reported a success that never ran.
  const running = runningRebuild();
  if (running) {
    const what = running === "be" ? "full rebuild + restart" : "frontend rebuild";
    return { ok: false, status: "running", running, error: `A ${what} is already running` };
  }
  // FORK 2026-09-30 (the architect: "wire both buttons so that an agent can find them as a skill"): the
  // page and the agent skill `tinker-rebuild` start the same job here, so a run either one starts
  // shows on the buttons. `by` says which; only the page's click skips the restart-loop guard.
  const by = opts.by === "page" ? "page" : "agent";
  const origin = typeof opts.origin === "string" ? opts.origin.slice(0, 200) : "";
  const reason =
    typeof opts.reason === "string" && opts.reason.trim()
      ? opts.reason.trim().slice(0, 200)
      : by === "page"
        ? "rebuild from the Tinker page"
        : "rebuild asked by an agent";
  // FORK 2026-10-03: `by` says page or agent, which is not a person. `requester` is who asked, in
  // words a person reads; it rides to the disruption ledger and the restart history. A click is
  // always the page's own button; skill tinker-rebuild names the chat or terminal that asked.
  const requester =
    by === "page"
      ? "Tinker page button"
      : typeof opts.requester === "string" && opts.requester.trim()
        ? opts.requester.trim().slice(0, 200)
        : "an agent (no requester given)";
  const env = {
    ...process.env,
    HOME,
    PATH: `${NODE_BIN_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
  const feDir = JSON.stringify(path.join(ROOT, "tinker-ui"));
  const repoDir = JSON.stringify(ROOT);
  // FORK 2026-09-22: the backend rebuild used to stop the gateway, run `pnpm build` in
  // the SHARED checkout and start it again under `set -e`. On 09-22 the build's last
  // step (plugin-SDK .d.ts generation, irrelevant at run time) failed on drifted
  // node_modules, `set -e` skipped the start, and the gateway stayed DOWN until it was
  // restarted by hand. It now runs the documented safe deploy: build the committed
  // `develop` HEAD in a clean worktree, gate it, and only then stop, swap and restart
  // (unconditionally). A failed build never touches the running gateway.
  //
  // FORK 2026-09-30 (bible lifecycles.md L4b): the backend job is now the FULL rebuild —
  // scripts/rebuild-and-restart.sh builds develop and its UI in a clean worktree, stages both, and
  // restarts through the gateway-restart skill, which drains live turns and continues them after.
  // Its arguments ride as argv ("$@"), never pasted into the command string.
  const restartScript = JSON.stringify(path.join(ROOT, "scripts", "rebuild-and-restart.sh"));
  const script =
    kind === "fe"
      ? `set -euo pipefail; cd ${feDir}; npx vite build`
      : `set -uo pipefail; cd ${repoDir}; bash ${restartScript} "$@"`;
  const args =
    kind === "fe"
      ? []
      : [
          "--reason",
          reason,
          ...(origin ? ["--origin", origin] : []),
          "--requester",
          requester,
          ...(by === "page" ? ["--force"] : []),
        ];
  const child = spawn("bash", ["-lc", script, "rebuild", ...args], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;
  job.status = "running";
  job.startedAt = Date.now();
  job.finishedAt = 0;
  job.error = "";
  job.phase = "";
  job.lastOutputAt = job.startedAt;
  job.by = by;
  job.origin = origin;
  job.requester = requester;
  job.reason = reason;
  job.log = [
    `starting ${kind} rebuild (${by === "page" ? "from the page" : `by ${requester}`}: ${reason})`,
  ];
  recordDisruption("rebuild", { phase: "start", kind, by, requester, origin, reason });
  // FORK 2026-10-05 — a frontend build is made from the shared checkout as it is. Say it when that
  // is not develop: on 10-05 a dead session's branch was rebuilt, reported "ok", and hid a merged
  // feature for an hour (scripts/lib/checkout-drift.mjs).
  job.warning = "";
  if (kind === "fe") {
    const drift = checkoutDrift(ROOT);
    if (drift) {
      job.warning = drift.warning;
      appendRebuildLog(kind, drift.warning);
    }
  }
  // One 'end' line per run. A spawn that fails emits 'error' AND then 'close' (exit -2, measured on
  // Node 22), and Node's docs say to guard handlers on both against running twice.
  let endRecorded = false;
  const recordEnd = () => {
    if (endRecorded) {
      return;
    }
    endRecorded = true;
    recordDisruption("rebuild", {
      phase: "end",
      kind,
      by,
      requester,
      reason,
      status: job.status,
      error: job.error,
      tookS: Math.round((job.finishedAt - job.startedAt) / 1000),
    });
  };
  const onChunk = (buf) => appendRebuildLog(kind, buf.toString("utf8"));
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("error", (err) => {
    job.status = "error";
    job.error = err.message;
    job.finishedAt = Date.now();
    job.child = null;
    appendRebuildLog(kind, err.message);
    recordEnd();
  });
  child.on("close", (code) => {
    job.child = null;
    job.finishedAt = Date.now();
    if (code === 0) {
      job.status = "ok";
      appendRebuildLog(kind, `${kind} rebuild ok`);
    } else {
      job.status = "error";
      job.error = `exit ${code ?? "unknown"}`;
      appendRebuildLog(kind, job.error);
    }
    recordEnd();
    persistRebuildResult(kind);
    if (code === 0) {
      restartSelfIfChanged(kind);
    }
  });
  return { ok: true, status: "running" };
}

function rebuildSnapshot(kind) {
  const job = rebuildJobs[kind];
  return {
    kind,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastOutputAt: job.lastOutputAt,
    now: Date.now(),
    phase: job.phase,
    error: job.error,
    by: job.by ?? "",
    origin: job.origin ?? "",
    requester: job.requester ?? "",
    reason: job.reason ?? "",
    log: job.log.slice(-20),
  };
}

async function handleRebuild(kind, req, res) {
  if (kind !== "fe" && kind !== "be") {
    json(res, 404, { error: "Unknown rebuild" });
    return true;
  }
  if (req.method === "GET") {
    json(res, 200, rebuildSnapshot(kind));
    return true;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return true;
  }
  // FORK 2026-09-30: a backend rebuild restarts the gateway, so it takes the same guard as pause and
  // play (isPageCaller): the page and the local agent skill send the header, a foreign page cannot.
  if (!isPageCaller(req, "rebuild")) {
    json(res, 403, { error: "A rebuild can only be started from the Tinker page or this host" });
    return true;
  }
  const q = new URL(req.url ?? "/", "http://x").searchParams;
  const started = startRebuild(kind, {
    by: q.get("by") ?? "",
    origin: q.get("origin") ?? "",
    requester: q.get("requester") ?? "",
    reason: q.get("reason") ?? "",
  });
  json(res, started.ok ? 202 : 409, { ...rebuildSnapshot(started.running ?? kind), ...started });
  return true;
}

// FORK 2026-09-25 (the architect): the ⏸ / ▶ buttons next to SESSIONS drive the host's freeze-thaw
// skill. They live here, not in the gateway, because pause STOPS the gateway and play has to
// work while it is down. The skill is private to the host; when its script is absent the
// status says available:false and the page hides both buttons.
const FREEZE_THAW_SCRIPT =
  process.env.TINKER_FREEZE_THAW_SCRIPT ||
  path.join(HOME, ".openclaw/workspace/skills/freeze-thaw/scripts/freeze_thaw.py");
const FREEZE_THAW_STATE = path.join(
  process.env.XDG_STATE_HOME || path.join(HOME, ".local/state"),
  "freeze-thaw",
);

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function freezeThawStatus() {
  const pending = readJsonFile(path.join(FREEZE_THAW_STATE, "pending.json"));
  let lastThaw = null;
  try {
    const dir = path.join(FREEZE_THAW_STATE, "history");
    const newest = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .toSorted((a, b) => b.t - a.t)[0];
    const h = newest ? readJsonFile(path.join(dir, newest.f)) : null;
    if (h?.thaw) {
      lastThaw = { at: h.thaw.finishedAt ?? null, summary: h.thaw.summary ?? null };
    }
  } catch {
    // no history yet
  }
  return {
    available: fs.existsSync(FREEZE_THAW_SCRIPT),
    frozen: Boolean(pending),
    frozenAt: pending?.frozenAt ?? null,
    summary: pending?.summary ?? null,
    lastThaw,
  };
}

// A pause stops every agent on the machine, so only this page may ask for one. The custom header
// forces a CORS preflight that this server never answers; the Host must be an IP or localhost
// (DNS rebinding arrives under a domain name); an Origin, when sent, must be this very host.
// The bug-report route (2026-09-26) writes files, so it takes the same guard under its own header.
function isPageCaller(req, action) {
  if (req.headers["x-tinker-action"] !== action) return false;
  const host = String(req.headers.host ?? "");
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (hostname !== "localhost" && !net.isIP(hostname)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function runFreezeThaw(cmd, args) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 60_000, env: { ...process.env, HOME } },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`.trim().split("\n").slice(-3).join("\n");
        resolve({ ok: !err, out });
      },
    );
  });
}

async function handleFreezeThaw(action, req, res) {
  if (!action && req.method === "GET") {
    json(res, 200, freezeThawStatus());
    return true;
  }
  if (action !== "pause" && action !== "play") {
    json(res, 404, { error: "Unknown freeze-thaw action" });
    return true;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return true;
  }
  if (!isPageCaller(req, "freeze-thaw")) {
    json(res, 403, { error: "Pause and play can only be pressed from the Tinker page" });
    return true;
  }
  const status = freezeThawStatus();
  if (!status.available) {
    json(res, 404, { ...status, error: "The freeze-thaw skill is not installed on this host" });
    return true;
  }
  const dry = new URL(req.url ?? "/", "http://x").searchParams.get("dry") === "1";
  let run;
  if (action === "pause") {
    if (status.frozen && !dry) {
      json(res, 409, { ...status, error: "Already paused. Press ▶ to resume." });
      return true;
    }
    // The script hands itself to a transient systemd unit, so it outlives the gateway stop.
    // --force: a click on this page is the architect's own hand. The boot/thaw guard exists to stop a
    // RESUMED AGENT from freezing the laptop again, not him.
    run = await runFreezeThaw(
      "python3",
      dry
        ? [FREEZE_THAW_SCRIPT, "freeze", "--dry-run", "--then=none"]
        : [FREEZE_THAW_SCRIPT, "freeze", "--then=none", "--force"],
    );
  } else {
    if (!status.frozen && !dry) {
      json(res, 409, { ...status, error: "Nothing is paused." });
      return true;
    }
    // Detached: a thaw waits minutes for the network and the gateway, and must survive a restart
    // of this proxy.
    run = dry
      ? await runFreezeThaw("python3", [FREEZE_THAW_SCRIPT, "thaw", "--dry-run"])
      : await runFreezeThaw("systemd-run", [
          "--user",
          `--unit=freeze-thaw-play-${Date.now()}`,
          "--collect",
          "--quiet",
          "python3",
          FREEZE_THAW_SCRIPT,
          "thaw",
        ]);
  }
  console.log(
    `[tinker-prod-ui] freeze-thaw ${action}${dry ? " (dry)" : ""}: ${run.ok ? "ok" : "FAILED"} ${run.out}`,
  );
  json(res, run.ok ? 202 : 500, {
    ...freezeThawStatus(),
    ok: run.ok,
    dry,
    output: run.out,
    ...(run.ok ? {} : { error: run.out || `${action} failed` }),
  });
  return true;
}

// FORK 2026-09-26 (the architect: "add a bug icon button, which should log that this particular prompt
// feature did not work correctly ... whatever we need to find the bug"). The 🐛 on a LOST prompt
// posts the page's half of the evidence (tinker-ui/src/prompt-bug-report.ts). This adds the half
// only this machine can see — the gateway journal lines naming the prompt's key, the journal around
// its ack, and the transcript lines holding its key or text — and writes one JSON file per click.
// ~/.openclaw/data is git-ignored, and the files are 0600: a report holds the prompt's text.
const BUG_REPORT_DIR = path.join(HOME, ".openclaw", "data", "bug-reports");
const MAX_BUG_REPORT_BODY = 8 * 1024 * 1024;
const BUG_JOURNAL_MAX_LINES = 300;
// Separate budgets: a key also rides on every tool event of its run, and those must not crowd out
// the user row that holds the prompt's text.
const BUG_TRANSCRIPT_KEY_LINES = 15;
const BUG_TRANSCRIPT_TEXT_LINES = 25;
const BUG_LINE_MAX = 4000;
const BUG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gatewayJournal(args) {
  return new Promise((resolve) => {
    execFile(
      "journalctl",
      ["--user", "-u", "openclaw-gateway", "--no-pager", "-o", "short-iso", ...args],
      { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        const lines = String(stdout ?? "")
          .split("\n")
          .filter(Boolean)
          .map((l) => l.slice(0, BUG_LINE_MAX));
        // --grep exits 1 when nothing matched: an empty answer, not a failure.
        if (err && lines.length === 0 && err.code !== 1) {
          resolve({ args, error: err.message, lines: [] });
          return;
        }
        resolve({ args, total: lines.length, lines });
      },
    );
  });
}

async function transcriptEvidence(sessionKey, key, text) {
  const agentId = /^agent:([^:]+):/.exec(sessionKey)?.[1] ?? "main";
  const storePath = path.join(HOME, ".openclaw", "agents", agentId, "sessions", "sessions.json");
  let row;
  try {
    row = JSON.parse(fs.readFileSync(storePath, "utf8"))[sessionKey];
  } catch (err) {
    return { error: `sessions.json: ${err.message}` };
  }
  if (!row) return { error: `no sessions.json row for ${sessionKey}` };
  const file = row.sessionFile || path.join(path.dirname(storePath), `${row.sessionId}.jsonl`);
  const rowFacts = Object.fromEntries(
    Object.entries(row).filter(([k]) =>
      /^(sessionId|sessionFile|updatedAt|abortedLastRun|model|modelProvider)$|cli|claude/i.test(k),
    ),
  );
  // JSONL stores the text JSON-escaped: search for the escaped first line, and only when it is
  // long enough not to match everything.
  const firstLine = String(text ?? "")
    .split("\n")[0]
    .trim()
    .slice(0, 60);
  const needle = firstLine.length >= 12 ? JSON.stringify(firstLine).slice(1, -1) : "";
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return { row: rowFacts, file, error: `transcript: ${err.message}` };
  }
  const matches = [];
  let keyKept = 0;
  let textKept = 0;
  let keyTotal = 0;
  let textTotal = 0;
  let lineCount = 0;
  let lastLine = "";
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    lineCount++;
    lastLine = line;
    const hasKey = key ? line.includes(key) : false;
    const hasText = needle ? line.includes(needle) : false;
    keyTotal += hasKey ? 1 : 0;
    textTotal += hasText ? 1 : 0;
    const keep =
      (hasText && textKept < BUG_TRANSCRIPT_TEXT_LINES) ||
      (hasKey && keyKept < BUG_TRANSCRIPT_KEY_LINES);
    if (keep) {
      textKept += hasText ? 1 : 0;
      keyKept += hasKey && !hasText ? 1 : 0;
      matches.push({ line: lineCount, hasKey, hasText, text: line.slice(0, BUG_LINE_MAX) });
    }
  }
  return {
    row: rowFacts,
    file,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    lineCount,
    needle,
    keyLineTotal: keyTotal,
    textLineTotal: textTotal,
    matches,
    lastLine: lastLine.slice(0, BUG_LINE_MAX),
  };
}

async function handleBugReport(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!isPageCaller(req, "bug-report")) {
    json(res, 403, { error: "Bug reports can only be sent from the Tinker page" });
    return;
  }
  let report;
  try {
    report = JSON.parse((await readRequestBody(req, MAX_BUG_REPORT_BODY)).toString("utf8"));
  } catch (err) {
    json(res, err?.code === "OVERFLOW" ? 413 : 400, {
      error: err?.code === "OVERFLOW" ? "Report too large" : "Invalid JSON",
    });
    return;
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    json(res, 400, { error: "Report must be a JSON object" });
    return;
  }
  const key = BUG_UUID.test(String(report.promptId ?? "")) ? String(report.promptId) : "";
  const sessionKey = typeof report.sessionKey === "string" ? report.sessionKey : "";
  const entry =
    report.outboxEntry && typeof report.outboxEntry === "object" ? report.outboxEntry : {};
  const now = Date.now();
  const typedAt = Number.isFinite(entry.ts) ? entry.ts : now - 2 * 3600_000;
  const anchor = Number.isFinite(entry.ackedAt) ? entry.ackedAt : typedAt;
  const sec = (ms) => `@${Math.floor(ms / 1000)}`;
  const [journalKey, journalAround, transcript] = await Promise.all([
    key
      ? gatewayJournal([`--since=${sec(typedAt - 5 * 60_000)}`, `--grep=${key}`])
      : Promise.resolve({ skipped: "no prompt key" }),
    gatewayJournal([`--since=${sec(anchor - 5_000)}`, `--until=${sec(anchor + 60_000)}`]),
    sessionKey
      ? transcriptEvidence(sessionKey, key, entry.text).catch((err) => ({ error: err.message }))
      : Promise.resolve({ skipped: "no session key" }),
  ]);
  // The key's lines keep the newest; the window around the ack keeps the lines nearest the ack.
  const trim = (j, newest) =>
    j.lines && j.lines.length > BUG_JOURNAL_MAX_LINES
      ? {
          ...j,
          lines: newest
            ? j.lines.slice(-BUG_JOURNAL_MAX_LINES)
            : j.lines.slice(0, BUG_JOURNAL_MAX_LINES),
          trimmedTo: BUG_JOURNAL_MAX_LINES,
        }
      : j;
  const server = {
    receivedAt: new Date(now).toISOString(),
    host: os.hostname(),
    gatewayJournalForKey: trim(journalKey, true),
    gatewayJournalAroundAck: trim(journalAround, false),
    transcript,
  };
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hms = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const kind = /^[a-z-]{1,40}$/.test(String(report.kind ?? "")) ? report.kind : "report";
  const dir = path.join(BUG_REPORT_DIR, day);
  const file = path.join(dir, `${hms}-${kind}-${key ? key.slice(0, 8) : "nokey"}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ ...report, server }, null, 2), { mode: 0o600 });
    fs.appendFileSync(
      path.join(BUG_REPORT_DIR, "index.jsonl"),
      `${JSON.stringify({ at: server.receivedAt, kind, promptId: key || null, sessionKey, headline: report.headline ?? null, path: file })}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    console.error(`[tinker-prod-ui] bug report write failed: ${err.message}`);
    json(res, 500, { error: `Write failed: ${err.message}` });
    return;
  }
  console.log(`[tinker-prod-ui] bug report ${kind} ${key || "nokey"} → ${file}`);
  json(res, 201, { ok: true, path: file });
}

// FORK 2026-10-03: a page load left no trace on this server, and 15 of the 43 Tinker reloads in
// 48 h (2026-10-01/02) could not be explained afterwards: only the page knew why it reloaded. Each
// page now posts why it loaded (a pushed build, a manual refresh, a first open ...) once it is up,
// and the line lands in the disruption ledger next to the rebuilds and gateway restarts. Same guard
// as the bug report: only the Tinker page itself may post here.
const MAX_PAGE_LOAD_BODY = 4096;

async function handlePageLoad(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!isPageCaller(req, "page-load")) {
    json(res, 403, { error: "A page load can only be reported from the Tinker page" });
    return;
  }
  let report;
  try {
    report = JSON.parse((await readRequestBody(req, MAX_PAGE_LOAD_BODY)).toString("utf8"));
  } catch (err) {
    json(res, err?.code === "OVERFLOW" ? 413 : 400, {
      error: err?.code === "OVERFLOW" ? "Report too large" : "Invalid JSON",
    });
    return;
  }
  if (!isPlainObject(report)) {
    json(res, 400, { error: "Report must be a JSON object" });
    return;
  }
  // A value the page did not send, or sent with the wrong type, is recorded as unknown (null),
  // never as "" or 0: a 0 would read as "reloaded at once". Whitespace folds to one space so a
  // value cannot split the journal line below.
  const text = (v, max = 300) =>
    typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, max) : null;
  const seconds = (ms) => (Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null);
  const entry = {
    cause: text(report.cause, 40),
    detail: text(report.detail),
    when: text(report.when),
    bundle: text(report.bundle),
    prevBundle: text(report.prevBundle),
    navType: text(report.navType),
    deferredS: seconds(report.deferredMs),
    idleS: seconds(report.idleMs),
    busy: typeof report.busy === "boolean" ? report.busy : null,
    ageS: seconds(report.ageMs),
  };
  recordDisruption("page-load", entry);
  console.log(
    `[page-load] cause=${entry.cause} bundle=${entry.bundle ?? "?"} ${entry.detail ?? ""}`,
  );
  res.writeHead(204);
  res.end();
}

function serveIndex(res) {
  const raw = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  const tag = `<script>window.__TINKER_CONFIG=${JSON.stringify({ token: TOKEN })}</script>`;
  const html = raw.includes("__TINKER_CONFIG") ? raw : raw.replace("</head>", `${tag}\n</head>`);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(html);
}

// FORK 2026-09-24 — how long a proxied /tinker/api call may wait for the gateway to START
// answering. Chrome gives this host six HTTP connections, shared by these proxied calls and by
// the /api/ui-state mirror that prod-ui answers itself. With no limit here, a gateway whose
// event loop is pinned (5–17 min on 2026-09-23) held all six on context-anatomy calls and every
// tab open/close queued behind them — measured with a gateway that never answers HTTP: 6 calls
// held, the mirror stuck at 5 landed / 12 pending, the new tab never on disk. A reboot inside
// such a stall lost the tabs. Once the gateway has started a response it may stream as long as
// it likes; only the wait for the first byte is bounded.
const PROXY_FIRST_BYTE_TIMEOUT_MS = Number(process.env.TINKER_PROXY_TIMEOUT_MS || 30_000);

function proxyToGateway(req, res, rewritePath) {
  const headers = { ...req.headers, host: `${GW_HOST}:${GW_PORT}` };
  headers.authorization = `Bearer ${TOKEN}`;
  let firstByte = null;
  const pReq = http.request(
    {
      hostname: GW_HOST,
      port: GW_PORT,
      path: rewritePath ?? req.url,
      method: req.method,
      headers,
    },
    (pRes) => {
      clearTimeout(firstByte);
      res.writeHead(pRes.statusCode ?? 502, pRes.headers);
      pRes.pipe(res);
    },
  );
  firstByte = setTimeout(() => {
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end(`gateway did not answer within ${PROXY_FIRST_BYTE_TIMEOUT_MS} ms`);
    pReq.destroy();
  }, PROXY_FIRST_BYTE_TIMEOUT_MS);
  pReq.on("error", (err) => {
    clearTimeout(firstByte);
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end(`gateway proxy failed: ${err.message}`);
  });
  req.pipe(pReq);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;
  if (pathname === "/api/ui-state") {
    void handleUiState(req, res);
    return;
  }
  if (pathname === "/api/open-file") {
    void handleOpenFile(req, res);
    return;
  }
  if (pathname.startsWith("/api/gantt/")) {
    void handleGantt(pathname.slice("/api/gantt/".length), url, req, res);
    return;
  }
  // FORK 2026-09-30 (the architect: "make code changes and deploy them hot, from now on"): what this server
  // serves NOW. Every open page compares it with the bundle it runs and reloads onto a new one.
  if (pathname === "/api/ui-build") {
    json(res, 200, {
      bundle: servedBundle(),
      server: SERVER_SOURCE_HASH.slice(0, 12),
      pages: pageCensus(),
      // FORK 2026-10-03: the last build pushed to open pages and the rebuild behind it.
      lastPush,
    });
    return;
  }
  if (pathname === "/api/ui-events") {
    handleUiEvents(req, res);
    return;
  }
  if (pathname === "/api/rebuild/fe") {
    void handleRebuild("fe", req, res);
    return;
  }
  if (pathname === "/api/rebuild/be") {
    void handleRebuild("be", req, res);
    return;
  }
  if (pathname === "/api/freeze-thaw" || pathname.startsWith("/api/freeze-thaw/")) {
    void handleFreezeThaw(pathname.slice("/api/freeze-thaw/".length), req, res);
    return;
  }
  if (pathname === "/api/bug-report") {
    void handleBugReport(req, res);
    return;
  }
  if (pathname === "/api/page-load") {
    void handlePageLoad(req, res);
    return;
  }
  if (pathname === "/api/kit-content") {
    proxyToGateway(req, res, `/tinker/api/kit-content${url.search}`);
    return;
  }
  if (pathname === "/api/save-file") {
    proxyToGateway(req, res, `/tinker/api/save-file${url.search}`);
    return;
  }
  if (pathname === "/") {
    res.writeHead(302, { Location: "/tinker/" });
    res.end();
    return;
  }
  if (pathname.startsWith("/tinker/api/") || pathname === "/tinker/api") {
    proxyToGateway(req, res);
    return;
  }
  if (!pathname.startsWith("/tinker")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  let rel = pathname.slice("/tinker".length) || "/";
  if (rel === "/") {
    serveIndex(res);
    return;
  }
  const ext = path.extname(rel).toLowerCase();
  const filePath = path.resolve(DIST, `.${rel}`);
  if (!filePath.startsWith(DIST + path.sep) && filePath !== DIST) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": rel.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      res.end(data);
      return;
    }
  } catch {
    // fall through
  }
  if (!ext || ext === ".html") {
    serveIndex(res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.on("upgrade", (req, clientSocket, head) => {
  const gwSocket = net.connect(GW_PORT, GW_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const v = Array.isArray(value) ? value.join(", ") : value;
      if (key.toLowerCase() === "host") {
        lines.push(`Host: ${GW_HOST}:${GW_PORT}`);
      } else {
        lines.push(`${key}: ${v}`);
      }
    }
    lines.push("", "");
    gwSocket.write(lines.join("\r\n"));
    if (head?.length) gwSocket.write(head);
    gwSocket.pipe(clientSocket);
    clientSocket.pipe(gwSocket);
  });
  gwSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => gwSocket.destroy());
});

// A rebuild's result outlives the self-restart it may have triggered (restartSelfIfChanged).
restoreRebuildResults();
watchServedBundle();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[tinker-prod-ui] production Tinker (no HMR) http://127.0.0.1:${PORT}/tinker/`);
  console.log(`[tinker-prod-ui] dist=${DIST} gateway=${GW_HOST}:${GW_PORT}`);
  console.log(
    `[tinker-prod-ui] desk=${REQUIRE_SEAT ? "per-seat only (TINKER_REQUIRE_SEAT=1)" : `${LEGACY_STATE_FILE} for seat-less requests, per-seat under data/seats/`}`,
  );
});
