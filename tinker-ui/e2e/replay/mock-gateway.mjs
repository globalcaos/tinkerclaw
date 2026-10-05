#!/usr/bin/env node
/**
 * Scenario-driven mock gateway + static server for replaying a real Tinker chat turn into a real
 * browser. Adapted from tinker-ui/e2e/chat-viewport/mock-gateway.mjs (that file is not modified).
 *
 *   node mock-gateway.mjs --scenario <scenario.json> --dist <built tinker-ui dist> [--port 0]
 *        [--port-file <path>] [--log <path.ndjson>]
 *
 * Binds 127.0.0.1 only and connects to nothing. Serves the dist under /tinker/ (index.html gets
 * window.__TINKER_CONFIG={token:"mock"}), answers /api/* and /tinker/api/* with 404 (so the page's
 * build poll, ui-state mirror and page-load report all stand down), and speaks the gateway protocol
 * on the same port: the connect handshake, sessions.list, chat.history from the scenario's timeline,
 * chat.send (binds the scenario's run to the page's idempotencyKey), sessions.subscribe, chat.abort.
 * Any other method is answered with an error, as an unknown method would be.
 *
 * THE CLOCK. Scenario time t=0 is planned at boot + scenario.prerollMs (default 15 s), and every
 * epoch-ms value in served frames and history rows is shifted by (that planned instant - epoch0), so
 * the gateway's timestamps line up with the page's own clock. POST /__mock/start starts the clock at
 * the planned instant (it waits if called early; if called late the lag is logged as `skewMs`).
 * Frames go out at start + at, in file order, to every open socket. chat.history serves the latest
 * snapshot whose `at` <= now (the first snapshot before the clock starts).
 *
 * Control (HTTP, same port):
 *   POST /__mock/start           start the clock → {startReal, plannedStart, skewMs}
 *   GET  /__mock/clock           {started, t}
 *   GET  /__mock/log             every logged event so far (JSON array)
 *   POST /__mock/drop  {ms}      close every socket and refuse new ones for ms (a gateway outage)
 *   POST /__mock/emit  {event, payload, seq?}   push one extra frame now (experiments)
 */
import {
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WT = process.env.HARNESS_WORKTREE ?? fileURLToPath(new URL("../../../", import.meta.url));
const { WebSocketServer } = createRequire(join(WT, "package.json"))("ws");

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const scenario = JSON.parse(readFileSync(args.scenario, "utf-8"));
const DIST = resolve(args.dist);
const PORT = Number(args.port ?? 0);
const LOG = args.log ?? null;
const PREROLL = Number(scenario.prerollMs ?? 15000);
const bootAt = Date.now();
const plannedStart = bootAt + PREROLL;
/** Shift applied to every epoch value served: scenario t=0 (epoch0) lands on plannedStart. */
const DELTA = plannedStart - Number(scenario.epoch0 ?? plannedStart);
let startReal = null;
const logRows = [];
function log(kind, data) {
  const row = {
    t: startReal === null ? null : Date.now() - startReal,
    wall: Date.now() - bootAt,
    kind,
    ...data,
  };
  logRows.push(row);
  if (LOG) appendFileSync(LOG, JSON.stringify(row) + "\n");
}
if (LOG) writeFileSync(LOG, "");

// ── payload transforms ────────────────────────────────────────────────────────────────────────
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
function shiftEpochs(v) {
  if (typeof v === "number" && v > 1.5e12 && v < 2.5e12) return v + DELTA;
  if (typeof v === "string" && ISO.test(v)) return new Date(Date.parse(v) + DELTA).toISOString();
  if (Array.isArray(v)) return v.map(shiftEpochs);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = shiftEpochs(x);
    return o;
  }
  return v;
}
/** runId (scenario) → idempotencyKey the page sent. */
const bindings = new Map();
const bindable = (scenario.runs ?? []).filter((r) => r.bind === "page-send").map((r) => r.id);
function rebind(obj) {
  if (bindings.size === 0) return obj;
  let s = JSON.stringify(obj);
  for (const [from, to] of bindings) s = s.split(from).join(to);
  return JSON.parse(s);
}
const servable = (obj) => rebind(shiftEpochs(obj));

// ── history ───────────────────────────────────────────────────────────────────────────────────
const nowT = () => (startReal === null ? Number.NEGATIVE_INFINITY : Date.now() - startReal);
function snapshotFor(key) {
  const list = scenario.history?.[key];
  if (!Array.isArray(list) || list.length === 0) return null;
  const T = nowT();
  let pick = list[0];
  for (const s of list) if (s.at <= T) pick = s;
  return pick;
}
const meta = (m) =>
  m && typeof m === "object" && m.__openclaw && typeof m.__openclaw === "object"
    ? m.__openclaw
    : null;
