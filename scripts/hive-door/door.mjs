#!/usr/bin/env node
/**
 * Hive door — per-person tokens and per-person chats in front of the gateway (opt-in multi-user mode).
 *
 * WHAT IT IS FOR: several people share one agent. Each opens it with their OWN token; the token (never
 * a typed name) decides who they are. Each person sees their own chats, keeps their own tabs and page
 * state, and an admin sees everyone's chats grouped by owner and manages the people from the page.
 * HOW IT WAS DERIVED: the single-user door took ONE shared token plus a typed name, with the seat in a
 * client-set cookie and header, so anyone holding the token could claim anyone's seat and read every
 * chat. Measured basis: extensions/tinkerclaw-tinker/index.ts, src/gateway/client.ts (the chat connects
 * with `connect` params.auth.token in its first frame), src/gateway/server-broadcast.ts (events are
 * broadcast to every connection), src/gateway/server/health-state.ts (the hello snapshot names the Main
 * chat). Visibility rules: acl.mjs.
 * WHAT WOULD CHANGE IT: native per-user identity in the gateway (then this enforcement moves inside).
 *
 * Flow: GET /tinker/login (token only) -> POST token -> signed HttpOnly session cookie. Every HTTP
 * request goes upstream with the gateway Bearer and `x-tinker-seat` from the table (client copies are
 * stripped). Every WebSocket gets the same headers; the door then reads each frame:
 *   client -> gateway: `connect` gets the real token; any request naming a chat the person may not see
 *     is refused; a regular user's `sessions.delete` only hides the chat for them (nothing is deleted);
 *   gateway -> client: the hello names the person's own Main chat; `sessions.list` keeps only visible
 *     chats and tags each with its owner; events about chats the person may not see are dropped.
 * Admin API (admins only): /tinker/door/api/{me,users,users/<id>/{rotate,revoke,delete,admin}}.
 *
 * Run: node door.mjs   (env: DOOR_PORT=18795 DOOR_BIND=127.0.0.1 DOOR_UPSTREAM=127.0.0.1:18789
 *       DOOR_STATE_DIR=... DOOR_TITLE=Agent DOOR_LEGACY_USERS=id1,id2 DOOR_SESSIONS_STORE=... )
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { ADMIN_ROLE, createAcl } from "./acl.mjs";
import {
  activeAdmins,
  addPerson,
  loadRows,
  saveRows,
  seedSeats,
  sha256Hex,
  newToken,
} from "./table.mjs";

export { sha256Hex };
export const PLACEHOLDER_TOKEN = "door-session";
export const SESSION_COOKIE = "tinker_door";
const SESSION_MS = 365 * 24 * 3600 * 1000;
const FAIL_LIMIT = 8;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const API = "/tinker/door/api/";

export function timingEq(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Find the ACTIVE row whose stored hash matches the presented token. Checks every row (no early exit). */
export function findRowByToken(rows, token) {
  if (typeof token !== "string" || token.length < 8 || token.length > 300) return null;
  const h = sha256Hex(token);
  let hit = null;
  for (const r of rows) {
    if (r.status === "active" && typeof r.hash === "string" && timingEq(r.hash, h) && !hit) hit = r;
  }
  return hit;
}

export function signSession(secret, row, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ t: row.tokenId, e: now + SESSION_MS })).toString(
    "base64url",
  );
  const mac = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

/** Returns the tokenId of a valid, unexpired session, else null. Revocation is checked by the caller. */
export function readSession(secret, cookieValue, now = Date.now()) {
  if (typeof cookieValue !== "string") return null;
  const [payload, mac] = cookieValue.split(".");
  if (!payload || !mac) return null;
  const want = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!timingEq(mac, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof p.t !== "string" || typeof p.e !== "number" || p.e < now) return null;
    return p.t;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Headers sent upstream: client identity/credentials removed, door-asserted ones added. */
export function upstreamHeaders(reqHeaders, row, gatewayToken) {
  const h = { ...reqHeaders };
  for (const k of Object.keys(h)) {
    const l = k.toLowerCase();
    if (l === "authorization" || l === "cookie" || l === "x-tinker-seat" || l === "accept-encoding")
      delete h[k];
    if (l.startsWith("x-forwarded-") || l === "forwarded" || l === "x-real-ip") delete h[k];
  }
  h.authorization = `Bearer ${gatewayToken}`;
  h["x-tinker-seat"] = row.seatId;
  return h;
}

/** Overwrite the token the page sent in its `connect` frame with the real one. Other frames pass untouched. */
export function rewriteClientFrame(text, gatewayToken) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return text;
  }
  if (obj && obj.type === "req" && obj.method === "connect") {
    obj.params = obj.params && typeof obj.params === "object" ? obj.params : {};
    obj.params.auth = { ...(obj.params.auth || {}), token: gatewayToken };
    return JSON.stringify(obj);
  }
  return text;
}

