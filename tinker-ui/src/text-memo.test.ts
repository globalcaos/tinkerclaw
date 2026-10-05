import { describe, expect, it } from "vitest";
import { memoizeText } from "./text-memo.js";

function counted() {
  const calls: string[] = [];
  const fn = (t: string) => {
    calls.push(t);
    return `<p>${t}</p>`;
  };
  return { calls, fn };
}

describe("memoizeText", () => {
  it("renders a text once and answers repeats from the memo", () => {
    const { calls, fn } = counted();
    const md = memoizeText(fn, 1000);
    expect(md("a")).toBe("<p>a</p>");
    expect(md("a")).toBe("<p>a</p>");
    expect(md("b")).toBe("<p>b</p>");
    expect(calls).toEqual(["a", "b"]);
  });

  it("evicts the least recently used entries once the character budget is spent", () => {
    const { calls, fn } = counted();
    // Each entry costs 1 + 8 = 9 characters; the budget holds three.
    const md = memoizeText(fn, 27);
    md("a");
    md("b");
    md("c");
    md("a"); // refresh: b is now the oldest
    md("d"); // evicts b
    expect(md.size).toBe(3);
    md("a");
    md("c");
    md("d");
    md("b");
    expect(calls).toEqual(["a", "b", "c", "d", "b"]);
  });

  it("a growing live text churns out before the settled rows every repaint touches", () => {
    const { calls, fn } = counted();
    const md = memoizeText(fn, 200);
    const settled = ["row one", "row two", "row three"];
    let live = "";
    for (let k = 0; k < 30; k++) {
      live += "w";
      for (const s of settled) {
        md(s);
      }
      md(live);
    }
    expect(calls.filter((t) => settled.includes(t))).toEqual(settled);
  });

  it("does not cache a result larger than the whole budget", () => {
    const { calls, fn } = counted();
    const md = memoizeText(fn, 10);
    md("a long text");
    md("a long text");
    expect(calls).toHaveLength(2);
    expect(md.size).toBe(0);
  });

  it("clear() forgets everything", () => {
    const { calls, fn } = counted();
    const md = memoizeText(fn, 100);
    md("a");
    md.clear();
    md("a");
    expect(calls).toEqual(["a", "a"]);
  });
});
