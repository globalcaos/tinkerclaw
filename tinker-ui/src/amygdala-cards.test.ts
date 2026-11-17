import { describe, expect, it } from "vitest";
import {
  type EffectView,
  renderAllowBar,
  renderEffectCards,
  renderAskCard,
  renderExceptionalCard,
  renderHoldCard,
  renderMarker,
  renderRefusalStrip,
  renderRewoundMarker,
} from "./amygdala-cards.js";
import type { ChangeView, InterventionView, MarkerView } from "./amygdala-types.js";

const EVIL = '<img src=x onerror="alert(1)">';

function dom(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

function iv(over: Partial<InterventionView> = {}): InterventionView {
  return {
    id: "iv1",
    ts: 1,
    sessionKey: "s",
    turnId: "t1",
    kind: "hold",
    state: "open",
    title: "test-title",
    chips: ["chip-a", "chip-b"],
    cmd: "test-cmd",
    ...over,
  };
}

function change(over: Partial<ChangeView> = {}): ChangeView {
  return {
    id: "c1",
    kind: "loosen",
    questionName: "test-name",
    from: 3,
    to: 2,
    exceptional: true,
    status: "pending",
    replaySummary: { cases: 4, relaxed: 4, tightened: 0, mustCatchLost: 0, controlsNewlyHeld: 0 },
    ...over,
  };
}

describe("renderHoldCard", () => {
  it("open: the hand, one question and its two answers, nothing else (2026-11-03)", () => {
    const el = dom(renderHoldCard(iv({ ask: "Allow deleting /home/x/notes.txt?" })));
    expect(el.querySelector(".amy-hold")!.getAttribute("data-iv")).toBe("iv1");
    expect(el.querySelector(".amy-q-icon")!.textContent).toBe("✋");
    expect(el.querySelector(".amy-q-text")!.textContent).toBe("Allow deleting /home/x/notes.txt?");
    const acts = [...el.querySelectorAll("button")].map((b) => [
      b.getAttribute("data-amy-act"),
      b.getAttribute("data-answer"),
      b.textContent,
    ]);
    expect(acts).toEqual([
      ["answer", "allow-once", "Allow"],
      ["answer", "keep-held", "No"],
    ]);
    expect(el.textContent).not.toContain("test-cmd");
    expect(el.textContent).not.toContain("chip-a");
  });
  it("a gateway that sent no question still asks one", () => {
    expect(dom(renderHoldCard(iv())).querySelector(".amy-q-text")!.textContent).toBe(
      "Allow this step?",
    );
  });
  it("closed: the question and what became of it, no buttons", () => {
    const el = dom(renderHoldCard(iv({ state: "denied", ask: "Allow deleting x?" })));
    expect(el.textContent).toBe("✋ Allow deleting x? · kept held");
    expect(el.querySelector("button")).toBeNull();
    expect(dom(renderHoldCard(iv({ state: "released" }))).textContent).toBe(
      "✋ Allow this step? · allowed",
    );
  });
  it("escapes the question and the sentence", () => {
    const el = dom(renderHoldCard(iv({ ask: EVIL, sentence: EVIL })));
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".amy-q-text")!.textContent).toBe(EVIL);
    expect(el.querySelector(".amy-hold")!.getAttribute("title")).toBe(EVIL);
  });
});

