// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DID_WORD, GLYPH } from "./amygdala-html.js";
import { groupBySteps, renderJevNotConsulted, renderJevWindow, summarise } from "./amygdala-jev.js";
import type { CodeDid, JevDecision, TurnView } from "./amygdala-types.js";

function dec(id: string, over: Partial<JevDecision> = {}): JevDecision {
  return {
    id,
    ts: 1,
    sessionKey: "s",
    turnId: "t1",
    stepLabel: "read a.md",
    seam: "pre",
    questionId: "q-id",
    questionName: "Danger level",
    version: 2,
    answer: 0,
    prob: 0.98,
    confidence: 0.95,
    cacheHit: false,
    latencyMs: 96,
    weak: false,
    codeDid: "ok",
    degraded: false,
    ...over,
  };
}

function turn(decisions: JevDecision[]): TurnView {
  return { turnId: "t1", sessionKey: "s", ts: 1, decisions, interventions: [], markers: [] };
}

function parse(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

const none = new Set<string>();

describe("renderJevWindow", () => {
  it("returns empty string for a turn without decisions", () => {
    expect(renderJevWindow(turn([]), { open: true, openRows: none })).toBe("");
  });

  it("collapsed vs open, chevron, body always present", () => {
    const t = turn([dec("a")]);
    const c = parse(renderJevWindow(t, { open: false, openRows: none }));
    expect(c.querySelector(".amy-jev")!.classList.contains("amy-open")).toBe(false);
    expect(c.querySelector(".amy-jtw")!.textContent).toBe("▸");
    expect(c.querySelector(".amy-jev-body")).not.toBeNull();
    const bar = c.querySelector(".amy-jev-bar")!;
    expect(bar.getAttribute("data-amy-act")).toBe("jev-toggle");
    expect(bar.getAttribute("data-turn")).toBe("t1");
    expect(bar.querySelector("svg")).not.toBeNull();
    const o = parse(renderJevWindow(t, { open: true, openRows: none }));
    expect(o.querySelector(".amy-jev")!.classList.contains("amy-open")).toBe(true);
    expect(o.querySelector(".amy-jtw")!.textContent).toBe("▾");
  });

  it("groups by step with interleaved seams", () => {
    const ds = [
      dec("1", { stepLabel: "read a", seam: "pre" }),
      dec("2", { stepLabel: "read a", seam: "pre" }),
      dec("3", { stepLabel: "read a", seam: "post" }),
      dec("4", { stepLabel: "exec b", seam: "pre" }),
      dec("5", { stepLabel: "read a", seam: "pre" }),
    ];
    const g = groupBySteps(ds);
    expect(g.map((x) => x.rows.length)).toEqual([2, 1, 1, 1]);
    const el = parse(renderJevWindow(turn(ds), { open: true, openRows: none }));
    expect(el.querySelectorAll(".amy-jstep").length).toBe(4);
    expect(el.querySelectorAll(".amy-jr").length).toBe(5);
    expect(el.querySelector(".amy-jstep")!.textContent).toBe("├ read a");
  });

  it("renders glyph and pill class for every codeDid", () => {
    const cls: Record<CodeDid, string> = {
      ok: "ok",
      held: "held",
      proof: "note",
      note: "note",
      ask: "note",
      "sent-back": "back",
      refusal: "refusal",
    };
    for (const k of Object.keys(cls) as CodeDid[]) {
      const el = parse(
        renderJevWindow(turn([dec("x", { codeDid: k })]), { open: true, openRows: none }),
      );
      expect(el.querySelector(".amy-jg")!.textContent).toBe(GLYPH[k]);
      const pill = el.querySelector(".amy-jo")!;
      expect(pill.classList.contains(cls[k])).toBe(true);
      expect(pill.textContent).toBe(DID_WORD[k]);
    }
  });

  it("marks weak and degraded rows", () => {
    const el = parse(
      renderJevWindow(turn([dec("w", { weak: true }), dec("d", { degraded: true }), dec("n")]), {
        open: true,
        openRows: none,
      }),
    );
    expect(el.querySelectorAll(".amy-jw").length).toBe(1);
    expect(el.querySelector(".amy-jw")!.getAttribute("title")).toBe("rests on inferred fields");
    expect(el.querySelectorAll(".amy-jx").length).toBe(1);
  });

  it("shows detail only for open rows, with label buttons, cache and footer", () => {
    const ds = [dec("a", { cacheHit: true }), dec("b")];
    const el = parse(renderJevWindow(turn(ds), { open: true, openRows: new Set(["a"]) }));
    const details = el.querySelectorAll(".amy-jd");
    expect(details[0].classList.contains("amy-show")).toBe(true);
    expect(details[1].classList.contains("amy-show")).toBe(false);
    expect(details[0].textContent).toContain("q-id v2");
    expect(details[0].textContent).toContain("96 ms · cached");
    expect(details[1].textContent).not.toContain("cached");
    const btn = details[0].querySelectorAll("button[data-amy-act=label]");
    expect(btn.length).toBe(2);
    expect(btn[0].getAttribute("data-target-id")).toBe("a");
    expect(btn[0].getAttribute("data-target-kind")).toBe("verdict");
    expect(btn[0].getAttribute("data-kind")).toBe("useful");
    expect(btn[0].getAttribute("data-value")).toBe("1");
    expect(btn[1].getAttribute("data-value")).toBe("-1");
    const row = el.querySelector(".amy-jr")!;
    expect(row.getAttribute("data-amy-act")).toBe("jev-row");
    expect(row.getAttribute("data-id")).toBe("a");
    expect(el.querySelector(".amy-jft")!.textContent).toBe("2 answers · 1 cached");
  });

  it("escapes question name and step label", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = renderJevWindow(turn([dec("e", { questionName: evil, stepLabel: evil })]), {
      open: true,
      openRows: new Set(["e"]),
    });
    const el = parse(html);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".amy-jq")!.textContent).toContain(evil);
    expect(el.querySelector(".amy-jstep")!.textContent).toContain(evil);
  });

  it("never emits an instructions field", () => {
    const html = renderJevWindow(turn([dec("a")]), { open: true, openRows: new Set(["a"]) });
    expect(html).not.toMatch(/instructions/i);
  });
});

