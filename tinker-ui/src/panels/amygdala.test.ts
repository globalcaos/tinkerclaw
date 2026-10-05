import { describe, it, expect } from "vitest";
import type { ChangeView, InterventionView, QuestionRow, StatusView } from "../amygdala-types";
import {
  renderAmygdalaPanelBody,
  renderDot,
  statusLine,
  stripBars,
  learningRows,
  type PanelInput,
} from "./amygdala";

const NOW = 1_800_000_000_000;
const EVIL = `<img src=x onerror=alert(1)>`;

const status = (over: Partial<StatusView> = {}): StatusView => ({
  ts: NOW,
  state: "working",
  line: "Working · 214 checks · 3 held · 1 asked · €0.003 today",
  mode: "enforce",
  floorActive: false,
  seams: {
    prompt: { lastTs: NOW - 120_000 },
    pre: { lastTs: NOW - 4_000 },
    post: { lastTs: NOW - 4_000 },
    stop: { lastTs: null },
  },
  rules: { n: 47, version: 12 },
  judge: { lastMs: 280, errors: 0 },
  spendEurToday: 0.003,
  checksToday: 214,
  heldToday: 3,
  askedToday: 1,
  waitingForYou: 0,
  notesDropped: 0,
  ...over,
});

const change = (over: Partial<ChangeView> = {}): ChangeView => ({
  id: "c1",
  kind: "loosen",
  questionName: "Danger level",
  from: 2,
  to: 3,
  exceptional: false,
  status: "applied",
  replaySummary: { cases: 6, relaxed: 6, tightened: 0, mustCatchLost: 0, controlsNewlyHeld: 0 },
  ...over,
});

const iv = (over: Partial<InterventionView> = {}): InterventionView => ({
  id: "i1",
  decisionId: "d1",
  ts: NOW - 60_000,
  sessionKey: "s",
  turnId: "t",
  kind: "hold",
  state: "open",
  title: "held a delete",
  chips: [],
  ...over,
});

const input = (over: Partial<PanelInput> = {}): PanelInput => ({
  available: true,
  status: status(),
  questions: [],
  changes: [],
  precedents: 23,
  spend: { eur: 0.003, eur30: 0.08, calls: 212 },
  strip: [],
  interventionsToday: [],
  now: NOW,
  ...over,
});

const parse = (html: string) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d;
};
const accEl = (root: HTMLElement, id: string) =>
  root.querySelector(`[data-acc="${id}"]`)!.closest(".amy-acc") as HTMLElement;
const isOpen = (root: HTMLElement, id: string) =>
  accEl(root, id).classList.contains("amy-acc--open");
const none = new Set<string>();