const localSeq = (m) => {
  const o = meta(m);
  return o && o.importedFrom == null && Number.isInteger(o.seq) && o.seq > 0 ? o.seq : undefined;
};
const isImported = (m) => meta(m)?.importedFrom != null;
const tsOf = (m) => {
  const t = m?.timestamp;
  if (typeof t === "number") return t;
  if (typeof t === "string") {
    const p = Date.parse(t);
    return Number.isFinite(p) ? p : undefined;
  }
  return undefined;
};
const rowId = (m) => {
  const o = meta(m);
  if (!o) return null;
  return o.id ? `oc:${o.id}` : o.externalId ? `ext:${o.externalId}` : null;
};
/**
 * Emulates chat-history-cursor.ts over one served snapshot: the snapshot is what a tail read
 * returned, so a delta is the snapshot's local rows after `afterSeq` plus its imports at or after the
 * anchor row's time; a hidden anchor (a local row the projection dropped) uses snap.hiddenLocal.
 */
function planFor(snap, params) {
  const { afterSeq, beforeSeq, epoch } = params ?? {};
  const cursor = snap.cursor;
  const msgs = snap.messages ?? [];
  if (afterSeq === undefined && beforeSeq === undefined)
    return { kind: "tail", rows: msgs, cursor };
  const reset = (reason) => ({
    kind: "tail",
    reason,
    rows: msgs,
    cursor: cursor ? { ...cursor, reset: true } : cursor,
  });
  if (!cursor || cursor.epoch == null) return reset("epoch_null");
  if (epoch === undefined || epoch !== cursor.epoch) return reset("epoch_mismatch");
  const hidden = new Map((snap.hiddenLocal ?? []).map((h) => [h.seq, h.timestamp]));
  const lastSeq = Number(cursor.lastSeq ?? 0);
  if (afterSeq !== undefined) {
    let anchorTs;
    let anchorFound = afterSeq === 0;
    if (afterSeq === 0) anchorTs = Number.NEGATIVE_INFINITY;
    const rows = [];
    for (const m of msgs) {
      const s = localSeq(m);
      if (s === undefined) continue;
      if (s === afterSeq) {
        anchorFound = true;
        anchorTs = tsOf(m) ?? Number.NEGATIVE_INFINITY;
      }
    }
    if (!anchorFound && hidden.has(afterSeq)) {
      anchorFound = true;
      anchorTs = hidden.get(afterSeq);
    }
    if (!anchorFound) return reset("anchor_missing");
    if (afterSeq > lastSeq) return reset("past_end");
    for (const m of msgs) {
      const s = localSeq(m);
      if (s !== undefined) {
        if (s > afterSeq) rows.push(m);
        continue;
      }
      if (!isImported(m)) {
        rows.push(m); // stranded (seq-less) local row: every delta carries it
        continue;
      }
      const t = tsOf(m);
      if (t === undefined || t >= anchorTs) rows.push(m);
    }
    return {
      kind: "after",
      rows,
      cursor: {
        ...cursor,
        firstSeq: lastSeq > afterSeq ? afterSeq + 1 : afterSeq,
        lastSeq,
        hasMoreBefore: (lastSeq > afterSeq ? afterSeq + 1 : afterSeq) > 1,
        reset: false,
        userRowsBefore: undefined,
      },
    };
  }
  // beforeSeq: the snapshot's local rows below it, imports up to the anchor's time.
  const anchor = msgs.find((m) => localSeq(m) === beforeSeq);
  const toTs = anchor
    ? (tsOf(anchor) ?? Number.POSITIVE_INFINITY)
    : (hidden.get(beforeSeq) ?? Number.POSITIVE_INFINITY);
  const rows = msgs.filter((m) => {
    const s = localSeq(m);
    if (s !== undefined) return s < beforeSeq;
    if (!isImported(m)) return true;
    const t = tsOf(m);
    return t === undefined || t <= toTs;
  });
  const seqs = rows.map(localSeq).filter((s) => s !== undefined);
  return {
    kind: "before",
    rows,
    cursor: {
      ...cursor,
      firstSeq: seqs.length ? Math.min(...seqs) : Math.max(0, beforeSeq - 1),
      lastSeq: seqs.length ? Math.max(...seqs) : Math.max(0, beforeSeq - 1),
      hasMoreBefore: false,
      reset: false,
    },
  };
}
function answerHistory(params) {
  const key = String(params?.sessionKey ?? "");
  if (params?.resetArchiveBefore !== undefined) {
    log("history", { key, archive: true });
    return {
      sessionKey: key,
      messages: [],
      archive: { resetAt: null, olderCount: 0, rowsBefore: 0 },
    };
  }
  const snap = snapshotFor(key);
  if (!snap) {
    log("history", {
      key,
      snapshot: null,
      rows: 0,
      params: {
        afterSeq: params?.afterSeq,
        beforeSeq: params?.beforeSeq,
        epoch: params?.epoch,
        limit: params?.limit,
      },
    });
    return { sessionKey: key, messages: [] };
  }
  const plan = planFor(snap, params);
  let rows = plan.rows;
  const limit = typeof params?.limit === "number" ? params.limit : 200;
  if (plan.kind === "tail" && rows.length > limit) rows = rows.slice(rows.length - limit);
  const reply = { sessionKey: key, ...(snap.extra ?? {}), messages: rows };
  if (plan.cursor !== undefined) {
    const c = { ...plan.cursor };
    if (c.userRowsBefore === undefined) delete c.userRowsBefore;
    reply.cursor = c;
  }
  log("history", {
    key,
    snapshot: { at: snap.at, tag: snap.tag },
    plan: plan.kind + (plan.reason ? `:${plan.reason}` : ""),
    params: {
      afterSeq: params?.afterSeq,
      beforeSeq: params?.beforeSeq,
      epoch: params?.epoch,
      limit: params?.limit,
    },
    rows: rows.length,
    ids: rows.map((m) => `${m.role}:${rowId(m) ?? "-"}`),
    cursor: reply.cursor ?? null,
  });
  return servable(reply);
}

