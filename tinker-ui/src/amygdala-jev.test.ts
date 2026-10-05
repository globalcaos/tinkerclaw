// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DID_WORD, GLYPH } from "./amygdala-html.js";
import {
  actionsOf,
  actionsSummary,
  checksSummary,
  renderJevActions,
  renderJevChecks,
  renderJevNotConsulted,
  stepsOf,
} from "./amygdala-jev.js";
import type {
  CodeDid,
  InterventionView,
  JevDecision,
  MarkerView,
  TurnView,
} from "./amygdala-types.js";

// Fixed local times so the clock strings do not depend on the machine's time zone.
const T0 = new Date(2026, 9, 5, 9, 38, 12).getTime();

function dec(id: string, over: Partial<JevDecision> = {}): JevDecision {
  return {
    id,
    ts: T0,
    sessionKey: "s",
    turnId: "t1",
    stepLabel: "read a.md",
    seam: "pre-tool",
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

function iv(id: string, over: Partial<InterventionView> = {}): InterventionView {
  return {
    id,
    ts: T0,
    sessionKey: "s",
    turnId: "t1",
    kind: "hold",
    state: "settled",
    title: "Held before it ran",
    chips: ["effect: delete"],
    ...over,
  };
}

function turn(
  decisions: JevDecision[],
  interventions: InterventionView[] = [],
  markers: MarkerView[] = [],
  turnId = "t1",
): TurnView {
  return { turnId, sessionKey: "s", ts: T0, decisions, interventions, markers };
}

function parse(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

const none = new Set<string>();
const LANE = 40;
const AX = 8;
const y = (r: Element): number => Number(r.getAttribute("y"));

// the architect 2026-10-05: "two kinds of messages, one with a summary of the checks it performed, which should expand into a
// nice diagram of what it did and when ... and another type of entry ... with actions it would have taken".

describe("stepsOf: one timeline column per step", () => {
  it("a tool call's pre and post checks share its column, even when parallel calls interleave", () => {
    const s = stepsOf([
      dec("1", { toolUseId: "A", stepLabel: "exec a", ts: T0 }),
      dec("2", { toolUseId: "B", stepLabel: "exec b", ts: T0 + 1 }),
      dec("3", { toolUseId: "A", stepLabel: "exec a", seam: "post-tool", ts: T0 + 2 }),
      dec("4", { toolUseId: "B", stepLabel: "exec b", seam: "post-tool", ts: T0 + 3 }),
    ]);
    expect(s.map((x) => [x.label, x.before.length, x.after.length])).toEqual([
      ["exec a", 1, 1],
      ["exec b", 1, 1],
    ]);
  });
  it("without a tool use id, consecutive checks on a label share a column; the same command run again is a new one", () => {
    const s = stepsOf([
      dec("1", { stepLabel: "prompt", seam: "prompt", ts: T0 }),
      dec("2", { stepLabel: "read a", ts: T0 + 1 }),
      dec("3", { stepLabel: "read a", seam: "post-tool", ts: T0 + 2 }),
      dec("4", { stepLabel: "read a", ts: T0 + 3 }),
      dec("5", { stepLabel: "stop", seam: "stop", ts: T0 + 4 }),
    ]);
    expect(s.map((x) => [x.label, x.before.length, x.after.length])).toEqual([
      ["prompt", 1, 0],
      ["read a", 1, 1],
      ["read a", 1, 0],
      ["stop", 0, 1],
    ]);
  });
  it("sorts by time whatever order the events came in", () => {
    const s = stepsOf([
      dec("b", { stepLabel: "b", ts: T0 + 5 }),
      dec("a", { stepLabel: "a", ts: T0 }),
    ]);
    expect(s.map((x) => x.label)).toEqual(["a", "b"]);
  });
});

describe("renderJevChecks: the summary line and its timeline", () => {
  const ds = [
    dec("p", { stepLabel: "prompt", seam: "prompt", ts: T0 }),
    dec("a1", { toolUseId: "A", stepLabel: "exec rm x", ts: T0 + 60_000 }),
    dec("a2", {
      toolUseId: "A",
      stepLabel: "exec rm x",
      ts: T0 + 60_001,
      codeDid: "held",
      decisionId: "D1",
    }),
    dec("a3", {
      toolUseId: "A",
      stepLabel: "exec rm x",
      seam: "post-tool",
      ts: T0 + 61_000,
      cacheHit: true,
    }),
    dec("s", { stepLabel: "stop", seam: "stop", ts: T0 + 14 * 60_000 + 28_000, latencyMs: 4000 }),
  ];
  const render = (o: Partial<Parameters<typeof renderJevChecks>[2]> = {}) =>
    parse(renderJevChecks("t1", ds, { open: true, openRows: none, ...o }));

  it("returns empty string when Jev answered nothing", () => {
    expect(renderJevChecks("t1", [], { open: true, openRows: none })).toBe("");
  });

  it("collapsed by default: one bar saying how many checks, on how many steps, from when to when", () => {
    const el = parse(renderJevChecks("t1", ds, { open: false, openRows: none }));
    const w = el.querySelector(".amy-jev-checks")!;
    expect(w.classList.contains("amy-open")).toBe(false);
    const bar = w.querySelector(".amy-jev-bar")!;
    expect(bar.getAttribute("data-amy-act")).toBe("jev-toggle");
    expect(bar.getAttribute("data-run")).toBe("t1");
    expect(bar.querySelector(".amy-jttl")!.textContent).toBe("JEV");
    expect(bar.querySelector(".amy-jkind")!.textContent).toBe("checks");
    expect(bar.querySelector(".amy-jsm")!.textContent).toBe("5 checks · 3 steps · 09:38–09:52");
    expect(bar.querySelector(".amy-jtw")!.textContent).toBe("▸");
    expect(render().querySelector(".amy-jtw")!.textContent).toBe("▾");
  });

  it("checksSummary names one clock when everything happened in the same minute", () => {
    expect(checksSummary([dec("a")])).toBe("1 check · 1 step · 09:38");
  });

  it("draws one cell per check and one clickable column per step, with the step in its tooltip", () => {
    const el = render();
    expect(el.querySelectorAll("svg.amy-tl rect.amy-tc")).toHaveLength(5);
    const cols = el.querySelectorAll("rect.amy-tcol");
    expect(cols).toHaveLength(3);
    expect(cols[1]!.getAttribute("data-amy-act")).toBe("jev-col");
    expect(cols[1]!.getAttribute("data-run")).toBe("t1");
    expect(cols[1]!.getAttribute("data-col")).toBe("1");
    expect(cols[1]!.querySelector("title")!.textContent).toBe(
      "exec rm x\n09:39:12 · 2 before it ran, 1 after · held",
    );
  });

  it("checks made before a step sit above the axis, after it below; a change touches the axis and marks it", () => {
    const el = render();
    const cells = [...el.querySelectorAll("rect.amy-tc")];
    const held = cells.find((r) => r.classList.contains("amy-tc-held"))!;
    const above = cells.filter((r) => y(r) < LANE);
    const below = cells.filter((r) => y(r) >= LANE + AX);
    expect(above).toHaveLength(3); // prompt + two pre-tool checks
    expect(below).toHaveLength(2); // post-tool + stop
    // The held answer is the one nearest the axis in its column.
    const col1Above = above.filter((r) => r.getAttribute("x") === held.getAttribute("x"));
    expect(Math.max(...col1Above.map(y))).toBe(y(held));
    const mark = el.querySelector("rect.amy-tmark")!;
    expect(mark.classList.contains("amy-tc-held")).toBe(true);
    expect(el.querySelectorAll("rect.amy-tmark")).toHaveLength(1);
    expect(el.querySelectorAll("rect.amy-cached")).toHaveLength(1);
  });

  it("says when: the span in the title, the clock at both ends and the middle, the lanes' tallest stacks", () => {
    const el = render();
    expect(el.querySelector(".amy-thead")!.textContent).toBe(
      "CHECK TIMELINE3 steps · 09:38:12 → 09:52:40 · 14 min 28 s",
    );
    expect([...el.querySelectorAll(".amy-tticks span")].map((s) => s.textContent)).toEqual([
      "09:38:12",
      "09:39:12",
      "09:52:40",
    ]);
    expect(el.querySelector(".amy-tcap-top")!.textContent).toBe("before it ran ↑ 2");
    expect(el.querySelector(".amy-tcap-bot")!.textContent).toBe("after it ran ↓ 1");
  });

  it("the legend lists only what the drawing painted", () => {
    const leg = render().querySelector(".amy-tleg")!.textContent!;
    expect(leg).toContain("ok");
    expect(leg).toContain("held");
    expect(leg).toContain("cached");
    expect(leg).not.toContain("sent back");
    expect(leg).not.toContain("refusal");
  });

  it("no column picked: a hint; a picked column lists its checks before and after, each opening to its detail", () => {
    expect(render().querySelector(".amy-thint")!.textContent).toBe(
      "Click a column to see that step's checks.",
    );
    const el = render({ col: 1, openRows: new Set(["a3"]) });
    expect(el.querySelector(".amy-thint")).toBeNull();
    expect(el.querySelector("rect.amy-tsel")!.getAttribute("x")).toBe(
      el.querySelectorAll("rect.amy-tcol")[1]!.getAttribute("x"),
    );
    const det = el.querySelector(".amy-tdet")!;
    expect(det.querySelector(".amy-jstep")!.textContent).toBe("├ exec rm x · 09:39:12");
    expect([...det.querySelectorAll(".amy-tseam")].map((s) => s.textContent)).toEqual([
      "before it ran",
      "after it ran",
    ]);
    const rows = det.querySelectorAll(".amy-jr");
    expect([...rows].map((r) => r.getAttribute("data-id"))).toEqual(["a1", "a2", "a3"]);
    expect(rows[0]!.getAttribute("data-amy-act")).toBe("jev-row");
    const details = det.querySelectorAll(".amy-jd");
    expect(details[2]!.classList.contains("amy-show")).toBe(true);
    expect(details[0]!.classList.contains("amy-show")).toBe(false);
    expect(details[2]!.textContent).toContain("96 ms · cached");
    const lab = details[2]!.querySelectorAll("button[data-amy-act=label]");
    expect(lab[0]!.getAttribute("data-target-id")).toBe("a3");
    expect(lab[0]!.getAttribute("data-target-kind")).toBe("verdict");
    // A column out of range is ignored.
    expect(render({ col: 9 }).querySelector(".amy-tdet")).toBeNull();
  });

  it("rows carry the glyph and pill of what code did, for every kind", () => {
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
        renderJevChecks("t1", [dec("x", { codeDid: k })], { open: true, col: 0, openRows: none }),
      );
      expect(el.querySelector(".amy-jr .amy-jg")!.textContent).toBe(GLYPH[k]);
      const pill = el.querySelector(".amy-jr .amy-jo")!;
      expect(pill.classList.contains(cls[k])).toBe(true);
      expect(pill.textContent).toBe(DID_WORD[k]);
      expect(el.querySelector(`rect.amy-tc-${cls[k]}`)).not.toBeNull();
    }
  });

  it("footer: checks, cached, the judge's time (cached answers cost none) and the steps that ran on rules only", () => {
    expect(render().querySelector(".amy-jft")!.textContent).toBe(
      "5 checks · 1 cached · judge 4.3 s",
    );
    expect(render({ rulesOnly: 2 }).querySelector(".amy-jft")!.textContent).toBe(
      "5 checks · 1 cached · judge 4.3 s · 2 steps on the hard rules only",
    );
  });

  it("marks weak and degraded answers in the step list", () => {
    const el = parse(
      renderJevChecks("t1", [dec("w", { weak: true }), dec("d", { degraded: true }), dec("n")], {
        open: true,
        col: 0,
        openRows: none,
      }),
    );
    expect(el.querySelectorAll(".amy-jw")).toHaveLength(1);
    expect(el.querySelectorAll(".amy-jx")).toHaveLength(1);
  });

  it("escapes the step label and question name; never emits an instructions field", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = renderJevChecks("t1", [dec("e", { questionName: evil, stepLabel: evil })], {
      open: true,
      col: 0,
      openRows: new Set(["e"]),
    });
    const el = parse(html);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".amy-jq")!.textContent).toContain(evil);
    expect(el.querySelector("rect.amy-tcol title")!.textContent).toContain(evil);
    expect(html).not.toMatch(/instructions/i);
  });
});

