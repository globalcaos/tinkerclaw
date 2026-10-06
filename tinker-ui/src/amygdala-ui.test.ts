import { describe, expect, it, vi } from "vitest";
import type { ChangeView, InterventionView, JevDecision, StatusView } from "./amygdala-types.js";
import { createAmygdalaUi, type AmygdalaUiDeps } from "./amygdala-ui.js";

const TAB = "agent:main:tinker:tabX";

const status = (over: Partial<StatusView> = {}): StatusView => ({
  ts: 1000,
  state: "working",
  line: "Working · 3 checks · 1 held · 0 asked · €0.001 today",
  mode: "enforce",
  floorActive: true,
  seams: {
    prompt: { lastTs: 900 },
    pre: { lastTs: 990 },
    post: { lastTs: 990 },
    stop: { lastTs: null },
  },
  rules: { n: 47, version: 12 },
  judge: { lastMs: 280, errors: 0 },
  spendEurToday: 0.001,
  checksToday: 3,
  heldToday: 1,
  askedToday: 0,
  waitingForYou: 0,
  notesDropped: 0,
  ...over,
});
const dec = (id: string, over: Partial<JevDecision> = {}): JevDecision => ({
  id,
  ts: 10_000,
  sessionKey: TAB,
  turnId: `${TAB}#1`,
  stepLabel: "Bash cp a b",
  seam: "pre-tool",
  questionId: "danger-level",
  questionName: "Danger level",
  version: 2,
  answer: 3,
  prob: 0.93,
  confidence: 0.88,
  cacheHit: false,
  latencyMs: 148,
  weak: false,
  codeDid: "held",
  degraded: false,
  ...over,
});
const hold = (over: Partial<InterventionView> = {}): InterventionView => ({
  id: "iv1",
  decisionId: "d1",
  ts: 10_000,
  sessionKey: TAB,
  turnId: `${TAB}#1`,
  kind: "hold",
  state: "open",
  title: "Held before it ran",
  chips: ["effect: delete"],
  cmd: "cp a b",
  ...over,
});
const pendingChange = (): ChangeView => ({
  id: "ch1",
  kind: "loosen",
  questionName: "Danger level",
  from: "≥ 2",
  to: "≥ 3",
  exceptional: true,
  status: "pending",
  replaySummary: { cases: 4, relaxed: 4, tightened: 0, mustCatchLost: 0, controlsNewlyHeld: 0 },
});

