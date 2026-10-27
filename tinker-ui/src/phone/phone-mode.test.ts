// FORK 2026-10-19 (the architect: phone app) — phone mode: the pure gesture rules, and the controller
// against a minimal copy of the app.ts skeleton under jsdom.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dragProgress,
  edgeOf,
  glowColorFromStyle,
  initPhoneMode,
  lockAxis,
  phoneModeWanted,
  phoneQueryFlag,
  phoneTabsChanged,
  PHONE_STICKY_KEY,
  settleDrawer,
  type PhoneModeController,
  type PhoneModeDeps,
  type PhoneTab,
} from "./phone-mode";

describe("pure rules", () => {
  it("reads ?phone=1 / ?phone=0 and nothing else", () => {
    expect(phoneQueryFlag("?phone=1")).toBe(true);
    expect(phoneQueryFlag("?a=b&phone=0")).toBe(false);
    expect(phoneQueryFlag("?phone=yes")).toBeNull();
    expect(phoneQueryFlag("")).toBeNull();
  });

  it("is wanted for any one of narrow, in-app or sticky", () => {
    expect(phoneModeWanted({ narrow: false, inApp: false, sticky: false })).toBe(false);
    expect(phoneModeWanted({ narrow: true, inApp: false, sticky: false })).toBe(true);
    expect(phoneModeWanted({ narrow: false, inApp: true, sticky: false })).toBe(true);
    expect(phoneModeWanted({ narrow: false, inApp: false, sticky: true })).toBe(true);
  });

  it("finds the 48px edge bands", () => {
    expect(edgeOf(0, 412)).toBe("left");
    expect(edgeOf(48, 412)).toBe("left");
    expect(edgeOf(49, 412)).toBeNull();
    expect(edgeOf(363, 412)).toBeNull();
    expect(edgeOf(364, 412)).toBe("right");
    expect(edgeOf(412, 412)).toBe("right");
  });

  it("locks an axis only after 10px, and to the dominant one", () => {
    expect(lockAxis(6, 6)).toBeNull();
    expect(lockAxis(12, 3)).toBe("x");
    expect(lockAxis(-3, 12)).toBe("y");
    expect(lockAxis(-12, 3)).toBe("x");
  });

  it("follows the finger, clamped to 0..1, per side and start state", () => {
    expect(dragProgress("left", false, 160, 320)).toBe(0.5);
    expect(dragProgress("left", false, -50, 320)).toBe(0);
    expect(dragProgress("left", true, -80, 320)).toBe(0.75);
    expect(dragProgress("right", false, -160, 320)).toBe(0.5);
    expect(dragProgress("right", true, 400, 320)).toBe(0);
  });

  it("opens past 35% or on a flick faster than 0.4 px/ms", () => {
    expect(settleDrawer(0.34, 0, false)).toBe(false);
    expect(settleDrawer(0.36, 0, false)).toBe(true);
    expect(settleDrawer(0.1, 0.5, false)).toBe(true);
    expect(settleDrawer(0.9, -0.5, false)).toBe(false);
    // an open drawer closes once pushed back by 35%
    expect(settleDrawer(0.7, 0, true)).toBe(true);
    expect(settleDrawer(0.6, 0, true)).toBe(false);
    expect(settleDrawer(0.95, -0.5, true)).toBe(false);
  });

  it("takes the solid colour out of the tab glow", () => {
    expect(glowColorFromStyle("#D9775780")).toBe("#D97757");
    expect(glowColorFromStyle(" #abcdef ")).toBe("#abcdef");
    expect(glowColorFromStyle("")).toBeNull();
  });
});

// ─── controller ──────────────────────────────────────────────────────────────

const SKELETON = `
<div id="app">
  <nav class="sidebar">
    <button class="nav-btn nav-active" data-tab="chat" data-hint="Chat"></button>
    <button class="nav-btn" data-tab="overview" data-hint="Overview"></button>
  </nav>
  <div class="topbar">
    <div class="tab-bar" id="tab-bar"><div class="tab-bar-scroll" id="tab-bar-scroll"></div></div>
    <div class="topbar-controls"><div class="toolbox"><span id="tb-voice"></span></div></div>
    <span id="after-controls"></span>
  </div>
  <div class="chat-area"></div>
  <div class="right-panels"><div class="rpanel" id="sessions-panel"><div id="sessions-list">
    <div class="session-row" data-session-key="k1"><span class="session-label">One</span><button class="session-delete-btn">x</button></div>
  </div></div></div>
</div>`;

