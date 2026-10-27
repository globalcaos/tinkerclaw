import { afterEach, describe, expect, it } from "vitest";
import { enhanceChatImages } from "./chat-image-zoom";

// jsdom has no layout: fake the file's real width and the width the chat draws it at.
function chatImage(natural: number, shown: number, href?: string): HTMLImageElement {
  const img = document.createElement("img");
  Object.defineProperty(img, "naturalWidth", { value: natural });
  Object.defineProperty(img, "complete", { value: true });
  img.getBoundingClientRect = () => ({ width: shown, height: shown / 2 }) as DOMRect;
  img.src = "http://127.0.0.1/x.jpg";
  if (href) {
    const a = document.createElement("a");
    a.href = href;
    a.appendChild(img);
    document.body.appendChild(a);
  } else {
    document.body.appendChild(img);
  }
  return img;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("enhanceChatImages", () => {
  it("gives a large drawn image its zoom bar", () => {
    const img = chatImage(1600, 700);
    enhanceChatImages([img]);
    expect(img.closest(".ciz-wrap")?.querySelector(".ciz-bar")).not.toBeNull();
  });

  it("puts no bar on a thumbnail of a large file (the architect 2026-10-15: the buttons cover it)", () => {
    const img = chatImage(768, 146, "http://127.0.0.1/x.jpg");
    enhanceChatImages([img]);
    expect(document.querySelector(".ciz-bar")).toBeNull();
    expect(img.style.cursor).toBe("zoom-in");
  });

  it("opens the full-size overlay when a thumbnail is clicked, instead of following its link", () => {
    const img = chatImage(768, 146, "http://127.0.0.1/x.jpg");
    enhanceChatImages([img]);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    img.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.querySelector(".ciz-view img")).not.toBeNull();
  });

  it("leaves a small file shown at its own size alone", () => {
    const img = chatImage(120, 120);
    enhanceChatImages([img]);
    expect(img.style.cursor).toBe("");
    expect(document.querySelector(".ciz-bar")).toBeNull();
  });
});
