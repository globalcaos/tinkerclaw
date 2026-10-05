/**
 * FORK 2026-09-10 — Pulse graphs: linked X axis + pointer reorder.
 *
 * the architect: stretch every chart to the longest series, then zoom/pan one and
 * the rest follow; drag the cards to change their order. These specs pin
 * the helpers the UI calls; the SVG paint is a look, not a string match.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLinkX,
  attachPresenceGraphs,
  loadLinkX,
  longestRange,
  PG_LINK_KEY,
  PG_ORDER_KEY,
  renderPresenceGraphsHtml,
  resetPresenceGraphStateForTests,
  seriesPoints,
  type GGroup,
} from "./presence-graph";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 1, 12); // 2026-06-01 noon UTC
const T1 = T0 + 10 * DAY;
const T2 = T0 + 100 * DAY;

function group(key: string, tStart: number, tEnd: number): GGroup {
  return {
    key,
    title: key,
    series: [
      {
        id: key,
        label: key,
        points: [
          { ts: tStart, value: 1 },
          { ts: tEnd, value: 2 },
        ],
      },
    ],
  };
}

afterEach(() => {
  resetPresenceGraphStateForTests();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("longestRange", () => {
  it("is the union of every loaded group — the longest series wins", () => {
    const html = renderPresenceGraphsHtml([group("short", T1, T1 + DAY), group("long", T0, T2)]);
    expect(html).toContain('data-group="short"');
    const r = longestRange();
    expect(r.t0).toBeLessThanOrEqual(T0 + DAY);
    expect(r.t1).toBeGreaterThanOrEqual(T2 - DAY);
    expect(r.t1 - r.t0).toBeGreaterThan(80 * DAY);
  });
});

describe("applyLinkX", () => {
  it("persists the toggle and stretches every chart to the longest span", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    root.innerHTML = renderPresenceGraphsHtml([
      group("short", T1, T1 + DAY),
      group("long", T0, T2),
    ]);
    attachPresenceGraphs(root);
    applyLinkX(root, true);
    expect(loadLinkX()).toBe(true);
    expect(localStorage.getItem(PG_LINK_KEY)).toBe("1");
    const svgs = [...root.querySelectorAll("svg.pg-svg")];
    expect(svgs.length).toBe(2);
    // Linked render shares x-tick labels — both charts now cover months, not days.
    const labels = svgs.map((s) =>
      [...s.querySelectorAll(".pg-xlab")].map((t) => t.textContent).join("|"),
    );
    expect(labels[0]).toBe(labels[1]);
    applyLinkX(root, false);
    expect(loadLinkX()).toBe(false);
  });
});

describe("pointer reorder", () => {
  it("moves a card and persists the new order", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    root.innerHTML = renderPresenceGraphsHtml([
      group("a", T0, T1),
      group("b", T0, T1),
      group("c", T0, T1),
    ]);
    attachPresenceGraphs(root);
    const cards = () =>
      [...root.querySelectorAll<HTMLElement>(".pg-chart")].map((c) => c.dataset.group);
    expect(cards()).toEqual(["a", "b", "c"]);
    const a = root.querySelector<HTMLElement>('.pg-chart[data-group="a"]')!;
    const head = a.querySelector(".pg-head") as HTMLElement;
    // jsdom has no layout / elementFromPoint, so the pointer handler only
    // flips `moved` on the 4px threshold; we apply the DOM move ourselves
    // and let pointerup persist whatever order is now in the container.
    head.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientY: 10, button: 0, pointerId: 1 }),
    );
    root.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientY: 240, clientX: 0, pointerId: 1 }),
    );
    root.insertBefore(a, null);
    root.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    expect(JSON.parse(localStorage.getItem(PG_ORDER_KEY) || "[]")).toEqual(["b", "c", "a"]);
  });
});

describe("seriesPoints cumulative", () => {
  it("running-sums daily deltas the way views/clones already do", () => {
    const pts = seriesPoints({
      id: "graph.activity.commits",
      label: "commits",
      cumulative: true,
      points: [
        { ts: T0, value: 2 },
        { ts: T0 + DAY, value: 0 },
        { ts: T0 + 2 * DAY, value: 5 },
      ],
    });
    expect(pts.map((p) => p.value)).toEqual([2, 2, 7]);
  });
});
