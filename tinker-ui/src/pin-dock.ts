// FORK 2026-10-13 (the architect: "a way to pin a particular response to the top of the chat, while I can
// keep working … shrink the page and scroll it … on mouseover a brown pin on the top-right").
//
// One pinned answer per chat tab, docked above #messages. Hovering an assistant bubble shows a
// brown pin at its top-right; clicking it copies the bubble's rendered HTML into the dock. The
// dock is resizable (drag its bottom edge) and scrolls on its own, so the chat keeps working
// underneath. Pins persist per session key in localStorage, so they survive a reload and a tab
// switch, and do not depend on the pinned turn still being inside the loaded history window.
//
// The button is attached on hover (event delegation), not in the ~10 bubble render sites, so no
// render path changes. Copies keep html-render iframes working: srcdoc is in the markup and the
// frame-resize listener matches every iframe.chat-html-frame on the page.

const STORE_KEY = "tinker-pinned-answers";
const DEFAULT_HEIGHT = 260;

type Pin = { html: string; at: number; height?: number };
type PinMap = Record<string, Pin>;

const PIN_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" ' +
  'd="M16 3l5 5-2 1-3 3 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 3-3z"/></svg>';

function readPins(): PinMap {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as PinMap) : {};
  } catch {
    return {};
  }
}

function writePins(m: PinMap): void {
  const before = readPins();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(m));
  } catch (err) {
    console.error("[pin-dock] could not save the pin", err);
  }
  sharePinChanges(before, m);
}

// FORK 2026-10-16 (the architect: Zen Mail may show "tasks that I have pinned"). Pins live only in this page's localStorage,
// so the page tells Zen Mail (loopback, 127.0.0.1:18804) what CHANGED: pins added or edited, keys removed. Never the
// full set: another browser running Tinker (a phone, a test page) has no pins, and a full set from it would wipe
// these. A "simple" text/plain POST needs no CORS preflight and no answer; Zen Mail being down changes nothing here.
const ZEN_MAIL_PINS_URL = "http://127.0.0.1:18804/api/pins";

function pinText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll("iframe, script, style").forEach((n) => n.remove());
  return (div.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 3000);
}

function postPins(pins: { key: string; at: number; text: string }[], removed: string[]): void {
  if (pins.length === 0 && removed.length === 0) return;
  void fetch(ZEN_MAIL_PINS_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ pins, removed }),
  }).catch(() => {
    /* Zen Mail not running: nothing to do */
  });
}

/** Tell Zen Mail what changed between two pin maps (added or re-pinned answers, removed keys). */
export function sharePinChanges(before: PinMap, after: PinMap): void {
  try {
    const pins = Object.entries(after)
      .filter(([key, p]) => before[key]?.html !== p.html || before[key]?.at !== p.at)
      .map(([key, p]) => ({ key, at: p.at, text: pinText(p.html) }));
    const removed = Object.keys(before).filter((key) => !(key in after));
    postPins(pins, removed);
  } catch (err) {
    console.error("[pin-dock] could not share the pins with Zen Mail", err);
  }
}

/** The bubble's HTML without its own controls (pin, retry, elapsed chip). */
export function snapshotBubble(bubble: Element): string {
  const copy = bubble.cloneNode(true) as Element;
  copy
    .querySelectorAll(".msg-pin-btn, .retry-provider-btn, .msg-elapsed")
    .forEach((n) => n.remove());
  return copy.innerHTML;
}

function injectStyles(): void {
  if (document.getElementById("pin-dock-style")) {
    return;
  }
  const st = document.createElement("style");
  st.id = "pin-dock-style";
  st.textContent =
    ".msg.assistant{position:relative}" +
    ".msg-pin-btn{position:absolute;top:4px;right:4px;width:26px;height:26px;display:flex;align-items:center;" +
    // FORK 2026-10-15 (owner): styled like the quote Copy button (.bq-copy); the old cream fill went white on hover.
    "justify-content:center;border:1px solid var(--border,#c9b48f);border-radius:4px;background:transparent;" +
    "color:var(--muted,#7a4e24);cursor:pointer;opacity:0;transition:opacity .12s;z-index:2;padding:0}" +
    ".msg.assistant:hover>.msg-pin-btn{opacity:1}" +
    ".msg-pin-btn:hover{color:var(--text,#3b2a14);border-color:currentColor}" +
    ".msg-pin-btn.is-pinned{opacity:1;color:#7a4e24;border-color:#7a4e24;background:rgba(122,78,36,.12)}" +
    "#pin-dock{flex:none;position:relative;margin:6px 8px 0}" +
    "#pin-dock[hidden]{display:none}" +
    "#pin-dock .pd-body{overflow:auto;min-height:60px;margin:0;max-width:none}" +
    "#pin-dock .pd-unpin{position:absolute;top:4px;right:6px;z-index:3;width:24px;height:24px;border:none;" +
    "border-radius:6px;background:rgba(0,0,0,.35);color:#e8d3b0;cursor:pointer;font-size:14px;line-height:24px;padding:0}" +
    "#pin-dock .pd-unpin:hover{background:rgba(0,0,0,.6)}" +
    "#pin-dock .pd-grip{height:10px;cursor:ns-resize;display:flex;align-items:center;justify-content:center;touch-action:none}" +
    "#pin-dock .pd-grip::before{content:'';width:48px;height:4px;border-radius:2px;background:#8a6a45;opacity:.7}" +
    "#pin-dock .pd-grip:hover::before{opacity:1}";
  document.head.appendChild(st);
}

