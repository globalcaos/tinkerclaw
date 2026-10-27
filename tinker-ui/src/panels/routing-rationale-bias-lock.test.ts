// FORK 2026-08-29 (the architect): "the thalamus panel slider should then become usable, otherwise
// the circle should not be there at all."
//
// Two halves have to hold TOGETHER, and each is worthless alone:
//   1. the renderer marks the row `.is-locked` + disables the input whenever the MODEL slider
//      is NOT on Auto — and leaves both off when it is (that second case is the control: an
//      "is it locked?" assertion with no Auto case passes just as happily against a renderer
//      that locks the dial always, which would be the opposite bug);
//   2. base.css hides the THUMB and nothing else. `display:none` on the input itself would
//      also take the track and the seven tick labels — only the circle was to go — so this
//      file parses the real stylesheet and fails on any locked rule that hides the bare input.
//      That parser is itself controlled against a deliberately broken stylesheet, because a
//      "no bad rule found" check passes equally well when it is looking in the wrong place.
//
// Kept out of routing-rationale.test.ts so the stylesheet-parsing half lives next to the
// requirement it enforces rather than at the end of a 400-line spec about sentences.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  BIAS_LOCKED_TITLE,
  BIAS_STOPS,
  isBiasLive,
  renderBiasSlider,
  renderRoutingRationale,
  type RoutingSignals,
} from "./routing-rationale";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_CSS = resolve(HERE, "../styles/base.css");

/** Auto — the MODEL slider is on its first stop, so THALAMUS is doing the choosing. */
const auto: RoutingSignals = {
  modelLabel: "the default chain",
  modelPinned: false,
  effortLabel: "Auto",
  effortPinned: false,
  nowMs: 1_700_000_000_000,
  biasIdx: 5,
};
/** The same turn with a model pinned — the dial now drives nothing. */
const pinned: RoutingSignals = { ...auto, modelLabel: "Opus 5", modelPinned: true };

/** Parse the rendered fragment so the assertions run against a DOM, not a substring. The CSS
 *  selectors in base.css are written against this exact shape; matching them here is what
 *  proves the stylesheet can actually fire. */
const dom = (html: string): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
};

describe("isBiasLive — the dial follows the MODEL slider unless told otherwise", () => {
  it("is live on Auto and dead on a pin", () => {
    expect(isBiasLive(auto)).toBe(true);
    expect(isBiasLive(pinned)).toBe(false);
  });

  it("takes an explicit answer from the caller over the pin state", () => {
    expect(isBiasLive({ ...pinned, biasEnabled: true })).toBe(true);
    expect(isBiasLive({ ...auto, biasEnabled: false })).toBe(false);
  });
});

describe("renderBiasSlider — the circle is gone, not greyed", () => {
  it("CONTROL: on Auto the dial is a live control", () => {
    const el = dom(renderBiasSlider(auto));
    const row = el.querySelector(".orca-bias-row")!;
    const input = el.querySelector<HTMLInputElement>("input[type=range]")!;
    expect(row.classList.contains("is-locked")).toBe(false);
    expect(input.hasAttribute("disabled")).toBe(false);
    expect(row.getAttribute("title")).toBeNull();
    // the locked stylesheet must not be able to touch a live dial
    expect(el.querySelector('.orca-bias-row.is-locked input[type="range"]')).toBeNull();
  });

  it("with a model pinned the row locks and the input is disabled", () => {
    const el = dom(renderBiasSlider(pinned));
    const row = el.querySelector(".orca-bias-row")!;
    const input = el.querySelector<HTMLInputElement>("input[type=range]")!;
    expect(row.classList.contains("is-locked")).toBe(true);
    expect(input.disabled).toBe(true);
  });

  it("the selector base.css writes is the selector the markup produces", () => {
    // If the class ever moves onto the input, or the row stops being an ancestor, every
    // `.orca-bias-row.is-locked input[type="range"]::…` rule silently matches nothing and the
    // thumb comes back — with no test failing anywhere else.
    const el = dom(renderBiasSlider(pinned));
    expect(el.querySelector('.orca-bias-row.is-locked input[type="range"]')).not.toBeNull();
  });

  it("keeps the lock OFF the input's class attribute", () => {
    // routing-rationale.test.ts pins this attribute verbatim; state that here too so the
    // reason survives next to the code that would be tempted to append to it.
    expect(renderBiasSlider(pinned)).toContain('class="model-think-slider orca-bias-slider"');
  });

  it("says WHY it is inert, and how to get it back", () => {
    const el = dom(renderBiasSlider(pinned));
    const title = el.querySelector(".orca-bias-row")!.getAttribute("title") ?? "";
    expect(title).toBe(BIAS_LOCKED_TITLE);
    expect(title).toMatch(/Auto/);
    expect(title.toLowerCase()).toContain("pinned");
  });

  it("keeps the track and all seven tick labels while locked", () => {
    // The whole point of hiding only the thumb: the row still tells you where the dial sits.
    const el = dom(renderBiasSlider(pinned));
    expect(el.querySelector("input[type=range]")).not.toBeNull();
    expect(el.querySelectorAll(".model-slider-stop")).toHaveLength(BIAS_STOPS.length);
    expect(el.querySelector(".model-slider-stop.active")!.textContent).toBe(BIAS_STOPS[5].short);
  });

  it("the whole card carries the lock, not just the slider in isolation", () => {
    expect(renderRoutingRationale(pinned)).toContain("orca-bias-row is-locked");
    expect(renderRoutingRationale(auto)).not.toContain("is-locked");
  });
});

