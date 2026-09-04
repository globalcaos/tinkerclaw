import { WebSocket } from "ws";
const [, , WSURL, TARGET, EXPR] = process.argv;
const ws = new WebSocket(WSURL);
let id = 0;
const waiters = new Map();
const send = (m, p, sid) =>
  new Promise((r) => {
    const i = ++id;
    waiters.set(i, r);
    ws.send(
      JSON.stringify(
        sid ? { id: i, method: m, params: p, sessionId: sid } : { id: i, method: m, params: p },
      ),
    );
  });
ws.on("message", (b) => {
  const m = JSON.parse(b);
  if (m.id && waiters.has(m.id)) {
    waiters.get(m.id)(m);
    waiters.delete(m.id);
  }
});
ws.on("open", async () => {
  try {
    const at = await send("Target.attachToTarget", { targetId: TARGET, flatten: true });
    const sid = at.result?.sessionId;
    if (!sid) {
      console.log("NO_SESSION " + JSON.stringify(at.error || at));
      process.exit(1);
    }
    const r = await send(
      "Runtime.evaluate",
      { expression: EXPR, returnByValue: true, awaitPromise: true },
      sid,
    );
    console.log(JSON.stringify(r.result?.result?.value ?? r.error ?? r.result));
  } catch (e) {
    console.log("ERR " + e);
  } finally {
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (e) => {
  console.log("WSERR " + e);
  process.exit(1);
});
setTimeout(() => {
  console.log("timeout");
  process.exit(1);
}, 15000);
