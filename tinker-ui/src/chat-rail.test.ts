import { describe, expect, it } from "vitest";
import {
  answeringModel,
  namedModel,
  PENDING_RAIL,
  railCapHtml,
  railSegmentHtml,
  railTitle,
  runHasAnswer,
  runRailState,
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

  // FORK 2026-10-05 (the architect: "the tinker UI first assigns the last model used and, when and if the
  // model Thalamus choses to use is different, then the whole line changes, pretending nothing
  // happened"). The TURN TIMING block is chrome about the turn, written before any model is named.
  it("never guesses a model for a run whose only row is the TURN TIMING block", () => {
    const timing = [{ role: "assistant", content: "turn timing", _isPhaseTiming: true }];
    expect(runHasAnswer(timing)).toBe(false);
    expect(answeringModel(timing, { ...none, sessionModel: () => opus }, grok)).toBeNull();
  });

  it("reads the run a TURN TIMING block names, once the run table knows its model", () => {
    const timing = [
      { role: "assistant", content: "turn timing", _isPhaseTiming: true, _phaseRunId: "run-9" },
    ];
    const lookups: RailLookups = {
      runModel: (id) => (id === "run-9" ? opus : undefined),
      sessionModel: () => grok,
    };
    expect(answeringModel(timing, lookups, grok)).toEqual(opus);
  });
});

describe("runRailState — the turn in flight shows only the model it has named", () => {
  const timing = { role: "assistant", content: "turn timing", _isPhaseTiming: true };

  it("reserves the rail unpainted while the turn has not named a model, whatever came before", () => {
    const lookups: RailLookups = { runModel: () => undefined, sessionModel: () => grok };
    expect(runRailState([timing], lookups, grok, { model: null })).toEqual({ kind: "pending" });
    // A live bubble whose run has not named its model either: still no guess.
    const bubble = { role: "assistant", _runId: "run-3", _temporary: true };
    expect(runRailState([timing, bubble], lookups, grok, { model: null })).toEqual({
      kind: "pending",
    });
  });

  it("paints the model the turn named, the one the thinking indicator shows", () => {
    expect(runRailState([timing], none, grok, { model: opus })).toEqual({
      kind: "model",
      model: opus,
    });
  });

  it("a settled run still resolves from its rows, then the previous run, then the session", () => {
    const rows = [timing, { role: "assistant", content: "hi" }];
    expect(runRailState(rows, none, grok, null)).toEqual({ kind: "model", model: grok });
    expect(runRailState([timing], none, grok, null)).toBeNull();
  });
});

describe("namedModel — a run's model only when the run itself named it", () => {
  it("returns the run table's real model, never an empty or injected one", () => {
    expect(namedModel({ model: "claude-opus-5-5", provider: "claude-code" })).toEqual(opus);
    expect(namedModel({ model: "", provider: "xai" })).toBeNull();
    expect(namedModel({ model: "gateway-injected", provider: "openclaw" })).toBeNull();
    expect(namedModel(undefined)).toBeNull();
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

  it("a pending rail keeps the rail's room and paints nothing: no colour, no logo, no name", () => {
    const seg = railSegmentHtml("<p>x</p>", PENDING_RAIL);
    expect(seg.startsWith('<div class="turn-seg is-pending">')).toBe(true);
    expect(seg).not.toContain("--rail");
    expect(seg).not.toContain("title=");
    const cap = railCapHtml(PENDING_RAIL, "start");
    expect(cap).toContain('class="turn-rail-cap turn-rail-cap--start is-pending"');
    expect(cap).not.toContain("turn-rail-logo");
  });

  it("lets only a colour into the style attribute, and escapes the title", () => {
    expect(safeRailColor("#4285F4")).toBe("#4285F4");
    expect(safeRailColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(safeRailColor('red;" onmouseover="x')).toBe("var(--muted)");
    const html = railSegmentHtml("<p>x</p>", { ...rail, title: 'a"<b>' });
    expect(html).toContain('title="a&quot;&lt;b&gt;"');
  });
});