/** Strip comments first: this file's own CSS comment quotes the locked selector, and an
 *  un-stripped scan would read that prose as a rule and flag it. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `selector { body }` in `css` whose selector mentions the locked row. */
function lockedRules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(css))) !== null) {
    const selector = m[1].replace(/\s+/g, " ").trim();
    if (selector.includes(".orca-bias-row.is-locked")) {
      out.push({ selector, body: m[2] });
    }
  }
  return out;
}

/** The bug this file exists to prevent: a locked rule that hides the INPUT (and with it the
 *  track and the tick labels) rather than just the thumb. A rule targeting a `::` part is
 *  fine — that is the thumb — so only bare-element selectors are inspected. */
function hidesTheWholeInput(css: string): boolean {
  return lockedRules(css).some(
    (r) => !r.selector.includes("::") && /display\s*:\s*none|visibility\s*:\s*hidden/.test(r.body),
  );
}

describe("base.css — the locked dial loses its thumb and keeps everything else", () => {
  const css = readFileSync(BASE_CSS, "utf-8");

  it("CONTROL: the parser really does catch a stylesheet that hides the input", () => {
    // Without this, "no bad rule found" would also be the answer if the scan were looking at
    // the wrong selectors, or at nothing at all.
    expect(
      hidesTheWholeInput(`.orca-bias-row.is-locked input[type="range"] { display: none; }`),
    ).toBe(true);
    expect(
      hidesTheWholeInput(`.orca-bias-row.is-locked input[type="range"] { visibility: hidden; }`),
    ).toBe(true);
    expect(lockedRules(css).length).toBeGreaterThanOrEqual(4);
  });

  it("never hides the input itself — that would take the track and the ticks too", () => {
    expect(hidesTheWholeInput(css)).toBe(false);
  });

  it("removes the WebKit thumb", () => {
    const rule = lockedRules(css).find((r) => r.selector.endsWith("::-webkit-slider-thumb"));
    expect(rule, "no locked ::-webkit-slider-thumb rule in base.css").toBeDefined();
    expect(rule!.body).toMatch(/display\s*:\s*none/);
  });

  it("removes the Firefox thumb", () => {
    const rule = lockedRules(css).find((r) => r.selector.endsWith("::-moz-range-thumb"));
    expect(rule, "no locked ::-moz-range-thumb rule in base.css").toBeDefined();
    // Firefox ignores `display` on the part, so the thumb is zeroed instead.
    expect(rule!.body).toMatch(/width\s*:\s*0/);
    expect(rule!.body).toMatch(/border\s*:\s*0/);
  });

  it("still styles a track, so the row does not go blank", () => {
    const tracks = lockedRules(css).filter((r) => /-track\b/.test(r.selector));
    expect(tracks.length).toBeGreaterThanOrEqual(2);
    for (const t of tracks) expect(t.body).toMatch(/background\s*:/);
  });
});
