import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  backgroundStubAllowed,
  decodeViewportMemory,
  encodeViewportMemory,
  FOLLOWING,
  HTML_FRAME_MAX_PX,
  htmlFrameHeight,
  isProgrammaticEcho,
  lateGrowthAdjustment,
  middleFraction,
  PANE_SETTLE_MS,
  paneResizeSettles,
  paneResizeStep,
  pendingRestoreStep,
  RESTORE_MAX_AGE_MS,
  RESTORE_MAX_PAGES,
  scrollIsResizeLayout,
  scrollTopForMiddle,
  viewportChoiceId,
  viewportMemory,
  type ViewportAnchor,
} from "./chat-viewport.js";

const anchor = (over: Partial<ViewportAnchor> = {}): ViewportAnchor => ({
  unit: "oc:row-7",
  unitOffset: -40,
  ocId: "row-7",
  ocPart: "main",
  ocOffset: -40,
  ...over,
});

describe("viewportMemory — what a tab remembers when it is left", () => {
  it("a tab left at the bottom remembers only that it was following", () => {
    expect(viewportMemory(true, anchor())).toBe(FOLLOWING);
  });

  it("a tab left reading remembers the row it was reading", () => {
    const a = anchor();
    expect(viewportMemory(false, a)).toEqual({ follow: false, anchor: a });
  });

  it("reading with nothing to come back to falls back to following, never to a stale pixel", () => {
    expect(viewportMemory(false, null)).toBe(FOLLOWING);
    expect(viewportMemory(false, anchor({ unit: null, ocId: null }))).toBe(FOLLOWING);
  });
});

describe("persistence codec (ui-state choice `chat:scroll:<tabId>`)", () => {
  it("the choice id is namespaced per tab", () => {
    expect(viewportChoiceId("tab-main")).toBe("chat:scroll:tab-main");
  });

  it("following encodes to the empty string, which ui-state stores as absent", () => {
    expect(encodeViewportMemory(FOLLOWING)).toBe("");
  });

  it("reading round-trips through the transcript identity only", () => {
    const enc = encodeViewportMemory({ follow: false, anchor: anchor({ ocOffset: -40.6 }) });
    expect(decodeViewportMemory(enc)).toEqual({
      follow: false,
      anchor: { unit: null, unitOffset: 0, ocId: "row-7", ocPart: "main", ocOffset: -41 },
    });
  });

  it("a reading anchor with no transcript row is not worth persisting: a reload restores the bottom", () => {
    expect(encodeViewportMemory({ follow: false, anchor: anchor({ ocId: null }) })).toBe("");
  });

  it("absent, malformed, foreign-shaped or future-versioned values decode to following", () => {
    for (const bad of ["", "{", "null", "[]", '{"v":2,"id":"x","part":"main","y":0}', '{"v":1}']) {
      expect(decodeViewportMemory(bad)).toBe(FOLLOWING);
    }
  });
});

describe("pendingRestoreStep — finding a remembered row after a reload", () => {
  const base = { pagesTried: 0, ageMs: 0, olderAvailable: true, busy: false };

  it("pages older rows in while the row is missing and older pages exist", () => {
    expect(pendingRestoreStep(base)).toBe("page-older");
  });

  it("waits while the session is busy: older pages are refused under a live writer", () => {
    expect(pendingRestoreStep({ ...base, busy: true })).toBe("wait");
  });

  it("gives up when the transcript has no older page left", () => {
    expect(pendingRestoreStep({ ...base, olderAvailable: false })).toBe("give-up");
  });

  it("is bounded in pages and in time", () => {
    expect(pendingRestoreStep({ ...base, pagesTried: RESTORE_MAX_PAGES })).toBe("give-up");
    expect(pendingRestoreStep({ ...base, busy: true, ageMs: RESTORE_MAX_AGE_MS })).toBe("give-up");
  });
});

describe("backgroundStubAllowed — the idle-tab memory stub and a tab left reading", () => {
  it("stubs a tab left following, or one with no memory yet", () => {
    expect(backgroundStubAllowed(FOLLOWING)).toBe(true);
    expect(backgroundStubAllowed(null)).toBe(true);
  });

  it("never stubs away the rows under a tab left reading (R12: never under the history he is reading)", () => {
    expect(backgroundStubAllowed({ follow: false, anchor: anchor() })).toBe(false);
  });
});

describe("isProgrammaticEcho — our own write versus a gesture", () => {
  it("the scroll event of our own write is an echo", () => {
    expect(isProgrammaticEcho(500, { top: 500, at: 1000 }, 1016)).toBe(true);
    expect(isProgrammaticEcho(500.6, { top: 500, at: 1000 }, 1016)).toBe(true);
  });

  it("a gesture that lands elsewhere is not", () => {
    expect(isProgrammaticEcho(480, { top: 500, at: 1000 }, 1016)).toBe(false);
    expect(isProgrammaticEcho(500, null, 1016)).toBe(false);
  });

  it("an old write cannot swallow a later gesture that lands on the same pixel", () => {
    // The 2026-10-02 bug: scrolling up and back down to an unchanged bottom never re-armed follow,
    // because the gesture's final event matched the last pin's value forever.
    expect(isProgrammaticEcho(500, { top: 500, at: 1000 }, 5000)).toBe(false);
  });
});