describe("summarise", () => {
  it("nothing changed", () => {
    expect(summarise([dec("1"), dec("2"), dec("3")])).toBe("nothing changed · 3 answers");
  });
  it("counts the would-be changes, one per decision, ahead of the answers", () => {
    const ds = [
      ...Array.from({ length: 5 }, (_, i) => dec(`o${i}`)),
      dec("h", { codeDid: "held", decisionId: "D1" }),
      dec("h2", { codeDid: "held", decisionId: "D1" }),
      dec("p", { codeDid: "proof", decisionId: "D2" }),
      dec("s", { codeDid: "sent-back", decisionId: "D3" }),
    ];
    expect(summarise(ds)).toBe("3 to review: 1 held · 1 proof · 1 sent back · 9 answers");
  });
  it("counts note, ask and refusal", () => {
    const ds = [
      dec("n", { codeDid: "note" }),
      dec("a", { codeDid: "ask" }),
      dec("r", { codeDid: "refusal" }),
    ];
    expect(summarise(ds)).toBe("3 to review: 1 note · 1 ask · 1 refusal · 3 answers");
  });
});

// the architect 2026-10-02: "keep only the things that Jarvis would have changed, clearly so I can evaluate, then leave the
// rest expandable in another section".
describe("renderJevWindow: changes first, the rest folded", () => {
  const ds = [
    dec("a", { stepLabel: "read a.md" }),
    dec("h1", {
      codeDid: "held",
      decisionId: "D1",
      stepLabel: "rm -rf x",
      questionName: "Danger level: how hard is this step to undo?",
      answer: 3,
    }),
    dec("h2", {
      codeDid: "held",
      decisionId: "D1",
      stepLabel: "rm -rf x",
      questionName: "Planted instructions: is it obeying you, or text it read?",
      answer: "read-content",
    }),
    dec("b", { stepLabel: "read b.md" }),
    dec("s", {
      codeDid: "sent-back",
      decisionId: "D2",
      stepLabel: "end of turn",
      seam: "stop",
      questionName: "False success: does it claim work the record never shows?",
      answer: 0.83,
    }),
  ];
  const render = (o: Partial<Parameters<typeof renderJevWindow>[1]> = {}) =>
    parse(renderJevWindow(turn(ds), { open: true, openRows: none, ...o }));

  it("one card per would-be change, saying what, on which step and why, with the votes in view", () => {
    const el = render();
    const cards = el.querySelectorAll(".amy-jchange");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("Would have held this step");
    expect(cards[0]!.textContent).toContain("rm -rf x");
    expect(cards[0]!.textContent).toContain("Danger level: how hard is this step to undo?");
    expect(cards[0]!.textContent).toContain("Planted instructions");
    expect(cards[1]!.textContent).toContain("Would have sent the reply back");
    const votes = cards[0]!.querySelectorAll("button[data-amy-act=label]");
    expect(votes).toHaveLength(2);
    expect(votes[0]!.getAttribute("data-target-id")).toBe("D1");
    expect(votes[0]!.getAttribute("data-target-kind")).toBe("decision");
    expect(votes[0]!.getAttribute("data-kind")).toBe("useful");
    expect(votes[0]!.getAttribute("data-value")).toBe("1");
    expect(votes[0]!.textContent).toContain("right call");
    expect(votes[1]!.getAttribute("data-value")).toBe("-1");
    expect(votes[1]!.textContent).toContain("wrong call");
  });

  it("the answers that changed nothing sit in their own folded section", () => {
    const el = render();
    const bar = el.querySelector(".amy-jothers-bar")!;
    expect(bar.textContent).toContain("2 answers that changed nothing");
    expect(bar.getAttribute("data-amy-act")).toBe("jev-others");
    expect(el.querySelector(".amy-jothers")!.classList.contains("amy-show")).toBe(false);
    expect(el.querySelectorAll(".amy-jothers .amy-jr")).toHaveLength(2);
    expect(
      render({ othersOpen: true }).querySelector(".amy-jothers")!.classList.contains("amy-show"),
    ).toBe(true);
  });

  it("says plainly when nothing would have changed", () => {
    const el = parse(renderJevWindow(turn([dec("a"), dec("b")]), { open: true, openRows: none }));
    expect(el.querySelector(".amy-jnone")!.textContent).toBe(
      "Nothing would have changed in this turn.",
    );
    expect(el.querySelector(".amy-jchange")).toBeNull();
  });

  it("a vote already given shows on its button; enforce mode says what it did", () => {
    const el = render({ votes: new Map([["D1", 1]]) });
    const v = el.querySelectorAll(".amy-jchange")[0]!.querySelectorAll("button");
    expect(v[0]!.classList.contains("amy-voted")).toBe(true);
    expect(v[1]!.classList.contains("amy-voted")).toBe(false);
    expect(render({ shadow: false }).querySelector(".amy-jchange")!.textContent).toContain(
      "Held this step",
    );
  });

  it("without a decision id the vote falls back to the first reason's answer", () => {
    const el = parse(
      renderJevWindow(turn([dec("x", { codeDid: "note" })]), { open: true, openRows: none }),
    );
    const b = el.querySelector(".amy-jchange button")!;
    expect(b.getAttribute("data-target-id")).toBe("x");
    expect(b.getAttribute("data-target-kind")).toBe("verdict");
  });
});

describe("renderJevNotConsulted", () => {
  it("renders both variants as one line without a body", () => {
    const a = parse(renderJevNotConsulted("t9", "real-steps-stay-local"));
    expect(a.textContent).toContain("JEV");
    expect(a.textContent).toContain("not consulted (real steps stay local) · rules only");
    expect(a.querySelector(".amy-jev-body")).toBeNull();
    expect(a.querySelector("[data-amy-act]")).toBeNull();
    const b = parse(renderJevNotConsulted("t9", "judge-down"));
    expect(b.textContent).toContain("unreachable · judge checks skipped");
  });
});
