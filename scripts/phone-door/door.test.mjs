// node --test scripts/phone-door/door.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  addDevice,
  apkNameOk,
  backupRelPath,
  checkBind,
  createDoor,
  devicesFile,
  issuePairCode,
  loadRows,
  packNameOk,
  pairCodesFile,
  revokeDevice,
  saveRows,
  upstreamHeaders,
} from "./door.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GW = "FAKE-GATEWAY-TOKEN-0123456789";

let tmp, dir, tripDir, upstream, upPort, lastUpgrade, door, doorPort, phone, liveSockets;

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
}

function req(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      const bufs = [];
      res.on("data", (d) => bufs.push(d));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(bufs).toString("utf8"),
        }),
      );
    });
    r.on("error", reject);
    if (body) {
      r.write(body);
    }
    r.end();
  });
}
const get = (urlPath, opts) => req(doorPort, "GET", urlPath, opts);
const form = (port, urlPath, fields, headers = {}) =>
  req(port, "POST", urlPath, {
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Upgrade through the door; resolves { status, echo } (echo = what came back for "ping"). */
function upgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: `http://127.0.0.1:${port}`,
        ...headers,
      },
    });
    r.on("upgrade", (res, socket) => {
      socket.once("data", (d) => {
        socket.destroy();
        resolve({ status: res.statusCode, echo: d.toString("utf8") });
      });
      socket.write("ping");
    });
    r.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    r.on("error", reject);
    r.end();
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-door-"));
  dir = path.join(tmp, "door");
  tripDir = path.join(tmp, "trip");
  upstream = http.createServer((q, s) => {
    if (q.url === "/sse") {
      s.writeHead(200, { "Content-Type": "text/event-stream" });
      s.write("data: 0\n\n");
      const t = setInterval(() => s.write("data: tick\n\n"), 50);
      s.on("close", () => clearInterval(t));
      return;
    }
    if (q.url === "/slow-body") {
      let n = 0;
      q.on("data", (d) => (n += d.length));
      q.on("end", () => s.end(JSON.stringify({ got: n })));
      return;
    }
    s.writeHead(200, { "Content-Type": "application/json", "X-Up": "yes" });
    s.end(JSON.stringify({ method: q.method, url: q.url, headers: q.headers }));
  });
  upstream.on("upgrade", (q, socket) => {
    lastUpgrade = q.headers;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (d) => socket.write(d));
    socket.on("error", () => {});
  });
  upPort = await listen(upstream);
  ({ server: door, liveSockets } = createDoor({
    dir,
    upstream: `127.0.0.1:${upPort}`,
    tripDir,
    backupDir: path.join(tmp, "backup"),
    readGatewayToken: () => GW,
    revokeSweepMs: 100,
  }));
  doorPort = await listen(door);
  phone = addDevice(dir, "the architect Flip6");
});

