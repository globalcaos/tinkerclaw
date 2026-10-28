/**
 * term.mjs: a terminal on the Pi, served by the phone door (2026-10-20: a way in to run Claude Code and
 * repair the machine when it hangs).
 *
 * WHY HERE: the door is its own small service. When the gateway or the Tinker page server hangs, the
 * door still answers, so the terminal still opens. It reuses the door's device-token auth (cookie or
 * header) and its tailnet-only bind; nothing in it is reachable without a paired device.
 *
 * ROUTES (all behind the door's auth):
 *   GET /door/term/            the page (xterm.js + a key bar: Esc Tab Ctrl-C Ctrl-D arrows)
 *   GET /door/term/vendor/<f>  xterm.js, xterm.css, addon-fit.js (vendored, MIT)
 *   WS  /door/term/ws          the shell: browser → {"t":"i","d":…}/{"t":"r","c","r"}; shell → text
 *
 * ONE SHELL PER DEVICE, kept 30 min after the phone disconnects (a lock screen or a tunnel must not
 * kill a running `claude`); a reconnect gets the last 200 kB of output replayed, then goes live.
 * The shell is term-pty.py (a real pty) attached to the tmux session of pi-term.service, which runs
 * Claude Code in ~/src/jarvis-icu and outlives the door and the app until the Pi reboots (2026-10-22).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "xterm");
const HELPER = path.join(HERE, "term-pty.py");
const KEEP_MS = 30 * 60 * 1000;
const REPLAY_BYTES = 200 * 1024;
const VENDOR_FILES = {
  "xterm.js": "text/javascript; charset=utf-8",
  "xterm.css": "text/css; charset=utf-8",
  "addon-fit.js": "text/javascript; charset=utf-8",
};

export function createTerminal({ audit = () => {}, live } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  /** deviceId -> { child, buf: string, ws, timer } */
  const sessions = new Map();

  function startShell(deviceId) {
    const child = spawn("python3", ["-I", HELPER], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const s = { child, buf: "", ws: null, timer: null };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      s.buf = (s.buf + d).slice(-REPLAY_BYTES);
      if (s.ws?.readyState === 1) s.ws.send(d);
    });
    child.on("exit", () => {
      sessions.delete(deviceId);
      if (s.ws?.readyState === 1) {
        s.ws.send("\r\n[shell ended: reload to start a new one]\r\n");
        s.ws.close();
      }
      audit({ ev: "term_exit", deviceId });
    });
    sessions.set(deviceId, s);
    audit({ ev: "term_start", deviceId });
    return s;
  }

  function attach(ws, dev) {
    let s = sessions.get(dev.id);
    if (s?.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (s?.ws && s.ws !== ws) s.ws.close(4000, "opened elsewhere");
    if (!s) s = startShell(dev.id);
    else if (s.buf) ws.send(s.buf);
    s.ws = ws;
    const conn = { id: dev.id, hash: dev.hash, kind: "term", close: () => ws.close() };
    live?.add(conn);
    ws.on("message", (raw) => {
      const line = String(raw);
      if (line.length > 64 * 1024) return;
      s.child.stdin.write(line.replace(/\n/g, "") + "\n");
    });
    ws.on("close", () => {
      live?.delete(conn);
      if (s.ws !== ws) return;
      s.ws = null;
      s.timer = setTimeout(() => {
        s.child.kill("SIGHUP");
        sessions.delete(dev.id);
      }, KEEP_MS);
    });
  }

  /** True when the path was a terminal route (the response is sent). */
  function handleHttp(p, res) {
    if (p === "/door/term" || p === "/door/term/") {
      const body = PAGE;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-cache",
      });
      res.end(body);
      return true;
    }
    if (p.startsWith("/door/term/vendor/")) {
      const name = p.slice("/door/term/vendor/".length);
      const ctype = VENDOR_FILES[name];
      if (!ctype) return false;
      const file = path.join(VENDOR, name);
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        return false;
      }
      res.writeHead(200, {
        "Content-Type": ctype,
        "Content-Length": String(size),
        "Cache-Control": "max-age=86400",
      });
      fs.createReadStream(file).pipe(res);
      return true;
    }
    return false;
  }

  /** True when the upgrade was the terminal's (handled here, never proxied to Tinker). */
  function handleUpgrade(req, socket, head, dev) {
    const p = new URL(req.url, "http://door").pathname;
    if (p !== "/door/term/ws") return false;
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, dev));
    return true;
  }

  return { handleHttp, handleUpgrade, sessionCount: () => sessions.size };
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,interactive-widget=resizes-content">
<title>Pi terminal</title>
<link rel="stylesheet" href="/door/term/vendor/xterm.css">
<style>
  html,body{margin:0;height:100%;background:#1b1510;color:#f3e6cf;font-family:system-ui,sans-serif;overflow:hidden}
  #wrap{position:fixed;inset:0;display:flex;flex-direction:column}
  #term{flex:1;min-height:0;padding:4px 4px 0}
  #keys{display:flex;gap:4px;padding:5px 4px calc(5px + env(safe-area-inset-bottom,0px));background:#2a2019;border-top:1px solid #4a3a28;overflow-x:auto}
  #keys button{flex:0 0 auto;min-width:44px;height:38px;border-radius:7px;border:1px solid #6b5545;background:#3a2d22;color:#f3e6cf;font-size:14px}
  #keys button.on{background:#8a6d3b}
  #st{position:fixed;top:6px;right:8px;font-size:11px;opacity:.7}
</style></head>
<body><div id="wrap"><div id="term"></div>
<div id="keys">
  <button data-k="esc">Esc</button><button data-k="tab">Tab</button><button data-k="ctrl">Ctrl</button>
  <button data-s="\\u0003">^C</button><button data-s="\\u0004">^D</button>
  <button data-s="\\u001b[A">↑</button><button data-s="\\u001b[B">↓</button>
  <button data-s="\\u001b[D">←</button><button data-s="\\u001b[C">→</button>
  <button data-s="/">/</button><button data-s="|">|</button><button data-s="~">~</button>
</div></div><div id="st">connecting…</div>
<script src="/door/term/vendor/xterm.js"></script>
<script src="/door/term/vendor/addon-fit.js"></script>
<script>
(function(){
  var T = window.Terminal && (window.Terminal.Terminal || window.Terminal);
  var F = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon);
  var term = new T({cursorBlink:true,fontSize:13,scrollback:5000,theme:{background:'#1b1510',foreground:'#f3e6cf'}});
  var fit = new F(); term.loadAddon(fit); term.open(document.getElementById('term'));
  var st = document.getElementById('st'), ws = null, ctrl = false, retry = 0;
  function send(o){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function size(){ try { fit.fit(); } catch(e){} send({t:'r',c:term.cols,r:term.rows}); }
  function input(d){
    if (ctrl && d.length === 1) { var c = d.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64); ctrl = false; ctrlBtn.classList.remove('on'); }
    send({t:'i',d:d});
  }
  term.onData(input);
  var ctrlBtn = document.querySelector('[data-k=ctrl]');
  document.getElementById('keys').addEventListener('click', function(e){
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.k === 'esc') send({t:'i',d:'\\u001b'});
    else if (b.dataset.k === 'tab') send({t:'i',d:'\\t'});
    else if (b.dataset.k === 'ctrl') { ctrl = !ctrl; b.classList.toggle('on', ctrl); }
    else if (b.dataset.s) send({t:'i',d:JSON.parse('"' + b.dataset.s + '"')});
    term.focus();
  });
  function connect(){
    st.textContent = 'connecting…';
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/door/term/ws');
    ws.onopen = function(){ retry = 0; st.textContent = ''; size(); term.focus(); };
    ws.onmessage = function(e){ term.write(e.data); };
    ws.onclose = function(e){
      if (e.code === 4000) { st.textContent = 'opened on another screen'; return; }
      st.textContent = 'reconnecting…';
      setTimeout(connect, Math.min(8000, 500 * Math.pow(2, retry++)));
    };
  }
  // Vertical swipe = scroll. A plain shell scrolls xterm's scrollback; a full-screen app (Claude
  // Code, tmux, less) has none, so it gets wheel events when it asked for the mouse, arrows otherwise.
  var el = document.getElementById('term'), ty = null, acc = 0, swiping = false;
  function wheel(up){
    var m = term.modes;
    if (term.buffer.active.type === 'normal') { term.scrollLines(up ? -1 : 1); return; }
    if (m.mouseTrackingMode !== 'none') send({t:'i',d:'\\u001b[<' + (up ? 64 : 65) + ';1;1M'});
    else send({t:'i',d:(m.applicationCursorKeysMode ? '\\u001bO' : '\\u001b[') + (up ? 'A' : 'B')});
  }
  el.addEventListener('touchstart', function(e){
    if (e.touches.length !== 1) { ty = null; return; }
    ty = e.touches[0].clientY; acc = 0; swiping = false;
  }, {capture:true, passive:true});
  el.addEventListener('touchmove', function(e){
    if (ty === null) return;
    var y = e.touches[0].clientY, step = el.clientHeight / term.rows;
    acc += y - ty; ty = y;
    if (!swiping && Math.abs(acc) < 10) return;
    swiping = true; e.preventDefault(); e.stopPropagation();
    while (Math.abs(acc) >= step) { wheel(acc > 0); acc -= acc > 0 ? step : -step; }
  }, {capture:true, passive:false});
  el.addEventListener('touchend', function(e){ if (swiping) { e.stopPropagation(); swiping = false; } ty = null; }, {capture:true});
  window.addEventListener('resize', size);
  if (window.visualViewport) visualViewport.addEventListener('resize', size);
  connect();
})();
</script></body></html>`;
