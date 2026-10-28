// update-when-on-screen.mjs: install a published Jarvis build the moment the app is open on the phone.
// Silent installs only go through while the app is on screen (2026-10-21, again 2026-10-28), and the app
// itself only checks at a cold start and every 6 h, so jarvis-pi-publish.sh can end with "published, not
// installed" (exit 3). This waits, never wakes the phone itself (it acts only when node.list says the app is
// connected), pushes jarvis.update once the app answers on screen (jarvis.tinker.eval), and exits 0 when
// device.info reports the wanted build. Run it as a longjob so the result wakes the chat:
//   node apps/android/scripts/update-when-on-screen.mjs [versionCode, default: latest published] [hours, default 3]
// Exit 0 = installed; 3 = not installed in time (the app's own 6-hour check still will); 4 = gateway gone.
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

const HOME = os.homedir();
const latest = () => {
  try {
    return String(JSON.parse(fs.readFileSync(`${HOME}/.openclaw/data/phone-door/app/latest.json`, "utf8")).versionCode);
  } catch {
    return "";
  }
};
const WANT = process.argv[2] || latest();
const HOURS = Number(process.argv[3] || 3);
if (!/^\d+$/.test(WANT)) {
  console.error("no versionCode given and none published in ~/.openclaw/data/phone-door/app/latest.json");
  process.exit(2);
}
const { WebSocket } = createRequire(`${HOME}/src/tinkerclaw/package.json`)("ws");
const TOKEN = JSON.parse(fs.readFileSync(`${HOME}/.openclaw/openclaw.json`, "utf8")).gateway.auth.token;
const ws = new WebSocket("ws://127.0.0.1:18789", { headers: { Origin: "http://127.0.0.1:18790", Authorization: `Bearer ${TOKEN}` } });
let n = 0;
const pend = new Map();
const req = (method, params, ms = 60_000) =>
  new Promise((res, rej) => {
    const id = `u${++n}`;
    const t = setTimeout(() => {
      pend.delete(id);
      rej(new Error(`${method} timeout`));
    }, ms);
    pend.set(id, { res, rej, t });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (nodeId, command, params, timeoutMs) =>
  req("node.invoke", { nodeId, command, params, timeoutMs, idempotencyKey: `${command}-${Date.now()}` }, timeoutMs + 30_000);

ws.on("close", () => {
  log("gateway socket closed");
  process.exit(4);
});
ws.on("message", async (raw) => {
  const f = JSON.parse(raw);
  if (f.type === "res" && pend.has(f.id)) {
    const p = pend.get(f.id);
    pend.delete(f.id);
    clearTimeout(p.t);
    return f.ok ? p.res(f.payload) : p.rej(new Error(JSON.stringify(f.error).slice(0, 200)));
  }
  if (f.type !== "event" || f.event !== "connect.challenge") return;
  await req("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "webchat-ui", displayName: "update-when-on-screen", version: "1", platform: "cli", mode: "webchat" },
    role: "operator", scopes: ["operator.admin"], caps: [], auth: { token: TOKEN },
  });
  log(`waiting up to ${HOURS} h for the phone to run ${WANT}`);
  const end = Date.now() + HOURS * 3_600_000;
  let pushedAt = 0;
  let lastSeen = "";
  while (Date.now() < end) {
    try {
      const nodes = (await req("node.list", {})).nodes || [];
      const phone = nodes.find((x) => /android/i.test(x.platform || "") && (x.commands || []).includes("jarvis.update"));
      if (phone?.connected) {
        const info = await invoke(phone.nodeId, "device.info", {}, 20_000);
        const build = JSON.stringify(info).match(/"appBuild\\?":\s*\\?"(\d+)/)?.[1] ?? "?";
        if (build !== lastSeen) {
          log("phone runs", build);
          lastSeen = build;
        }
        if (build === WANT) {
          log(`phone on ${WANT}`);
          process.exit(0);
        }
        const onScreen = await invoke(phone.nodeId, "jarvis.tinker.eval", { javaScript: "1" }, 15_000).then(() => true, () => false);
        if (onScreen && Date.now() - pushedAt > 5 * 60_000) {
          pushedAt = Date.now();
          log("app on screen: pushing jarvis.update");
          await invoke(phone.nodeId, "jarvis.update", {}, 90_000).then(
            () => log("update pushed"),
            (e) => log("update push failed:", e.message),
          );
        }
      }
    } catch (e) {
      log("round failed:", e.message);
    }
    await sleep(60_000);
  }
  log(`phone still not on ${WANT} after ${HOURS} h; the app installs it at its next cold start or 6-hour check`);
  process.exit(3);
});
