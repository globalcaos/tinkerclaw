import { describe, expect, it } from "vitest";
import {
  renderAskCard,
  renderExceptionalCard,
  renderHoldCard,
  renderMarker,
  renderProofCard,
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
  it("open: card with cmd, chips and the three actions", () => {
    const el = dom(renderHoldCard(iv()));
    const root = el.querySelector(".amy-hold")!;
    expect(root.getAttribute("data-iv")).toBe("iv1");
    expect(el.querySelector(".amy-cmd")!.textContent).toBe("test-cmd");
    expect(el.querySelectorAll(".amy-chip").length).toBe(2);
    const acts = [...el.querySelectorAll("button")].map((b) => [
      b.getAttribute("data-amy-act"),
      b.getAttribute("data-answer"),
    ]);
    expect(acts).toEqual([
      ["answer", "allow-once"],
      ["answer", "keep-held"],
      ["why", null],
    ]);
    expect(el.querySelector(".amy-why")).toBeNull();
  });
  it("showWhy lists the chips again", () => {
    const el = dom(renderHoldCard(iv(), { showWhy: true }));
    expect(el.querySelectorAll(".amy-why li").length).toBe(2);
  });
  it("closed: one settled line, no buttons", () => {
    const el = dom(renderHoldCard(iv({ state: "denied" })));
    expect(el.textContent).toBe("✋ held · denied");
    expect(el.querySelector("button")).toBeNull();
  });
  it("escapes cmd and chips", () => {
    const el = dom(renderHoldCard(iv({ cmd: EVIL, chips: [EVIL] }), { showWhy: true }));
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".amy-cmd")!.textContent).toBe(EVIL);
  });
});

describe("renderProofCard", () => {
  it("open shows cmd and chips, no buttons", () => {
    const el = dom(renderProofCard(iv({ kind: "proof" })));
    expect(el.querySelector(".amy-proof")!.getAttribute("data-iv")).toBe("iv1");
    expect(el.querySelector(".amy-cmd")!.textContent).toBe("test-cmd");
    expect(el.querySelector("button")).toBeNull();
  });
  it("closed released reads as a released line", () => {
    const el = dom(renderProofCard(iv({ kind: "proof", state: "released" })));
    expect(el.textContent).toBe("✓ released");
  });
  it("closed with another state names it", () => {
    expect(dom(renderProofCard(iv({ state: "expired" }))).textContent).toContain("expired");
  });
  it("escapes", () => {
    const el = dom(renderProofCard(iv({ cmd: EVIL, chips: [EVIL] })));
    expect(el.querySelector("img")).toBeNull();
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
    expect(el.textContent).toContain("This looks like a refusal");
    expect(el.textContent).toContain("logged for the router");
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
    expect(el.textContent).toBe("still unsupported after two attempts: upload B, upload C");
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