// ── sessions ──────────────────────────────────────────────────────────────────────────────────
function sessionRows() {
  const rows = scenario.sessions ?? [
    {
      key: scenario.mainSession,
      sessionKey: scenario.mainSession,
      label: "Main",
      title: "Main",
      kind: "direct",
      model: "mock",
    },
    {
      key: scenario.session,
      sessionKey: scenario.session,
      label: "Replay",
      title: "Replay",
      kind: "direct",
      model: "mock",
    },
  ];
  return rows.map((r) => ({ updatedAt: Date.now(), ...r }));
}

// ── frames ────────────────────────────────────────────────────────────────────────────────────
const sockets = new Set();
const connSeq = new Map();
let refuseUntil = 0;
function sendFrame(event, payload, withSeq, meta = {}) {
  let delivered = 0;
  for (const ws of sockets) {
    if (ws.readyState !== 1) continue;
    const frame = { type: "event", event, payload };
    if (withSeq) {
      const n = (connSeq.get(ws) ?? 0) + 1;
      connSeq.set(ws, n);
      frame.seq = n;
    }
    ws.send(JSON.stringify(frame));
    delivered++;
  }
  log("frame", {
    event,
    state: payload?.state ?? payload?.stream ?? null,
    runId: payload?.runId ?? null,
    pseq: payload?.seq ?? null,
    len: event === "chat" ? textLen(payload?.message) : undefined,
    delivered,
    ...meta,
  });
}
function textLen(m) {
  if (!m) return undefined;
  if (typeof m.text === "string") return m.text.length;
  if (Array.isArray(m.content))
    return m.content.reduce((n, b) => n + (b?.type === "text" ? (b.text ?? "").length : 0), 0);
  return undefined;
}
const frames = (scenario.frames ?? []).map((f, i) => ({ ...f, i }));
let nextFrame = 0;
let holdSince = null;
const HOLD_MAX_MS = 30000;
function mentionsUnbound(f) {
  if (bindable.length === 0) return false;
  const s = JSON.stringify(f.payload);
  return bindable.some((id) => !bindings.has(id) && s.includes(id));
}
let pumpTimer = null;
function schedulePump(ms) {
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pump();
  }, ms);
}
function pump() {
  if (startReal === null) return;
  const T = Date.now() - startReal;
  while (nextFrame < frames.length && frames[nextFrame].at <= T) {
    const f = frames[nextFrame];
    if (mentionsUnbound(f)) {
      // The page has not sent the prompt this run answers yet: hold the stream (in order) until it does.
      holdSince ??= Date.now();
      if (Date.now() - holdSince < HOLD_MAX_MS) {
        schedulePump(50);
        return;
      }
      log("hold-timeout", { frame: f.i });
    }
    if (holdSince !== null) {
      log("hold-released", { frame: f.i, heldMs: Date.now() - holdSince });
      holdSince = null;
    }
    sendFrame(f.event, servable(f.payload), f.seq !== false, {
      frame: f.i,
      at: f.at,
      ...(f.synthetic ? { synthetic: true } : {}),
    });
    nextFrame++;
  }
  if (nextFrame < frames.length) {
    const wait = Math.max(0, frames[nextFrame].at - (Date.now() - startReal));
    schedulePump(Math.min(wait, 1000));
  } else if (!framesDone) {
    framesDone = true;
    log("frames-done", { count: frames.length });
  }
}
let framesDone = false;

