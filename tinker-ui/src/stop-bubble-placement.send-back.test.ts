import { describe, expect, it } from "vitest";
import { placeStopBubbles, type StopBubble } from "./stop-bubble-placement.js";

const unit = (b: StopBubble) => ({ key: `amy-stop:${b.key}`, html: b.html });
const keys = (u: { key: string }[]) => u.map((x) => x.key);
const sendBack = (ts: number): StopBubble => ({
  key: "sb",
  ts,
  html: "",
  opens: true,
  seam: "stop",
  turnId: "tab#e.6",
});
const oneAnswer = () => [
  { key: "steps", html: "" },
  { key: "a1", html: "the reply" },
  { key: "rail-end", html: "" },
];
const twoAnswers = () => [
  { key: "steps", html: "" },
  { key: "a1", html: "the reply" },
  { key: "a2", html: "the result" },
  { key: "rail-end", html: "" },
];
const BETWEEN = ["steps", "a1", "amy-stop:sb", "a2", "rail-end"];

// FORK 2026-11-13 (F2): the count from the end takes every send-back for one more answer written
// after it. One that opened no further answer (the turn was stopped, the hook's answer came too
// late, a runner that records the check and never blocks) pushed its own card above the answer.
describe("placeStopBubbles — a send-back counts only when a row began after it", () => {
  it("one that opened no further answer stays under the answer it judged", () => {
    const u = oneAnswer();
    placeStopBubbles(u, [{ key: "a1", at: 100 }], [sendBack(150)], unit);
    expect(keys(u)).toEqual(["steps", "a1", "amy-stop:sb", "rail-end"]);
  });

  it("one that did open another answer still sits between the two", () => {
    const u = twoAnswers();
    placeStopBubbles(
      u,
      [
        { key: "a1", at: 100 },
        { key: "a2", at: 300 },
      ],
      [sendBack(150)],
      unit,
    );
    expect(keys(u)).toEqual(BETWEEN);
  });

  it("rows that all arrived after the check (a page that slept) are counted as before", () => {
    const u = twoAnswers();
    placeStopBubbles(
      u,
      [
        { key: "a1", at: 9_000 },
        { key: "a2", at: 9_001 },
      ],
      [sendBack(150)],
      unit,
    );
    expect(keys(u)).toEqual(BETWEEN);
  });

  it("rows with no time are counted as before", () => {
    const u = twoAnswers();
    placeStopBubbles(
      u,
      [
        { key: "a1", at: undefined },
        { key: "a2", at: undefined },
      ],
      [sendBack(150)],
      unit,
    );
    expect(keys(u)).toEqual(BETWEEN);
  });
});