const SESSION_PARAM_NAMES = [
  "sessionKey",
  "parentSessionKey",
  "targetSessionKey",
  "childSessionKey",
  "requesterSessionKey",
  "fromSessionKey",
  "toSessionKey",
];

/** Every chat a request names. `key`/`keys` count only on chat and session methods. */
export function sessionKeysOf(method, params) {
  const out = [];
  if (!params || typeof params !== "object") return out;
  for (const n of SESSION_PARAM_NAMES) if (typeof params[n] === "string") out.push(params[n]);
  const sessionish = typeof method === "string" && /^(sessions|chat)\./.test(method);
  if (sessionish && typeof params.key === "string") out.push(params.key);
  for (const n of sessionish ? ["sessionKeys", "keys"] : ["sessionKeys"]) {
    if (Array.isArray(params[n])) for (const k of params[n]) if (typeof k === "string") out.push(k);
  }
  return out;
}

/** The chat an event is about, if any. */
export function eventSessionKey(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.sessionKey === "string") return payload.sessionKey;
  if (typeof payload.key === "string" && /^(agent|tinker):/.test(payload.key)) return payload.key;
  if (payload.session && typeof payload.session.key === "string") return payload.session.key;
  return null;
}

function loginPage(msg = "", rawTitle = process.env.DOOR_TITLE || "Agent") {
  const title = String(rawTitle).replace(/[<&>"]/g, "");
  const safe = String(msg).replace(
    /[<&>"]/g,
    (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;" })[c],
  );
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui;background:#f5ecd9;color:#3b2a1a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#fff8ea;border:1px solid #b08a5a;border-radius:10px;padding:26px 28px;width:320px}h1{margin:0 0 14px;font-size:20px}
input{width:100%;box-sizing:border-box;padding:9px;margin:6px 0 12px;border:1px solid #b08a5a;border-radius:6px;font-size:15px}
button{width:100%;padding:10px;border:0;border-radius:6px;background:#7a4e2a;color:#fff;font-size:15px;cursor:pointer}.m{color:#8a2a1a;margin:0 0 10px;font-size:14px}</style></head>
<body><form method="post" action="/tinker/login"><h1>${title}</h1>${msg ? `<p class="m">${safe}</p>` : ""}
<label>Your token</label><input name="token" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Enter</button></form></body></html>`;
}

function publicPerson(r, counts) {
  return {
    operatorId: r.operatorId,
    displayName: r.displayName,
    admin: Boolean(r.admin),
    status: r.status,
    tokenId: r.tokenId,
    createdAt: r.createdAt ?? null,
    rotatedAt: r.rotatedAt ?? null,
    revokedAt: r.revokedAt ?? null,
    deletedAt: r.deletedAt ?? null,
    lastLoginAt: r.lastLoginAt ?? null,
    chats: counts?.[r.operatorId] ?? 0,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {string} opts.upstream          "host:port" of the gateway
 * @param {string} opts.gatewayToken
 * @param {string} [opts.gatewayStoreFile] the gateway's sessions.json (legacy migration, parent lookup)
 * @param {string[]} [opts.legacyUsers]   people who keep seeing the chats that predate multi-user mode
 * @param {string} [opts.seatsFile]        operators.json the page reads for display names
 * @param {string} [opts.defaultAgent]
 */
export function createDoor(opts) {
  const stateDir = opts.stateDir;
  const tableFile = path.join(stateDir, "tokens.json");
  const auditFile = path.join(stateDir, "audit.jsonl");
  const secretFile = path.join(stateDir, "session.key");
  const [upHost, upPortStr] = opts.upstream.split(":");
  const upPort = Number(upPortStr);
  const gatewayToken = opts.gatewayToken;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(secretFile))
    fs.writeFileSync(secretFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const secret = fs.readFileSync(secretFile, "utf8").trim();
  const acl = createAcl({
    file: path.join(stateDir, "acl.json"),
    gatewayStoreFile: opts.gatewayStoreFile,
    legacyUsers: opts.legacyUsers ?? [],
    defaultAgent: opts.defaultAgent ?? "main",
  });

  // The table is re-read when its file changes, and the file is checked at most every 500 ms: the
  // WebSocket bridge asks on every frame, and a revocation still takes effect within half a second.
  let cache = { mtimeMs: -1, rows: [], checkedAt: 0 };
  function rows(fresh = false) {
    const now = Date.now();
    if (!fresh && now - cache.checkedAt < 500) return cache.rows;
    try {
      const st = fs.statSync(tableFile);
      if (st.mtimeMs !== cache.mtimeMs)
        cache = { mtimeMs: st.mtimeMs, rows: loadRows(tableFile), checkedAt: now };
      else cache.checkedAt = now;
    } catch {
      cache = { mtimeMs: -1, rows: [], checkedAt: now };
    }
    return cache.rows;
  }
  function writeRows(next) {
    saveRows(tableFile, next);
    cache = { mtimeMs: -1, rows: [], checkedAt: 0 };
    if (opts.seatsFile) {
      try {
        seedSeats(opts.seatsFile, next);
      } catch (err) {
        console.error("[door] seat seeding failed", err);
      }
    }
  }
  function audit(ev) {
    try {
      fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...ev }) + "\n");
    } catch (err) {
      console.error("[door] audit write failed", err);
    }
  }
  const fails = new Map();
  function limited(ip) {
    const f = fails.get(ip);
    return Boolean(f && f.resetAt > Date.now() && f.n >= FAIL_LIMIT);
  }
  function noteFail(ip) {
    const f = fails.get(ip);
    if (!f || f.resetAt <= Date.now())
      fails.set(ip, { n: 1, resetAt: Date.now() + FAIL_WINDOW_MS });
    else f.n += 1;
  }

  const userOf = (r) => ({ operatorId: r.operatorId, admin: Boolean(r.admin) });
  function rowById(tokenId, fresh = false) {
    return rows(fresh).find((r) => r.tokenId === tokenId && r.status === "active") ?? null;
  }
  /** HTTP and upgrades read the table fresh: a revocation stops the very next request. */
  function rowFor(req) {
    const c = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const tokenId = readSession(secret, c);
    return tokenId ? rowById(tokenId, true) : null;
  }

  async function readBody(req, limit = 8192) {
    const chunks = [];
    let size = 0;
    for await (const ch of req) {
      size += ch.length;
      if (size > limit) throw new Error("body too large");
      chunks.push(ch);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const json = (res, code, body) =>
    res
      .writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify(body));

  /** Admin API. Returns true when it handled the request. */
  async function handleApi(req, res, url, me) {
    const sub = url.pathname.slice(API.length).replace(/\/+$/, "");
    if (sub === "me" && req.method === "GET") {
      json(res, 200, {
        operatorId: me.operatorId,
        displayName: me.displayName,
        admin: Boolean(me.admin),
        mainSessionKey: acl.mainKeyFor(me.operatorId),
        multiUser: true,
      });
      return true;
    }
    if (!me.admin) {
      json(res, 403, { error: "admins only" });
      return true;
    }
    if (
      req.method === "POST" &&
      !String(req.headers["content-type"] ?? "").includes("application/json")
    ) {
      json(res, 415, { error: "send application/json" });
      return true;
    }
    const counts = acl.countsByOwner();
    if (sub === "users" && req.method === "GET") {
      json(res, 200, {
        users: rows().map((r) => publicPerson(r, counts)),
        legacyChats: counts.legacy ?? 0,
      });
      return true;
    }
    if (sub === "users" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const {
          rows: next,
          row,
          token,
        } = addPerson(rows(), {
          displayName: body.displayName,
          admin: body.admin === true,
        });
        writeRows(next);
        audit({ ev: "user_add", by: me.operatorId, operatorId: row.operatorId, admin: row.admin });
        json(res, 200, { user: publicPerson(row, counts), token });
      } catch (err) {
        json(res, 400, { error: String(err.message ?? err) });
      }
      return true;
    }
    const m = /^users\/([A-Za-z0-9._:-]{1,80})\/(rotate|revoke|delete|admin)$/.exec(sub);
    if (m && req.method === "POST") {
      const [, id, action] = m;
      const all = rows().map((r) => ({ ...r }));
      const r = all.find((x) => x.operatorId === id);
      if (!r) {
        json(res, 404, { error: "no such person" });
        return true;
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const at = new Date().toISOString();
      const losesAdmin =
        (action === "revoke" ||
          action === "delete" ||
          (action === "admin" && body.admin === false)) &&
        r.admin &&
        r.status === "active";
      if (losesAdmin && activeAdmins(all).length <= 1) {
        json(res, 409, { error: "the last admin cannot lose admin rights or access" });
        return true;
      }
      if ((action === "revoke" || action === "delete") && id === me.operatorId) {
        json(res, 409, { error: "you cannot remove your own access" });
        return true;
      }
      let token;
      if (action === "rotate") {
        token = newToken();
        r.hash = sha256Hex(token);
        r.status = "active";
        r.rotatedAt = at;
        delete r.revokedAt;
        delete r.deletedAt;
      } else if (action === "revoke") {
        r.status = "revoked";
        r.revokedAt = at;
      } else if (action === "delete") {
        r.status = "deleted";
        r.deletedAt = at;
      } else if (action === "admin") {
        r.admin = body.admin === true;
      }
      writeRows(all);
      audit({ ev: `user_${action}`, by: me.operatorId, operatorId: id, admin: r.admin });
      json(res, 200, { user: publicPerson(r, counts), ...(token ? { token } : {}) });
      return true;
    }
    json(res, 404, { error: "unknown admin call" });
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? "?";
    const url = new URL(req.url ?? "/", "http://door");
    try {
      if (url.pathname === "/tinker/login" || url.pathname === "/tinker/login/") {
        if (req.method === "GET") {
          if (rowFor(req)) {
            res.writeHead(303, { Location: "/tinker/" }).end();
            return;
          }
          res
            .writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            })
            .end(loginPage());
          return;
        }
        if (req.method === "POST") {
          if (limited(ip)) {
            audit({ ev: "login_limited", ip });
            res
              .writeHead(429, { "Content-Type": "text/html; charset=utf-8" })
              .end(loginPage("Too many tries. Wait a few minutes."));
            return;
          }
          const ctype = String(req.headers["content-type"] ?? "");
          const raw = await readBody(req);
          const token = ctype.includes("application/json")
            ? String(JSON.parse(raw || "{}").token ?? "")
            : (new URLSearchParams(raw).get("token") ?? "");
          const row = findRowByToken(rows(), token.trim());
          if (!row) {
            noteFail(ip);
            audit({ ev: "login_fail", ip });
            res
              .writeHead(401, { "Content-Type": "text/html; charset=utf-8" })
              .end(loginPage("That token does not open this house."));
            return;
          }
          audit({ ev: "login_ok", ip, tokenId: row.tokenId, operatorId: row.operatorId });
          writeRows(
            rows().map((r) =>
              r.tokenId === row.tokenId ? { ...r, lastLoginAt: new Date().toISOString() } : r,
            ),
          );
          const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
          res
            .writeHead(303, {
              Location: "/tinker/",
              "Set-Cookie": `${SESSION_COOKIE}=${signSession(secret, row)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
            })
            .end();
          return;
        }
        res.writeHead(405).end("Method not allowed");
        return;
      }
      if (url.pathname === "/tinker/logout") {
        res
          .writeHead(303, {
            Location: "/tinker/login",
            "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
          })
          .end();
        return;
      }
      const row = rowFor(req);
      if (!row) {
        const wantsHtml =
          req.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
        if (wantsHtml) res.writeHead(303, { Location: "/tinker/login" }).end();
        else json(res, 401, { error: "unauthorized" });
        return;
      }
      if (url.pathname === "/") {
        res.writeHead(303, { Location: "/tinker/" }).end();
        return;
      }
      if (url.pathname.startsWith(API)) {
        try {
          await handleApi(req, res, url, row);
        } catch (err) {
          console.error("[door] admin api error", err);
          if (!res.headersSent) json(res, 500, { error: "door error" });
        }
        return;
      }
      // The page saves tabs and panel state at the root path /api/ui-state; behind the gateway plugin
      // that endpoint lives at /tinker/api/ui-state. Map it so each person's state persists.
      const upPath =
        url.pathname === "/api/ui-state" ? `/tinker/api/ui-state${url.search}` : req.url;
      const up = http.request(
        {
          host: upHost,
          port: upPort,
          method: req.method,
          path: upPath,
          headers: upstreamHeaders(req.headers, row, gatewayToken),
        },
        (ur) => {
          const ctype = String(ur.headers["content-type"] ?? "");
          const headers = { ...ur.headers };
          delete headers["set-cookie"]; // the upstream login cookies carry the gateway token: never to the browser
          if (ctype.includes("text/html")) {
            const bufs = [];
            ur.on("data", (d) => bufs.push(d));
            ur.on("end", () => {
              const body = Buffer.concat(bufs)
                .toString("utf8")
                .split(gatewayToken)
                .join(PLACEHOLDER_TOKEN);
              delete headers["content-length"];
              delete headers["content-encoding"];
              res.writeHead(ur.statusCode ?? 502, headers).end(body);
            });
            return;
          }
          res.writeHead(ur.statusCode ?? 502, headers);
          ur.pipe(res);
        },
      );
      up.on("error", (err) => {
        console.error("[door] upstream error", err.message);
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("gateway unavailable");
      });
      req.pipe(up);
    } catch (err) {
      console.error("[door] request error", err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  /** Owner tag for one row of `sessions.list`, as the admin view groups by it. */
  function ownerTag(key) {
    const e = acl.entry(key);
    if (!e) return { hiveOwner: null, hiveOwnerName: "System", hiveScope: "system" };
    if (e.legacy && !e.owner)
      return { hiveOwner: null, hiveOwnerName: "Shared (before multi-user)", hiveScope: "legacy" };
    const person = rows().find((r) => r.operatorId === e.owner);
    const name = person?.displayName ?? e.owner ?? "System";
    const gone = person && person.status !== "active" ? ` (${person.status})` : "";
    const scope = (e.visibleTo ?? []).includes(ADMIN_ROLE) ? "user" : "private";
    return { hiveOwner: e.owner ?? null, hiveOwnerName: name + gone, hiveScope: scope };
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const row = rowFor(req);
    if (!row) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const headers = upstreamHeaders(req.headers, row, gatewayToken);
      for (const k of [
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "upgrade",
        "connection",
        "sec-websocket-protocol",
      ])
        delete headers[k];
      const upstream = new WebSocket(`ws://${upHost}:${upPort}${req.url}`, { headers });
      const pending = [];
      const tracked = new Map(); // request id -> method, for replies the door rewrites
      let open = false;
      audit({ ev: "ws_open", operatorId: row.operatorId, tokenId: row.tokenId });
      upstream.on("open", () => {
        open = true;
        for (const m of pending.splice(0)) upstream.send(m.data, { binary: m.isBinary });
      });
      const toUpstream = (data, isBinary) => {
        if (open) upstream.send(data, { binary: isBinary });
        else pending.push({ data, isBinary });
      };
      const reply = (id, ok, payloadOrError) =>
        client.readyState === WebSocket.OPEN &&
        client.send(
          JSON.stringify(
            ok
              ? { type: "res", id, ok: true, payload: payloadOrError }
              : { type: "res", id, ok: false, error: payloadOrError },
          ),
        );
      const closeBoth = () => {
        try {
          client.close();
        } catch {}
        try {
          upstream.close();
        } catch {}
      };

      client.on("message", (data, isBinary) => {
        // Revoked or deleted while connected: the door closes the connection at the next frame.
        const live = rowById(row.tokenId);
        if (!live) {
          audit({ ev: "ws_closed_revoked", operatorId: row.operatorId });
          closeBoth();
          return;
        }
        const user = userOf(live);
        if (isBinary) {
          toUpstream(data, true);
          return;
        }
        const text = data.toString("utf8");
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          toUpstream(text, false);
          return;
        }
        if (!frame || frame.type !== "req" || typeof frame.method !== "string") {
          toUpstream(text, false);
          return;
        }
        const { id, method, params } = frame;
        if (method === "connect") {
          tracked.set(id, method);
          toUpstream(rewriteClientFrame(text, gatewayToken), false);
          return;
        }
        for (const k of sessionKeysOf(method, params)) {
          const d = acl.authorize(user, k);
          if (!d.ok) {
            audit({ ev: "ws_denied", operatorId: user.operatorId, method, key: d.key });
            reply(id, false, {
              code: "INVALID_REQUEST",
              message: "This chat belongs to someone else.",
            });
            return;
          }
        }
        if (method === "sessions.delete" && !user.admin) {
          // A regular user's delete hides the chat for them only. The chat and its history stay.
          const k = params?.key ?? params?.sessionKey;
          acl.hideFor(user, k);
          audit({ ev: "chat_hidden", operatorId: user.operatorId, key: acl.canon(k) });
          reply(id, true, { ok: true, key: acl.canon(k), deleted: true, hiddenOnlyForYou: true });
          return;
        }
        if (
          method === "sessions.list" ||
          method === "sessions.create" ||
          method === "sessions.fork" ||
          method === "sessions.delete"
        ) {
          tracked.set(id, { method, params, user });
        }
        toUpstream(text, false);
      });

      upstream.on("message", (data, isBinary) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (isBinary) {
          client.send(data, { binary: true });
          return;
        }
        const live = rowById(row.tokenId);
        if (!live) {
          closeBoth();
          return;
        }
        const user = userOf(live);
        const text = data.toString("utf8");
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          client.send(text);
          return;
        }
        if (frame?.type === "event") {
          const k = eventSessionKey(frame.payload);
          if (k && !acl.canSee(user, k)) return; // someone else's chat: not for this person
          client.send(text);
          return;
        }
        if (frame?.type === "res" && tracked.has(frame.id)) {
          const t = tracked.get(frame.id);
          tracked.delete(frame.id);
          const method = typeof t === "string" ? t : t.method;
          if (frame.ok && frame.payload && typeof frame.payload === "object") {
            const p = frame.payload;
            if (method === "connect") {
              const mine = acl.mainKeyFor(user.operatorId);
              acl.claim(user, mine);
              if (p.snapshot?.sessionDefaults) p.snapshot.sessionDefaults.mainSessionKey = mine;
            } else if (method === "sessions.list" && Array.isArray(p.sessions)) {
              p.sessions = p.sessions
                .filter((s) => s && typeof s.key === "string" && acl.canSee(user, s.key))
                .map((s) => ({ ...s, ...ownerTag(s.key) }));
              p.count = p.sessions.length;
              if (p.defaults && typeof p.defaults === "object" && "mainSessionKey" in p.defaults)
                p.defaults.mainSessionKey = acl.mainKeyFor(user.operatorId);
            } else if ((method === "sessions.create" || method === "sessions.fork") && p.key) {
              acl.claim(user, p.key);
            } else if (method === "sessions.delete" && user.admin) {
              const k = t.params?.key ?? t.params?.sessionKey;
              acl.markDeletedByAdmin(user, k);
              audit({
                ev: "chat_deleted_by_admin",
                operatorId: user.operatorId,
                key: acl.canon(k),
              });
            }
            client.send(JSON.stringify(frame));
            return;
          }
        }
        client.send(text);
      });
      client.on("close", closeBoth);
      upstream.on("close", closeBoth);
      client.on("error", closeBoth);
      upstream.on("error", (err) => {
        console.error("[door] upstream ws error", err.message);
        closeBoth();
      });
    });
  });
  return { server, rows, audit, tableFile, acl };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const home = os.homedir();
  const stateDir = process.env.DOOR_STATE_DIR ?? path.join(home, ".openclaw", "data", "door");
  const upstream = process.env.DOOR_UPSTREAM ?? "127.0.0.1:18789";
  let gatewayToken = process.env.DOOR_GATEWAY_TOKEN ?? "";
  if (!gatewayToken) {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, ".openclaw", "openclaw.json"), "utf8"));
    gatewayToken = cfg?.gateway?.auth?.token ?? "";
  }
  if (!gatewayToken) {
    console.error(
      "[door] no gateway token found (DOOR_GATEWAY_TOKEN or openclaw.json gateway.auth.token)",
    );
    process.exit(1);
  }
  const port = Number(process.env.DOOR_PORT ?? 18795);
  // Loopback by default (put your own proxy/tunnel in front); set DOOR_BIND to a LAN address to serve people directly.
  const bind = process.env.DOOR_BIND ?? "127.0.0.1";
  const { server } = createDoor({
    stateDir,
    upstream,
    gatewayToken,
    gatewayStoreFile:
      process.env.DOOR_SESSIONS_STORE ??
      path.join(home, ".openclaw", "agents", "main", "sessions", "sessions.json"),
    legacyUsers: (process.env.DOOR_LEGACY_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    seatsFile: path.join(home, ".openclaw", "data", "seats", "operators.json"),
  });
  server.listen(port, bind, () =>
    console.log(`[door] ${bind}:${port} -> ${upstream}, state ${stateDir}`),
  );
}