function make(
  reqImpl?: (method: string, params?: unknown) => unknown,
  extra: Partial<AmygdalaUiDeps> = {},
) {
  const calls: Array<[string, unknown]> = [];
  const spies = {
    repaintChat: vi.fn(),
    repaintPanel: vi.fn(),
    setComposerText: vi.fn(),
    notify: vi.fn(),
    openPanel: vi.fn(),
  };
  const deps: AmygdalaUiDeps = {
    async req(method: string, params?: unknown) {
      calls.push([method, params]);
      const r = reqImpl ? await reqImpl(method, params) : {};
      return r as never;
    },
    tabKey: () => TAB,
    now: () => 50_000,
    ...spies,
    ...extra,
  };
  return { ui: createAmygdalaUi(deps), calls, spies };
}
const available = async (feed: object = {}) => {
  const m = make((method) =>
    method === "amygdala2.status"
      ? status()
      : method === "amygdala2.feed"
        ? { status: status(), ...feed }
        : { ok: true },
  );
  await m.ui.onConnected();
  return m;
};
const userRow = (ts: number) => ({ role: "user", ts });
const btn = (attrs: Record<string, string>): Element => {
  const el = document.createElement("button");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

describe("inert while the gateway has no amygdala methods", () => {
  it("an unknown-method error keeps every hook empty", async () => {
    const m = make(() => {
      throw { message: "unknown method: amygdala2.status" };
    });
    await m.ui.onConnected();
    expect(m.ui.available()).toBe(false);
    expect(m.ui.afterRun(userRow(1), null)).toBe("");
    expect(m.ui.tailHtml()).toBe("");
    expect(m.ui.panelBodyHtml()).toBe("");
    expect(m.ui.dotHtml()).toBe("");
    expect(m.calls.map((c) => c[0])).toEqual(["amygdala2.status"]);
  });
  it("an {ok:false} status answer is inert too, and events before the probe do not draw anything", async () => {
    const m = make(() => ({ ok: false, error: "runtime not started" }));
    m.ui.onEvent("amygdala2.decision", dec("v1"));
    await m.ui.onConnected();
    expect(m.ui.available()).toBe(false);
    expect(m.ui.afterRun(userRow(1), null)).toBe("");
  });
});

describe("available: the chat and panel hooks", () => {
  it("probes status then the feed, and draws the window after the run its time falls in", async () => {
    const { ui, calls } = await available({ decisionEvents: [dec("v1")], interventions: [hold()] });
    expect(calls.map((c) => c[0])).toEqual(["amygdala2.status", "amygdala2.feed"]);
    const inRun = ui.afterRun(userRow(9_000), userRow(20_000));
    expect(inRun).toContain('data-amy-turn="agent:main:tinker:tabX#1"');
    expect(inRun).toContain("amy-jev");
    expect(inRun).toContain("Held before it ran"); // the hold card
    expect(ui.afterRun(userRow(20_000), userRow(30_000))).toBe(""); // another run
    expect(ui.afterRun(userRow(1_000), userRow(9_000))).toBe(""); // an earlier run
  });
  it("a prompt with no time can only claim the newest turn, in the last run", async () => {
    const { ui } = await available({ decisionEvents: [dec("v1")] });
    expect(ui.afterRun({ role: "user" }, { role: "user" })).toBe("");
    expect(ui.afterRun({ role: "user" }, null)).toContain("amy-jev");
  });
  it("a consult note draws 'not consulted' for a step with no answers, only once and only in its run", async () => {
    const { ui } = await available();
    ui.onEvent("amygdala2.consult", {
      sessionKey: TAB,
      turnId: `${TAB}#2`,
      ts: 12_000,
      state: "real-steps-stay-local",
    });
    const html = ui.afterRun(userRow(9_000), userRow(20_000));
    expect(html).toContain("not consulted");
    expect(ui.afterRun(userRow(20_000), null)).toBe("");
    ui.onEvent("amygdala2.consult", {
      sessionKey: "other-tab",
      turnId: "z#1",
      ts: 12_000,
      state: "judge-down",
    });
    expect(ui.afterRun(userRow(9_000), userRow(20_000))).not.toContain("z#1");
  });
  it("only the exceptional change is a card at the end of the chat", async () => {
    const { ui } = await available({
      changes: [
        pendingChange(),
        { ...pendingChange(), id: "ch2", exceptional: false, status: "applied" },
      ],
    });
    const tail = ui.tailHtml();
    expect(tail).toContain('data-change="ch1"');
    expect(tail).not.toContain('data-change="ch2"');
  });
  it("panel body, dot and events", async () => {
    const { ui, spies } = await available();
    expect(ui.panelBodyHtml()).toContain("amy-p-line");
    expect(ui.dotHtml()).toContain("amy-dot");
    spies.repaintChat.mockClear();
    ui.onEvent("amygdala2.decision", dec("v2"));
    ui.onEvent("not-ours", {});
    expect(spies.repaintChat).toHaveBeenCalled();
    expect(ui.store.turnsFor(TAB)[0]?.decisions.map((d) => d.id)).toEqual(["v2"]);
  });
  it("an event that arrives before the probe answers still opens the UI (the status event proves the plugin is there)", () => {
    const { ui } = make();
    ui.onEvent("amygdala2.status", status());
    expect(ui.available()).toBe(true);
  });
});

describe("clicks call the gateway with the right parameters", () => {
  it("label, answer, ask select + confirm, approve, undo, canary", async () => {
    const { ui, calls } = await available({
      interventions: [
        {
          ...hold({
            kind: "ask",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          }),
        },
      ],
    });
    calls.length = 0;
    await ui.handleClick(
      btn({
        "data-amy-act": "label",
        "data-target-id": "v1",
        "data-target-kind": "verdict",
        "data-kind": "useful",
        "data-value": "-1",
      }),
    );
    await ui.handleClick(
      btn({ "data-amy-act": "answer", "data-iv": "iv1", "data-answer": "allow-once" }),
    );
    await ui.handleClick(
      btn({ "data-amy-act": "ask-select", "data-iv": "iv1", "data-option": "b" }),
    );
    await ui.handleClick(btn({ "data-amy-act": "ask-confirm", "data-iv": "iv1" }));
    expect(calls.slice(0, 3)).toEqual([
      ["amygdala2.label", { targetId: "v1", targetKind: "verdict", kind: "useful", value: -1 }],
      ["amygdala2.answer", { interventionId: "iv1", answer: "allow-once" }],
      ["amygdala2.answer", { interventionId: "iv1", answer: "option:b" }],
    ]);
    calls.length = 0;
    await ui.handleClick(btn({ "data-amy-act": "approve", "data-change": "ch1", "data-yes": "1" }));
    await ui.handleClick(btn({ "data-amy-act": "undo", "data-change": "c9" }));
    expect(calls.filter((c) => c[0] !== "amygdala2.status" && c[0] !== "amygdala2.feed")).toEqual([
      ["amygdala2.approve", { changeId: "ch1", approve: true }],
      ["amygdala2.undo", { changeId: "c9" }],
    ]);
    calls.length = 0;
    await ui.handleClick(btn({ "data-amy-act": "canary" }));
    expect(calls[0]?.[0]).toBe("amygdala2.canary");
  });
  it("ask-confirm without a selection sends the first option", async () => {
    const { ui, calls } = await available({
      interventions: [hold({ kind: "ask", options: [{ id: "first", label: "F" }] })],
    });
    calls.length = 0;
    await ui.handleClick(btn({ "data-amy-act": "ask-confirm", "data-iv": "iv1" }));
    expect(calls[0]).toEqual([
      "amygdala2.answer",
      { interventionId: "iv1", answer: "option:first" },
    ]);
  });
  it("local toggles repaint and are remembered; unknown acts are not ours", async () => {
    const { ui, spies } = await available({ decisionEvents: [dec("v1")] });
    const checksOpen = (): boolean =>
      document
        .createRange()
        .createContextualFragment(ui.afterRun(userRow(9_000), null))
        .querySelector(".amy-jev-checks")!
        .classList.contains("amy-open");
    expect(checksOpen()).toBe(false);
    await ui.handleClick(btn({ "data-amy-act": "jev-toggle", "data-run": `${TAB}#1` }));
    expect(checksOpen()).toBe(true);
    expect(spies.repaintChat).toHaveBeenCalled();
    await ui.handleClick(btn({ "data-amy-act": "acc", "data-acc": "learning" }));
    expect(await ui.handleClick(btn({ "data-amy-act": "no-such-act" }))).toBe(false);
    expect(await ui.handleClick(btn({}))).toBe(false);
    await ui.handleClick(btn({ "data-amy-act": "dot" }));
    expect(spies.openPanel).toHaveBeenCalled();
  });
  // 2026-10-06, the architect: "Keep the Jev's insertions in the chat collapsed by default from now on."
  it("WOULD HAVE is collapsed by default and opens on a click; a card that waits for an answer forces it open", async () => {
    const { ui } = await available({
      decisionEvents: [dec("v1", { codeDid: "sent-back", decisionId: "D1" })],
    });
    const act = (): Element | null =>
      document
        .createRange()
        .createContextualFragment(ui.afterRun(userRow(9_000), null))
        .querySelector(".amy-jev-act");
    expect(act()!.classList.contains("amy-open")).toBe(false);
    await ui.handleClick(btn({ "data-amy-act": "jev-act-toggle", "data-run": `${TAB}#1` }));
    expect(act()!.classList.contains("amy-open")).toBe(true);
    await ui.handleClick(btn({ "data-amy-act": "jev-act-toggle", "data-run": `${TAB}#1` }));
    expect(act()!.classList.contains("amy-open")).toBe(false);
    ui.onEvent("amygdala2.intervention", hold({ decisionId: "D1" }));
    expect(act()!.classList.contains("amy-open")).toBe(true);
  });
  it("a click on a timeline column lists that step's checks; a second click folds them", async () => {
    const { ui } = await available({ decisionEvents: [dec("v1", { codeDid: "ok" })] });
    await ui.handleClick(btn({ "data-amy-act": "jev-toggle", "data-run": `${TAB}#1` }));
    expect(ui.afterRun(userRow(9_000), null)).not.toContain("amy-tdet");
    const col = btn({ "data-amy-act": "jev-col", "data-run": `${TAB}#1`, "data-col": "0" });
    await ui.handleClick(col);
    expect(ui.afterRun(userRow(9_000), null)).toContain('class="amy-tdet"');
    await ui.handleClick(col);
    expect(ui.afterRun(userRow(9_000), null)).not.toContain("amy-tdet");
  });
});

describe("per-tab feed", () => {
  it("drawing a tab loads that tab's own feed once (a quiet tab is not in the gateway's newest 400)", async () => {
    const m = await available();
    m.ui.afterRun(userRow(9_000), null);
    m.ui.afterRun(userRow(9_000), null);
    await Promise.resolve();
    const tabFeeds = m.calls.filter(
      (c) => c[0] === "amygdala2.feed" && (c[1] as { sessionKey?: string }).sessionKey === TAB,
    );
    expect(tabFeeds).toHaveLength(1);
    expect(tabFeeds[0]![1]).toEqual({
      sessionKey: TAB,
      limit: 400,
      sinceTs: 50_000 - 36 * 3_600_000,
    });
  });
});

describe("feed window", () => {
  it("loads the last 36 hours, not since midnight: last night's strips survive a morning reload (2026-09-30)", async () => {
    const m = await available();
    expect(m.calls.find((c) => c[0] === "amygdala2.feed")?.[1]).toEqual({
      limit: 400,
      sinceTs: 50_000 - 36 * 3_600_000,
    });
  });
});

describe("rewind and retry with another model (Thalamus full deploy)", () => {
  const refusal = (): InterventionView =>
    hold({ id: "iv-r", kind: "refusal", title: "This looks like a refusal", cmd: undefined });
  const pick = {
    model: "xai/grok-4.7",
    effort: "high",
    family: "xai",
    reason: "best at code on another vendor",
  };
  const setup = async (
    over: (method: string, params?: unknown) => unknown | undefined = () => undefined,
    pinned?: string,
  ) => {
    const sendOneTurn = vi.fn(async () => {});
    const m = make(
      (method, params) => {
        const o = over(method, params);
        if (o !== undefined) return o;
        return method === "amygdala2.rewind"
          ? { ok: true, restoredPrompt: "the refused request" }
          : method === "amygdala2.status"
            ? status()
            : {
                status: status(),
                interventions: [refusal()],
                decisionEvents: [dec("v1", { codeDid: "refusal" })],
              };
      },
      {
        modelLabel: (id) => (id === "xai/grok-4.7" ? "Grok 4.7" : id),
        modelChip: () => '<svg class="eeg-model-chip"></svg>',
        pinnedModel: () => pinned,
        sendOneTurn,
      },
    );
    await m.ui.onConnected();
    return { ...m, sendOneTurn };
  };
  const strip = (m: { ui: { afterRun(a: unknown, b: unknown): string } }) =>
    document.createRange().createContextualFragment(m.ui.afterRun(userRow(9_000), null));
  const retryAttr = (m: Parameters<typeof strip>[0]) =>
    strip(m).querySelector('[data-amy-act="rewind-retry"]');

  it("the event's pick draws the second button with the model's name and its picker chip", async () => {
    const m = await setup((method) =>
      method === "thalamus.retryPick" ? { ok: true, pick } : undefined,
    );
    m.ui.onEvent("thalamus.refusal", { sessionKey: TAB, turnId: `${TAB}#1`, retry: pick });
    const b = retryAttr(m)!;
    expect(b.textContent).toContain("Rewind and retry with");
    expect(b.textContent).toContain("Grok 4.7");
    expect(b.querySelector("svg.eeg-model-chip")).not.toBeNull();
    expect(b.getAttribute("title")).toBe(pick.reason);
    expect(strip(m).querySelector('[data-amy-act="rewind"]')).not.toBeNull();
    expect(m.calls.some((c) => c[0] === "thalamus.retryPick")).toBe(false);
  });

  it("clicking it rewinds, then sends the restored prompt once on the picked model; nothing lands in the composer", async () => {
    const m = await setup();
    m.ui.onEvent("thalamus.refusal", { sessionKey: TAB, turnId: `${TAB}#1`, retry: pick });
    await m.ui.handleClick(btn({ "data-amy-act": "rewind-retry", "data-turn": `${TAB}#1` }));
    expect(m.calls.find((c) => c[0] === "amygdala2.rewind")?.[1]).toEqual({
      sessionKey: TAB,
      turnId: `${TAB}#1`,
    });
    expect(m.sendOneTurn).toHaveBeenCalledTimes(1);
    expect(m.sendOneTurn).toHaveBeenCalledWith("the refused request", "xai/grok-4.7");
    expect(m.spies.setComposerText).not.toHaveBeenCalled();
    expect(m.ui.afterRun(userRow(9_000), null)).toContain("Rewound");
  });

  it("a tab on the built-in runner takes the gateway's own rewind, then the same one-turn send", async () => {
    const m = await setup((method) =>
      method === "amygdala2.rewind"
        ? { ok: false, capability: "unsupported" }
        : method === "sessions.rewind"
          ? { ok: true, restoredPrompt: "are you stuck?" }
          : undefined,
    );
    m.ui.onEvent("thalamus.refusal", { sessionKey: TAB, turnId: `${TAB}#1`, retry: pick });
    await m.ui.handleClick(btn({ "data-amy-act": "rewind-retry", "data-turn": `${TAB}#1` }));
    expect(m.calls.find((c) => c[0] === "sessions.rewind")?.[1]).toEqual({ key: TAB });
    expect(m.sendOneTurn).toHaveBeenCalledWith("are you stuck?", "xai/grok-4.7");
  });

  it("no pick (retry: null) leaves Rewind alone, with no second button", async () => {
    const m = await setup();
    m.ui.onEvent("thalamus.refusal", { sessionKey: TAB, turnId: `${TAB}#1`, retry: null });
    expect(retryAttr(m)).toBeNull();
    expect(strip(m).querySelector('[data-amy-act="rewind"]')).not.toBeNull();
  });

  it("a failed rewind sends nothing", async () => {
    const m = await setup((method) =>
      method === "amygdala2.rewind" ? { ok: false, reason: "a reply is running" } : undefined,
    );
    m.ui.onEvent("thalamus.refusal", { sessionKey: TAB, turnId: `${TAB}#1`, retry: pick });
    await m.ui.handleClick(btn({ "data-amy-act": "rewind-retry", "data-turn": `${TAB}#1` }));
    expect(m.sendOneTurn).not.toHaveBeenCalled();
    expect(m.spies.notify).toHaveBeenCalled();
  });

  it("a send that fails puts the prompt back in the composer", async () => {
    const m = await setup();
    m.sendOneTurn.mockRejectedValueOnce(new Error("socket closed"));
    m.ui.onEvent("thalamus.refusal", { sessionKey: TAB, turnId: `${TAB}#1`, retry: pick });
    await m.ui.handleClick(btn({ "data-amy-act": "rewind-retry", "data-turn": `${TAB}#1` }));
    expect(m.spies.setComposerText).toHaveBeenCalledWith("the refused request");
  });

  it("with no event yet it asks thalamus.retryPick once, naming the hand-picked model, and then draws the button", async () => {
    const m = await setup(
      (method) => (method === "thalamus.retryPick" ? { ok: true, pick } : undefined),
      "claude-code/claude-opus-5-5",
    );
    expect(retryAttr(m)).toBeNull(); // first paint: the question is in flight
    await vi.waitFor(() => expect(retryAttr(m)).not.toBeNull());
    expect(m.calls.filter((c) => c[0] === "thalamus.retryPick")).toEqual([
      ["thalamus.retryPick", { sessionKey: TAB, model: "claude-code/claude-opus-5-5" }],
    ]);
    strip(m);
    expect(m.calls.filter((c) => c[0] === "thalamus.retryPick")).toHaveLength(1);
  });

  it("an older gateway (unknown method) or a null pick: Rewind alone, asked once", async () => {
    const m = await setup((method) => {
      if (method === "thalamus.retryPick") throw { message: "unknown method: thalamus.retryPick" };
      return undefined;
    });
    strip(m);
    await vi.waitFor(() => expect(m.spies.repaintChat).toHaveBeenCalled());
    expect(retryAttr(m)).toBeNull();
    strip(m);
    expect(m.calls.filter((c) => c[0] === "thalamus.retryPick")).toHaveLength(1);
  });

  it("another tab's refusal event is ignored", async () => {
    const m = await setup((method) =>
      method === "thalamus.retryPick" ? { ok: true, pick: null } : undefined,
    );
    m.ui.onEvent("thalamus.refusal", {
      sessionKey: "agent:main:tinker:other",
      turnId: `${TAB}#1`,
      retry: pick,
    });
    expect(retryAttr(m)).toBeNull();
  });
});

describe("rewind", () => {
  const refusal = (): InterventionView =>
    hold({ id: "iv-r", kind: "refusal", title: "This looks like a refusal", cmd: undefined });
  it("success: marks the turn, refills the composer, hides the strip and shows the marker", async () => {
    const m = make((method) =>
      method === "amygdala2.rewind"
        ? { ok: true, restoredPrompt: "the refused request", forkSessionId: "f1" }
        : method === "amygdala2.status"
          ? status()
          : {
              status: status(),
              interventions: [refusal()],
              decisionEvents: [dec("v1", { codeDid: "refusal" })],
            },
    );
    await m.ui.onConnected();
    expect(m.ui.afterRun(userRow(9_000), null)).toContain("This looks like a refusal");
    await m.ui.handleClick(btn({ "data-amy-act": "rewind", "data-turn": `${TAB}#1` }));
    expect(m.calls.find((c) => c[0] === "amygdala2.rewind")?.[1]).toEqual({
      sessionKey: TAB,
      turnId: `${TAB}#1`,
    });
    expect(m.spies.setComposerText).toHaveBeenCalledWith("the refused request");
    const html = m.ui.afterRun(userRow(9_000), null);
    expect(html).not.toContain("This looks like a refusal");
    expect(html).toContain("Rewound");
    await m.ui.handleClick(btn({ "data-amy-act": "rewind-undo", "data-turn": `${TAB}#1` }));
    expect(m.calls.filter((c) => c[0] === "amygdala2.rewind")[1]?.[1]).toEqual({
      sessionKey: TAB,
      turnId: `${TAB}#1`,
      undo: true,
    });
    expect(m.ui.afterRun(userRow(9_000), null)).not.toContain("Rewound");
  });
  it("unsupported: says so, changes nothing", async () => {
    const m = make((method) =>
      method === "amygdala2.rewind"
        ? { ok: false, capability: "unsupported", reason: "no session map is wired" }
        : method === "amygdala2.status"
          ? status()
          : {
              status: status(),
              interventions: [refusal()],
              decisionEvents: [dec("v1", { codeDid: "refusal" })],
            },
    );
    await m.ui.onConnected();
    await m.ui.handleClick(btn({ "data-amy-act": "rewind", "data-turn": `${TAB}#1` }));
    expect(m.spies.setComposerText).not.toHaveBeenCalled();
    expect(m.spies.notify).toHaveBeenCalled();
    expect(m.ui.afterRun(userRow(9_000), null)).toContain("This looks like a refusal");
  });
  it("a tab on the built-in runner (Grok): amygdala says unsupported, the gateway rewinds the session", async () => {
    const m = make((method) =>
      method === "amygdala2.rewind"
        ? { ok: false, capability: "unsupported", reason: "this runner cannot rewind" }
        : method === "sessions.rewind"
          ? { ok: true, capability: "session-branch", restoredPrompt: "are you stuck?" }
          : method === "amygdala2.status"
            ? status()
            : {
                status: status(),
                interventions: [refusal()],
                decisionEvents: [dec("v1", { codeDid: "refusal" })],
              },
    );
    await m.ui.onConnected();
    await m.ui.handleClick(btn({ "data-amy-act": "rewind", "data-turn": `${TAB}#1` }));
    expect(m.calls.find((c) => c[0] === "sessions.rewind")?.[1]).toEqual({ key: TAB });
    expect(m.spies.setComposerText).toHaveBeenCalledWith("are you stuck?");
    expect(m.ui.afterRun(userRow(9_000), null)).toContain("Rewound");
    await m.ui.handleClick(btn({ "data-amy-act": "rewind-undo", "data-turn": `${TAB}#1` }));
    expect(m.calls.filter((c) => c[0] === "sessions.rewind")[1]?.[1]).toEqual({
      key: TAB,
      undo: true,
    });
  });
  it("two refusals in a row: only the newest offers Rewind; once it is rewound, the older one does", async () => {
    const older = hold({
      id: "iv-a",
      kind: "refusal",
      turnId: `${TAB}#1`,
      ts: 10_000,
      cmd: undefined,
    });
    const newer = hold({
      id: "iv-b",
      kind: "refusal",
      turnId: `${TAB}#2`,
      ts: 20_000,
      cmd: undefined,
    });
    const m = make((method) =>
      method === "amygdala2.rewind"
        ? { ok: true, restoredPrompt: "are you stuck?" }
        : method === "amygdala2.status"
          ? status()
          : {
              status: status(),
              interventions: [older, newer],
              decisionEvents: [
                dec("v1", { codeDid: "refusal", turnId: `${TAB}#1`, ts: 10_000 }),
                dec("v2", { codeDid: "refusal", turnId: `${TAB}#2`, ts: 20_000 }),
              ],
            },
    );
    await m.ui.onConnected();
    const active = () =>
      [
        ...document
          .createRange()
          .createContextualFragment(m.ui.afterRun(userRow(9_000), null))
          .querySelectorAll('[data-amy-act="rewind"]'),
      ].map((b) => b.getAttribute("data-turn"));
    expect(active()).toEqual([`${TAB}#2`]);
    await m.ui.handleClick(btn({ "data-amy-act": "rewind", "data-turn": `${TAB}#2` }));
    expect(active()).toEqual([`${TAB}#1`]);
  });
  it("Keep removes the strip without calling the gateway", async () => {
    const m = make((method) =>
      method === "amygdala2.status"
        ? status()
        : {
            status: status(),
            interventions: [refusal()],
            decisionEvents: [dec("v1", { codeDid: "refusal" })],
          },
    );
    await m.ui.onConnected();
    m.calls.length = 0;
    await m.ui.handleClick(btn({ "data-amy-act": "refusal-keep", "data-turn": `${TAB}#1` }));
    expect(m.calls).toEqual([]);
    expect(m.ui.afterRun(userRow(9_000), null)).not.toContain("This looks like a refusal");
  });
});

// the architect 2026-10-05: "two kinds of messages". Nothing else of Jev's is drawn per reply: no chip on a tool row, no
// sent-back chip, no settled one-liners.
describe("two windows per reply", () => {
  it("one CHECKS and one WOULD HAVE window for a reply with several turns, and nothing else", async () => {
    const { ui } = await available({
      decisionEvents: [
        dec("n1", { codeDid: "note", decisionId: "D1", toolUseId: "toolu_9" }),
        dec("o1", { codeDid: "ok", turnId: `${TAB}#2`, ts: 11_000 }),
        dec("s1", { codeDid: "sent-back", decisionId: "D2", turnId: `${TAB}#2`, ts: 12_000 }),
      ],
      interventions: [
        hold({ id: "ivn", decisionId: "D1", kind: "note", state: "settled" }),
        hold({
          id: "ivs",
          decisionId: "D2",
          kind: "send-back",
          state: "settled",
          turnId: `${TAB}#2`,
        }),
      ],
    });
    const frag = document
      .createRange()
      .createContextualFragment(ui.afterRun(userRow(9_000), userRow(20_000)));
    expect(frag.querySelectorAll(".amy-turn")).toHaveLength(1);
    expect(frag.querySelectorAll(".amy-jev")).toHaveLength(2);
    expect(frag.querySelector(".amy-jev-checks .amy-jsm")!.textContent).toContain("3 checks");
    expect(frag.querySelectorAll(".amy-jev-act .amy-jact")).toHaveLength(2);
    expect(frag.querySelector(".amy-sentback, .amy-note-chip, .amy-settled, .amy-card")).toBeNull();
  });
});
