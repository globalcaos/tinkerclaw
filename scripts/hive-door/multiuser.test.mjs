// node --test scripts/hive-door/multiuser.test.mjs
// The owner's multi-user rules, end to end through the door against a fake gateway.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createDoor } from "./door.mjs";
import { rememberToken, sha256Hex } from "./table.mjs";

const GW = "REAL-GATEWAY-SECRET-0987654321";
const T = {
  alice: "alice-token-aaaaaaaa",
  bob: "bob-token-bbbbbbbb",
  carol: "carol-token-cccccccc",
};
let tmp, tableFile, upstream, upPort, door, port;
const upSeen = []; // every request frame the fake gateway received: { method, params }
const upHttp = []; // every HTTP request: { url, seat }
const sockets = new Set();
const liveKeys = new Set();

function gatewayStore() {
  return {
    "agent:main:main": { sessionId: "m" },
    "agent:main:tinker:old1": { sessionId: "o1" },
    "agent:main:cron:nightly": { sessionId: "c" },
    "agent:main:subagent:s1": { sessionId: "s", spawnedBy: "agent:main:tinker:old1" },
  };
}

function httpReq(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const b = [];
      res.on("data", (d) => b.push(d));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(b).toString(),
        }),
      );
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
async function cookieFor(token) {
  const r = await httpReq("POST", "/tinker/login", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(token)}`,
  });
  return r.headers["set-cookie"]?.[0]?.split(";")[0];
}
const api = (cookie, method, p, body) =>
  httpReq(method, `/tinker/door/api/${p}`, {
    headers: { cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => ({ status: r.status, json: r.body ? JSON.parse(r.body) : null }));

async function connectAs(token) {
  const cookie = await cookieFor(token);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie } });
  const events = [];
  const waiting = new Map();
  let n = 0;
  ws.on("message", (m) => {
    const f = JSON.parse(m.toString());
    if (f.type === "event") events.push(f);
    if (f.type === "res" && waiting.has(f.id)) {
      waiting.get(f.id)(f);
      waiting.delete(f.id);
    }
  });
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = `r${++n}`;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ type: "req", id, method, params }));
      setTimeout(() => reject(new Error(`timeout ${method}`)), 3000);
    });
  const hello = await call("connect", {
    auth: { token: "door-session" },
    client: { id: "webchat-ui", displayName: "Tinker UI" },
  });
  return { ws, call, events, hello, cookie };
}
const keysOf = (res) => res.payload.sessions.map((s) => s.key).sort();
const settle = () => new Promise((r) => setTimeout(r, 120));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "door-mu-"));
  tableFile = path.join(tmp, "tokens.json");
  const row = (id, admin) => ({
    tokenId: `t_${id}`,
    operatorId: id,
    displayName: id[0].toUpperCase() + id.slice(1),
    seatId: id,
    hash: sha256Hex(T[id]),
    status: "active",
    admin,
  });
  fs.writeFileSync(
    tableFile,
    JSON.stringify([row("alice", true), row("bob", false), row("carol", false)]),
  );
  const storeFile = path.join(tmp, "sessions.json");
  fs.writeFileSync(storeFile, JSON.stringify(gatewayStore()));
  for (const k of Object.keys(gatewayStore())) liveKeys.add(k);

  upstream = http.createServer((q, s) => {
    upHttp.push({ url: q.url, seat: q.headers["x-tinker-seat"] });
    s.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (m) => {
      const f = JSON.parse(m.toString());
      upSeen.push({ method: f.method, params: f.params });
      let payload = { echo: f.method };
      if (f.method === "connect")
        payload = { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } };
      if (f.method === "chat.send")
        liveKeys.add(
          f.params.sessionKey.startsWith("agent:")
            ? f.params.sessionKey
            : `agent:main:${f.params.sessionKey}`,
        );
      if (f.method === "sessions.list")
        payload = { count: liveKeys.size, sessions: [...liveKeys].map((key) => ({ key })) };
      if (f.method === "sessions.delete") liveKeys.delete(f.params.key);
      if (f.method === "test.emit") {
        for (const k of f.params.keys)
          for (const c of sockets)
            c.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { sessionKey: k, state: "delta" },
              }),
            );
      }
      ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upPort = upstream.address().port;
  door = createDoor({
    stateDir: tmp,
    upstream: `127.0.0.1:${upPort}`,
    gatewayToken: GW,
    gatewayStoreFile: storeFile,
    legacyUsers: ["bob"],
    seatsFile: path.join(tmp, "operators.json"),
  });
  await new Promise((r) => door.server.listen(0, "127.0.0.1", r));
  port = door.server.address().port;
});
after(() => {
  door.server.close();
  upstream.close();
});

describe("multi-user door", () => {
  let alice, bob, carol;

  it("each person gets their own Main chat in the hello", async () => {
    alice = await connectAs(T.alice);
    bob = await connectAs(T.bob);
    carol = await connectAs(T.carol);
    assert.equal(
      alice.hello.payload.snapshot.sessionDefaults.mainSessionKey,
      "agent:main:hive:alice:main",
    );
    assert.equal(
      bob.hello.payload.snapshot.sessionDefaults.mainSessionKey,
      "agent:main:hive:bob:main",
    );
    assert.equal(upSeen.find((f) => f.method === "connect").params.auth.token, GW);
  });

  it("the agent is told who is talking: the door sets the client's name from the token", () => {
    const names = upSeen
      .filter((f) => f.method === "connect")
      .map((f) => f.params.client.displayName);
    assert.deepEqual(names.slice(0, 3), ["Alice", "Bob", "Carol"]);
  });

  it("a user's new chat: that user and the admins see it, nobody else", async () => {
    assert.equal(
      (await bob.call("chat.send", { sessionKey: "tinker:b1", message: "hi" })).ok,
      true,
    );
    const refused = await carol.call("chat.history", { sessionKey: "tinker:b1" });
    assert.equal(refused.ok, false);
    assert.match(refused.error.message, /someone else/);
    assert.equal(upSeen.filter((f) => f.method === "chat.history").length, 0);
    assert.equal(
      (await alice.call("chat.history", { sessionKey: "agent:main:tinker:b1" })).ok,
      true,
    );
  });

  it("an admin's new chat is private to that admin", async () => {
    await alice.call("chat.send", { sessionKey: "tinker:a1", message: "secret" });
    assert.equal((await bob.call("chat.history", { sessionKey: "tinker:a1" })).ok, false);
    assert.equal((await carol.call("chat.history", { sessionKey: "tinker:a1" })).ok, false);
  });

  it("session lists are per person and the admin's carries owner tags", async () => {
    const b = keysOf(await bob.call("sessions.list"));
    assert.deepEqual(
      b,
      [
        "agent:main:hive:bob:main",
        "agent:main:main",
        "agent:main:subagent:s1",
        "agent:main:tinker:b1",
        "agent:main:tinker:old1",
      ]
        .filter((k) => liveKeys.has(k))
        .sort(),
    );
    assert.ok(!b.includes("agent:main:cron:nightly"));
    assert.ok(!b.includes("agent:main:tinker:a1"));
    const c = keysOf(await carol.call("sessions.list"));
    assert.ok(!c.includes("agent:main:main"), "legacy chats only for the legacy users");
    const a = await alice.call("sessions.list");
    const tag = Object.fromEntries(a.payload.sessions.map((s) => [s.key, s]));
    assert.equal(tag["agent:main:tinker:b1"].hiveOwner, "bob");
    assert.equal(tag["agent:main:tinker:b1"].hiveOwnerName, "Bob");
    assert.equal(tag["agent:main:tinker:a1"].hiveScope, "private");
    assert.equal(tag["agent:main:main"].hiveScope, "legacy");
    assert.ok(tag["agent:main:cron:nightly"]);
    assert.equal(a.payload.count, a.payload.sessions.length);
  });

  it("streamed events reach only the people who may see that chat", async () => {
    for (const p of [alice, bob, carol]) p.events.length = 0;
    await alice.call("test.emit", { keys: ["agent:main:tinker:a1", "agent:main:tinker:b1"] });
    await settle();
    const seen = (p) => p.events.map((e) => e.payload.sessionKey).sort();
    assert.deepEqual(seen(alice), ["agent:main:tinker:a1", "agent:main:tinker:b1"]);
    assert.deepEqual(seen(bob), ["agent:main:tinker:b1"]);
    assert.deepEqual(seen(carol), []);
  });

  it("a user's delete only hides the chat for them; the admin still sees it", async () => {
    const before = upSeen.filter((f) => f.method === "sessions.delete").length;
    const r = await bob.call("sessions.delete", {
      key: "agent:main:tinker:b1",
      deleteTranscript: false,
    });
    assert.equal(r.ok, true);
    assert.equal(
      upSeen.filter((f) => f.method === "sessions.delete").length,
      before,
      "never reached the gateway",
    );
    assert.ok(!keysOf(await bob.call("sessions.list")).includes("agent:main:tinker:b1"));
    assert.ok(keysOf(await alice.call("sessions.list")).includes("agent:main:tinker:b1"));
  });

  it("an admin's delete really deletes (the gateway archives it)", async () => {
    const r = await alice.call("sessions.delete", {
      key: "agent:main:tinker:b1",
      deleteTranscript: false,
    });
    assert.equal(r.ok, true);
    assert.ok(
      upSeen.some((f) => f.method === "sessions.delete" && f.params.key === "agent:main:tinker:b1"),
    );
    assert.ok(!keysOf(await alice.call("sessions.list")).includes("agent:main:tinker:b1"));
  });

  it("tab and page state is saved per person at the path the page uses", async () => {
    await httpReq("GET", "/api/ui-state", {
      headers: { cookie: bob.cookie, "x-tinker-seat": "alice" },
    });
    const last = upHttp.at(-1);
    assert.equal(last.url, "/tinker/api/ui-state");
    assert.equal(last.seat, "bob");
  });

  it("admin API: regular users are refused; admins add, rotate, revoke and delete people", async () => {
    assert.equal((await api(bob.cookie, "GET", "users")).status, 403);
    assert.equal((await api(bob.cookie, "GET", "me")).json.admin, false);
    const list = await api(alice.cookie, "GET", "users");
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.json).includes("hash"), "hashes never leave the door");
    const add = await api(alice.cookie, "POST", "users", { displayName: "Dan Smith" });
    assert.equal(add.status, 200);
    assert.equal(add.json.user.operatorId, "dan-smith");
    assert.ok(await cookieFor(add.json.token), "the new token opens the door");
    const rot = await api(alice.cookie, "POST", "users/dan-smith/rotate", {});
    assert.equal(await cookieFor(add.json.token), undefined, "old token stops");
    assert.ok(await cookieFor(rot.json.token));
    await api(alice.cookie, "POST", "users/dan-smith/revoke", {});
    assert.equal(await cookieFor(rot.json.token), undefined);
    const del = await api(alice.cookie, "POST", "users/dan-smith/delete", {});
    assert.equal(del.json.user.status, "deleted");
    assert.ok(
      JSON.parse(fs.readFileSync(tableFile, "utf8")).some((r) => r.operatorId === "dan-smith"),
      "row kept",
    );
    assert.ok(
      JSON.parse(fs.readFileSync(path.join(tmp, "operators.json"), "utf8")).some(
        (o) => o.deviceId === "dan-smith",
      ),
    );
  });

  it("an admin can copy a person's current token; nobody else can, and lists never carry it", async () => {
    const add = await api(alice.cookie, "POST", "users", { displayName: "Copy Me" });
    const id = add.json.user.operatorId;
    assert.equal(add.json.user.hasToken, true);
    assert.equal((await api(bob.cookie, "GET", `users/${id}/token`)).status, 403);
    const got = await api(alice.cookie, "GET", `users/${id}/token`);
    assert.equal(got.status, 200);
    assert.equal(got.json.token, add.json.token, "the same token the add showed");
    const list = JSON.stringify((await api(alice.cookie, "GET", "users")).json);
    assert.ok(!list.includes(add.json.token), "a list never carries a token");
    const rot = await api(alice.cookie, "POST", `users/${id}/rotate`, {});
    assert.equal((await api(alice.cookie, "GET", `users/${id}/token`)).json.token, rot.json.token);
    await api(alice.cookie, "POST", `users/${id}/revoke`, {});
    assert.equal(
      (await api(alice.cookie, "GET", `users/${id}/token`)).status,
      409,
      "no copy of a token that no longer opens the door",
    );
  });

  it("rememberToken keeps a pre-existing token only when it matches the stored hash", () => {
    const table = [{ operatorId: "old", hash: sha256Hex("tok-old-123"), status: "active" }];
    assert.throws(() => rememberToken(table, "old", "some-other-token"));
    assert.equal(rememberToken(table, "old", "tok-old-123").token, "tok-old-123");
  });

  it("admin is a property: the last admin cannot lose it; a granted admin sees users' chats, not other admins' private ones", async () => {
    assert.equal(
      (await api(alice.cookie, "POST", "users/alice/admin", { admin: false })).status,
      409,
    );
    assert.equal(
      (await api(alice.cookie, "POST", "users/carol/admin", { admin: true })).status,
      200,
    );
    await settle();
    await new Promise((r) => setTimeout(r, 550)); // the door re-reads the table at most every 500 ms
    assert.equal(
      (await carol.call("chat.history", { sessionKey: "tinker:a1" })).ok,
      false,
      "alice's private chat stays private",
    );
    await bob.call("chat.send", { sessionKey: "tinker:b2", message: "x" });
    assert.equal((await carol.call("chat.history", { sessionKey: "tinker:b2" })).ok, true);
    assert.equal((await api(carol.cookie, "GET", "users")).status, 200);
  });

  it("revoking a person closes their open connection", async () => {
    await api(alice.cookie, "POST", "users/bob/revoke", {});
    await new Promise((r) => setTimeout(r, 550));
    const closed = new Promise((r) => bob.ws.on("close", () => r(true)));
    bob.ws.send(JSON.stringify({ type: "req", id: "x", method: "sessions.list", params: {} }));
    assert.equal(
      await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 2000))]),
      true,
    );
    for (const p of [alice, carol]) p.ws.close();
  });
});