describe("renderAmygdalaPanelBody", () => {
  it("returns an empty string when the amygdala is not available", () => {
    expect(renderAmygdalaPanelBody(input({ available: false }), { open: none })).toBe("");
  });

  it("closed: five expanders with summaries, bodies empty, spend line present", () => {
    const root = parse(renderAmygdalaPanelBody(input(), { open: none }));
    const accs = [...root.querySelectorAll("[data-amy-act='acc']")].map((e) =>
      e.getAttribute("data-acc"),
    );
    expect(accs).toEqual(["health", "today", "questions", "learning", "cost"]);
    for (const id of accs) {
      expect(isOpen(root, id!)).toBe(false);
      expect(accEl(root, id!).querySelector(".amy-ab")!.textContent).toBe("");
    }
    expect(root.querySelector(".amy-p-line")!.textContent).toContain("€0.003 today");
    expect(root.querySelector(".amy-p-line--bad")).toBeNull();
    expect(accEl(root, "cost").querySelector(".amy-s")!.textContent).toBe("€0.003 today");
    expect(root.querySelector(".amy-p-head .amy-dot--green")).not.toBeNull();
  });

  it("open: each expander shows its body", () => {
    const html = renderAmygdalaPanelBody(
      input({
        interventionsToday: [iv()],
        questions: [
          { id: "q", name: "Danger level", version: 2, today: 5, right: 0.9, status: "active" },
        ],
      }),
      { open: new Set(["health", "today", "questions", "learning", "cost"]) },
    );
    const root = parse(html);
    for (const id of ["health", "today", "questions", "learning", "cost"])
      expect(isOpen(root, id)).toBe(true);
    const health = accEl(root, "health").textContent!;
    expect(health).toContain("Your prompt");
    expect(health).toContain("2 min ago");
    expect(health).toContain("never");
    expect(health).toContain("47 · v12");
    expect(health).toContain("280 ms · 0 errors");
    expect(health).toContain("enforcing");
    expect(root.querySelector("[data-amy-act='canary']")).not.toBeNull();
    expect(accEl(root, "today").textContent).toContain("held a delete");
    expect(accEl(root, "cost").textContent).toContain("€0.08");
    expect(accEl(root, "cost").textContent).toContain("212");
  });

  it("degraded auto-opens Health and turns line and dot red", () => {
    const s = status({
      state: "degraded",
      line: "Judge silent 6 min · hard rules still on",
      judge: { lastMs: null, errors: 3, silentSince: NOW - 6 * 60_000 },
    });
    const root = parse(renderAmygdalaPanelBody(input({ status: s }), { open: none }));
    expect(isOpen(root, "health")).toBe(true);
    expect(isOpen(root, "today")).toBe(false);
    expect(root.querySelector(".amy-p-line--bad")).not.toBeNull();
    expect(root.querySelector(".amy-p-head .amy-dot--red")).not.toBeNull();
    const h = accEl(root, "health").textContent!;
    expect(h).toContain("silent 6 min");
    expect(h).toContain("hard rules only");
  });

  it("shadow mode: amber dot and 'shadow' mode row", () => {
    const root = parse(
      renderAmygdalaPanelBody(input({ status: status({ state: "shadow", mode: "shadow" }) }), {
        open: new Set(["health"]),
      }),
    );
    expect(root.querySelector(".amy-p-head .amy-dot--amber")).not.toBeNull();
    expect(accEl(root, "health").textContent).toContain("shadow");
  });

  it("Today: labels target the decision, count of quiet steps floored at 0", () => {
    const root = parse(
      renderAmygdalaPanelBody(
        input({ interventionsToday: [iv(), iv({ id: "i2", decisionId: "d2", kind: "ask" })] }),
        { open: new Set(["today"]) },
      ),
    );
    const btns = [...root.querySelectorAll("[data-amy-act='label']")] as HTMLElement[];
    expect(btns).toHaveLength(4);
    expect(btns[0].dataset.targetId).toBe("d1");
    expect(btns[0].dataset.targetKind).toBe("decision");
    expect(btns[0].dataset.kind).toBe("useful");
    expect(btns.map((b) => b.dataset.value)).toEqual(["1", "-1", "1", "-1"]);
    expect(accEl(root, "today").textContent).toContain("212 steps proceeded without a word");
    const few = parse(
      renderAmygdalaPanelBody(
        input({ status: status({ checksToday: 0 }), interventionsToday: [iv()] }),
        { open: new Set(["today"]) },
      ),
    );
    expect(accEl(few, "today").textContent).toContain("0 steps proceeded");
  });

  it("Questions: null right shows 'no labels yet', off rows dimmed, summary counts", () => {
    const qs: QuestionRow[] = [
      { id: "a", name: "Runs or quotes", version: 3, today: 61, right: 0.97, status: "active" },
      { id: "b", name: "Two readings", version: 4, today: 9, right: null, status: "active" },
      { id: "c", name: "Old one", version: 1, today: 0, right: null, status: "off" },
    ];
    const root = parse(
      renderAmygdalaPanelBody(input({ questions: qs }), { open: new Set(["questions"]) }),
    );
    expect(accEl(root, "questions").querySelector(".amy-s")!.textContent).toBe("3 · 1 off");
    expect(root.querySelectorAll(".amy-bar")).toHaveLength(1);
    expect(root.querySelectorAll(".amy-qrow--off")).toHaveLength(1);
    expect(accEl(root, "questions").textContent).toContain("no labels yet");
    expect(accEl(root, "questions").textContent).toContain("v3");
  });

  it("Jev prompts: the section is named for what it holds and each name opens its .md (2026-09-30)", () => {
    const qs: QuestionRow[] = [
      {
        id: "claim-source",
        name: "Where the claim comes from",
        version: 1,
        today: 2,
        right: null,
        status: "active",
        file: "/repo/extensions/tinkerclaw-amygdala/questions/double-check/claim-source.md",
      },
      { id: "b", name: "No file", version: 1, today: 0, right: null, status: "active" },
      {
        id: "e",
        name: "Evil",
        version: 1,
        today: 0,
        right: null,
        status: "active",
        file: '/x/"><img src=x onerror=alert(1)>.md',
      },
    ];
    const root = parse(
      renderAmygdalaPanelBody(input({ questions: qs }), { open: new Set(["questions"]) }),
    );
    const acc = accEl(root, "questions");
    expect(acc.textContent).toContain("Jev prompts");
    expect(acc.textContent).not.toContain("Questions");
    const links = acc.querySelectorAll<HTMLElement>("code.fs-link.amy-qlink");
    expect(links).toHaveLength(2);
    expect(links[0]!.dataset.path).toBe(qs[0]!.file);
    expect(links[0]!.textContent).toBe("Where the claim comes from");
    expect(links[1]!.dataset.path).toBe(qs[2]!.file);
    expect(acc.querySelector("img")).toBeNull();
    expect(acc.textContent).toContain("No file");
  });

  it("Jev prompts: grouped under the paper's families, in the order the gateway sends them (2026-10-01)", () => {
    const row = (id: string, family?: [string, string, string]): QuestionRow => ({
      id,
      name: `Name ${id}`,
      version: 1,
      today: 0,
      right: null,
      status: "active",
      ...(family ? { family: family[0], familyTitle: family[1], familySubtitle: family[2] } : {}),
    });
    const safety: [string, string, string] = ["safety", "Safety", "no action you would regret"];
    const pers: [string, string, string] = ["personality", "Personality", "curiosity & surprise"];
    const qs = [row("a", safety), row("b", safety), row("c", pers), row("d")];
    const acc = accEl(
      parse(renderAmygdalaPanelBody(input({ questions: qs }), { open: new Set(["questions"]) })),
      "questions",
    );
    const seq = [...acc.querySelectorAll(".amy-qfam, .amy-qrow:not(.amy-qhead)")].map((e) =>
      e.classList.contains("amy-qfam") ? `[${e.textContent}]` : e.firstElementChild!.textContent,
    );
    expect(seq).toEqual([
      "[Safety · no action you would regret]",
      "Name a",
      "Name b",
      "[Personality · curiosity & surprise]",
      "Name c",
      "Name d",
    ]);
  });

  it("Jev prompts: the paper's name before the colon is bold, the question follows (2026-10-01)", () => {
    const qs: QuestionRow[] = [
      {
        id: "worth-knowing",
        name: "Curiosity: did it read <b>?",
        version: 1,
        today: 0,
        right: null,
        status: "off",
        file: "/q/w.md",
      },
      { id: "plain", name: "No colon here", version: 1, today: 0, right: null, status: "active" },
    ];
    const acc = accEl(
      parse(renderAmygdalaPanelBody(input({ questions: qs }), { open: new Set(["questions"]) })),
      "questions",
    );
    const names = acc.querySelectorAll(".amy-qname");
    expect(names[0]!.querySelector("b.amy-qlabel")!.textContent).toBe("Curiosity");
    expect(names[0]!.textContent).toBe("Curiosity: did it read <b>?");
    expect(names[0]!.querySelectorAll("b")).toHaveLength(1);
    expect(names[1]!.querySelector("b")).toBeNull();
    expect(names[1]!.textContent).toBe("No colon here");
  });

  it("Learning with 0 changes", () => {
    const root = parse(renderAmygdalaPanelBody(input(), { open: new Set(["learning"]) }));
    expect(root.querySelectorAll("[data-amy-act='undo']")).toHaveLength(0);
    expect(accEl(root, "learning").querySelector(".amy-s")!.textContent).toBe(
      "0 loosened by itself · undo",
    );
    expect(accEl(root, "learning").textContent).toContain("Waiting for younone");
    expect(accEl(root, "learning").textContent).toContain("23");
  });

  it("Learning with one change: Undo button and replay line", () => {
    const root = parse(
      renderAmygdalaPanelBody(input({ changes: [change()] }), { open: new Set(["learning"]) }),
    );
    const undo = root.querySelectorAll("[data-amy-act='undo']");
    expect(undo).toHaveLength(1);
    expect((undo[0] as HTMLElement).dataset.change).toBe("c1");
    const t = accEl(root, "learning").textContent!;
    expect(t).toContain("Danger level 2 → 3");
    expect(t).toContain("6 of 6 proceed");
    expect(t).toContain("no must-catch case lost");
    expect(accEl(root, "learning").querySelector(".amy-s")!.textContent).toBe(
      "1 loosened by itself · undo",
    );
  });

  it("Learning with several: undone struck through without button, pending counted", () => {
    const changes = [
      change({ id: "a" }),
      change({ id: "b", status: "undone" }),
      change({
        id: "t",
        kind: "tighten",
        questionName: "Recent edits",
        replaySummary: {
          cases: 4,
          relaxed: 0,
          tightened: 4,
          mustCatchLost: 0,
          controlsNewlyHeld: 0,
        },
      }),
      change({ id: "p", exceptional: true, status: "pending" }),
    ];
    const root = parse(
      renderAmygdalaPanelBody(input({ changes }), { open: new Set(["learning"]) }),
    );
    const ids = [...root.querySelectorAll("[data-amy-act='undo']")].map(
      (e) => (e as HTMLElement).dataset.change,
    );
    expect(ids).toEqual(["a", "t"]);
    expect(root.querySelectorAll(".amy-lo--undone")).toHaveLength(1);
    expect(root.querySelector(".amy-lo--undone button")).toBeNull();
    const l = accEl(root, "learning");
    expect(l.querySelector(".amy-s")!.textContent).toBe("1 waiting for you");
    expect(l.textContent).toContain("Waiting for you1");
    expect(l.textContent).toContain("Tightened by itself1");
  });

  it("escapes every name and title", () => {
    const html = renderAmygdalaPanelBody(
      input({
        status: status({ line: EVIL }),
        questions: [{ id: "q", name: EVIL, version: 1, today: 1, right: 0.5, status: "active" }],
        changes: [change({ questionName: EVIL, from: EVIL, to: EVIL })],
        interventionsToday: [iv({ title: EVIL, decisionId: EVIL })],
      }),
      { open: new Set(["today", "questions", "learning", "health"]) },
    );
    const root = parse(html);
    expect(root.querySelector("img")).toBeNull();
    expect(html).not.toContain("<img");
  });
});