describe("renderJevNotConsulted", () => {
  it("renders both variants as one CHECKS line without a body", () => {
    const a = parse(renderJevNotConsulted("t9", "real-steps-stay-local"));
    expect(a.textContent).toContain("JEV");
    expect(a.textContent).toContain("not consulted (real steps stay local) · rules only");
    expect(a.querySelector(".amy-jev-checks")).not.toBeNull();
    expect(a.querySelector(".amy-jev-body")).toBeNull();
    expect(a.querySelector("[data-amy-act]")).toBeNull();
    const b = parse(renderJevNotConsulted("t9", "judge-down"));
    expect(b.textContent).toContain("unreachable · judge checks skipped");
  });
});

describe("actionsOf: what Jev would have done", () => {
  it("one action per decision with its driving answers; its intervention attached; lone rules after; time order", () => {
    const t = turn(
      [
        dec("o", {}),
        dec("h1", { codeDid: "held", decisionId: "D1", stepLabel: "rm -rf x", ts: T0 + 10 }),
        dec("h2", { codeDid: "held", decisionId: "D1", stepLabel: "rm -rf x", ts: T0 + 11 }),
        dec("n", { codeDid: "note", decisionId: "D2", ts: T0 + 30 }),
      ],
      [
        iv("iv1", { decisionId: "D1", ts: T0 + 12 }),
        iv("iv2", { kind: "proof", cmd: "curl x", chips: ["rule: network"], ts: T0 + 20 }),
      ],
    );
    const a = actionsOf([t]);
    expect(a.map((x) => [x.did, x.key, x.reasons.length, x.iv?.id])).toEqual([
      ["held", "D1", 2, "iv1"],
      ["proof", "iv2", 0, "iv2"],
      ["note", "D2", 1, undefined],
    ]);
    expect(a[1]!.step).toBe("curl x");
    expect(a[1]!.chips).toEqual(["rule: network"]);
  });
  it("actionsSummary counts each kind in words", () => {
    const a = actionsOf([
      turn([
        dec("s", { codeDid: "sent-back", decisionId: "D1" }),
        dec("n1", { codeDid: "note", decisionId: "D2" }),
        dec("n2", { codeDid: "note", decisionId: "D3" }),
        dec("n3", { codeDid: "note", decisionId: "D4" }),
      ]),
    ]);
    expect(actionsSummary(a)).toBe("4 to review: 1 sent back · 3 notes");
    expect(actionsSummary([])).toBe("nothing to review");
  });
});

