#!/usr/bin/env node
/**
 * broca.mjs — tiny CLI for the BROCA recipe RPCs.
 *
 * Exists because every session re-derives the same handshake and loses ~15 min to two
 * gotchas: the WS endpoint is `/ws` (without it the socket opens and the gateway never
 * sends connect.challenge — you just time out with zero frames), and the frame types are
 * `req`/`res`, not `request`/`response`.
 *
 *   node scripts/broca.mjs list
 *   node scripts/broca.mjs match "show me pictures of X"
 *   node scripts/broca.mjs get <slug>
 *   node scripts/broca.mjs author <spec.json>     # spec.json = PrefrontalKitAuthorParams
 *   node scripts/broca.mjs call <method> <json>   # any prefrontal.* RPC
 *
 * Run from inside ~/src/tinkerclaw so `ws` resolves.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const TOKEN = (() => {
  const p = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const c = JSON.parse(fs.readFileSync(p, "utf-8"));
  return c?.gateway?.auth?.token ?? c?.gateway?.controlUi?.auth?.token ?? "";
})();

// NOTE the `/ws` — this is the gotcha.
const WS_URL = process.env.OPENCLAW_WS ?? "ws://127.0.0.1:18789/ws";

const [cmd, ...rest] = process.argv.slice(2);
const ROUTES = {
  list: () => ["prefrontal.recipe.list", {}],
  match: () => ["prefrontal.recipe.match", { prompt: rest.join(" ") }], // param is `prompt`, not `text`
  get: () => ["prefrontal.recipe.get", { slug: rest[0] }],
  read: () => ["prefrontal.recipe.read", { slug: rest[0] }],
  author: () => ["prefrontal.recipe.author", JSON.parse(fs.readFileSync(rest[0], "utf-8"))],
  call: () => [rest[0], rest[1] ? JSON.parse(rest[1]) : {}],
};
if (!ROUTES[cmd]) {
  console.error(`usage: broca.mjs <${Object.keys(ROUTES).join("|")}> [args]`);
  process.exit(2);
}
const [METHOD, PARAMS] = ROUTES[cmd]();

const ws = new WebSocket(WS_URL, {
  headers: { Origin: "http://127.0.0.1:18790", Authorization: `Bearer ${TOKEN}` },
});
const uuid = () => "broca-" + Math.random().toString(36).slice(2, 10);
let sent = false;

ws.on("message", (buf) => {
  let f;
  try {
    f = JSON.parse(buf.toString());
  } catch {
    return;
  }
  if (f.type === "event" && f.event === "connect.challenge") {
    ws.send(
      JSON.stringify({
        type: "req",
        id: uuid(),
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "webchat-ui",
            displayName: "broca-cli",
            version: "0.1",
            platform: "cli",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.admin"],
          caps: [],
          auth: { token: TOKEN },
        },
      }),
    );
    return;
  }
  if (!sent && f?.payload?.features) {
    sent = true;
    ws.send(JSON.stringify({ type: "req", id: "MAIN", method: METHOD, params: PARAMS }));
    return;
  }
  if (f.id === "MAIN") {
    console.log(JSON.stringify(f.ok ? f.payload : { error: f.error }, null, 1));
    process.exit(f.ok ? 0 : 1);
  }
});
ws.on("error", (e) => {
  console.error("ws-error:", String(e));
  process.exit(1);
});
setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 30000);