describe("renderAskCard", () => {
  const opts = [
    { id: "a", label: "Alpha", hint: "first" },
    { id: "b", label: "Beta" },
    { id: "other", label: "Something else…" },
  ];
  it("defaults to the first option", () => {
    const el = dom(renderAskCard(iv({ kind: "ask", options: opts }), null));
    const rows = [...el.querySelectorAll(".amy-opt")];
    expect(rows.length).toBe(3);
    expect(rows[0]!.classList.contains("amy-sel")).toBe(true);
    expect(rows[1]!.classList.contains("amy-sel")).toBe(false);
    expect(rows[0]!.querySelector("small")!.textContent).toBe("first");
  });
  it("highlights the selected option and wires the acts", () => {
    const el = dom(renderAskCard(iv({ kind: "ask", options: opts }), "b"));
    const rows = [...el.querySelectorAll(".amy-opt")];
    expect(rows[1]!.classList.contains("amy-sel")).toBe(true);
    expect(rows[0]!.classList.contains("amy-sel")).toBe(false);
    expect(rows[1]!.getAttribute("data-amy-act")).toBe("ask-select");
    expect(rows[1]!.getAttribute("data-option")).toBe("b");
    expect(rows[1]!.getAttribute("data-iv")).toBe("iv1");
    const send = el.querySelector('button[data-amy-act="ask-confirm"]')!;
    expect(send.getAttribute("data-iv")).toBe("iv1");
  });
  it("no options: just the title", () => {
    const el = dom(renderAskCard(iv({ kind: "ask", options: [] }), null));
    expect(el.querySelector("h3")!.textContent).toContain("test-title");
    expect(el.querySelector(".amy-opt")).toBeNull();
    expect(el.querySelector("button")).toBeNull();
  });
  it("closed: settled line", () => {
    const el = dom(renderAskCard(iv({ kind: "ask", state: "settled", options: opts }), "a"));
    expect(el.querySelector(".amy-opt")).toBeNull();
    expect(el.textContent).toContain("settled");
  });
  it("escapes title, labels and hints", () => {
    const el = dom(
      renderAskCard(
        iv({ kind: "ask", title: EVIL, options: [{ id: EVIL, label: EVIL, hint: EVIL }] }),
        null,
      ),
    );
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("renderRefusalStrip", () => {
  it("hidden when denied or missing", () => {
    expect(renderRefusalStrip("t1", iv({ kind: "refusal", state: "denied" }), true)).toBe("");
    expect(renderRefusalStrip("t1", undefined, true)).toBe("");
  });
  it("shown in shadow mode too (a settled refusal is the same offer, 2026-09-30)", () => {
    const el = dom(renderRefusalStrip("t1", iv({ kind: "refusal", state: "settled" }), true));
    expect(el.querySelector('[data-amy-act="rewind"]')).not.toBeNull();
  });
  it("an older exchange shows Rewind greyed out with the reason", () => {
    const el = dom(
      renderRefusalStrip("t1", iv({ kind: "refusal" }), false, "Rewind the newer exchange first"),
    );
    const b = el.querySelector("button[disabled]")!;
    expect(b.textContent).toContain("Rewind");
    expect(b.getAttribute("title")).toBe("Rewind the newer exchange first");
    expect(b.getAttribute("data-amy-act")).toBeNull();
  });
  it("open with Rewind and Keep", () => {
    const el = dom(renderRefusalStrip("t1", iv({ kind: "refusal" }), true));
    const acts = [...el.querySelectorAll("button")].map((b) => [
      b.getAttribute("data-amy-act"),
      b.getAttribute("data-turn"),
    ]);
    expect(acts).toEqual([
      ["rewind", "t1"],
      ["refusal-keep", "t1"],
    ]);
    // The bubble it rides in already says what Jev saw (2026-11-03): the strip is its buttons.
    expect(el.textContent).toBe("⟲ RewindKeep");
  });
  it("no Rewind when canRewind is false", () => {
    const el = dom(renderRefusalStrip("t1", iv({ kind: "refusal" }), false));
    expect(el.querySelector('[data-amy-act="rewind"]')).toBeNull();
    expect(el.querySelector('[data-amy-act="refusal-keep"]')).not.toBeNull();
  });
  it("a retry pick adds the second button, named, with the logo; the label is escaped", () => {
    const el = dom(
      renderRefusalStrip("t1", iv({ kind: "refusal" }), true, undefined, {
        label: EVIL,
        chipHtml: '<span class="model-provider-icon"><svg></svg></span>',
        reason: "best at code",
      }),
    );
    const acts = [...el.querySelectorAll("button")].map((b) => b.getAttribute("data-amy-act"));
    expect(acts).toEqual(["rewind", "rewind-retry", "refusal-keep"]);
    const b = el.querySelector('[data-amy-act="rewind-retry"]')!;
    expect(b.textContent).toContain("Rewind and retry with");
    expect(b.querySelector(".model-provider-icon svg")).not.toBeNull();
    expect(b.getAttribute("title")).toBe("best at code");
    expect(el.querySelector("img")).toBeNull();
  });
  it("no retry button without a pick, or on an older exchange that cannot be rewound", () => {
    expect(
      dom(renderRefusalStrip("t1", iv({ kind: "refusal" }), true, undefined, null)).querySelector(
        '[data-amy-act="rewind-retry"]',
      ),
    ).toBeNull();
    const old = dom(
      renderRefusalStrip("t1", iv({ kind: "refusal" }), false, "Rewind the newer exchange first", {
        label: "Grok 4.7",
        chipHtml: "",
      }),
    );
    expect(old.querySelector('[data-amy-act="rewind-retry"]')).toBeNull();
  });
  it("escapes the turn id", () => {
    const el = dom(renderRefusalStrip(EVIL, iv({ kind: "refusal" }), true));
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("renderRewoundMarker", () => {
  it("has text and an Undo act", () => {
    const el = dom(renderRewoundMarker("t1", { ts: Date.now() }));
    expect(el.textContent).toContain("Rewound 1 exchange");
    expect(el.textContent).toContain("the model no longer sees it");
    const undo = el.querySelector('[data-amy-act="rewind-undo"]')!;
    expect(undo.getAttribute("data-turn")).toBe("t1");
    expect(undo.textContent).toBe("Undo");
  });
  it("escapes the restored prompt and the turn id", () => {
    const html = renderRewoundMarker(EVIL, { ts: 0, restoredPrompt: EVIL });
    const el = dom(html);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".amy-rewound")!.getAttribute("title")).toBe(EVIL);
  });
});

describe("renderExceptionalCard", () => {
  it("pending: tag, name, from to, replay chips, three buttons", () => {
    const el = dom(renderExceptionalCard(change(), false));
    expect(el.querySelector(".amy-appr")!.getAttribute("data-change")).toBe("c1");
    expect(el.querySelector(".amy-tag")!.textContent).toBe("Exceptional · needs you");
    expect(el.textContent).toContain("test-name");
    expect(el.querySelector(".amy-fromto")!.textContent).toBe("3 → 2");
    const chips = [...el.querySelectorAll(".amy-chip")].map((c) => c.textContent);
    expect(chips).toEqual([
      "4 of 4 cases now proceed",
      "0 must-catch lost",
      "0 controls newly held",
    ]);
    expect(el.querySelector(".amy-chip.amy-bad")).toBeNull();
    const btns = [...el.querySelectorAll("button")].map((b) => [
      b.getAttribute("data-amy-act"),
      b.getAttribute("data-yes"),
    ]);
    expect(btns).toEqual([
      ["approve", "1"],
      ["approve", "0"],
      ["see-cases", null],
    ]);
    expect(el.querySelector(".amy-cases")).toBeNull();
  });
  it("expanded shows the replay detail", () => {
    const el = dom(renderExceptionalCard(change(), true));
    expect(el.querySelector(".amy-cases")!.textContent).toContain("Replayed 4 cases");
  });
  it("marks lost must-catches and newly held controls", () => {
    const el = dom(
      renderExceptionalCard(
        change({
          replaySummary: {
            cases: 5,
            relaxed: 2,
            tightened: 1,
            mustCatchLost: 1,
            controlsNewlyHeld: 2,
          },
        }),
        false,
      ),
    );
    expect(el.querySelectorAll(".amy-chip.amy-bad").length).toBe(2);
  });
  it("applied and rejected have no buttons", () => {
    for (const status of ["applied", "rejected", "undone"] as const) {
      const el = dom(renderExceptionalCard(change({ status }), false));
      expect(el.querySelector("button")).toBeNull();
      expect(el.querySelector(".amy-status")!.textContent).toBe(status);
    }
  });
  it("escapes name, from and to", () => {
    const el = dom(
      renderExceptionalCard(change({ questionName: EVIL, from: EVIL, to: EVIL }), true),
    );
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("renderMarker", () => {
  const m = (over: Partial<MarkerView> = {}): MarkerView => ({
    kind: "unsupported-after-two",
    sessionKey: "s",
    turnId: "t1",
    items: ["upload B", "upload C"],
    ts: 1,
    ...over,
  });
  it("reads as the one-line marker", () => {
    const el = dom(renderMarker(m()));
    expect(el.textContent).toBe("still unsupported after one send-back: upload B, upload C");
    expect(el.querySelector(".amy-marker")!.getAttribute("data-turn")).toBe("t1");
  });
  it("handles the refusal-rewound kind", () => {
    expect(dom(renderMarker(m({ kind: "refusal-rewound", items: [] }))).textContent).toBe(
      "refusal rewound",
    );
  });
  it("escapes items", () => {
    expect(dom(renderMarker(m({ items: [EVIL] }))).querySelector("img")).toBeNull();
  });
});

describe("the plain sentence replaces the command (2026-11-01)", () => {
  const plain =
    "This deletes notes.txt, and it cannot be undone, because it looks hard to reverse.";
  const withSentence = () =>
    iv({ sentence: plain, cmd: "rm -f notes.txt", chips: ["effect: delete"] });

  it("a hold asks its question; the sentence rides on hover, never the command", () => {
    const el = dom(renderHoldCard({ ...withSentence(), ask: "Allow deleting notes.txt?" }));
    expect(el.querySelector(".amy-hold")!.getAttribute("title")).toBe(plain);
    expect(el.querySelector(".amy-cmd")).toBeNull();
    expect(el.textContent).not.toContain("rm -f");
  });

  it("the ask card shows it above its options", () => {
    const el = dom(renderAskCard(iv({ kind: "ask", sentence: plain, options: [] }), null));
    expect(el.querySelector(".amy-plain")!.textContent).toBe(plain);
  });

  it("the Allow bar: one line per step, the hand, the question and the button; the sentence on hover", () => {
    const el = dom(
      renderAllowBar([{ code: "JEV-1", ask: "Allow deleting notes.txt?", what: plain }], new Set()),
    );
    const row = el.querySelector(".amy-allow-row")!;
    expect(row.querySelector(".amy-allow-icon")!.textContent).toBe("✋");
    expect(row.querySelector(".amy-allow-what")!.textContent).toBe("Allow deleting notes.txt?");
    expect(row.getAttribute("title")).toBe(plain);
    expect(row.querySelector("button")!.textContent).toBe("Allow");
    expect(el.textContent).toBe("✋Allow deleting notes.txt?Allow");
  });

  it("the Allow bar escapes its question and its sentence", () => {
    const el = dom(renderAllowBar([{ code: "JEV-1", ask: EVIL, what: EVIL }], new Set()));
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".amy-allow-row")!.getAttribute("title")).toBe(EVIL);
  });
});

describe("effect cards (2026-11-08)", () => {
  const e = (over: Partial<EffectView> = {}): EffectView => ({
    id: "eff-t#1-0",
    sessionKey: "s",
    turnId: "t#1",
    ts: 1,
    what: "Test page <published>",
    where: "biz.example.test",
    week: 1,
    lifetime: 40,
    revert: "ssh web rm /var/www/page.html",
    state: "live",
    ...over,
  });
  it("says what and where, the reach for the week and the lifetime, and offers Revert", () => {
    const h = renderEffectCards([e()]);
    expect(h).toContain('class="amy-effect"');
    expect(h).toContain("Test page &lt;published&gt;");
    expect(h).toContain("biz.example.test");
    expect(h).toContain("1 person this week");
    expect(h).toContain("40 people lifetime");
    expect(h).toContain('data-amy-act="effect-revert" data-effect="eff-t#1-0"');
  });
  it("a reverted change is marked and has no button; a change with no undo says so", () => {
    expect(renderEffectCards([e({ state: "reverted" })])).toContain("Reverted ✓");
    expect(renderEffectCards([e({ state: "reverted" })])).not.toContain(
      'data-amy-act="effect-revert"',
    );
    expect(renderEffectCards([e({ revert: null })])).toContain("Can't undo");
    expect(renderEffectCards([e({ state: "revert-failed", output: "boom" })])).toContain(
      "Retry revert",
    );
  });
  it("nothing to show is an empty string", () => {
    expect(renderEffectCards([])).toBe("");
  });
});
