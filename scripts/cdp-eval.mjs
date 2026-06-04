import { WebSocket } from "ws";
const [, , WSURL, EXPR] = process.argv;
const ws = new WebSocket(WSURL);
let id = 0;
const send = (method, params) =>
  new Promise((res) => {
    const myid = ++id;
    const h = (b) => {
      const m = JSON.parse(b);
      if (m.id === myid) {
        ws.off("message", h);
        res(m);
      }
    };
    ws.on("message", h);
    ws.send(JSON.stringify({ id: myid, method, params }));
  });
ws.on("open", async () => {
  try {
    const r = await send("Runtime.evaluate", {
      expression: EXPR,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(JSON.stringify(r.result?.result?.value ?? r.result ?? r.error ?? r));
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
