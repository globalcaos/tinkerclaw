// node --test scripts/hive-door/door.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { PLACEHOLDER_TOKEN, createDoor, sha256Hex } from "./door.mjs";

const GATEWAY_TOKEN = "REAL-GATEWAY-SECRET-1234567890";
const ALICE = "alice-personal-token-aaaa";
const BOB = "bob-personal-token-bbbb";

let tmp, upstreamServer, upstreamPort, seenHttp, seenWs, door, doorPort, tableFile;

function req(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: doorPort, method, path: urlPath, headers },
      (res) => {
        const bufs = [];
        res.on("data", (d) => bufs.push(d));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(bufs).toString("utf8"),
          }),
        );
      },
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
async function login(token) {
  const r = await req("POST", "/tinker/login", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(token)}`,
  });
  const c = r.headers["set-cookie"]?.[0]?.split(";")[0];
  return { r, cookie: c };
}
function rows() {
  return JSON.parse(fs.readFileSync(tableFile, "utf8"));
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "door-"));
  tableFile = path.join(tmp, "tokens.json");
  fs.writeFileSync(
    tableFile,
    JSON.stringify([
      {
        tokenId: "t_alice",
        operatorId: "alice",
        displayName: "alice",
        seatId: "alice",
        hash: sha256Hex(ALICE),
        status: "active",
      },
      {
        tokenId: "t_bob",
        operatorId: "bob",
        displayName: "Bob",
        seatId: "bob",
        hash: sha256Hex(BOB),
        status: "active",
      },
    ]),
  );
  seenHttp = [];
  seenWs = { frames: [], headers: null };
  upstreamServer = http.createServer((q, s) => {
    seenHttp.push({ url: q.url, headers: q.headers });
    if (q.url.startsWith("/tinker/") && !q.url.includes("api")) {
      s.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": `tinker_gateway=${GATEWAY_TOKEN}`,
      });
      s.end(`<html><script>window.__TINKER_CONFIG={"token":"${GATEWAY_TOKEN}"}</script></html>`);
    } else {
      s.writeHead(200, { "content-type": "application/json" });
      s.end("{}");
    }
  });
  const wss = new WebSocketServer({ server: upstreamServer });
  wss.on("connection", (ws, q) => {
    seenWs.headers = q.headers;
    ws.on("message", (m) => {
      seenWs.frames.push(m.toString());
      ws.send("echo:" + m.toString());
    });
  });
  await new Promise((r) => upstreamServer.listen(0, "127.0.0.1", r));
  upstreamPort = upstreamServer.address().port;
  door = createDoor({
    stateDir: tmp,
    upstream: `127.0.0.1:${upstreamPort}`,
    gatewayToken: GATEWAY_TOKEN,
  });
  await new Promise((r) => door.server.listen(0, "127.0.0.1", r));
  doorPort = door.server.address().port;
});
after(() => {
  door.server.close();
  upstreamServer.close();
});

describe("door", () => {
  it("login page asks for a token only, never a name", async () => {
    const r = await req("GET", "/tinker/login");
    assert.equal(r.status, 200);
    assert.match(r.body, /name="token"/);
    assert.doesNotMatch(r.body, /name="name"/);
  });

  it("without a session: HTML goes to login, API and WebSocket are refused", async () => {
    assert.equal((await req("GET", "/tinker/", { headers: { accept: "text/html" } })).status, 303);
    assert.equal((await req("GET", "/tinker/api/ui-state")).status, 401);
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${doorPort}/`);
      ws.on("unexpected-response", (_q, res) => {
        assert.equal(res.statusCode, 401);
        resolve();
      });
      ws.on("error", () => resolve());
    });
  });

  it("a wrong token does not open the door and is audited", async () => {
    const { r, cookie } = await login("not-a-real-token-123");
    assert.equal(r.status, 401);
    assert.match(r.body, /does not open this house/);
    assert.equal(cookie, undefined);
    assert.match(fs.readFileSync(path.join(tmp, "audit.jsonl"), "utf8"), /login_fail/);
  });

  it("the gateway's own secret is not a person's token", async () => {
    assert.equal((await login(GATEWAY_TOKEN)).r.status, 401);
  });

  it("each token maps to its own person; forged seat/authorization headers are replaced", async () => {
    const { cookie } = await login(BOB);
    assert.ok(cookie);
    await req("GET", "/tinker/api/seat", {
      headers: { cookie, "x-tinker-seat": "alice", authorization: "Bearer evil" },
    });
    const got = seenHttp.at(-1).headers;
    assert.equal(got["x-tinker-seat"], "bob");
    assert.equal(got.authorization, `Bearer ${GATEWAY_TOKEN}`);
    assert.equal(got.cookie, undefined);
  });

  it("the gateway secret never reaches the page or its cookies", async () => {
    const { cookie } = await login(ALICE);
    const r = await req("GET", "/tinker/", { headers: { cookie, accept: "text/html" } });
    assert.equal(r.status, 200);
    assert.ok(!r.body.includes(GATEWAY_TOKEN));
    assert.ok(r.body.includes(PLACEHOLDER_TOKEN));
    assert.equal(r.headers["set-cookie"], undefined);
  });

  it("chat WebSocket: the connect frame carries the real token, identity comes from the door", async () => {
    const { cookie } = await login(ALICE);
    const msgs = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${doorPort}/`, {
        headers: { cookie, "x-tinker-seat": "bob" },
      });
      const out = [];
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "req",
            id: "1",
            method: "connect",
            params: { auth: { token: PLACEHOLDER_TOKEN }, client: "tinker" },
          }),
        );
        ws.send(
          JSON.stringify({
            type: "req",
            id: "2",
            method: "chat.history",
            params: { sessionKey: "k" },
          }),
        );
      });
      ws.on("message", (m) => {
        out.push(m.toString());
        if (out.length === 2) {
          ws.close();
          resolve(out);
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 4000);
    });
    assert.equal(msgs.length, 2);
    const connect = JSON.parse(seenWs.frames[0]);
    assert.equal(connect.params.auth.token, GATEWAY_TOKEN);
    assert.equal(connect.params.client, "tinker");
    assert.equal(JSON.parse(seenWs.frames[1]).method, "chat.history");
    assert.equal(seenWs.headers["x-tinker-seat"], "alice");
    assert.equal(seenWs.headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
  });

  it("revoking a token stops that person's existing session at once", async () => {
    const { cookie } = await login(BOB);
    assert.equal((await req("GET", "/tinker/api/seat", { headers: { cookie } })).status, 200);
    const t = rows();
    t.find((x) => x.tokenId === "t_bob").status = "revoked";
    fs.writeFileSync(tableFile, JSON.stringify(t));
    fs.utimesSync(tableFile, new Date(), new Date(Date.now() + 5000));
    assert.equal((await req("GET", "/tinker/api/seat", { headers: { cookie } })).status, 401);
    assert.equal((await login(BOB)).r.status, 401);
  });

  it("a forged or tampered session cookie is refused", async () => {
    const { cookie } = await login(ALICE);
    const forged = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    assert.equal(
      (await req("GET", "/tinker/api/seat", { headers: { cookie: forged } })).status,
      401,
    );
  });

  it("repeated wrong tokens get rate limited", async () => {
    let last;
    for (let i = 0; i < 10; i++) last = (await login("wrong-token-" + i + "-xxxxxx")).r;
    assert.equal(last.status, 429);
    assert.match(last.body, /Too many tries/);
  });
});