describe("statusLine / renderDot", () => {
  it("statusLine(null) says Not watching", () => {
    expect(statusLine(null)).toEqual({ text: "Not watching", bad: false });
  });
  it("statusLine passes the line and flags degraded", () => {
    expect(statusLine(status())).toEqual({ text: status().line, bad: false });
    expect(statusLine(status({ state: "degraded" })).bad).toBe(true);
    expect(statusLine(status({ state: "shadow" })).bad).toBe(false);
  });
  it("renderDot for four states, title escaped", () => {
    for (const st of ["green", "amber", "red", "grey"] as const) {
      const el = parse(renderDot(st, "t")).firstElementChild!;
      expect(el.className).toBe(`amy-dot amy-dot--${st}`);
      expect(el.getAttribute("title")).toBe("t");
    }
    expect(parse(renderDot("red", EVIL)).querySelector("img")).toBeNull();
  });
});

describe("stripBars", () => {
  it("all-zero hours: bars of height 0, empty class, legend present", () => {
    const strip = Array.from({ length: 24 }, (_, hour) => ({ hour, ok: 0, noteAsk: 0, held: 0 }));
    const root = parse(stripBars(strip));
    expect(root.querySelector(".amy-strip--empty")).not.toBeNull();
    const bars = [...root.querySelectorAll(".amy-strip-bar")] as HTMLElement[];
    expect(bars).toHaveLength(24);
    expect(bars.every((b) => b.style.height === "0%")).toBe(true);
    expect(root.querySelector(".amy-legend")!.textContent).toContain("held");
  });
  it("a single busy hour scales to 100% and others to 0", () => {
    const strip = Array.from({ length: 24 }, (_, hour) => ({ hour, ok: 0, noteAsk: 0, held: 0 }));
    strip[10] = { hour: 10, ok: 6, noteAsk: 3, held: 1 };
    const root = parse(stripBars(strip));
    const bars = [...root.querySelectorAll(".amy-strip-bar")] as HTMLElement[];
    expect(bars[10].style.height).toBe("100%");
    expect(bars[3].style.height).toBe("0%");
    expect(bars[10].querySelector(".amy-strip-ok")).not.toBeNull();
    expect(bars[10].querySelector(".amy-strip-note")).not.toBeNull();
    expect(bars[10].querySelector(".amy-strip-held")).not.toBeNull();
    expect(root.querySelector(".amy-strip--empty")).toBeNull();
  });
  it("scales relative to the busiest hour", () => {
    const root = parse(
      stripBars([
        { hour: 0, ok: 10, noteAsk: 0, held: 0 },
        { hour: 1, ok: 5, noteAsk: 0, held: 0 },
      ]),
    );
    const bars = [...root.querySelectorAll(".amy-strip-bar")] as HTMLElement[];
    expect(bars[1].style.height).toBe("50%");
  });
});

describe("learningRows", () => {
  it("splits applied (incl. undone, non-exceptional) from pending", () => {
    const r = learningRows([
      change({ id: "a" }),
      change({ id: "u", status: "undone" }),
      change({ id: "p", status: "pending", exceptional: true }),
      change({ id: "r", status: "rejected" }),
      change({ id: "e", exceptional: true }),
    ]);
    expect(r.applied.map((c) => c.id)).toEqual(["a", "u"]);
    expect(r.pending.map((c) => c.id)).toEqual(["p"]);
  });
});