describe("renderJevActions: the actions to review", () => {
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
    dec("s", {
      codeDid: "sent-back",
      decisionId: "D2",
      stepLabel: "end of turn",
      seam: "stop",
      questionName: "False success: does it claim work the record never shows?",
      answer: 0.83,
      ts: T0 + 60_000,
    }),
  ];
  const render = (o: Partial<Parameters<typeof renderJevActions>[2]> = {}, t = turn(ds)) =>
    parse(renderJevActions("t1", [t], { open: true, ...o }));

  it("returns empty string when Jev would have changed nothing", () => {
    expect(renderJevActions("t1", [turn([dec("a"), dec("b")])], { open: true })).toBe("");
  });

  it("a bar in Jev's look says 'would have' and counts them; it folds on a click", () => {
    const el = render();
    const w = el.querySelector(".amy-jev-act")!;
    expect(w.classList.contains("amy-open")).toBe(true);
    const bar = w.querySelector(".amy-jev-bar")!;
    expect(bar.getAttribute("data-amy-act")).toBe("jev-act-toggle");
    expect(bar.getAttribute("data-run")).toBe("t1");
    expect(bar.querySelector(".amy-jkind")!.textContent).toBe("would have");
    expect(bar.querySelector(".amy-jsm")!.textContent).toBe("2 to review: 1 held · 1 sent back");
    expect(
      render({ open: false }).querySelector(".amy-jev-act")!.classList.contains("amy-open"),
    ).toBe(false);
    expect(render({ shadow: false }).querySelector(".amy-jkind")!.textContent).toBe("acted");
  });

  it("one row per action: what, on which step, why, when, with the votes in view", () => {
    const el = render();
    const rows = el.querySelectorAll(".amy-jact");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Would have held this step");
    expect(rows[0]!.querySelector(".amy-jc-step")!.textContent).toBe("step rm -rf x");
    const why = rows[0]!.querySelector(".amy-jc-why")!.textContent!;
    expect(why).toContain("because Jev answered");
    expect(why).toContain("Danger level: how hard is this step to undo? → 3");
    expect(why).toContain("Planted instructions");
    expect(rows[0]!.querySelector(".amy-ja-time")!.textContent).toBe("09:38");
    expect(rows[1]!.textContent).toContain("Would have sent the reply back to be finished");
    const votes = rows[0]!.querySelectorAll("button[data-amy-act=label]");
    expect(votes).toHaveLength(2);
    expect(votes[0]!.getAttribute("data-target-id")).toBe("D1");
    expect(votes[0]!.getAttribute("data-target-kind")).toBe("decision");
    expect(votes[0]!.getAttribute("data-kind")).toBe("useful");
    expect(votes[0]!.getAttribute("data-value")).toBe("1");
    expect(votes[0]!.textContent).toContain("right call");
    expect(votes[1]!.getAttribute("data-value")).toBe("-1");
    expect(votes[1]!.textContent).toContain("wrong call");
  });

  it("a vote already given shows on its button; enforce mode says what it did", () => {
    const v = render({ votes: new Map([["D1", 1]]) })
      .querySelectorAll(".amy-jact")[0]!
      .querySelectorAll("button");
    expect(v[0]!.classList.contains("amy-voted")).toBe(true);
    expect(v[1]!.classList.contains("amy-voted")).toBe(false);
    expect(render({ shadow: false }).querySelector(".amy-jact")!.textContent).toContain(
      "Held this step",
    );
  });

  it("without a decision id the vote falls back to the first answer; a lone rule with no decision has no vote", () => {
    const b = render({}, turn([dec("x", { codeDid: "note" })])).querySelector(".amy-jact button")!;
    expect(b.getAttribute("data-target-id")).toBe("x");
    expect(b.getAttribute("data-target-kind")).toBe("verdict");
    const lone = render({}, turn([], [iv("r1", { cmd: "rm -rf /tmp/x" })])).querySelector(
      ".amy-jact",
    )!;
    expect(lone.querySelector("button")).toBeNull();
    expect(lone.querySelector(".amy-jc-why")!.textContent).toBe(
      "because of the rules effect: delete",
    );
    expect(lone.querySelector(".amy-jc-step")!.textContent).toBe("step rm -rf /tmp/x");
  });

  it("the extra markup (a waiting card, the refusal offer) rides on its own row", () => {
    const el = render({ extra: (a) => (a.did === "held" ? '<div class="probe">card</div>' : "") });
    const rows = el.querySelectorAll(".amy-jact");
    expect(rows[0]!.querySelector(".amy-ja-extra .probe")).not.toBeNull();
    expect(rows[1]!.querySelector(".amy-ja-extra")).toBeNull();
  });

  it("a reply marker closes the window, and alone is enough to draw it", () => {
    const m: MarkerView = {
      kind: "unsupported-after-two",
      sessionKey: "s",
      turnId: "t1",
      items: ["claims"],
      ts: T0,
    };
    const el = parse(renderJevActions("t1", [turn([], [], [m])], { open: true }));
    expect(el.querySelector(".amy-jev-act .amy-marker")!.textContent).toBe(
      "still unsupported after two attempts: claims",
    );
    expect(el.querySelector(".amy-jsm")!.textContent).toBe("nothing to review");
  });

  it("actions of several turns in one reply share the window, in time order", () => {
    const html = renderJevActions(
      "t1",
      [
        turn([dec("x", { codeDid: "note", decisionId: "D9", ts: T0 + 5 })], [], [], "t2"),
        turn([dec("y", { codeDid: "held", decisionId: "D8", ts: T0 })]),
      ],
      { open: true },
    );
    const rows = parse(html).querySelectorAll(".amy-jact");
    expect([...rows].map((r) => r.getAttribute("data-turn"))).toEqual(["t1", "t2"]);
  });

  it("escapes names and steps", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const el = render(
      {},
      turn([dec("e", { codeDid: "note", questionName: evil, stepLabel: evil })]),
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".amy-jc-step")!.textContent).toContain(evil);
  });
});
