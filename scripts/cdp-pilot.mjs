// Same-site co-pilot for the shared tab via raw CDP (no Playwright needed).
// Usage: node cdp-pilot.mjs <wsUrl> <read|nav|click> [arg]
// HARD RULE (Oscar): nav refuses any cross-origin target — cannot change websites at will.
import { WebSocket } from "ws";
const [, , WSURL, ACTION = "read", ARG = ""] = process.argv;
const READER = `JSON.stringify({title:document.title,url:location.href,origin:location.origin,
  clickable:[...document.querySelectorAll('button,a[role=button],[role=link],a')].map(e=>(e.innerText||e.getAttribute('aria-label')||'').trim()).filter(t=>t&&t.length<55).slice(0,45),
  inputs:[...document.querySelectorAll('input,textarea')].map(e=>({name:e.name||e.id||e.getAttribute('aria-label')||'',type:e.type||'text'})).filter(x=>x.name).slice(0,25)})`;
const ws = new WebSocket(WSURL);
let id = 0;
const cmd = (m, p) =>
  new Promise((r) => {
    const i = ++id;
    const h = (b) => {
      const x = JSON.parse(b);
      if (x.id === i) {
        ws.off("message", h);
        r(x);
      }
    };
    ws.on("message", h);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
const evalJS = async (e) => {
  const r = await cmd("Runtime.evaluate", {
    expression: e,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.on("open", async () => {
  try {
    if (ACTION === "nav") {
      const cur = await evalJS("location.origin");
      let tOrigin;
      try {
        tOrigin = new URL(ARG).origin;
      } catch {
        console.log("BAD_URL");
        process.exit(1);
      }
      if (tOrigin !== cur) {
        console.log("BLOCKED cross-site: " + cur + " -> " + tOrigin);
        process.exit(0);
      }
      await cmd("Page.navigate", { url: ARG });
      await sleep(4000);
    } else if (ACTION === "click") {
      const clicked = await evalJS(`(()=>{const t=${JSON.stringify(ARG)}.toLowerCase();
      const els=[...document.querySelectorAll('button,a,[role=button],[role=link],span,div')];
      const el=els.find(e=>(e.innerText||'').trim().toLowerCase()===t)||els.find(e=>(e.innerText||'').trim().toLowerCase().includes(t)&&(e.innerText||'').length<60);
      if(!el)return 'NOT_FOUND'; el.scrollIntoView(); el.click(); return 'clicked: '+(el.innerText||'').trim().slice(0,40);})()`);
      console.log(clicked);
      await sleep(2500);
    }
    console.log(await evalJS(READER));
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
}, 20000);
