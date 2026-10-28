// FORK 2026-10-19 (the architect: phone app) — Tinker phone mode.
//
// the architect flies with only his phone (a flip phone: a cover screen and a ~412 CSS px inner one),
// and the Jarvis app is a WebView of this very page through the phone door. The desktop layout is
// a three-column grid with a 420px right rail, which does not fit. Phone mode keeps every piece
// of it and rearranges it for one hand:
//   - one chat at a time, under a compact header: ☰, the chat dropdown, +, ⋯;
//   - the left nav rail becomes a drawer (☰, or swipe in from the left edge), with the topbar
//     toolbox moved into it so no toggle is lost;
//   - the right panels become a drawer (⋯, or swipe in from the right edge);
//   - the dropdown lists EVERY tab of the desktop tab bar, the same array, to switch, close or
//     open a chat. The desktop tab bar is still rendered, just not shown.
//
// On when the viewport is narrow (max-width 820px), when the Android app marked the page
// (html.jarvis-app), or with ?phone=1 (sticky for this browser tab; ?phone=0 clears it). It
// toggles live, so folding and unfolding the Flip6 switches layouts without a reload. Off, it
// adds nothing visible: the elements it creates carry `hidden`, every rule in phone.css is
// scoped under body.phone, and no node is moved until it switches on.
//
// app.ts wires it with an import, one initPhoneMode() after the skeleton is built and one
// phoneTabsChanged() at the end of renderTabs(). window.__jarvisBack() is what the app calls on
// the Android Back key.

import { ZEN_ICON_PATHS, zenTitleHtml } from "../zen-link.js";
import { closePdfReader, openPdfReader, showPdfReader } from "./pdf-reader.js";

export type PhoneTab = { id: string; title: string };

export interface PhoneModeDeps {
  getTabs(): readonly PhoneTab[];
  getActiveTabId(): string;
  isRunning(tabId: string): boolean;
  /** FORK 2026-10-27 — a turn finished in this chat and the owner has not seen it yet. */
  isUnread?(tabId: string): boolean;
  switchToTab(id: string): void;
  /** The same close path as the desktop tab ✕ (chained pairs close together). */
  closeTab(id: string): void;
  /** The same path as the desktop #tab-add button. */
  newTab(): void;
  /** Make the sessions panel ready to show (expanded); phone mode opens the drawer around it. */
  openSessions(): void;
  /** The desktop tab's right-click menu (rename, auto-name, clone, chain, delete), at x/y. */
  openTabMenu?(id: string, x: number, y: number): void;
  /** The desktop logo's "New session": the viewed chat starts a fresh session. */
  resetSession?(): void;
  /** True for the chat Zen Mail hands its card prompts to: its icon stands in for the title. */
  isZenTab?(id: string): boolean;
}

export const PHONE_MEDIA_QUERY = "(max-width: 820px)";
/** sessionStorage key that keeps ?phone=1 for the rest of this browser tab. */
export const PHONE_STICKY_KEY = "tinker.phoneMode";
/** A drawer gesture starts only this close to its screen edge. */
export const EDGE_BAND_PX = 48;
/** Movement before the gesture commits to an axis; below it nothing is decided. */
export const AXIS_LOCK_PX = 10;
/** Dragged past this fraction of the drawer's width, a released drawer stays open. */
export const OPEN_FRACTION = 0.35;
/** A flick faster than this (px/ms) decides on its own, whatever the distance. */
export const FLICK_PX_PER_MS = 0.4;

type Side = "left" | "right";

// ─── pure rules (unit-tested) ───────────────────────────────────────────────

/** `?phone=1` → true, `?phone=0` → false, otherwise null (no opinion). */
export function phoneQueryFlag(search: string): boolean | null {
  const v = new URLSearchParams(search).get("phone");
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return null;
}

export function phoneModeWanted(s: { narrow: boolean; inApp: boolean; sticky: boolean }): boolean {
  return s.narrow || s.inApp || s.sticky;
}

/** Which edge band a touch at `x` started in, if any. */
export function edgeOf(x: number, viewportWidth: number, band = EDGE_BAND_PX): Side | null {
  if (x <= band) return "left";
  if (x >= viewportWidth - band) return "right";
  return null;
}

