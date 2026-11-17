// node --test scripts/tinker-prod-ui.origin.test.mjs
//
// tinker-prod-ui listens on loopback and adds the gateway Bearer to what it forwards, so a page
// of another site, opened in a browser on the same machine, could write repo files and run them
// (burn review 2026-11-13 s1-http-doors F1) or press Zen Mail's buttons (s3-zen-mail F1). These
// tests boot a copy of the real script in a temp root against a stub gateway and a stub Zen Mail.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { upstreamHeaders } from "./phone-door/door.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIL = "https://evil.example";
let tmp, child, port, gw, gwSeen, zen, zenSeen;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

function stub(seen) {
  return http.createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      origin: req.headers.origin,
      auth: req.headers.authorization,
    });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
}

function send(method, urlPath, headers = {}, body = "") {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}

const own = () => `http://127.0.0.1:${port}`;
const plain = { "content-type": "text/plain" };
const saveBody = '{"path":"skills/build-gantt/scripts/gantt.py","content":"print(1)"}';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prod-ui-origin-"));
  const root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  fs.copyFileSync(
    path.join(HERE, "tinker-prod-ui.mjs"),
    path.join(root, "scripts", "tinker-prod-ui.mjs"),
  );
  for (const lib of ["checkout-drift.mjs", "longjob-trail.mjs"]) {
    fs.copyFileSync(path.join(HERE, "lib", lib), path.join(root, "scripts", "lib", lib));
  }
  fs.mkdirSync(path.join(root, "tinker-ui", "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tinker-ui", "dist", "index.html"),
    "<html><head></head><body></body></html>",
  );
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".openclaw", "openclaw.json"),
    JSON.stringify({ gateway: { auth: { token: "test-gateway-token" } } }),
  );

  gwSeen = [];
  gw = stub(gwSeen);
  const gwPort = await listen(gw);
  zenSeen = [];
  zen = stub(zenSeen);
  const zenPort = await listen(zen);
  const probe = http.createServer();
  port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  child = spawn(process.execPath, [path.join(root, "scripts", "tinker-prod-ui.mjs")], {
    env: {
      ...process.env,
      HOME: home,
      TINKER_PROD_PORT: String(port),
      TINKER_GATEWAY_PORT: String(gwPort),
      ZEN_MAIL_PORT: String(zenPort),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("production Tinker") && resolve());
    child.on("exit", (code) => reject(new Error(`prod-ui exited ${code}`)));
  });
});

