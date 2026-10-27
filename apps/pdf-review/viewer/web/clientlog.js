// Client log (2026-10-22, the architect: "Riddle the code with log messages"). The phone's WebView showed
// "1 of 15" and no page while every desktop test drew fine, and nothing on the Pi could say why.
// Every viewer now reports what it sees to POST /api/clientlog, which the server writes to
// ~/.local/state/pdf-review.log as "CLIENT <id> <event> <json>". Read it with:
//   grep CLIENT ~/.local/state/pdf-review.log | tail -50
// Loaded first (classic script) so it also catches errors thrown while the modules load.
(() => {
  const BASE = location.pathname.replace(/\/viewer\/web\/[^/]*$/, "");
  const id = Math.random().toString(36).slice(2, 7);
  const t0 = performance.now();
  const send = (event, data = {}) => {
    const body = JSON.stringify({ id, event, t: Math.round(performance.now() - t0), ...data });
    try {
      if (!navigator.sendBeacon?.(BASE + "/api/clientlog", new Blob([body], { type: "application/json" })))
        fetch(BASE + "/api/clientlog", { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(() => {});
    } catch {}
  };
  const box = (sel) => {
    const el = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.top)}`;
  };
  // A 100vh probe: if this reads 0 the viewport height is the bug, not pdf.js.
  const vhProbe = () => {
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;visibility:hidden;height:100vh;width:1px;top:0";
    document.documentElement.append(d);
    const h = d.getBoundingClientRect().height;
    d.remove();
    return Math.round(h);
  };
  const layout = () => ({
    inner: [innerWidth, innerHeight],
    vv: window.visualViewport ? [Math.round(visualViewport.width), Math.round(visualViewport.height), visualViewport.scale] : null,
    dpr: devicePixelRatio,
    vh100: vhProbe(),
    framed: window !== window.top,
    body: box(document.body),
    outer: box("#outerContainer"),
    main: box("#mainContainer"),
    container: box("#viewerContainer"),
    viewer: box("#viewer"),
  });
  window.__clientLog = send;
  send("boot", { ua: navigator.userAgent, url: location.href.slice(0, 200), ...layout() });
  addEventListener("error", (e) => send("error", { msg: String(e.message), src: `${e.filename}:${e.lineno}:${e.colno}`, stack: String(e.error?.stack || "").slice(0, 800) }));
  addEventListener("unhandledrejection", (e) => send("rejection", { msg: String(e.reason?.message || e.reason), stack: String(e.reason?.stack || "").slice(0, 800) }));
  for (const level of ["error", "warn"]) {
    const orig = console[level].bind(console);
    console[level] = (...a) => {
      send(`console.${level}`, { msg: a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "object" ? (() => { try { return JSON.stringify(x); } catch { return String(x); } })() : String(x))).join(" ").slice(0, 800) });
      orig(...a);
    };
  }
  addEventListener("resize", () => send("resize", layout()));

  // pdf.js lifecycle, once the app exists.
  const wait = setInterval(() => {
    const app = window.PDFViewerApplication;
    if (!app?.initializedPromise) return;
    clearInterval(wait);
    app.initializedPromise.then(() => {
      send("initialized", layout());
      const bus = app.eventBus;
      let rendered = 0;
      bus.on("documentloaded", () => send("documentloaded", { pages: app.pagesCount }));
      bus.on("pagesinit", () => send("pagesinit", { pages: app.pagesCount, scale: app.pdfViewer.currentScaleValue, scroll: app.pdfViewer.scrollMode, spread: app.pdfViewer.spreadMode, ...layout() }));
      bus.on("pagesloaded", (e) => send("pagesloaded", { pages: e.pagesCount }));
      bus.on("scalechanging", (e) => send("scalechanging", { scale: e.scale, preset: e.presetValue }));
      bus.on("scrollmodechanged", (e) => send("scrollmodechanged", { mode: e.mode }));
      bus.on("pagerender", (e) => { if (rendered < 4) send("pagerender", { page: e.pageNumber }); });
      bus.on("pagerendered", (e) => {
        if (rendered++ >= 4) return;
        const c = e.source?.canvas;
        send("pagerendered", { page: e.pageNumber, err: e.error ? String(e.error) : null, canvas: c ? `${c.width}x${c.height}` : null, div: box(e.source?.div) });
      });
      // A snapshot of the first pages a few seconds in, rendered or not.
      for (const ms of [3000, 10000]) setTimeout(() => {
        const v = app.pdfViewer;
        const pages = (v?._pages || []).slice(0, 2).map((p) => ({ n: p.id, state: p.renderingState, w: p.width, h: p.height, scale: p.scale, div: box(p.div), canvas: p.canvas ? `${p.canvas.width}x${p.canvas.height}` : null }));
        send(`snapshot${ms / 1000}s`, { pages: app.pagesCount, scale: v?.currentScale, scaleValue: v?.currentScaleValue, scroll: v?.scrollMode, first: pages, ...layout() });
      }, ms);
    });
  }, 50);

  // 🕘 Recent: how big the dialog came out.
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("#recentFiles")) return;
    setTimeout(() => send("recent", { dialog: box("#recentDialog"), list: box("#recentDialog .recentList"), rows: document.querySelectorAll("#recentDialog .recentRow").length, ...layout() }), 1500);
  }, true);
})();