describe("lateGrowthAdjustment — content that grows after the pin (images, frames)", () => {
  const grow = (unitTop: number, unitBottom: number, growth: number, follow = false) =>
    lateGrowthAdjustment({ follow, unitTop, unitBottom, paneTop: 100, growth });

  it("re-pins the bottom while following", () => {
    expect(grow(900, 1300, 300, true)).toEqual({ kind: "pin" });
  });

  it("shifts by the growth when the grown row lay wholly above the pane before it grew", () => {
    // Row spanned -400..80 before (+300 now): everything on screen sat below it and moved down.
    expect(grow(-400, 380, 300)).toEqual({ kind: "shift", by: 300 });
  });

  it("leaves the row being read alone: one straddling the pane top keeps its top where it is", () => {
    // Row spanned -400..120 before: it was on screen, its top did not move, nothing above it grew.
    expect(grow(-400, 420, 300)).toEqual({ kind: "none" });
  });

  it("leaves growth inside or below the viewport alone, and a zero growth too", () => {
    expect(grow(400, 900, 300)).toEqual({ kind: "none" });
    expect(grow(-400, 80, 0)).toEqual({ kind: "none" });
  });
});

// ─── app.ts wiring, locked structurally ─────────────────────────────────────────────────
// app.ts is an un-testable browser entry, so the call-site facts this design depends on are read
// off its source, the technique scroll-follow.test.ts uses. Walk up from the vitest cwd.
describe("the middle anchor — a turn of the phone keeps the text at the middle (2026-11-15)", () => {
  // Measured in landscape: a 171 px pane at y=100, a paragraph from y=150 to 230.
  const before = { paneTop: 100, paneHeight: 171, nodeTop: 150, nodeHeight: 80 };

  it("measures where the pane's middle falls on the block", () => {
    expect(middleFraction(before)).toBeCloseTo((185.5 - 150) / 80);
    expect(middleFraction({ ...before, nodeHeight: 0 })).toBe(0);
  });

  it("puts that point back at the middle after the block re-wraps and the pane grows", () => {
    const fraction = middleFraction(before);
    // Upright: the pane is 817 px tall, the rows above wrapped longer (the block now at y=900),
    // and the block itself wraps to 160 px.
    const top = scrollTopForMiddle({
      scrollTop: 10_000,
      paneTop: 100,
      paneHeight: 817,
      nodeTop: 900,
      nodeHeight: 160,
      fraction,
    });
    // After the write the block sits 900 - (top - 10000) px down; its point is at the middle.
    const nodeTopAfter = 900 - (top - 10_000);
    expect(nodeTopAfter + fraction * 160).toBeCloseTo(100 + 817 / 2);
  });

  it("is a no-op when nothing moved", () => {
    expect(
      scrollTopForMiddle({ ...before, scrollTop: 500, fraction: middleFraction(before) }),
    ).toBeCloseTo(500);
  });

  it("following pins the bottom on every resize, as before", () => {
    const step = paneResizeStep({
      follow: true,
      prev: { w: 453, h: 171 },
      next: { w: 411, h: 817 },
      settling: false,
    });
    expect(step).toBe("pin");
  });

  it("reading: a new width puts the middle back; the first observation does nothing", () => {
    const next = { w: 411, h: 817 };
    expect(paneResizeStep({ follow: false, prev: { w: 453, h: 171 }, next, settling: false })).toBe(
      "keep-middle",
    );
    expect(paneResizeStep({ follow: false, prev: null, next, settling: false })).toBe("none");
  });

  it("reading: a height-only change keeps today's rule unless a turn is still settling", () => {
    const prev = { w: 411, h: 817 };
    const keyboard = { w: 411, h: 500 };
    expect(paneResizeStep({ follow: false, prev, next: keyboard, settling: false })).toBe("none");
    expect(paneResizeSettles({ prev, next: keyboard, settling: false })).toBe(false);
    // A turn's second resize: the width came first, the height a frame later.
    expect(paneResizeStep({ follow: false, prev, next: keyboard, settling: true })).toBe(
      "keep-middle",
    );
    expect(paneResizeSettles({ prev, next: prev, settling: true })).toBe(false);
  });

  it("a scroll with no input since the settle began is the layout's, not a gesture", () => {
    const t = { settleStartedAt: 1000, settlingUntil: 1000 + PANE_SETTLE_MS };
    expect(scrollIsResizeLayout({ ...t, now: 1010, lastInputAt: 200 })).toBe(true);
    // His wheel or touch after the turn began: his scroll.
    expect(scrollIsResizeLayout({ ...t, now: 1300, lastInputAt: 1200 })).toBe(false);
    // Once settled, every scroll is read as before.
    expect(scrollIsResizeLayout({ ...t, now: 1000 + PANE_SETTLE_MS, lastInputAt: 200 })).toBe(
      false,
    );
  });
});

