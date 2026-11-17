import { describe, expect, it } from "vitest";
import { placeStopBubbles, type StopBubble } from "./stop-bubble-placement.js";

const unit = (b: StopBubble) => ({ key: `amy-stop:${b.key}`, html: b.html });
const keys = (u: { key: string }[]) => u.map((x) => x.key);

describe("placeStopBubbles", () => {
  it("orders a turn by time: answer, send-back, correction, the note on the correction", () => {
    // Recorded 2026-11-03: answer 12.283 s, send-back 12.477, correction 15.641, note 15.826.
    const u = [
      { key: "steps", html: "" },
      { key: "a", html: "answer" },
      { key: "b", html: "correction" },
      { key: "rail-end", html: "" },
    ];
    const placed = placeStopBubbles(
      u,
      [
        { key: "a", at: 12283 },
        { key: "b", at: 15641 },
      ],
      [
        { key: "note", ts: 15826, html: "" },
        { key: "send", ts: 12477, html: "" },
      ],
      unit,
    );
    expect(keys(u)).toEqual(["steps", "a", "amy-stop:send", "b", "amy-stop:note", "rail-end"]);
    expect(placed.size).toBe(2);
  });
  it("keeps several checks after the last answer in their own order", () => {
    const u = [
      { key: "a", html: "" },
      { key: "rail-end", html: "" },
    ];
    placeStopBubbles(
      u,
      [{ key: "a", at: 100 }],
      [
        { key: "t2", ts: 300, html: "" },
        { key: "t1", ts: 200, html: "" },
      ],
      unit,
    );
    expect(keys(u)).toEqual(["a", "amy-stop:t1", "amy-stop:t2", "rail-end"]);
  });
  it("ignores rows not drawn as their own bubble and rows with no time", () => {
    const u = [
      { key: "a", html: "" },
      { key: "b", html: "" },
    ];
    placeStopBubbles(
      u,
      [
        { key: "hidden-tool-step", at: 500 },
        { key: "a", at: undefined },
        { key: "b", at: 200 },
      ],
      [{ key: "s", ts: 150, html: "" }],
      unit,
    );
    expect(keys(u)).toEqual(["a", "amy-stop:s", "b"]);
  });
  it("leaves bubbles to the closing block when no row has a time", () => {
    const u = [{ key: "a", html: "" }];
    expect(
      placeStopBubbles(u, [{ key: "a", at: undefined }], [{ key: "s", ts: 1, html: "" }], unit)
        .size,
    ).toBe(0);
    expect(keys(u)).toEqual(["a"]);
  });
});

// 2026-11-04, a phone tab that slept through an 80-minute turn: the answers reached the page after
// every check, so their row times are later than all of them. Prompt checks: .3 judged the owner's
// prompt that opened the run, .4-.6 judged agent wake-ups. Stop checks of turn .6: a send-back on the
// first answer at 09:12:30, then two notes at 09:12:36 after the second answer.
describe("placeStopBubbles — by the judged object", () => {
  const T = (h: number, m: number, s: number) => ((h * 60 + m) * 60 + s) * 1000;
  const turn = (n: number) => `tab#e.${n}`;
  const run = () => [
    { key: "steps", html: "" },
    { key: "a1", html: "Twenty picks… ✨ DEEPER … card" },
    { key: "a2", html: "The claim holds." },
    { key: "rail-end", html: "" },
  ];
  const late = [
    { key: "a1", at: T(17, 16, 0) },
    { key: "a2", at: T(17, 16, 1) },
  ];
  const stops: StopBubble[] = [
    { key: "n2", ts: T(9, 12, 36), html: "", opens: false, seam: "stop", turnId: turn(6) },
    { key: "sb", ts: T(9, 12, 30), html: "", opens: true, seam: "stop", turnId: turn(6) },
    { key: "n3", ts: T(9, 12, 36), html: "", opens: false, seam: "stop", turnId: turn(6) },
  ];
  const prompts: StopBubble[] = [
    { key: "p3", ts: T(8, 25, 47), html: "", seam: "prompt", turnId: turn(3), opensRun: true },
    { key: "p4", ts: T(8, 41, 49), html: "", seam: "prompt", turnId: turn(4) },
    { key: "p5", ts: T(8, 57, 2), html: "", seam: "prompt", turnId: turn(5) },
    { key: "p6", ts: T(8, 57, 37), html: "", seam: "prompt", turnId: turn(6) },
  ];
  const unitOf = (b: StopBubble) => ({
    key: `${b.seam === "prompt" ? "amy-prompt" : "amy-stop"}:${b.key}`,
    html: b.html,
  });

  it("puts each stop check after the answer it judged, though every row time is later", () => {
    const u = run();
    expect(placeStopBubbles(u, late, stops, unitOf).size).toBe(3);
    expect(keys(u)).toEqual([
      "steps",
      "a1",
      "amy-stop:sb",
      "a2",
      "amy-stop:n2",
      "amy-stop:n3",
      "rail-end",
    ]);
  });

  it("puts the run's own prompt check under the prompt and no prompt check after the answer", () => {
    const u = run();
    placeStopBubbles(u, late, [...prompts, ...stops], unitOf, 0);
    // The wake-ups have no row; with only late row times they go before the first answer.
    expect(keys(u)).toEqual([
      "amy-prompt:p3",
      "steps",
      "amy-prompt:p4",
      "amy-prompt:p5",
      "amy-prompt:p6",
      "a1",
      "amy-stop:sb",
      "a2",
      "amy-stop:n2",
      "amy-stop:n3",
      "rail-end",
    ]);
  });

  it("places a wake-up's prompt check by time when the rows have real times", () => {
    const u = [
      { key: "a1", html: "" },
      { key: "a2", html: "" },
    ];
    placeStopBubbles(
      u,
      [
        { key: "a1", at: T(8, 30, 0) },
        { key: "a2", at: T(8, 50, 0) },
      ],
      [prompts[0], prompts[1]],
      unitOf,
      0,
    );
    expect(keys(u)).toEqual(["amy-prompt:p3", "a1", "amy-prompt:p4", "a2"]);
  });

  it("a check of an earlier turn in the run still goes by time", () => {
    const u = run();
    placeStopBubbles(
      u,
      [
        { key: "a1", at: 100 },
        { key: "a2", at: 300 },
      ],
      [
        { key: "old", ts: 150, html: "", opens: false, seam: "stop", turnId: turn(4) },
        { key: "last", ts: 400, html: "", opens: false, seam: "stop", turnId: turn(6) },
      ],
      unitOf,
    );
    expect(keys(u)).toEqual(["steps", "a1", "amy-stop:old", "a2", "amy-stop:last", "rail-end"]);
  });
});