let dock: HTMLElement | null = null;
let shownKey: string | null = null;
let getKey: () => string = () => "";

function render(key: string): void {
  if (!dock) {
    return;
  }
  shownKey = key;
  const pin = key ? readPins()[key] : undefined;
  if (!pin) {
    dock.hidden = true;
    dock.innerHTML = "";
    return;
  }
  dock.hidden = false;
  dock.innerHTML =
    `<div class="pd-body msg assistant"></div>` +
    `<button class="pd-unpin" title="Unpin">✕</button>` +
    `<div class="pd-grip" title="Drag to show more or less of the pinned answer"></div>`;
  const body = dock.querySelector(".pd-body") as HTMLElement;
  body.style.height = `${pin.height ?? DEFAULT_HEIGHT}px`;
  body.innerHTML = pin.html;
  const grip = dock.querySelector(".pd-grip") as HTMLElement;
  grip.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const y0 = ev.clientY;
    const h0 = body.getBoundingClientRect().height;
    const max = Math.round(window.innerHeight * 0.85);
    const move = (e: PointerEvent) => {
      body.style.height = `${Math.min(max, Math.max(60, Math.round(h0 + e.clientY - y0)))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const m = readPins();
      if (m[key]) {
        m[key].height = parseInt(body.style.height, 10) || DEFAULT_HEIGHT;
        writePins(m);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

export function pinBubble(key: string, bubble: Element): void {
  if (!key) {
    return;
  }
  const m = readPins();
  m[key] = { html: snapshotBubble(bubble), at: Date.now(), height: m[key]?.height };
  writePins(m);
  render(key);
}

export function unpin(key: string): void {
  const m = readPins();
  delete m[key];
  writePins(m);
  render(key);
}

/** Call after every chat repaint: swaps the dock when the active tab changed, else no-op. */
export function syncPinDock(): void {
  const key = getKey();
  if (key !== shownKey) {
    render(key);
  }
}

export function wirePinDock(messages: HTMLElement, sessionKey: () => string): void {
  sharePinChanges({}, readPins()); // this page's pins, added (never a removal) at start
  if (dock) {
    return;
  }
  getKey = sessionKey;
  injectStyles();
  dock = document.createElement("div");
  dock.id = "pin-dock";
  dock.hidden = true;
  messages.parentElement?.insertBefore(dock, messages);

  messages.addEventListener("mouseover", (ev) => {
    const bubble = (ev.target as Element | null)?.closest?.(".msg.assistant:not(.msg-thinking)");
    if (!bubble || !messages.contains(bubble) || bubble.querySelector(":scope > .msg-pin-btn")) {
      return;
    }
    const btn = document.createElement("button");
    btn.className = "msg-pin-btn";
    btn.type = "button";
    btn.title = "Pin this answer to the top of the chat";
    btn.innerHTML = PIN_SVG;
    bubble.appendChild(btn);
  });
  messages.addEventListener("click", (ev) => {
    const btn = (ev.target as Element | null)?.closest?.(".msg-pin-btn");
    if (!btn) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const bubble = btn.closest(".msg.assistant");
    if (bubble) {
      pinBubble(getKey(), bubble);
    }
  });
  dock.addEventListener("click", (ev) => {
    if ((ev.target as Element).closest(".pd-unpin")) {
      unpin(getKey());
    }
  });
  render(getKey());
}

/** Test-only: forget the module state. */
export function __resetPinDockForTest(): void {
  dock = null;
  shownKey = null;
  getKey = () => "";
}