type Mq = { matches: boolean; listeners: Array<() => void> };

function installMatchMedia(mq: Mq): void {
  window.matchMedia = vi.fn(() => ({
    get matches() {
      return mq.matches;
    },
    media: "(max-width: 820px)",
    addEventListener: (_: string, fn: () => void) => mq.listeners.push(fn),
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function pointer(type: string, x: number, y: number, t: number, pointerType = "touch"): Event {
  const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(ev, "pointerType", { value: pointerType });
  Object.defineProperty(ev, "pointerId", { value: 1 });
  Object.defineProperty(ev, "timeStamp", { value: t });
  return ev;
}

describe("initPhoneMode", () => {
  let mq: Mq;
  let tabs: PhoneTab[];
  let activeId: string;
  let running: Set<string>;
  let deps: PhoneModeDeps & { [k: string]: ReturnType<typeof vi.fn> | unknown };
  let ctl: PhoneModeController;

  beforeEach(() => {
    document.body.innerHTML = SKELETON;
    document.body.className = "";
    document.documentElement.className = "";
    sessionStorage.clear();
    mq = { matches: false, listeners: [] };
    installMatchMedia(mq);
    tabs = [
      { id: "tab-main", title: "🏠 Main" },
      { id: "tab-a", title: "Alpha <b>" },
      { id: "tab-b", title: "Bravo" },
    ];
    activeId = "tab-a";
    running = new Set(["tab-b"]);
    deps = {
      getTabs: () => tabs,
      getActiveTabId: () => activeId,
      isRunning: (id: string) => running.has(id),
      switchToTab: vi.fn((id: string) => {
        activeId = id;
      }),
      closeTab: vi.fn(),
      newTab: vi.fn(),
      openSessions: vi.fn(),
    };
  });

  afterEach(() => {
    ctl?.destroy();
  });

  const header = () => document.getElementById("phone-header")!;
  const sheet = () => document.getElementById("phone-sheet")!;

  it("stays off on a wide desktop and changes nothing visible", () => {
    ctl = initPhoneMode(deps);
    expect(ctl.isActive()).toBe(false);
    expect(document.body.classList.contains("phone")).toBe(false);
    expect(header().hidden).toBe(true);
    expect(sheet().hidden).toBe(true);
    // the toolbox has not moved
    expect(document.querySelector(".topbar > .topbar-controls")).not.toBeNull();
    expect(ctl.back()).toBe(false);
  });

  it("switches on and off live with the media query (fold / unfold)", () => {
    ctl = initPhoneMode(deps);
    mq.matches = true;
    mq.listeners.forEach((fn) => fn());
    expect(document.body.classList.contains("phone")).toBe(true);
    expect(header().hidden).toBe(false);
    expect(
      document.querySelector("nav.sidebar .phone-drawer-tools .topbar-controls"),
    ).not.toBeNull();
    mq.matches = false;
    mq.listeners.forEach((fn) => fn());
    expect(document.body.classList.contains("phone")).toBe(false);
    // the toolbox is back exactly where it was, before #after-controls
    const back = document.querySelector(".topbar > .topbar-controls");
    expect(back?.nextElementSibling?.id).toBe("after-controls");
  });

  it("switches on inside the Android app (html.jarvis-app)", async () => {
    ctl = initPhoneMode(deps);
    document.documentElement.classList.add("jarvis-app");
    await new Promise((r) => setTimeout(r, 0));
    expect(ctl.isActive()).toBe(true);
  });

  it("?phone=1 is sticky for this browser tab", () => {
    sessionStorage.setItem(PHONE_STICKY_KEY, "1");
    ctl = initPhoneMode(deps);
    expect(ctl.isActive()).toBe(true);
  });

  describe("on", () => {
    beforeEach(() => {
      mq.matches = true;
      ctl = initPhoneMode(deps);
    });

    it("shows the active tab in the header, escaped", () => {
      expect(header().querySelector(".phone-chat-title")!.textContent).toBe("Alpha <b>");
      expect(header().querySelector(".phone-run-dot")!.classList.contains("on")).toBe(false);
      activeId = "tab-b";
      phoneTabsChanged();
      expect(header().querySelector(".phone-chat-title")!.textContent).toBe("Bravo");
      expect(header().querySelector(".phone-run-dot")!.classList.contains("on")).toBe(true);
    });

    it("lists every tab in order, marks the active one, Main has no ✕", () => {
      ctl.toggleSheet(true);
      expect(document.body.classList.contains("phone-sheet-open")).toBe(true);
      const rows = [...sheet().querySelectorAll<HTMLElement>("[data-phone-tab]")];
      expect(rows.map((r) => r.dataset.phoneTab)).toEqual(["tab-main", "tab-a", "tab-b"]);
      expect(rows[1].classList.contains("active")).toBe(true);
      expect(rows[0].querySelector("[data-phone-close]")).toBeNull();
      expect(rows[1].querySelector("[data-phone-close]")).not.toBeNull();
      expect(rows[2].querySelector(".phone-run-dot.on")).not.toBeNull();
      expect(sheet().innerHTML).toContain("Alpha &lt;b&gt;");
    });

    // FORK 2026-10-27 — an unread result: a still dot on its row, and on the header button while it
    // is another chat's (the dropdown is where to find it).
    it("marks unread chats in the list and on the header when the unread one is not on screen", () => {
      const unread = new Set(["tab-b"]);
      deps.isUnread = (id: string) => unread.has(id);
      phoneTabsChanged();
      ctl.toggleSheet(true);
      expect(sheet().querySelector('[data-phone-tab="tab-b"] .phone-unread-dot')).not.toBeNull();
      expect(sheet().querySelector('[data-phone-tab="tab-a"] .phone-unread-dot')).toBeNull();
      const elsewhere = header().querySelector<HTMLElement>(".phone-unread-elsewhere")!;
      expect(elsewhere.hidden).toBe(false);
      activeId = "tab-b"; // he opens it
      unread.clear();
      phoneTabsChanged();
      expect(elsewhere.hidden).toBe(true);
      expect(sheet().querySelector(".phone-unread-dot")).toBeNull();
    });

    it("re-renders when the tab array changes", () => {
      tabs.push({ id: "tab-c", title: "Charlie" });
      phoneTabsChanged();
      expect(sheet().querySelectorAll("[data-phone-tab]").length).toBe(4);
    });

    it("takes the running colour from the desktop tab glow", () => {
      document.getElementById("tab-bar-scroll")!.innerHTML =
        `<div class="tab" data-tab-id="tab-b" style="--glow-color:#16a34a80"></div>`;
      phoneTabsChanged();
      const dot = sheet().querySelector<HTMLElement>('[data-phone-tab="tab-b"] .phone-run-dot')!;
      expect(dot.getAttribute("style")).toContain("--run:#16a34a");
    });

    it("tap a row switches and closes the sheet", () => {
      ctl.toggleSheet(true);
      sheet().querySelector<HTMLElement>('[data-phone-tab="tab-b"] .phone-sheet-title')!.click();
      expect(deps.switchToTab).toHaveBeenCalledWith("tab-b");
      expect(document.body.classList.contains("phone-sheet-open")).toBe(false);
    });

    it("leaves an alt view for the chat when a chat is picked", () => {
      const chatNav = document.querySelector<HTMLElement>('.nav-btn[data-tab="chat"]')!;
      const clicked = vi.fn();
      chatNav.addEventListener("click", clicked);
      chatNav.classList.remove("nav-active");
      ctl.toggleSheet(true);
      sheet().querySelector<HTMLElement>('[data-phone-tab="tab-main"]')!.click();
      expect(clicked).toHaveBeenCalledTimes(1);
    });

    // Review fix: renderTabs rebuilds the sheet on every run-state change; a rebuild between the
    // finger going down and the click used to lose the tap.
    it("a tap survives a re-render between pointerdown and click", () => {
      ctl.toggleSheet(true);
      const close = sheet().querySelector<HTMLElement>('[data-phone-close="tab-a"]')!;
      close.dispatchEvent(pointer("pointerdown", 380, 120, 1000));
      running.add("tab-a");
      phoneTabsChanged(); // the row under the finger is gone; the click lands on the sheet
      const click = new MouseEvent("click", { bubbles: true });
      Object.defineProperty(click, "timeStamp", { value: 1080 });
      sheet().dispatchEvent(click);
      expect(deps.closeTab).toHaveBeenCalledWith("tab-a");
      expect(deps.switchToTab).not.toHaveBeenCalled();
    });

    it("a stale press is not replayed by a later stray click", () => {
      ctl.toggleSheet(true);
      sheet()
        .querySelector<HTMLElement>('[data-phone-tab="tab-b"]')!
        .dispatchEvent(pointer("pointerdown", 100, 120, 1000));
      const click = new MouseEvent("click", { bubbles: true });
      Object.defineProperty(click, "timeStamp", { value: 5000 });
      sheet().dispatchEvent(click);
      expect(deps.switchToTab).not.toHaveBeenCalled();
    });

    it("each row's ⋯ opens the desktop tab menu, and the drawer has no New session (the architect 2026-10-19)", () => {
      ctl.destroy();
      const openTabMenu = vi.fn();
      const resetSession = vi.fn();
      ctl = initPhoneMode({ ...deps, openTabMenu, resetSession });
      ctl.toggleSheet(true);
      sheet().querySelector<HTMLElement>('[data-phone-menu="tab-main"]')!.click();
      expect(openTabMenu).toHaveBeenCalledWith("tab-main", expect.any(Number), expect.any(Number));
      expect(document.body.classList.contains("phone-sheet-open")).toBe(false);
      ctl.openDrawer("left");
      expect(document.querySelector('nav.sidebar [data-phone-act="reset"]')).toBeNull();
      expect(resetSession).not.toHaveBeenCalled();
    });

    it("without those deps there is no ⋯ and no reset row", () => {
      ctl.toggleSheet(true);
      expect(sheet().querySelector("[data-phone-menu]")).toBeNull();
      expect(document.querySelector('[data-phone-act="reset"]')).toBeNull();
    });

    it("✕ uses the desktop close path and does not switch", () => {
      ctl.toggleSheet(true);
      sheet().querySelector<HTMLElement>('[data-phone-close="tab-b"]')!.click();
      expect(deps.closeTab).toHaveBeenCalledWith("tab-b");
      expect(deps.switchToTab).not.toHaveBeenCalled();
    });

    it("+ New chat and the header + both open a new chat", () => {
      ctl.toggleSheet(true);
      sheet().querySelector<HTMLElement>('[data-phone-act="new"]')!.click();
      document.getElementById("phone-new-btn")!.click();
      expect(deps.newTab).toHaveBeenCalledTimes(2);
    });

    it("the tab list starts with the button row, 📄 included, and has no All chats… (the architect 2026-10-21)", () => {
      ctl.toggleSheet(true);
      expect(sheet().querySelector('[data-phone-act="all"]')).toBeNull();
      const rows = sheet().querySelectorAll(".phone-sheet-list > .phone-sheet-row");
      expect(rows[0]!.classList.contains("phone-sheet-tools")).toBe(true);
      expect(rows[0]!.querySelector('[data-phone-act="new"]')).not.toBeNull();
      expect(rows[0]!.querySelector('[data-phone-act="pdf"]')).not.toBeNull();
      expect(rows[rows.length - 1]!.classList.contains("phone-sheet-tools")).toBe(false);
    });

    it("📬 opens Zen Mail at /zen/ in the reader layer, and Back closes it (the architect 2026-10-21)", () => {
      ctl.toggleSheet(true);
      sheet().querySelector<HTMLElement>('[data-phone-act="zen"]')!.click();
      const layer = document.getElementById("pdf-reader-layer")!;
      expect(layer.querySelector("iframe")!.getAttribute("src")).toBe("/zen/");
      // 2026-10-25 (the architect): no "Zen Mail" text and no ✕ over it; the name only titles the frame.
      expect(layer.querySelector("iframe")!.getAttribute("title")).toBe("Zen Mail");
      expect(layer.textContent).toBe("");
      expect(layer.querySelector("button")).toBeNull();
      expect(ctl.back()).toBe(true);
      expect(document.getElementById("pdf-reader-layer")).toBeNull();
    });

    it("☰ and ⋯ open one drawer at a time; the backdrop closes it", () => {
      document.getElementById("phone-menu-btn")!.click();
      expect(document.body.classList.contains("phone-left-open")).toBe(true);
      document.getElementById("phone-more-btn")!.click();
      expect(document.body.classList.contains("phone-left-open")).toBe(false);
      expect(document.body.classList.contains("phone-right-open")).toBe(true);
      document.querySelector<HTMLElement>(".phone-backdrop")!.click();
      expect(document.body.classList.contains("phone-right-open")).toBe(false);
    });

    it("a view picked in the left drawer closes it", () => {
      ctl.openDrawer("left");
      document.querySelector<HTMLElement>('.nav-btn[data-tab="overview"]')!.click();
      expect(document.body.classList.contains("phone-left-open")).toBe(false);
    });

    it("a chat picked in the sessions panel closes the right drawer; its buttons do not", async () => {
      ctl.openDrawer("right");
      document.querySelector<HTMLElement>(".session-delete-btn")!.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(document.body.classList.contains("phone-right-open")).toBe(true);
      document.querySelector<HTMLElement>(".session-label")!.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(document.body.classList.contains("phone-right-open")).toBe(false);
    });

    it("__jarvisBack closes the top layer and says whether it did", () => {
      const back = (window as Window & { __jarvisBack?: () => boolean }).__jarvisBack!;
      expect(back()).toBe(false);
      ctl.toggleSheet(true);
      expect(back()).toBe(true);
      expect(document.body.classList.contains("phone-sheet-open")).toBe(false);
      ctl.openDrawer("right");
      expect(back()).toBe(true);
      expect(back()).toBe(false);
    });

    it("a swipe in from the left edge opens the left drawer", () => {
      document.dispatchEvent(pointer("pointerdown", 5, 300, 0));
      document.dispatchEvent(pointer("pointermove", 30, 302, 50));
      expect(document.body.classList.contains("phone-dragging")).toBe(true);
      document.dispatchEvent(pointer("pointermove", 200, 304, 400));
      document.dispatchEvent(pointer("pointerup", 200, 304, 600));
      expect(document.body.classList.contains("phone-left-open")).toBe(true);
      expect(document.body.classList.contains("phone-dragging")).toBe(false);
      expect(document.querySelector<HTMLElement>("nav.sidebar")!.style.transform).toBe("");
    });

    it("a short slow pull from the right edge snaps back closed", () => {
      const w = window.innerWidth;
      document.dispatchEvent(pointer("pointerdown", w - 5, 300, 0));
      document.dispatchEvent(pointer("pointermove", w - 40, 300, 200));
      document.dispatchEvent(pointer("pointermove", w - 60, 300, 400));
      document.dispatchEvent(pointer("pointerup", w - 60, 300, 600));
      expect(document.body.classList.contains("phone-right-open")).toBe(false);
    });

    it("a fast flick from the right edge opens the right drawer", () => {
      const w = window.innerWidth;
      document.dispatchEvent(pointer("pointerdown", w - 5, 300, 0));
      document.dispatchEvent(pointer("pointermove", w - 20, 300, 10));
      document.dispatchEvent(pointer("pointermove", w - 60, 300, 60));
      document.dispatchEvent(pointer("pointerup", w - 60, 300, 70));
      expect(document.body.classList.contains("phone-right-open")).toBe(true);
    });

    it("never hijacks a vertical scroll, a mid-screen drag or a mouse", () => {
      document.dispatchEvent(pointer("pointerdown", 5, 300, 0));
      document.dispatchEvent(pointer("pointermove", 9, 340, 50));
      document.dispatchEvent(pointer("pointermove", 200, 400, 100));
      document.dispatchEvent(pointer("pointerup", 200, 400, 150));
      expect(document.body.classList.contains("phone-left-open")).toBe(false);

      document.dispatchEvent(pointer("pointerdown", 300, 300, 0));
      document.dispatchEvent(pointer("pointermove", 500, 300, 50));
      document.dispatchEvent(pointer("pointerup", 500, 300, 100));
      expect(document.body.classList.contains("phone-left-open")).toBe(false);

      document.dispatchEvent(pointer("pointerdown", 5, 300, 0, "mouse"));
      document.dispatchEvent(pointer("pointermove", 200, 300, 50, "mouse"));
      document.dispatchEvent(pointer("pointerup", 200, 300, 100, "mouse"));
      expect(document.body.classList.contains("phone-left-open")).toBe(false);
    });

    it("swiping an open drawer back toward its edge closes it", () => {
      ctl.openDrawer("left");
      document.dispatchEvent(pointer("pointerdown", 250, 300, 0));
      document.dispatchEvent(pointer("pointermove", 230, 300, 50));
      document.dispatchEvent(pointer("pointermove", 100, 300, 400));
      document.dispatchEvent(pointer("pointerup", 100, 300, 600));
      expect(document.body.classList.contains("phone-left-open")).toBe(false);
    });
  });
});
