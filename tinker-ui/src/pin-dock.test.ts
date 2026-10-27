import { beforeEach, describe, expect, it } from "vitest";
import { __resetPinDockForTest, snapshotBubble, syncPinDock, wirePinDock } from "./pin-dock.js";

function setup(): { msgs: HTMLElement; setKey: (k: string) => void } {
  document.body.innerHTML =
    `<div class="chat-area"><div class="messages" id="messages">` +
    `<div class="msg assistant" id="a1">Table of things to delete<table><tr><td>VM 19 GB</td></tr></table>` +
    `<span class="msg-elapsed">3 s</span></div>` +
    `<div class="msg assistant msg-thinking" id="t1">thinking</div>` +
    `</div></div>`;
  let key = "agent:main:tinker:a";
  const msgs = document.getElementById("messages")!;
  wirePinDock(msgs, () => key);
  return { msgs, setKey: (k) => (key = k) };
}

const hover = (el: Element) => el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

describe("pin dock", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPinDockForTest();
  });

  it("shows a pin on assistant answers only, never on thinking rows", () => {
    setup();
    hover(document.getElementById("a1")!);
    hover(document.getElementById("t1")!);
    expect(document.querySelectorAll("#a1 > .msg-pin-btn")).toHaveLength(1);
    expect(document.querySelectorAll("#t1 .msg-pin-btn")).toHaveLength(0);
    hover(document.getElementById("a1")!);
    expect(document.querySelectorAll("#a1 > .msg-pin-btn")).toHaveLength(1);
  });

  it("docks a clean copy above the chat on click", () => {
    setup();
    const a1 = document.getElementById("a1")!;
    hover(a1);
    (a1.querySelector(".msg-pin-btn") as HTMLElement).click();
    const dock = document.getElementById("pin-dock")!;
    expect(dock.hidden).toBe(false);
    expect(dock.nextElementSibling?.id).toBe("messages");
    const body = dock.querySelector(".pd-body")!;
    expect(body.querySelector("td")?.textContent).toBe("VM 19 GB");
    expect(body.querySelector(".msg-pin-btn, .msg-elapsed")).toBeNull();
  });

  it("keeps one pin per tab and survives a tab switch", () => {
    const { setKey } = setup();
    const a1 = document.getElementById("a1")!;
    hover(a1);
    (a1.querySelector(".msg-pin-btn") as HTMLElement).click();
    setKey("agent:main:tinker:b");
    syncPinDock();
    expect(document.getElementById("pin-dock")!.hidden).toBe(true);
    setKey("agent:main:tinker:a");
    syncPinDock();
    expect(document.getElementById("pin-dock")!.hidden).toBe(false);
  });

  it("is just the answer, an unpin cross and a grip; the cross unpins", () => {
    setup();
    const a1 = document.getElementById("a1")!;
    hover(a1);
    (a1.querySelector(".msg-pin-btn") as HTMLElement).click();
    const dock = document.getElementById("pin-dock")!;
    expect(Array.from(dock.children).map((c) => c.className)).toEqual([
      "pd-body msg assistant",
      "pd-unpin",
      "pd-grip",
    ]);
    (dock.querySelector(".pd-unpin") as HTMLElement).click();
    expect(dock.hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem("tinker-pinned-answers")!)).toEqual({});
  });

  it("dragging the grip down makes the answer taller and remembers it", () => {
    setup();
    const a1 = document.getElementById("a1")!;
    hover(a1);
    (a1.querySelector(".msg-pin-btn") as HTMLElement).click();
    const dock = document.getElementById("pin-dock")!;
    const body = dock.querySelector(".pd-body") as HTMLElement;
    body.getBoundingClientRect = () => ({ height: 260 }) as DOMRect;
    const grip = dock.querySelector(".pd-grip")!;
    grip.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientY: 100 }) as PointerEvent,
    );
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 250 }) as PointerEvent);
    window.dispatchEvent(new MouseEvent("pointerup", {}) as PointerEvent);
    expect(body.style.height).toBe("410px");
    expect(
      JSON.parse(localStorage.getItem("tinker-pinned-answers")!)["agent:main:tinker:a"].height,
    ).toBe(410);
  });

  it("snapshot drops controls but keeps html-render iframes", () => {
    const d = document.createElement("div");
    d.innerHTML = `<iframe class="chat-html-frame" srcdoc="&lt;b&gt;x&lt;/b&gt;"></iframe><button class="retry-provider-btn">↻</button>`;
    const html = snapshotBubble(d);
    expect(html).toContain("chat-html-frame");
    expect(html).not.toContain("retry-provider-btn");
  });
});
