import { describe, expect, it } from "vitest";
import {
  answeringModel,
  railCapHtml,
  railSegmentHtml,
  railTitle,
  runHasAnswer,
  safeRailColor,
  type ChatRail,
  type RailLookups,
} from "./chat-rail.js";

// FORK 2026-10-01 (the architect): a line at the left of the model's answer, in its EEG colour, opened
// and closed by its company's logo, its full name on hover, and none beside a prompt.

const opus = { model: "claude-opus-5-5", provider: "claude-code" };
const grok = { model: "grok-4.7", provider: "xai" };
const none: RailLookups = { runModel: () => undefined, sessionModel: () => undefined };
const rail: ChatRail = {
  color: "#d97757",
  logoHtml: "<svg></svg>",
  title: "Opus 5.5 — claude-code/claude-opus-5-5",
};

describe("answeringModel — which model answered a run", () => {
  it("takes the newest assistant row that names a real model", () => {
    const rows = [
      { role: "assistant", ...grok },
      { role: "user", content: [{ type: "tool_result" }] },
      { role: "assistant", ...opus },
    ];
    expect(answeringModel(rows, none, null)).toEqual(opus);
  });

  it("skips the gateway's injected notice, which names no real model", () => {
    const rows = [
      { role: "assistant", ...opus },
      { role: "assistant", model: "gateway-injected", provider: "openclaw" },
    ];
    expect(answeringModel(rows, none, null)).toEqual(opus);
  });

  it("asks the run table for a live bubble, which names no model of its own", () => {
    const rows = [{ role: "assistant", _runId: "run-7", _temporary: true }];
    const lookups: RailLookups = {
      runModel: (id) => (id === "run-7" ? grok : undefined),
      sessionModel: () => opus,
    };
    expect(answeringModel(rows, lookups, null)).toEqual(grok);
  });

  it("falls back to the previous run's model, then to the session's", () => {
    const rows = [{ role: "assistant", content: "hi" }];
    expect(answeringModel(rows, { ...none, sessionModel: () => opus }, grok)).toEqual(grok);
    expect(answeringModel(rows, { ...none, sessionModel: () => opus }, null)).toEqual(opus);
    expect(answeringModel(rows, none, null)).toBeNull();
  });

  it("draws no rail for a run the gateway answered alone, or one with no answer at all", () => {
    const notice = [{ role: "assistant", model: "gateway-injected", provider: "openclaw" }];
    expect(runHasAnswer(notice)).toBe(false);
    expect(answeringModel(notice, { ...none, sessionModel: () => opus }, opus)).toBeNull();
    expect(answeringModel([{ role: "user", content: "x" }], none, opus)).toBeNull();
  });
});

describe("the rail's markup", () => {
  it("titles the rail with the friendly label and the full provider/model id", () => {
    expect(railTitle(opus, "Opus 5.5")).toBe("Opus 5.5 — claude-code/claude-opus-5-5");
    expect(railTitle(opus, "claude-opus-5-5")).toBe("claude-code/claude-opus-5-5");
    expect(railTitle({ model: "m", provider: "" }, "")).toBe("m");
  });

  it("wraps a unit in its stretch of line, carrying the colour and the name on hover", () => {
    const html = railSegmentHtml('<div class="msg assistant">hi</div>', rail);
    expect(html.startsWith('<div class="turn-seg" style="--rail:#d97757">')).toBe(true);
    expect(html).toContain('class="turn-rail-line" title="Opus 5.5 — claude-code/claude-opus-5-5"');
    expect(html.endsWith('<div class="msg assistant">hi</div></div>')).toBe(true);
  });

  it("leaves an empty unit empty: a wrapper around nothing would add a gap to the column", () => {
    expect(railSegmentHtml("", rail)).toBe("");
    expect(railSegmentHtml("  ", rail)).toBe("  ");
  });

  it("opens and closes the rail with the logo, named for hover and for a screen reader", () => {
    const start = railCapHtml(rail, "start");
    expect(start).toContain('class="turn-rail-cap turn-rail-cap--start"');
    expect(start).toContain('<span class="turn-rail-logo" role="img" aria-label="Opus 5.5');
    expect(start).toContain("<svg></svg>");
    expect(railCapHtml(rail, "end")).toContain("turn-rail-cap--end");
  });

  it("lets only a colour into the style attribute, and escapes the title", () => {
    expect(safeRailColor("#4285F4")).toBe("#4285F4");
    expect(safeRailColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(safeRailColor('red;" onmouseover="x')).toBe("var(--muted)");
    const html = railSegmentHtml("<p>x</p>", { ...rail, title: 'a"<b>' });
    expect(html).toContain('title="a&quot;&lt;b&gt;"');
  });
});
