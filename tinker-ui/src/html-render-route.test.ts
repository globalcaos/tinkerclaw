import { describe, expect, it } from "vitest";
import { htmlRenderNeedsFrame } from "./html-render-route.js";

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