after(() => {
  door.close();
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("phone door", () => {
  it("health is open", async () => {
    const r = await get("/door/health");
    assert.equal(r.status, 200);
    assert.equal(r.body, "ok");
  });

  it("unauthenticated: browser navigation is sent to login, everything else gets 401 JSON", async () => {
    const nav = await get("/tinker/", { headers: { Accept: "text/html,application/xhtml+xml" } });
    assert.equal(nav.status, 302);
    assert.equal(nav.headers.location, "/door/login");
    const api = await get("/tinker/api/x", { headers: { Accept: "application/json" } });
    assert.equal(api.status, 401);
    assert.deepEqual(JSON.parse(api.body), { error: "unauthorized" });
  });

  it("cookie auth proxies, rewrites Host/Origin/Referer and strips the device credential", async () => {
    const r = await get("/tinker/api/echo?q=1", {
      headers: {
        Cookie: `other=1; jarvis_device=${phone.token}; theme=dark`,
        Host: "100.64.0.10:18794",
        Origin: "http://100.64.0.10:18794",
        Referer: "http://100.64.0.10:18794/tinker/?phone=1",
        "X-Jarvis-Device": phone.token,
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-up"], "yes");
    const echo = JSON.parse(r.body);
    assert.equal(echo.url, "/tinker/api/echo?q=1");
    assert.equal(echo.headers.host, `127.0.0.1:${upPort}`);
    assert.equal(echo.headers.origin, `http://127.0.0.1:${upPort}`);
    assert.equal(echo.headers.referer, `http://127.0.0.1:${upPort}/tinker/?phone=1`);
    assert.equal(echo.headers.cookie, "other=1; theme=dark");
    assert.equal(echo.headers["x-jarvis-device"], undefined);
    assert.ok(!JSON.stringify(echo).includes(phone.token));
  });

  it("header auth works and the cookie header is dropped when only the device cookie was in it", async () => {
    const r = await req(doorPort, "POST", "/tinker/api/post", {
      headers: { "X-Jarvis-Device": phone.token, "Content-Type": "text/plain" },
      body: "hello",
    });
    assert.equal(r.status, 200);
    const echo = JSON.parse(r.body);
    assert.equal(echo.method, "POST");
    assert.equal(echo.headers["x-jarvis-device"], undefined);
    const c = await get("/x", { headers: { Cookie: `jarvis_device=${phone.token}` } });
    assert.equal(JSON.parse(c.body).headers.cookie, undefined);
  });

  it("updates lastSeenAt", async () => {
    await get("/x", { headers: { "X-Jarvis-Device": phone.token } });
    const row = loadRows(devicesFile(dir)).find((x) => x.id === phone.row.id);
    assert.ok(row.lastSeenAt);
  });

  it("files are 0600 and the dir 0700", () => {
    assert.equal(fs.statSync(devicesFile(dir)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  it("WebSocket upgrade passes with auth, rewritten and stripped", async () => {
    const r = await upgrade(doorPort, {
      Cookie: `jarvis_device=${phone.token}`,
      "X-Jarvis-Device": phone.token,
    });
    assert.equal(r.status, 101);
    assert.equal(r.echo, "ping");
    assert.equal(lastUpgrade.host, `127.0.0.1:${upPort}`);
    assert.equal(lastUpgrade.origin, `http://127.0.0.1:${upPort}`);
    assert.equal(lastUpgrade.cookie, undefined);
    assert.equal(lastUpgrade["x-jarvis-device"], undefined);
    // The phone hung up (the helper destroys its socket): the door must not keep the pair open.
    for (let i = 0; i < 50 && liveSockets() > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(liveSockets(), 0);
  });

  it("WebSocket upgrade without auth is refused with 401", async () => {
    lastUpgrade = null;
    const r = await upgrade(doorPort);
    assert.equal(r.status, 401);
    assert.equal(lastUpgrade, null);
  });

  it("login page posts a token and sets the cookie", async () => {
    const page = await get("/door/login");
    assert.equal(page.status, 200);
    assert.match(page.body, /type="password"/);
    const bad = await req(doorPort, "POST", "/door/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=nope-nope-nope",
    });
    assert.equal(bad.status, 401);
    const ok = await req(doorPort, "POST", "/door/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(phone.token)}`,
    });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, "/tinker/");
    assert.equal(
      ok.headers["set-cookie"][0],
      `jarvis_device=${phone.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    );
  });

  it("whoami names the device", async () => {
    const r = await get("/door/whoami", { headers: { "X-Jarvis-Device": phone.token } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).id, phone.row.id);
    assert.equal(JSON.parse(r.body).publicOrigin, null);
  });

  it("pair code: works once, hands over cookie and deep link, then is gone", async () => {
    const { code } = issuePairCode(dir, phone.row.id, { token: phone.token });
    // A GET (a link-preview fetcher, or the phone before its script runs) does not spend it.
    for (let i = 0; i < 2; i++) {
      const look = await get(`/door/pair?code=${code}`);
      assert.equal(look.status, 200);
      assert.equal(look.headers["set-cookie"], undefined);
      assert.match(look.body, /method="post" action="\/door\/pair"/);
      assert.ok(!look.body.includes(phone.token));
      assert.ok(!look.body.includes(GW));
    }
    const r = await form(doorPort, "/door/pair", { code });
    assert.equal(r.status, 200);
    assert.equal(r.headers["set-cookie"][0].split(";")[0], `jarvis_device=${phone.token}`);
    const door = encodeURIComponent(`http://127.0.0.1:${doorPort}`);
    assert.ok(r.body.includes(`jarvis://pair?door=${door}&amp;device=${phone.token}&amp;gw=${GW}`));
    assert.match(r.body, /No app build/);
    assert.equal((await form(doorPort, "/door/pair", { code })).status, 404);
    assert.equal((await get(`/door/pair?code=${code}`)).status, 404);
    // Reload with the cookie the first POST set: the page comes back.
    const reload = await get("/door/pair", { headers: { Cookie: `jarvis_device=${phone.token}` } });
    assert.equal(reload.status, 200);
    assert.match(reload.body, /jarvis:\/\/pair\?/);
    assert.ok(!fs.readFileSync(path.join(dir, "pair-codes.json"), "utf8").includes(phone.token));
  });

  it("pair code: expired codes are refused", async () => {
    const { code } = issuePairCode(dir, phone.row.id, {
      token: phone.token,
      now: Date.now() - 16 * 60 * 1000,
    });
    assert.equal((await get(`/door/pair?code=${code}`)).status, 404);
    assert.equal((await form(doorPort, "/door/pair", { code })).status, 404);
  });

  it("pair code without a token rotates the device token on use", async () => {
    const d = addDevice(dir, "Spare");
    const { code } = issuePairCode(dir, d.row.id);
    const r = await form(doorPort, "/door/pair", { code });
    assert.equal(r.status, 200);
    const fresh = decodeURIComponent(r.headers["set-cookie"][0].split(";")[0].split("=")[1]);
    assert.notEqual(fresh, d.token);
    assert.equal((await get("/x", { headers: { "X-Jarvis-Device": fresh } })).status, 200);
    assert.equal((await get("/x", { headers: { "X-Jarvis-Device": d.token } })).status, 401);
  });

  it("app: latest.json and the apk are served; bad names and traversal are refused", async () => {
    const app = path.join(dir, "app");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "jarvis-1.apk"), "APKBYTES");
    fs.writeFileSync(
      path.join(app, "latest.json"),
      JSON.stringify({
        versionCode: 1,
        versionName: "1.0",
        file: "jarvis-1.apk",
        sha256: "x",
        notes: "",
      }),
    );
    const h = { "X-Jarvis-Device": phone.token };
    const latest = await get("/door/app/latest.json", { headers: h });
    assert.equal(JSON.parse(latest.body).file, "jarvis-1.apk");
    const apk = await get("/door/app/jarvis-1.apk", { headers: h });
    assert.equal(apk.status, 200);
    assert.equal(apk.headers["content-type"], "application/vnd.android.package-archive");
    assert.equal(apk.headers["content-length"], "8");
    assert.equal(apk.body, "APKBYTES");
    for (const p of [
      "/door/app/..%2Fdevices.json",
      "/door/app/%2e%2e%2fx.apk",
      "/door/app/latest.apk/../x",
    ]) {
      assert.equal((await get(p, { headers: h })).status, 404, p);
    }
    assert.equal(apkNameOk("../x.apk"), false);
    assert.equal(apkNameOk("jarvis-1.2.apk"), true);
    const unauth = await get("/door/app/jarvis-1.apk");
    assert.equal(unauth.status, 401);
  });

  it("pack: pack.json and the zip are served, bad names refused, outcomes audited", async () => {
    const app = path.join(dir, "app");
    fs.mkdirSync(app, { recursive: true });
    const h = { "X-Jarvis-Device": phone.token };
    assert.equal((await get("/door/app/pack.json", { headers: h })).status, 404);
    fs.writeFileSync(path.join(app, "pack-7.zip"), "PK-ZIP");
    fs.writeFileSync(
      path.join(app, "pack.json"),
      JSON.stringify({ version: 7, file: "pack-7.zip", sha256: "x", size: 6, sig: "s" }),
    );
    const pointer = await get("/door/app/pack.json", { headers: h });
    assert.equal(pointer.status, 200);
    assert.equal(JSON.parse(pointer.body).version, 7);
    const zip = await get("/door/app/pack-7.zip", { headers: h });
    assert.equal(zip.status, 200);
    assert.equal(zip.headers["content-type"], "application/zip");
    assert.equal(zip.body, "PK-ZIP");
    for (const p of [
      "/door/app/pack-8.zip",
      "/door/app/pack-7.zip.part",
      "/door/app/pack-..%2Fdevices.json",
    ]) {
      assert.equal((await get(p, { headers: h })).status, 404, p);
    }
    assert.equal(packNameOk("pack-1.zip"), true);
    assert.equal(packNameOk("pack-x.zip"), false);
    assert.equal((await get("/door/app/pack-7.zip")).status, 401);
    const r = await get(
      "/door/app/pack-installed?version=7&status=rolled-back&engine=javascriptengine&app=425600&detail=boom",
      { headers: h },
    );
    assert.equal(r.status, 200);
    const last = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n").pop();
    assert.deepEqual(
      { ...JSON.parse(last), at: undefined },
      {
        at: undefined,
        event: "pack-installed",
        device: phone.row.id,
        version: 7,
        status: "rolled-back",
        engine: "javascriptengine",
        app: "425600",
        detail: "boom",
      },
    );
    assert.equal((await get("/door/app/pack-installed?version=x", { headers: h })).status, 400);
    const report =
      "kind: java-crash\nat: 1793000000000\napp: 428530\nthread: main\n" +
      "headline: java.lang.IllegalStateException: boom\n\nat ai.openclaw.app.X.y(X.kt:1)\n";
    assert.equal((await req(doorPort, "POST", "/door/app/crash", { body: report })).status, 401);
    const c = await req(doorPort, "POST", "/door/app/crash", { headers: h, body: report });
    assert.equal(c.status, 200);
    const crash = JSON.parse(
      fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n").pop(),
    );
    assert.equal(crash.event, "app-crash");
    assert.equal(crash.kind, "java-crash");
    assert.equal(crash.app, "428530");
    assert.equal(crash.headline, "java.lang.IllegalStateException: boom");
    assert.equal(fs.readFileSync(path.join(dir, "crashes", crash.file), "utf8"), report);
  });

  it("trip: served from TRIP_DIR with no-cache, 404 page when missing", async () => {
    const h = { "X-Jarvis-Device": phone.token };
    assert.equal((await get("/trip/", { headers: h })).status, 404);
    fs.mkdirSync(tripDir, { recursive: true });
    fs.writeFileSync(path.join(tripDir, "trip.html"), "<html>trip</html>");
    fs.writeFileSync(path.join(tripDir, "trip.json"), '{"version":1}');
    const t = await get("/trip/", { headers: h });
    assert.equal(t.status, 200);
    assert.equal(t.headers["cache-control"], "no-cache");
    assert.equal(t.body, "<html>trip</html>");
    const j = await get("/trip/trip.json", { headers: h });
    assert.equal(JSON.parse(j.body).version, 1);
    assert.equal((await get("/trip/other.json", { headers: h })).status, 404);
    for (const p of ["/trip/constructor", "/trip/__proto__", "/trip/toString"]) {
      assert.equal((await get(p, { headers: h })).status, 404, p);
    }
  });

  it("revoke stops the token at the next request", async () => {
    const d = addDevice(dir, "Lost phone");
    assert.equal((await get("/x", { headers: { "X-Jarvis-Device": d.token } })).status, 200);
    revokeDevice(dir, d.row.id);
    assert.equal((await get("/x", { headers: { "X-Jarvis-Device": d.token } })).status, 401);
  });

  it("the audit log never holds a token", () => {
    const log = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8");
    assert.match(log, /login_ok/);
    assert.match(log, /pair_used/);
    assert.ok(!log.includes(phone.token));
    assert.ok(!log.includes(GW));
  });

  it("upstream down -> 502", async () => {
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await new Promise((r) => dead.close(r));
    const { server } = createDoor({ dir, upstream: `127.0.0.1:${deadPort}`, tripDir });
    const port = await listen(server);
    const r = await req(port, "GET", "/x", { headers: { "X-Jarvis-Device": phone.token } });
    server.close();
    assert.equal(r.status, 502);
  });

  it("8 distinct bad credentials in 10 minutes -> 429 with Retry-After; a valid token still passes", async () => {
    const { server } = createDoor({ dir, upstream: `127.0.0.1:${upPort}`, tripDir });
    const port = await listen(server);
    const codes = [];
    for (let i = 0; i < 8; i++) {
      codes.push(
        (await req(port, "GET", "/x", { headers: { "X-Jarvis-Device": `wrong-token-${i}` } }))
          .status,
      );
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 401, 401, 429]);
    const bad = await req(port, "GET", "/x", { headers: { "X-Jarvis-Device": "wrong-token-x" } });
    assert.equal(bad.status, 429);
    assert.ok(Number(bad.headers["retry-after"]) > 0);
    assert.equal((await upgrade(port, { "X-Jarvis-Device": "wrong-token-y" })).status, 429);
    // The owner's own token is never locked out by somebody else's (or its own stale) failures.
    const ok = await req(port, "GET", "/x", { headers: { "X-Jarvis-Device": phone.token } });
    assert.equal(ok.status, 200);
    assert.equal((await upgrade(port, { "X-Jarvis-Device": phone.token })).status, 101);
    const login = await form(port, "/door/login", { token: phone.token });
    assert.equal(login.status, 303);
    assert.equal((await req(port, "GET", "/door/health")).status, 200);
    server.close();
    const limited = fs
      .readFileSync(path.join(dir, "audit.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes('"rate_limited"'));
    assert.equal(limited.length, 1, "one rate_limited line per address per window");
  });

  it("one stale token replayed many times counts once, and never hides a valid header", async () => {
    const { server } = createDoor({ dir, upstream: `127.0.0.1:${upPort}`, tripDir });
    const port = await listen(server);
    const stale = "jd_stale-token-from-before-the-re-pair";
    for (let i = 0; i < 20; i++) {
      assert.equal((await upgrade(port, { "X-Jarvis-Device": stale })).status, 401);
    }
    const both = await req(port, "GET", "/x", {
      headers: { Cookie: `jarvis_device=${stale}`, "X-Jarvis-Device": phone.token },
    });
    assert.equal(both.status, 200);
    assert.equal(JSON.parse(both.body).headers.cookie, undefined);
    assert.equal(
      (await req(port, "GET", "/x", { headers: { "X-Jarvis-Device": "another-wrong-one" } }))
        .status,
      401,
    );
    server.close();
  });

  it("a page on another origin (another port of the same IP) is refused, HTTP and upgrade", async () => {
    const host = "100.64.0.20:18794";
    const evil = "http://100.64.0.20:8740";
    const auth = { Cookie: `jarvis_device=${phone.token}`, Host: host };
    const post = await req(doorPort, "POST", "/api/ui-state", {
      headers: { ...auth, Origin: evil, "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(post.status, 403);
    assert.equal((await get("/x", { headers: { ...auth, Origin: evil } })).status, 403);
    const viaReferer = await req(doorPort, "POST", "/x", {
      headers: { ...auth, Referer: `${evil}/evil` },
      body: "{}",
    });
    assert.equal(viaReferer.status, 403);
    const nullPost = await req(doorPort, "POST", "/x", {
      headers: { ...auth, Origin: "null" },
      body: "{}",
    });
    assert.equal(nullPost.status, 403);
    const loginCsrf = await form(doorPort, "/door/login", { token: phone.token }, { Origin: evil });
    assert.equal(loginCsrf.status, 403);
    lastUpgrade = null;
    assert.equal((await upgrade(doorPort, { ...auth, Origin: evil })).status, 403);
    assert.equal(lastUpgrade, null);
    // The door's own page, and clients that send no Origin, pass.
    const own = await req(doorPort, "POST", "/x", {
      headers: { ...auth, Origin: `http://${host}`, Referer: `http://${host}/tinker/` },
      body: "{}",
    });
    assert.equal(own.status, 200);
    assert.equal(JSON.parse(own.body).headers.origin, `http://127.0.0.1:${upPort}`);
    assert.equal((await upgrade(doorPort, { ...auth, Origin: `http://${host}` })).status, 101);
  });

  it("a slow upload is not cut by the first-byte timer", async () => {
    const { server } = createDoor({
      dir,
      upstream: `127.0.0.1:${upPort}`,
      tripDir,
      firstByteTimeoutMs: 300,
    });
    const port = await listen(server);
    const r = await new Promise((resolve, reject) => {
      const q = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/slow-body",
          headers: { "X-Jarvis-Device": phone.token, "Content-Type": "application/octet-stream" },
        },
        (res) => {
          const bufs = [];
          res.on("data", (d) => bufs.push(d));
          res.on("end", () =>
            resolve({ status: res.statusCode, body: Buffer.concat(bufs).toString() }),
          );
        },
      );
      q.on("error", reject);
      let i = 0;
      const t = setInterval(() => {
        q.write(Buffer.alloc(1024));
        if (++i === 8) {
          clearInterval(t);
          q.end();
        }
      }, 100);
    });
    server.close();
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).got, 8192);
  });

  it("revoke cuts an open event stream too", async () => {
    const d = addDevice(dir, "Stolen phone");
    const res = await new Promise((resolve, reject) => {
      const q = http.request({
        host: "127.0.0.1",
        port: doorPort,
        path: "/sse",
        headers: { "X-Jarvis-Device": d.token },
      });
      q.on("response", resolve);
      q.on("error", reject);
      q.end();
    });
    assert.equal(res.statusCode, 200);
    let chunks = 0;
    res.on("data", () => chunks++);
    const closed = new Promise((r) => res.on("close", r));
    await sleep(150);
    assert.ok(chunks > 0);
    revokeDevice(dir, d.row.id);
    const winner = await Promise.race([
      closed.then(() => "closed"),
      sleep(2000).then(() => "open"),
    ]);
    assert.equal(winner, "closed");
    for (let i = 0; i < 50 && liveSockets() > 0; i++) {
      await sleep(20);
    }
    assert.equal(liveSockets(), 0);
  });

  it("expired pair codes (each holds a raw token) are purged when the door starts", async () => {
    const d = addDevice(dir, "Purge me");
    issuePairCode(dir, d.row.id, { token: d.token, now: Date.now() - 16 * 60 * 1000 });
    assert.ok(fs.readFileSync(pairCodesFile(dir), "utf8").includes(d.token));
    const { server } = createDoor({ dir, upstream: `127.0.0.1:${upPort}`, tripDir });
    server.close();
    assert.ok(!fs.readFileSync(pairCodesFile(dir), "utf8").includes(d.token));
  });

  it("a corrupt devices.json is never read as empty (a write would wipe every device)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "phone-door-corrupt-"));
    fs.writeFileSync(devicesFile(d), '[{"id":"a"');
    assert.throws(() => loadRows(devicesFile(d)));
    assert.throws(() => addDevice(d, "x"));
    assert.equal(fs.readFileSync(devicesFile(d), "utf8"), '[{"id":"a"');
    saveRows(devicesFile(d), []);
    assert.deepEqual(loadRows(devicesFile(d)), []);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("backup: a PUT lands under the device folder with its mtime, and the manifest lists it", async () => {
    const dev = addDevice(dir, "Backup phone");
    const h = { "X-Jarvis-Device": dev.token };
    const body = Buffer.from("jpeg bytes here");
    const put = await req(
      doorPort,
      "PUT",
      "/door/backup/file?path=DCIM%2FCamera%2Fa.jpg&mtime=1700000000000",
      {
        headers: { ...h, "Content-Length": String(body.length) },
        body,
      },
    );
    assert.equal(put.status, 200, put.body);
    const f = path.join(tmp, "backup", dev.row.id, "DCIM", "Camera", "a.jpg");
    assert.equal(fs.readFileSync(f, "utf8"), "jpeg bytes here");
    assert.equal(Math.round(fs.statSync(f).mtimeMs), 1700000000000);
    const man = await get("/door/backup/manifest", { headers: h });
    assert.deepEqual(JSON.parse(man.body).files, [["DCIM/Camera/a.jpg", body.length]]);
  });

  it("backup: traversal and odd names are refused; no token is 401", async () => {
    for (const bad of ["../x.jpg", "a/../../x", "/", "a\\b", "x.jarvis-part-1", ""]) {
      assert.equal(backupRelPath(bad), null, bad);
    }
    assert.equal(backupRelPath("/DCIM//Camera/x.jpg"), "DCIM/Camera/x.jpg");
    const dev = addDevice(dir, "Backup phone 2");
    const r = await req(doorPort, "PUT", "/door/backup/file?path=..%2F..%2Fevil", {
      headers: { "X-Jarvis-Device": dev.token, "Content-Length": "1" },
      body: "x",
    });
    assert.equal(r.status, 400);
    const anon = await req(doorPort, "PUT", "/door/backup/file?path=a.jpg", {
      headers: { "Content-Length": "1" },
      body: "x",
    });
    assert.equal(anon.status, 401);
  });

  it("backup: an upload cut halfway leaves no file behind", async () => {
    const dev = addDevice(dir, "Backup phone 3");
    const r = http.request({
      host: "127.0.0.1",
      port: doorPort,
      method: "PUT",
      path: "/door/backup/file?path=DCIM%2Fcut.jpg",
      headers: { "X-Jarvis-Device": dev.token, "Content-Length": "1000" },
    });
    r.on("error", () => {});
    r.write("only part");
    await sleep(100);
    r.destroy();
    await sleep(200);
    const root = path.join(tmp, "backup", dev.row.id);
    const left = fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }) : [];
    assert.deepEqual(
      left.filter((n) => n.endsWith(".jpg") || n.includes("part")),
      [],
    );
  });

  it("upstreamHeaders leaves an unrelated request alone apart from Host", () => {
    const h = upstreamHeaders({ host: "a:1", accept: "*/*" }, "127.0.0.1:18793");
    assert.deepEqual(h, { accept: "*/*", host: "127.0.0.1:18793" });
  });
});

describe("bind", () => {
  it("checkBind refuses empty and every-interface addresses, allows loopback and tailnet", () => {
    assert.ok(checkBind(""));
    assert.ok(checkBind("0.0.0.0"));
    assert.ok(checkBind("::"));
    assert.ok(checkBind("0"));
    assert.ok(checkBind("::ffff:0.0.0.0"));
    assert.ok(checkBind("0:0::0"));
    assert.equal(checkBind("0.0.0.0", true), null);
    assert.equal(checkBind("127.0.0.1"), null);
    assert.equal(checkBind("100.64.0.10"), null);
  });

  for (const bind of ["0.0.0.0", "", "0"]) {
    it(`the server refuses to start with PHONE_DOOR_BIND=${JSON.stringify(bind)}`, async () => {
      const env = {
        ...process.env,
        PHONE_DOOR_BIND: bind,
        PHONE_DOOR_PORT: "0",
        PHONE_DOOR_DIR: path.join(os.tmpdir(), "phone-door-never"),
      };
      delete env.PHONE_DOOR_ALLOW_ANY;
      const r = await new Promise((resolve) =>
        execFile(
          process.execPath,
          [path.join(HERE, "door.mjs")],
          { env, timeout: 5000 },
          (err, _o, stderr) => resolve({ code: err?.code, stderr }),
        ),
      );
      assert.equal(r.code, 1);
      assert.match(r.stderr, /PHONE_DOOR_BIND|refusing/);
    });
  }
});

describe("devices.mjs", () => {
  it("add prints the token once with a pairing URL; list never shows it", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "phone-door-cli-"));
    const run = (...args) =>
      new Promise((resolve) =>
        execFile(
          process.execPath,
          [path.join(HERE, "devices.mjs"), ...args],
          { env: { ...process.env, PHONE_DOOR_DIR: d } },
          (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
        ),
      );
    const add = await run("add", "Test", "phone", "--door", "http://100.64.0.10:18794");
    assert.equal(add.code, 0);
    const token = /token\s+(\S+)/.exec(add.stdout)[1];
    assert.match(add.stdout, /pair\s+http:\/\/100\.64\.0\.10:18794\/door\/pair\?code=\S+/);
    const list = await run("list");
    assert.match(list.stdout, /test-phone\tactive\tTest phone/);
    assert.ok(!list.stdout.includes(token));
    const pc = await run("pair-code", "test-phone", "--door", "http://h:1");
    assert.match(pc.stdout, /http:\/\/h:1\/door\/pair\?code=/);
    const rv = await run("revoke", "test-phone");
    assert.equal(rv.code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, "pair-codes.json"), "utf8")).length, 0);
    assert.equal((await run("pair-code", "test-phone")).code, 1);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("devices.mjs phoneOnlineWarning", () => {
  it("warns when no phone peer is online and stays quiet when one is", async () => {
    const { phoneOnlineWarning } = await import("./devices.mjs");
    const off = phoneOnlineWarning({
      Peer: {
        a: { OS: "android", Online: false, HostName: "flip" },
        b: { OS: "linux", Online: true },
      },
    });
    assert.match(off, /no phone is online on the tailnet \(flip\)/);
    assert.equal(
      phoneOnlineWarning({ Peer: { a: { OS: "android", Online: true, HostName: "flip" } } }),
      null,
    );
  });
});