// ── methods ───────────────────────────────────────────────────────────────────────────────────
let sentCount = 0;
function answer(method, params) {
  if (method === "connect")
    return {
      type: "hello-ok",
      protocol: 3,
      server: { version: "mock-replay" },
      features: { methods: [], events: [] },
      snapshot: {
        sessionDefaults: scenario.sessionDefaults ?? { mainSessionKey: scenario.mainSession },
      },
      policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 30000 },
    };
  if (method === "sessions.list") {
    const rows = sessionRows();
    return { sessions: rows, count: rows.length };
  }
  if (method === "chat.history") return answerHistory(params);
  if (method === "chat.send") {
    const key = String(params?.idempotencyKey ?? `mock-${Date.now()}`);
    sentCount++;
    // Sends bind the scenario's page-send runs in order; a run may carry its own ack (e.g. a prompt
    // the gateway folds into a running turn), default {status:"started"}.
    const target = bindable.find((id) => !bindings.has(id));
    let ack = { status: "started" };
    if (target && String(params?.sessionKey ?? "") === scenario.session) {
      bindings.set(target, key);
      log("bind", { runId: target, idempotencyKey: key });
      ack = (scenario.runs ?? []).find((r) => r.id === target)?.ack ?? ack;
      schedulePump(0);
    }
    return { runId: key, ...ack };
  }
  if (method === "sessions.subscribe") return {};
  if (method === "chat.abort") return { ok: true, aborted: false };
  throw new Error(`unknown method (mock): ${method}`);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
function readBody(req) {
  return new Promise((ok) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => ok(b ? JSON.parse(b) : {}));
  });
}
async function control(req, res, url) {
  const j = req.method === "POST" ? await readBody(req) : {};
  const json = (o) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
  if (url.pathname === "/__mock/start") {
    if (startReal === null) {
      const wait = plannedStart - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      startReal = Date.now();
      log("start", { plannedStart, startReal, skewMs: startReal - plannedStart, delta: DELTA });
      pump();
    }
    return json({ startReal, plannedStart, skewMs: startReal - plannedStart, delta: DELTA });
  }
  if (url.pathname === "/__mock/clock")
    return json({ started: startReal !== null, startReal, t: nowT() });
  if (url.pathname === "/__mock/log") return json(logRows);
  if (url.pathname === "/__mock/drop") {
    const ms = Number(j.ms ?? 3000);
    refuseUntil = Date.now() + ms;
    for (const ws of sockets) ws.terminate();
    log("drop", { ms, sockets: sockets.size });
    return json({ ok: true });
  }
  if (url.pathname === "/__mock/emit") {
    sendFrame(String(j.event), servable(j.payload ?? {}), j.seq !== false, { injected: true });
    return json({ ok: true });
  }
  res.writeHead(404).end("no such control");
}
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/__mock/")) {
    control(req, res, url).catch((e) => res.writeHead(500).end(String(e)));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/tinker/api/")) {
    res
      .writeHead(404, { "content-type": "application/json" })
      .end('{"error":"mock: no such route"}');
    return;
  }
  if (!url.pathname.startsWith("/tinker")) {
    res.writeHead(404).end("not found");
    return;
  }
  let rel = url.pathname.replace(/^\/tinker\/?/, "");
  if (rel === "" || rel === "login" || !extname(rel)) rel = "index.html";
  const file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  if (rel === "index.html") {
    const html = readFileSync(file, "utf-8").replace(
      "<head>",
      `<head><script>window.__TINKER_CONFIG={token:"mock"};</script>`,
    );
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(html);
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  if (Date.now() < refuseUntil) {
    log("refused", {});
    ws.terminate();
    return;
  }
  sockets.add(ws);
  log("open", { sockets: sockets.size });
  ws.on("close", () => {
    sockets.delete(ws);
    connSeq.delete(ws);
    log("close", { sockets: sockets.size });
  });
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "n", ts: Date.now() },
    }),
  );
  ws.on("message", (raw) => {
    let f;
    try {
      f = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (f.type !== "req") return;
    const p = f.params ?? {};
    if (f.method !== "chat.history") {
      log("req", {
        method: f.method,
        sessionKey: p.sessionKey ?? undefined,
        ...(f.method === "chat.send"
          ? { idempotencyKey: p.idempotencyKey, textLen: String(p.message ?? "").length }
          : {}),
      });
    }
    try {
      ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload: answer(f.method, p) }));
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: "res",
          id: f.id,
          ok: false,
          error: { code: "UNAVAILABLE", message: String(e?.message ?? e) },
        }),
      );
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const port = server.address().port;
  if (args["port-file"]) writeFileSync(args["port-file"], String(port));
  console.log(
    `LISTENING ${port} scenario=${scenario.name} frames=${frames.length} preroll=${PREROLL}ms delta=${DELTA}`,
  );
});