/** The axis a gesture commits to once it has moved far enough, else null. */
export function lockAxis(dx: number, dy: number, threshold = AXIS_LOCK_PX): "x" | "y" | null {
  if (Math.hypot(dx, dy) < threshold) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/**
 * How open a drawer is (0..1) after a horizontal drag of `dx` px, for the side it lives on and
 * whether it started open.
 */
export function dragProgress(side: Side, startOpen: boolean, dx: number, width: number): number {
  const towardOpen = side === "left" ? dx : -dx;
  const p = (startOpen ? 1 : 0) + towardOpen / Math.max(width, 1);
  return Math.min(1, Math.max(0, p));
}

/**
 * Open or closed when the finger lifts. `velocityOpen` is px/ms in the OPENING direction. A flick
 * decides alone; otherwise a closed drawer opens past OPEN_FRACTION of its width and an open one
 * closes once pushed back by the same fraction.
 */
export function settleDrawer(progress: number, velocityOpen: number, startOpen: boolean): boolean {
  if (velocityOpen > FLICK_PX_PER_MS) return true;
  if (velocityOpen < -FLICK_PX_PER_MS) return false;
  return startOpen ? progress > 1 - OPEN_FRACTION : progress > OPEN_FRACTION;
}

/** Inline colour of a running tab's glow, from the desktop tab bar renderTabs just drew. */
export function glowColorFromStyle(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  // renderTabs writes `${hex}80` (50% alpha) for the glow; the dot wants the solid colour.
  const m = /^(#[0-9a-f]{6})[0-9a-f]{2}$/i.exec(v);
  return m ? m[1] : v;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── the controller ─────────────────────────────────────────────────────────

export interface PhoneModeController {
  isActive(): boolean;
  /** Re-evaluate whether phone mode should be on (media query, app class, sticky flag). */
  refresh(): void;
  render(): void;
  openDrawer(side: Side): void;
  closeAll(): boolean;
  toggleSheet(open?: boolean): void;
  /** What window.__jarvisBack does: close the top layer, true if something was open. */
  back(): boolean;
  destroy(): void;
}

let current: PhoneModeController | null = null;

// FORK 2026-10-23 (the architect: "the row of icons shown have no similarity, no cohesive style"). The dropdown's
// buttons were a text +, colour emoji 📄 📬 and text ✈ ⚙ ⌨. Now one line set: 24-unit grid, the stroke
// width and round joins set once in phone.css, colour from currentColor. Zen Mail = an envelope with a
// bonsai on top, the same drawing as its favicon (apps/zen-mail/ui/index.html).
const TOOL_ICONS: Record<string, string> = {
  new: '<path d="M12 5v14M5 12h14"/>',
  pdf:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>' +
    '<path d="M8.5 12.5h7M8.5 15.5h7M8.5 18h4"/>',
  zen: ZEN_ICON_PATHS,
  trip:
    '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5' +
    'c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06' +
    "a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0" +
    "-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09" +
    "A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65" +
    " 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 " +
    '2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  terminal:
    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
};
const tool = (act: string, label: string): string =>
  `<button type="button" class="phone-sheet-tool" data-phone-act="${act}" aria-label="${label}" title="${label}">` +
  `<svg viewBox="0 0 24 24" aria-hidden="true">${TOOL_ICONS[act]}</svg></button>`;

/** Call at the end of renderTabs(): the dropdown and header follow the desktop tab array. */
export function phoneTabsChanged(): void {
  current?.render();
}

type Drag = {
  pointerId: number;
  side: Side;
  startOpen: boolean;
  x0: number;
  y0: number;
  axis: "x" | "y" | null;
  width: number;
  el: HTMLElement;
  progress: number;
  samples: Array<{ x: number; t: number }>;
};

export function initPhoneMode(
  deps: PhoneModeDeps,
  opts: { doc?: Document; win?: Window } = {},
): PhoneModeController {
  current?.destroy();
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const body = doc.body;
  const app = doc.getElementById("app");
  const sidebar = doc.querySelector<HTMLElement>("nav.sidebar");
  const rightPanels = doc.querySelector<HTMLElement>(".right-panels");

  // ?phone=1 / ?phone=0 set or clear the sticky flag for this browser tab.
  const flag = phoneQueryFlag(win.location?.search ?? "");
  try {
    if (flag === true) win.sessionStorage.setItem(PHONE_STICKY_KEY, "1");
    if (flag === false) win.sessionStorage.removeItem(PHONE_STICKY_KEY);
  } catch {
    /* blocked storage: the query flag still applies to this load */
  }
  const sticky = (): boolean => {
    try {
      return win.sessionStorage.getItem(PHONE_STICKY_KEY) === "1";
    } catch {
      return flag === true;
    }
  };
  const mq = typeof win.matchMedia === "function" ? win.matchMedia(PHONE_MEDIA_QUERY) : null;

  // The header: ☰ · chat dropdown · + · ⋯. `hidden` until phone mode is on.
  const header = doc.createElement("header");
  header.className = "phone-header";
  header.id = "phone-header";
  header.hidden = true;
  header.innerHTML =
    `<button type="button" class="phone-hbtn" id="phone-menu-btn" aria-label="Menu">☰</button>` +
    `<button type="button" class="phone-chat-btn" id="phone-chat-btn" aria-haspopup="listbox" aria-expanded="false">` +
    `<span class="phone-run-dot" aria-hidden="true"></span><span class="phone-chat-title"></span>` +
    `<span class="phone-caret" aria-hidden="true">▾</span>` +
    // FORK 2026-10-27 — another chat has an unread result: the dropdown is where to find it.
    `<span class="phone-unread-dot phone-unread-elsewhere" aria-label="unread result in another chat" hidden></span></button>` +
    // FORK 2026-10-19 (the architect: phone app) — the trip corner lives here inside the Jarvis app, so no
    // floating button covers the chat. Hidden in a plain browser (no JarvisNative).
    `<button type="button" class="phone-hbtn" id="phone-trip-btn" aria-label="Trip" hidden>✈</button>` +
    // FORK 2026-10-19 (the architect: "there is no app settings or I cannot reach it") — the app's own settings
    // (door addresses, version, Check for update). App only, like the trip button.
    `<button type="button" class="phone-hbtn" id="phone-settings-btn" aria-label="App settings" hidden>⚙</button>` +
    // 2026-10-19 (the architect): exec mode lives in the header on the phone; it drives the toolbar's 🎯.
    `<button type="button" class="phone-hbtn" id="phone-exec-btn" aria-label="Exec mode">🎯</button>` +
    `<button type="button" class="phone-hbtn" id="phone-new-btn" aria-label="New chat">+</button>` +
    `<button type="button" class="phone-hbtn" id="phone-more-btn" aria-label="Panels">⋯</button>`;
  if (app) app.insertBefore(header, app.firstChild);
  const tripBtn = header.querySelector<HTMLElement>("#phone-trip-btn");
  // 2026-10-20 (the architect): ✈ and ⚙ live in the tab dropdown's bottom row now.
  if (tripBtn) tripBtn.hidden = true;
  const settingsBtn = header.querySelector<HTMLElement>("#phone-settings-btn");
  if (settingsBtn) settingsBtn.hidden = true;

  const backdrop = doc.createElement("div");
  backdrop.className = "phone-backdrop";
  backdrop.hidden = true;
  body.appendChild(backdrop);

  const sheet = doc.createElement("div");
  sheet.className = "phone-sheet";
  sheet.id = "phone-sheet";
  sheet.setAttribute("role", "listbox");
  sheet.hidden = true;
  body.appendChild(sheet);

  // Where the topbar toolbox lives on desktop, so switching off puts it back exactly.
  const tools = doc.querySelector<HTMLElement>(".topbar-controls");
  let toolsHome: { parent: Node; next: Node | null } | null = null;
  const toolsSlot = doc.createElement("div");
  toolsSlot.className = "phone-drawer-tools";
  toolsSlot.hidden = true;
  // 2026-10-19 (the architect): no "New session in this chat" in the phone drawer.

  let active = false;
  let leftOpen = false;
  let rightOpen = false;
  let sheetOpen = false;
  let drag: Drag | null = null;

  // FORK 2026-10-23 (the architect: "when a download is happening and I open the drop-down, I cannot click on
  // any of the options; the downloading message should stick to the bottom of the drop-down"). Inside
  // the Jarvis app the page tells the app when this sheet opens: the app's update banner steps aside
  // and its line comes back as a "jarvis-native" {ev:"update"} event, shown in the sheet's footer.
  type SheetNative = { sheet?: (open: boolean) => void };
  let updateLine = "";
  let nativeSheet = false;
  let sheetPoll: number | null = null;
  const tellNativeSheet = (open: boolean): void => {
    const n = (win as Window & { JarvisNative?: SheetNative }).JarvisNative;
    if (!n?.sheet || open === nativeSheet) return;
    nativeSheet = open;
    n.sheet(open);
    if (open) sheetPoll = win.setInterval(() => n.sheet?.(true), 1500);
    else if (sheetPoll !== null) {
      win.clearInterval(sheetPoll);
      sheetPoll = null;
    }
  };
  win.addEventListener("jarvis-native", (e) => {
    const d = (e as CustomEvent<{ ev?: string; line?: string }>).detail;
    if (d?.ev !== "update") return;
    updateLine = typeof d.line === "string" ? d.line : "";
    const foot = sheet.querySelector<HTMLElement>(".phone-sheet-update");
    if (foot) {
      foot.textContent = updateLine;
      foot.hidden = !updateLine;
    }
  });

  const syncClasses = (): void => {
    tellNativeSheet(active && sheetOpen);
    body.classList.toggle("phone-left-open", active && leftOpen);
    body.classList.toggle("phone-right-open", active && rightOpen);
    body.classList.toggle("phone-sheet-open", active && sheetOpen);
    header
      .querySelector("#phone-chat-btn")
      ?.setAttribute("aria-expanded", sheetOpen ? "true" : "false");
  };

  const setActive = (on: boolean): void => {
    if (on === active) return;
    active = on;
    if (!on) {
      leftOpen = rightOpen = sheetOpen = false;
      endDrag(false);
    }
    body.classList.toggle("phone", on);
    header.hidden = !on;
    backdrop.hidden = !on;
    sheet.hidden = !on;
    toolsSlot.hidden = !on;
    if (tools && sidebar) {
      if (on) {
        if (tools.parentNode && tools.parentNode !== toolsSlot) {
          toolsHome = { parent: tools.parentNode, next: tools.nextSibling };
        }
        sidebar.appendChild(toolsSlot);
        toolsSlot.appendChild(tools);
      } else if (toolsHome) {
        toolsHome.parent.insertBefore(tools, toolsHome.next);
        toolsSlot.remove();
      }
    }
    syncClasses();
    render();
  };

  const wanted = (): boolean =>
    phoneModeWanted({
      narrow: mq?.matches ?? false,
      inApp: doc.documentElement.classList.contains("jarvis-app"),
      sticky: sticky(),
    });
  const refresh = (): void => setActive(wanted());

  const runColor = (tabId: string): string | null => {
    for (const el of doc.querySelectorAll<HTMLElement>("#tab-bar-scroll [data-tab-id]")) {
      if (el.dataset.tabId === tabId) {
        return glowColorFromStyle(el.style.getPropertyValue("--glow-color"));
      }
    }
    return null;
  };

  function render(): void {
    if (!active) return;
    const tabs = deps.getTabs();
    const activeId = deps.getActiveTabId();
    const activeTab = tabs.find((t) => t.id === activeId);
    const titleEl = header.querySelector<HTMLElement>(".phone-chat-title");
    if (titleEl) {
      if (activeTab && deps.isZenTab?.(activeTab.id))
        titleEl.innerHTML = zenTitleHtml(activeTab.title, esc);
      else titleEl.textContent = activeTab?.title ?? "Chat";
    }
    const dot = header.querySelector<HTMLElement>(".phone-run-dot");
    if (dot) {
      const on = Boolean(activeTab && deps.isRunning(activeTab.id));
      dot.classList.toggle("on", on);
      const c = on && activeTab ? runColor(activeTab.id) : null;
      if (c) dot.style.setProperty("--run", c);
      else dot.style.removeProperty("--run");
    }
    const elsewhere = header.querySelector<HTMLElement>(".phone-unread-elsewhere");
    if (elsewhere) {
      elsewhere.hidden = !tabs.some((t) => t.id !== activeId && deps.isUnread?.(t.id));
    }
    // 2026-10-21 (the architect): the row of buttons goes at the TOP of the list, and gains the PDF reader
    // on the file read last. Before: the list ended in it (2026-10-20). 📄 works in a plain browser
    // too (tinker-prod-ui serves the reader under /pdf/); ✈ ⚙ ⌨ need the Jarvis app.
    const inApp = Boolean((win as Window & { JarvisNative?: unknown }).JarvisNative);
    let rows =
      `<div class="phone-sheet-row phone-sheet-tools" role="presentation">` +
      tool("new", "New chat") +
      tool("pdf", "PDF reader") +
      // 2026-10-21 (the architect): Zen Mail like the PDF reader: tinker-prod-ui serves it under /zen/.
      tool("zen", "Zen Mail") +
      (inApp
        ? tool("trip", "Trip") + tool("settings", "App settings") + tool("terminal", "Pi terminal")
        : "") +
      `</div>`;
    for (const t of tabs) {
      const running = deps.isRunning(t.id);
      const c = running ? runColor(t.id) : null;
      const isActive = t.id === activeId;
      rows +=
        `<div class="phone-sheet-row${isActive ? " active" : ""}" role="option" aria-selected="${isActive}" data-phone-tab="${esc(t.id)}">` +
        `<span class="phone-run-dot${running ? " on" : ""}"${c ? ` style="--run:${esc(c)}"` : ""} aria-hidden="true"></span>` +
        `<span class="phone-sheet-title">${deps.isZenTab?.(t.id) ? zenTitleHtml(t.title, esc) : esc(t.title)}</span>` +
        (deps.isUnread?.(t.id)
          ? `<span class="phone-unread-dot" aria-label="unread result"></span>`
          : "") +
        (deps.openTabMenu
          ? `<button type="button" class="phone-sheet-more" data-phone-menu="${esc(t.id)}" aria-label="Chat actions">⋯</button>`
          : "") +
        (t.id === "tab-main"
          ? `<span class="phone-sheet-close-spacer"></span>`
          : `<button type="button" class="phone-sheet-close" data-phone-close="${esc(t.id)}" aria-label="Close chat">✕</button>`) +
        `</div>`;
    }
    // 2026-10-20 (the architect): "All chats…" is redundant (the right drawer lists them). ✈ ⚙ ⌨ moved from
    // the header into the button row above (the terminal is served by the phone door, so it opens
    // even when the gateway hangs).
    sheet.innerHTML =
      `<div class="phone-sheet-list">${rows}</div>` +
      `<div class="phone-sheet-update" role="status"${updateLine ? "" : " hidden"}>${esc(updateLine)}</div>`;
  }

  /** A pick from the dropdown is a chat: leave an alt view (overview, cron…) for the chat. */
  const showChatView = (): void => {
    const chatNav = doc.querySelector<HTMLElement>('.nav-btn[data-tab="chat"]');
    if (chatNav && !chatNav.classList.contains("nav-active")) chatNav.click();
  };

  const closeAll = (): boolean => {
    const had = leftOpen || rightOpen || sheetOpen;
    leftOpen = rightOpen = sheetOpen = false;
    syncClasses();
    return had;
  };

  const openDrawer = (side: Side): void => {
    if (!active) return;
    sheetOpen = false;
    leftOpen = side === "left";
    rightOpen = side === "right";
    syncClasses();
  };

  const toggleSheet = (open?: boolean): void => {
    if (!active) return;
    const next = open ?? !sheetOpen;
    leftOpen = rightOpen = false;
    sheetOpen = next;
    if (next) render();
    syncClasses();
  };

  // The PDF reader layer sits over everything, so Back closes it first.
  const back = (): boolean => closePdfReader(doc) || (active ? closeAll() : false);

  // ── clicks ──
  const onHeaderClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!btn) return;
    if (btn.id === "phone-menu-btn") {
      if (leftOpen) closeAll();
      else openDrawer("left");
    } else if (btn.id === "phone-more-btn") {
      if (rightOpen) closeAll();
      else openDrawer("right");
    } else if (btn.id === "phone-chat-btn") {
      toggleSheet();
    } else if (btn.id === "phone-trip-btn") {
      closeAll();
      (
        win as Window & { JarvisNative?: { openNative?: (s: string) => void } }
      ).JarvisNative?.openNative?.("trip");
    } else if (btn.id === "phone-exec-btn") {
      closeAll();
      showChatView();
      doc.getElementById("tb-exec")?.click();
      btn.classList.toggle(
        "tb-active",
        !!doc.getElementById("app")?.classList.contains("exec-mode"),
      );
    } else if (btn.id === "phone-settings-btn") {
      closeAll();
      (
        win as Window & { JarvisNative?: { openNative?: (s: string) => void } }
      ).JarvisNative?.openNative?.("settings");
    } else if (btn.id === "phone-new-btn") {
      closeAll();
      showChatView();
      deps.newTab();
    }
  };
  // What a tap on the sheet means, read off the element it landed on.
  type SheetHit = { kind: "close" | "menu" | "act" | "tab"; id: string };
  const sheetHit = (target: EventTarget | null): SheetHit | null => {
    const t = (target as Node | null)?.nodeType === 1 ? (target as HTMLElement) : null;
    if (!t || !sheet.contains(t)) return null;
    const close = t.closest<HTMLElement>("[data-phone-close]");
    if (close) return { kind: "close", id: close.dataset.phoneClose ?? "" };
    const menu = t.closest<HTMLElement>("[data-phone-menu]");
    if (menu) return { kind: "menu", id: menu.dataset.phoneMenu ?? "" };
    const act = t.closest<HTMLElement>("[data-phone-act]");
    if (act) return { kind: "act", id: act.dataset.phoneAct ?? "" };
    const row = t.closest<HTMLElement>("[data-phone-tab]");
    if (row) return { kind: "tab", id: row.dataset.phoneTab ?? "" };
    return null;
  };
  // renderTabs rebuilds the sheet on every run-state change. A rebuild between the finger going
  // down and coming up sends the click to the sheet itself, with no row under it, so the row the
  // finger went down on is remembered and used when the click finds nothing.
  let pressed: { hit: SheetHit; at: number } | null = null;
  const onSheetPointerDown = (e: PointerEvent): void => {
    const hit = sheetHit(e.target);
    pressed = hit ? { hit, at: e.timeStamp } : null;
  };
  const onSheetClick = (e: Event): void => {
    let hit = sheetHit(e.target);
    if (!hit && pressed && e.timeStamp - pressed.at < 1_000) hit = pressed.hit;
    pressed = null;
    if (!hit) return;
    if (hit.kind === "close") {
      e.stopPropagation();
      deps.closeTab(hit.id);
      return; // the sheet stays open; renderTabs re-renders it through phoneTabsChanged
    }
    if (hit.kind === "menu") {
      // stopPropagation: the app closes its tab menu on any click that reaches the document
      e.stopPropagation();
      const r = [...sheet.querySelectorAll<HTMLElement>("[data-phone-menu]")]
        .find((b) => b.dataset.phoneMenu === hit?.id)
        ?.getBoundingClientRect();
      // FORK 2026-10-27 (the architect: "the drop down contracts while the options are visible. It should
      // not contract"): the sheet stays open under the menu (menu z-index 1300 > sheet 1150).
      deps.openTabMenu?.(hit.id, r ? r.left - 160 : 16, r ? r.bottom : 64);
      return;
    }
    const act = hit.kind === "act" ? hit.id : undefined;
    if (act === "new") {
      closeAll();
      showChatView();
      deps.newTab();
      return;
    }
    if (act === "pdf") {
      closeAll();
      openPdfReader(null, fetch, doc).catch((err: unknown) => {
        console.error("[phone] opening the PDF reader failed", err);
        win.alert(
          `The PDF reader did not open: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return;
    }
    if (act === "zen") {
      closeAll();
      showPdfReader("/zen/", doc, "Zen Mail");
      return;
    }
    if (act === "trip" || act === "settings" || act === "terminal") {
      closeAll();
      (
        win as Window & { JarvisNative?: { openNative?: (s: string) => void } }
      ).JarvisNative?.openNative?.(act);
      return;
    }
    if (act === "all") {
      showChatView();
      openDrawer("right");
      deps.openSessions();
      doc.getElementById("sessions-panel")?.scrollIntoView?.({ block: "start" });
      return;
    }
    if (hit.kind === "tab") {
      closeAll();
      showChatView();
      deps.switchToTab(hit.id);
    }
  };
  const onBackdropClick = (): void => {
    closeAll();
  };
  // A view picked in the left drawer is a destination: close the drawer behind it. The toolbox
  // toggles in the same drawer are not, so they leave it open.
  const onSidebarClick = (e: Event): void => {
    const t = e.target as HTMLElement;
    if (active && t.closest('[data-phone-act="reset"]')) {
      closeAll();
      showChatView();
      deps.resetSession?.();
      return;
    }
    if (active && leftOpen && t.closest(".nav-btn")) {
      closeAll();
    }
  };
  // A chat picked in the sessions panel opens it: the right drawer gets out of the way. Its
  // controls (delete, pause, the panel header folds) are not picks and leave it open.
  const onRightClick = (e: Event): void => {
    const t = e.target as HTMLElement;
    if (!active || !rightOpen || t.closest("button, a, input, select")) return;
    if (t.closest("#sessions-list .session-row[data-session-key]")) {
      // after the app's own handler has run on this click
      win.setTimeout(() => {
        closeAll();
        showChatView();
      }, 0);
    }
  };
  const onKey = (e: KeyboardEvent): void => {
    // 2026-10-25: the reader layer lost its ✕; Escape closes it first, like the phone's Back.
    if (e.key === "Escape" && (closePdfReader(doc) || active)) closeAll();
  };

  // ── edge-swipe gestures ──
  // Pointer events, all passive: nothing here ever calls preventDefault. phone.css gives the
  // scrolling surfaces `touch-action: pan-y pinch-zoom`, so a horizontal drag stays with us while
  // a vertical one scrolls as usual (the browser cancels our pointer and we let go).
  const drawerEl = (side: Side): HTMLElement | null => (side === "left" ? sidebar : rightPanels);

  const scrollsSideways = (target: EventTarget | null): boolean => {
    let el = (target as Node | null)?.nodeType === 1 ? (target as HTMLElement) : null;
    while (el && el !== body) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const ox = win.getComputedStyle(el).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
      el = el.parentElement;
    }
    return false;
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!active || drag || e.pointerType === "mouse" || sheetOpen) return;
    const vw = win.innerWidth;
    const edge = edgeOf(e.clientX, vw);
    let side: Side;
    let startOpen: boolean;
    if (leftOpen || rightOpen) {
      side = leftOpen ? "left" : "right";
      startOpen = true;
      if (!edge && scrollsSideways(e.target)) return;
    } else {
      if (!edge) return;
      side = edge;
      startOpen = false;
    }
    const el = drawerEl(side);
    if (!el) return;
    drag = {
      pointerId: e.pointerId,
      side,
      startOpen,
      x0: e.clientX,
      y0: e.clientY,
      axis: null,
      width: el.getBoundingClientRect().width || Math.min(vw * 0.8, 320),
      el,
      progress: startOpen ? 1 : 0,
      samples: [{ x: e.clientX, t: e.timeStamp }],
    };
  };

  const applyDrag = (d: Drag): void => {
    const off = (1 - d.progress) * d.width * 1.05;
    d.el.style.transform = `translateX(${d.side === "left" ? -off : off}px)`;
    backdrop.style.opacity = String(d.progress);
  };

  const onPointerMove = (e: PointerEvent): void => {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (d.axis === null) {
      d.axis = lockAxis(dx, dy);
      if (d.axis === null) return;
      const towardOpen = d.side === "left" ? dx > 0 : dx < 0;
      // Vertical, or the wrong way (opening a closed drawer away from its edge, or pushing an
      // open one further open): not ours.
      if (d.axis === "y" || towardOpen === d.startOpen) {
        drag = null;
        return;
      }
      body.classList.add("phone-dragging");
      body.classList.add(d.side === "left" ? "phone-left-drag" : "phone-right-drag");
    }
    d.progress = dragProgress(d.side, d.startOpen, dx, d.width);
    d.samples.push({ x: e.clientX, t: e.timeStamp });
    if (d.samples.length > 6) d.samples.shift();
    applyDrag(d);
  };

  function endDrag(settle: boolean, e?: PointerEvent): void {
    const d = drag;
    drag = null;
    if (!d || d.axis !== "x") return;
    let open = d.startOpen;
    if (settle) {
      const s = d.samples;
      const last = e ? { x: e.clientX, t: e.timeStamp } : s[s.length - 1];
      const ref = s.find((p) => last.t - p.t <= 100) ?? s[0];
      const dt = Math.max(last.t - ref.t, 1);
      const v = (last.x - ref.x) / dt;
      open = settleDrawer(d.progress, d.side === "left" ? v : -v, d.startOpen);
    }
    body.classList.remove("phone-dragging", "phone-left-drag", "phone-right-drag");
    d.el.style.transform = "";
    backdrop.style.opacity = "";
    if (d.side === "left") leftOpen = open;
    else rightOpen = open;
    if (open) {
      sheetOpen = false;
      if (d.side === "left") rightOpen = false;
      else leftOpen = false;
    }
    syncClasses();
  }

  const onPointerUp = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.pointerId) endDrag(true, e);
  };
  const onPointerCancel = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.pointerId) endDrag(true);
  };

  const onMq = (): void => refresh();
  const appClassObserver =
    typeof MutationObserver === "function" ? new MutationObserver(onMq) : null;

  header.addEventListener("click", onHeaderClick);
  sheet.addEventListener("click", onSheetClick);
  sheet.addEventListener("pointerdown", onSheetPointerDown, { passive: true });
  backdrop.addEventListener("click", onBackdropClick);
  sidebar?.addEventListener("click", onSidebarClick);
  // capture: the panel's own handler re-renders the list, detaching the row before bubbling ends
  rightPanels?.addEventListener("click", onRightClick, true);
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("pointerdown", onPointerDown, { passive: true });
  doc.addEventListener("pointermove", onPointerMove, { passive: true });
  doc.addEventListener("pointerup", onPointerUp, { passive: true });
  doc.addEventListener("pointercancel", onPointerCancel, { passive: true });
  mq?.addEventListener?.("change", onMq);
  win.addEventListener("resize", onMq);
  // FORK 2026-10-19 (the architect: phone app) — inside the Jarvis app's WebView every vh unit (vh, dvh, svh,
  // lvh) resolves to 0 while innerHeight is right (measured on WebView 155), which drew #app at 0 px:
  // a black screen. phone.css sizes heights from --phone-vh, kept here from innerHeight.
  const syncPhoneVh = () => {
    if (win.innerHeight > 0)
      doc.documentElement.style.setProperty("--phone-vh", `${win.innerHeight}px`);
  };
  syncPhoneVh();
  // FORK 2026-10-22 (the architect: the review PDF opened grey, "1 of 15", Recent a brown line). A tapped
  // http link to the viewer (/pdf/viewer/…) loaded it as the whole WebView page, where every vh is 0
  // (above), so its pages and dialogs collapsed. Open it in the reader layer's iframe instead, where
  // vh is right (client log: 100vh = 882 framed). Same-origin or door-host links only.
  const onViewerLink = (e: MouseEvent): void => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    let u: URL;
    try {
      u = new URL(a.href, win.location.href);
    } catch {
      return;
    }
    if (!/^\/pdf\/viewer\/web\/viewer\.html$/.test(u.pathname)) return;
    if (u.host !== win.location.host && u.hostname !== win.location.hostname) return;
    e.preventDefault();
    e.stopPropagation();
    console.info("[phone] viewer link opened in the reader layer", u.pathname + u.search);
    showPdfReader(u.pathname + u.search, doc);
  };
  doc.addEventListener("click", onViewerLink, true);
  win.addEventListener("resize", syncPhoneVh);
  win.visualViewport?.addEventListener("resize", syncPhoneVh);
  appClassObserver?.observe(doc.documentElement, { attributes: true, attributeFilter: ["class"] });

  const w = win as Window & { __jarvisBack?: () => boolean };
  w.__jarvisBack = back;

  const controller: PhoneModeController = {
    isActive: () => active,
    refresh,
    render,
    openDrawer,
    closeAll,
    toggleSheet,
    back,
    destroy: () => {
      setActive(false);
      header.removeEventListener("click", onHeaderClick);
      sheet.removeEventListener("click", onSheetClick);
      sheet.removeEventListener("pointerdown", onSheetPointerDown);
      backdrop.removeEventListener("click", onBackdropClick);
      sidebar?.removeEventListener("click", onSidebarClick);
      rightPanels?.removeEventListener("click", onRightClick, true);
      doc.removeEventListener("keydown", onKey);
      doc.removeEventListener("click", onViewerLink, true);
      doc.removeEventListener("pointerdown", onPointerDown);
      doc.removeEventListener("pointermove", onPointerMove);
      doc.removeEventListener("pointerup", onPointerUp);
      doc.removeEventListener("pointercancel", onPointerCancel);
      mq?.removeEventListener?.("change", onMq);
      win.removeEventListener("resize", onMq);
      appClassObserver?.disconnect();
      header.remove();
      backdrop.remove();
      sheet.remove();
      if (w.__jarvisBack === back) delete w.__jarvisBack;
      if (current === controller) current = null;
    },
  };
  current = controller;
  refresh();
  return controller;
}