describe("app.ts viewport wiring", () => {
  const findAppSource = (): string => {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "tinker-ui", "src", "app.ts");
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    throw new Error(`could not locate tinker-ui/src/app.ts from ${process.cwd()}`);
  };
  const app = readFileSync(findAppSource(), "utf8");
  const body = (decl: string): string => {
    const at = app.indexOf(decl);
    expect(at, `${decl} moved or was renamed`).toBeGreaterThan(-1);
    return app.slice(at, app.indexOf("\n}\n", at));
  };

  it("a tab is LEFT with its memory saved and persisted, and ENTERED with it restored", () => {
    expect(body("function saveCurrentTabState() {")).toMatch(
      /s\.viewport = viewedViewportMemory\(\);\s*\n\s*persistViewport\(activeTabId, s\.viewport\);/,
    );
    expect(body("function loadTabState(tabId: string) {")).toContain(
      "enterViewport(tabId, s.viewport);",
    );
  });

  it("a fresh page restores the viewed tab's memory once, from ui-state, at the first hello", () => {
    expect(app).toContain("st.viewport = persistedViewport(t.id);");
    expect(app).toMatch(
      /if \(!viewportsHydrated\) \{\s*\n\s*viewportsHydrated = true;\s*\n\s*enterViewport\(activeTabId,/,
    );
  });

  it("the idle background stub skips a tab left reading", () => {
    expect(body("function trimIdleBackgroundTabs(): void {")).toContain(
      "if (!backgroundStubAllowed(st.viewport)) {",
    );
  });

  it("updateChat positions the pane AFTER the paint's last mutation, remembered row first", () => {
    const u = body("function updateChat(skipScroll = false): ChatPositioning | null {");
    const graft = u.lastIndexOf("graftTimingBlocks(el);");
    const settle = u.indexOf("if (settlePendingViewport(el)) {");
    expect(graft).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(graft);
    expect(u.indexOf("restoreViewportAnchor(el, readingAnchor)")).toBeGreaterThan(settle);
  });

  it("the scroll listener tells echoes apart by value AND age, and consumes the record", () => {
    expect(app).toMatch(
      /if \(isProgrammaticEcho\(el\.scrollTop, lastProgrammatic, performance\.now\(\)\)\) \{[\s\S]{0,400}?lastProgrammatic = null;\s*\n\s*return;/,
    );
    expect(app).not.toContain("lastProgrammaticTop");
  });

  it("no code writes the chat pane's scrollTop behind setChatScrollTop's back", () => {
    // A bare write leaves no echo record, so its scroll event is misread as a gesture. The one
    // legitimate write is setChatScrollTop's own, right after it records the echo.
    const writes = app.match(/\bel\.scrollTop \+?= [^;]*;/g) ?? [];
    expect(writes).toEqual(["el.scrollTop = t;"]);
    expect(body("function setChatScrollTop(el: HTMLElement, v: number): void {")).toMatch(
      /lastProgrammatic = \{ top: t, at: performance\.now\(\) \};\s*\n\s*el\.scrollTop = t;/,
    );
    expect(app).not.toMatch(/container!\.scrollTop = /);
  });

  it("the pane's resize observer restores the middle anchor and starts a settle", () => {
    const b = body("function bindChatFollowListener(el: HTMLElement): void {");
    expect(b).toContain("const settles = paneResizeSettles(");
    expect(b).toMatch(/\} else if \(restoreMiddleAnchor\(el\)\) \{/);
    expect(b).toContain("extendPaneSettle(el);");
  });

  it("a layout scroll during a settle is consumed before the follow latch or paging sees it", () => {
    const b = body("function bindChatFollowListener(el: HTMLElement): void {");
    const layout = b.indexOf("scrollIsResizeLayout({");
    expect(layout).toBeGreaterThan(b.indexOf("isProgrammaticEcho(el.scrollTop"));
    expect(layout).toBeLessThan(b.indexOf('type: "user-scroll"'));
    expect(layout).toBeLessThan(b.indexOf("pageOlderRows();"));
  });

  it("the turn-end Reasoning group is asked whether it opens", () => {
    expect(app).toContain("openGroupOnForm: openReasoningGroupOnForm,");
  });
});

describe("htmlFrameHeight — a sandboxed card shows whole", () => {
  it("keeps a 20-card grid's full height instead of cutting it at 2000 px", () => {
    expect(htmlFrameHeight(9600)).toBe(9600);
  });
  it("keeps the 40 px floor and a runaway ceiling", () => {
    expect(htmlFrameHeight(0)).toBe(40);
    expect(htmlFrameHeight(10_000_000)).toBe(HTML_FRAME_MAX_PX);
  });
});