after(() => {
  child?.kill();
  gw?.close();
  zen?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("routes that write files or run a script refuse another site's page", () => {
  for (const p of ["/api/save-file", "/tinker/api/save-file"]) {
    it(`${p}: a foreign Origin is refused and never reaches the gateway`, async () => {
      const before = gwSeen.length;
      assert.equal(await send("POST", p, { ...plain, origin: EVIL }, saveBody), 403);
      assert.equal(gwSeen.length, before);
    });
    it(`${p}: Origin null (a local file, a sandboxed frame) is refused`, async () => {
      const before = gwSeen.length;
      assert.equal(await send("POST", p, { ...plain, origin: "null" }, saveBody), 403);
      assert.equal(gwSeen.length, before);
    });
    it(`${p}: a domain-name Host (DNS rebinding) is refused`, async () => {
      const before = gwSeen.length;
      const host = `attacker.example:${port}`;
      assert.equal(
        await send("POST", p, { ...plain, host, origin: `http://${host}` }, saveBody),
        403,
      );
      assert.equal(gwSeen.length, before);
    });
  }
  it("/api/kit-content (the other Bearer alias) refuses a foreign Origin", async () => {
    const before = gwSeen.length;
    assert.equal(await send("GET", "/api/kit-content?path=x", { origin: EVIL }), 403);
    assert.equal(gwSeen.length, before);
  });
  it("/api/gantt/agent (runs gantt.py) refuses a foreign Origin", async () => {
    assert.equal(await send("GET", "/api/gantt/agent?wf=wf_a&agent=a", { origin: EVIL }), 403);
  });
  it("/api/gantt/boards DELETE refuses a foreign Origin", async () => {
    assert.equal(await send("DELETE", "/api/gantt/boards?session=s", { origin: EVIL }), 403);
  });
  it("/api/open-file refuses a foreign Origin", async () => {
    assert.equal(
      await send("POST", "/api/open-file", { ...plain, origin: EVIL }, '{"path":"README.md"}'),
      403,
    );
  });
  it("/api/ui-state refuses a foreign Origin", async () => {
    assert.equal(await send("POST", "/api/ui-state", { ...plain, origin: EVIL }, "{}"), 403);
  });
  // FORK 2026-11-14 — a job's trail holds whatever its agent read and ran (lib/longjob-trail.mjs).
  it("/api/longjob/<id>/trail refuses a foreign Origin", async () => {
    assert.equal(await send("GET", "/api/longjob/some-job/trail", { origin: EVIL }), 403);
  });
});

describe("the owner's own page and local tools keep working", () => {
  it("save-file from this page is forwarded with the Bearer", async () => {
    assert.equal(
      await send("POST", "/tinker/api/save-file", { ...plain, origin: own() }, saveBody),
      200,
    );
    assert.deepEqual(gwSeen.at(-1), {
      method: "POST",
      url: "/tinker/api/save-file",
      origin: own(),
      auth: "Bearer test-gateway-token",
    });
  });
  it("a local script with no Origin is forwarded", async () => {
    assert.equal(await send("POST", "/api/save-file", plain, saveBody), 200);
    assert.equal(gwSeen.at(-1).url, "/tinker/api/save-file");
  });
  it("localhost as the Host passes", async () => {
    const host = `localhost:${port}`;
    assert.equal(await send("GET", "/tinker/api/x", { host, origin: `http://${host}` }), 200);
  });
  it("the phone door's rewritten headers pass (Host and Origin set to the loopback form)", async () => {
    const h = upstreamHeaders(
      {
        host: "raspberrypi.example.ts.net:8443",
        origin: "https://raspberrypi.example.ts.net:8443",
        "content-type": "text/plain",
      },
      `127.0.0.1:${port}`,
    );
    assert.equal(await send("POST", "/tinker/api/save-file", h, saveBody), 200);
    assert.equal(await send("POST", "/api/ui-state", h, "{}"), 200);
  });
  it("ui-state from this page is answered", async () => {
    assert.equal(await send("GET", "/api/ui-state", { origin: own() }), 200);
  });
  it("a job trail from this page is answered (404: no such job in the test home)", async () => {
    assert.equal(await send("GET", "/api/longjob/some-job/trail", { origin: own() }), 404);
  });
  it("gantt from this page is not refused", async () => {
    assert.notEqual(await send("GET", "/api/gantt/boards", { origin: own() }), 403);
  });
});

describe("the /zen/ proxy", () => {
  const mute = (headers) =>
    send(
      "POST",
      "/zen/api/sender",
      { ...plain, ...headers },
      '{"acct":"work","addr":"a@b.example","act":"mute"}',
    );
  it("refuses another site's POST instead of lending it Zen Mail's origin", async () => {
    const before = zenSeen.length;
    assert.equal(await mute({ origin: EVIL }), 403);
    assert.equal(zenSeen.length, before);
  });
  it("refuses Origin null", async () => {
    const before = zenSeen.length;
    assert.equal(await mute({ origin: "null" }), 403);
    assert.equal(zenSeen.length, before);
  });
  it("refuses a domain-name Host (DNS rebinding)", async () => {
    const before = zenSeen.length;
    assert.equal(
      await send("GET", "/zen/api/state?acct=all", { host: `attacker.example:${port}` }),
      403,
    );
    assert.equal(zenSeen.length, before);
  });
  it("passes this page's own POST, with Zen Mail's origin", async () => {
    assert.equal(await mute({ origin: own() }), 200);
    assert.equal(zenSeen.at(-1).url, "/api/sender");
    assert.match(zenSeen.at(-1).origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(zenSeen.at(-1).origin, own());
  });
});
