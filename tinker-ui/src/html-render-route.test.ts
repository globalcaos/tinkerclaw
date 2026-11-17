import { describe, expect, it } from "vitest";
import { htmlCardCensus, htmlRenderNeedsFrame } from "./html-render-route.js";

describe("htmlRenderNeedsFrame", () => {
  it("keeps a static inline-styled card inline", () => {
    expect(htmlRenderNeedsFrame('<div style="color:red">ok</div>')).toBe(false);
  });
  it("frames a block with a script", () => {
    expect(htmlRenderNeedsFrame("<div></div><script>1</script>")).toBe(true);
  });
  it("frames a block with its own stylesheet (DOMPurify would drop it inline)", () => {
    expect(htmlRenderNeedsFrame("<style>.t:hover .tip{display:block}</style><table></table>")).toBe(
      true,
    );
  });
});

// A card whose text is in the DOM can still draw nothing, so the census counts boxes, not strings.
function fakeRoot(heights: number[], rawFences: number) {
  return {
    querySelectorAll: (sel: string) =>
      (sel.includes("language-html-render")
        ? Array.from({ length: rawFences })
        : heights.map((height) => ({ getBoundingClientRect: () => ({ height }) }))) as never,
  };
}

describe("htmlCardCensus", () => {
  it("counts drawn cards, cards with no height and fences left as source", () => {
    expect(htmlCardCensus(fakeRoot([120, 0, 80], 1))).toEqual({
      cards: 3,
      zeroHeight: 1,
      rawFences: 1,
    });
  });
});
