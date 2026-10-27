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
  // Fixtures are decisions that acted unless a test says otherwise (2026-10-15: shadow records draw nothing).
  enforced: true,
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
const frag = (html: string): DocumentFragment =>
  document.createRange().createContextualFragment(html);
/** An `amygdala.hook` payload as the gateway broadcasts it (CONTRACT.md, unit gateway). */
const hookRow = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  ts: 10_500,
  tool: "Bash",
  target: "rm -rf build",
  decision: "deny",
  rule: "DELETE_UNREQUESTED",
  toolUseId: "toolu_h1",
  sessionId: "cc-session-1",
  enforced: true,
  ...over,
});

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
  it("probes status then the feed, and draws the end-of-run bubbles after the run their time falls in", async () => {
    const { ui, calls } = await available({ decisionEvents: [dec("v1")], interventions: [hold()] });
    expect(calls.map((c) => c[0])).toEqual(["amygdala2.status", "amygdala2.feed"]);
    const inRun = ui.afterRun(userRow(9_000), userRow(20_000));
    expect(inRun).toContain('data-amy-turn="agent:main:tinker:tabX#1"');
    expect(inRun).toContain("amy-inline"); // a pink bubble, not a window
    expect(inRun).not.toContain("amy-jev");
    expect(inRun).toContain("Held before it ran"); // the hold card rides on its action
    expect(ui.afterRun(userRow(20_000), userRow(30_000))).toBe(""); // another run
    expect(ui.afterRun(userRow(1_000), userRow(9_000))).toBe(""); // an earlier run
  });
  it("a prompt with no time can only claim the newest turn, in the last run", async () => {
    const { ui } = await available({ decisionEvents: [dec("v1")] });
    expect(ui.afterRun({ role: "user" }, { role: "user" })).toBe("");
    expect(ui.afterRun({ role: "user" }, null)).toContain("amy-inline");
  });
  // 2026-10-15: the CHECKS window is gone, and with it the "not consulted" line; the note is accepted and draws nothing.
  it("a consult note draws nothing now", async () => {
    const { ui } = await available();
    ui.onEvent("amygdala2.consult", {
      sessionKey: TAB,
      turnId: `${TAB}#2`,
      ts: 12_000,
      state: "real-steps-stay-local",
    });
    expect(ui.afterRun(userRow(9_000), userRow(20_000))).toBe("");
    expect(ui.store.turnsFor(TAB)).toHaveLength(0);
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
    // The window toggles still answer (handleClick unchanged, 2026-10-15) even though no window is drawn.
    for (const act of ["jev-toggle", "jev-act-toggle"]) {
      spies.repaintChat.mockClear();
      expect(await ui.handleClick(btn({ "data-amy-act": act, "data-run": `${TAB}#1` }))).toBe(true);
      expect(spies.repaintChat).toHaveBeenCalled();
    }
    expect(
      await ui.handleClick(
        btn({ "data-amy-act": "jev-col", "data-run": `${TAB}#1`, "data-col": "0" }),
      ),
    ).toBe(true);
    await ui.handleClick(btn({ "data-amy-act": "acc", "data-acc": "learning" }));
    expect(await ui.handleClick(btn({ "data-amy-act": "no-such-act" }))).toBe(false);
    expect(await ui.handleClick(btn({}))).toBe(false);
    await ui.handleClick(btn({ "data-amy-act": "dot" }));
    expect(spies.openPanel).toHaveBeenCalled();
  });
  // 2026-10-15, the architect: "I don't need to see the jev boxes at the end of the turn anymore."
  it("an action with no tool call is a pink bubble at the end of its run; a card that waits for an answer rides on it", async () => {
    const { ui } = await available({
      decisionEvents: [dec("v1", { codeDid: "sent-back", decisionId: "D1" })],
    });
    const bubble = (): Element | null =>
      frag(ui.afterRun(userRow(9_000), null)).querySelector('[data-amy-bubble="jev:D1"]');
    expect(bubble()).not.toBeNull();
    expect(bubble()!.classList.contains("amy-inline")).toBe(true);
    expect(bubble()!.getAttribute("data-tool-use")).toBe("");
    expect(bubble()!.querySelector(".amy-jact")).not.toBeNull();
    expect(bubble()!.textContent).toContain("Sent the reply back to be finished"); // mode enforce: acted, not would
    expect(ui.afterRun(userRow(9_000), null)).not.toContain("amy-jev");
    ui.onEvent("amygdala2.intervention", hold({ decisionId: "D1" }));
    expect(bubble()!.textContent).toContain("Held before it ran");
  });
});

// 2026-10-15, the architect: "all performed actions from Jev (not the ones he skips) right where he does it, within its context."
describe("inline bubbles per tool call", () => {
  it("a Jev action that names a tool call is drawn by inlineFor, not after the run", async () => {
    const { ui } = await available({
      decisionEvents: [
        dec("n1", { codeDid: "note", decisionId: "D1", toolUseId: "toolu_9", enforced: true }),
        dec("o1", { codeDid: "ok", turnId: `${TAB}#2`, ts: 11_000, toolUseId: "toolu_ok" }),
        dec("s1", {
          codeDid: "sent-back",
          decisionId: "D2",
          turnId: `${TAB}#2`,
          ts: 12_000,
          enforced: true,
        }),
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
    const after = frag(ui.afterRun(userRow(9_000), userRow(20_000)));
    expect(after.querySelectorAll(".amy-turn")).toHaveLength(1);
    expect(after.querySelectorAll(".amy-jev")).toHaveLength(0);
    expect(after.querySelectorAll("[data-amy-bubble]")).toHaveLength(1);
    expect(after.querySelector('[data-amy-bubble="jev:D2"]')).not.toBeNull();
    expect(after.querySelector('[data-amy-bubble="jev:D1"]')).toBeNull();
    const inline = frag(ui.inlineFor("toolu_9"));
    const b = inline.querySelector('[data-amy-bubble="jev:D1"]')!;
    expect(b.getAttribute("data-tool-use")).toBe("toolu_9");
    expect(b.querySelector(".amy-jact")).not.toBeNull();
    expect(b.querySelector('[data-amy-act="label"]')).not.toBeNull(); // the vote stays
    expect(ui.inlineFor("toolu_ok")).toBe(""); // a check that passed is skipped
    expect(ui.inlineFor("toolu_nope")).toBe("");
    expect(ui.inlineFor("")).toBe("");
  });
  // 2026-10-15, the architect: "I don't want to see so many pink stuff." A shadow record ("would have") draws nothing.
  it("a shadow decision draws no bubble and no timeline mark", async () => {
    const { ui } = await available({
      decisionEvents: [
        dec("n1", { codeDid: "note", decisionId: "D1", toolUseId: "toolu_9", enforced: false }),
        dec("s1", {
          codeDid: "sent-back",
          decisionId: "D2",
          turnId: `${TAB}#2`,
          ts: 12_000,
          enforced: false,
        }),
      ],
    });
    expect(ui.inlineFor("toolu_9")).toBe("");
    expect(
      frag(ui.afterRun(userRow(9_000), userRow(20_000))).querySelectorAll("[data-amy-bubble]"),
    ).toHaveLength(0);
    expect(ui.marks()).toEqual([]);
  });
  it("a hook action needs no amygdala2: it is a bubble even while the plugin is off, and 'allow' is skipped", async () => {
    const m = make(() => {
      throw { message: "unknown method: amygdala2.status" };
    });
    await m.ui.onConnected();
    expect(m.ui.available()).toBe(false);
    m.spies.repaintChat.mockClear();
    m.ui.onHookAction(hookRow("hook-1"));
    m.ui.onHookAction(hookRow("hook-2", { decision: "allow", toolUseId: "toolu_h2" }));
    m.ui.onHookAction(hookRow("hook-1")); // the feed seed repeats the live event
    expect(m.spies.repaintChat).toHaveBeenCalledTimes(1);
    const b = frag(m.ui.inlineFor("toolu_h1")).querySelectorAll("[data-amy-bubble]");
    expect(b).toHaveLength(1);
    expect(b[0]!.getAttribute("data-amy-bubble")).toBe("hook-1");
    expect(b[0]!.getAttribute("data-tool-use")).toBe("toolu_h1");
    expect(b[0]!.textContent).toContain("AMYGDALA");
    expect(m.ui.inlineFor("toolu_h2")).toBe("");
    expect(m.ui.marks()).toEqual([{ id: "hook-1", ts: 10_500, toolUseId: "toolu_h1" }]);
  });
  it("keeps the newest 500 hook actions by time: a live row that came before the seed survives it", async () => {
    const { ui } = await available();
    ui.onHookAction(hookRow("hook-live", { ts: 99_000, toolUseId: "toolu_live" }));
    for (let i = 0; i < 500; i++)
      ui.onHookAction(hookRow(`hook-${i}`, { ts: 1_000 + i, toolUseId: `toolu_${i}` }));
    const marks = ui.marks();
    expect(marks).toHaveLength(500);
    expect(marks.at(-1)).toEqual({ id: "hook-live", ts: 99_000, toolUseId: "toolu_live" });
    expect(marks[0]!.id).toBe("hook-1"); // hook-0, the oldest, went
    expect(ui.inlineFor("toolu_0")).toBe("");
    expect(ui.inlineFor("toolu_live")).toContain('data-amy-bubble="hook-live"');
  });
  it("marks lists hook and Jev bubbles in time order; focus marks one bubble until cleared", async () => {
    const { ui, spies } = await available({
      decisionEvents: [
        dec("n1", { codeDid: "note", decisionId: "D1", toolUseId: "toolu_9", enforced: true }),
      ],
    });
    ui.onHookAction(hookRow("hook-1", { ts: 9_500 }));
    ui.onHookAction(hookRow("hook-3", { ts: 10_500, toolUseId: "toolu_9" }));
    expect(ui.marks()).toEqual([
      { id: "hook-1", ts: 9_500, toolUseId: "toolu_h1" },
      { id: "jev:D1", ts: 10_000, toolUseId: "toolu_9" },
      { id: "hook-3", ts: 10_500, toolUseId: "toolu_9" },
    ]);
    // Hook first, then Jev, for the same tool call.
    const ids = [...frag(ui.inlineFor("toolu_9")).querySelectorAll("[data-amy-bubble]")].map((e) =>
      e.getAttribute("data-amy-bubble"),
    );
    expect(ids).toEqual(["hook-3", "jev:D1"]);
    expect(ui.focused()).toBeNull();
    spies.repaintChat.mockClear();
    ui.setFocus("jev:D1");
    expect(ui.focused()).toBe("jev:D1");
    expect(spies.repaintChat).toHaveBeenCalledTimes(1);
    const focusedNow = frag(ui.inlineFor("toolu_9"));
    expect(
      focusedNow.querySelector('[data-amy-bubble="jev:D1"]')!.classList.contains("amy-focus"),
    ).toBe(true);
    expect(
      focusedNow.querySelector('[data-amy-bubble="hook-3"]')!.classList.contains("amy-focus"),
    ).toBe(false);
    ui.setFocus("jev:D1"); // same id: no repaint
    expect(spies.repaintChat).toHaveBeenCalledTimes(1);
    ui.setFocus(null);
    expect(ui.focused()).toBeNull();
    expect(ui.inlineFor("toolu_9")).not.toContain("amy-focus");
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

  it("a provider safeguard offers Rewind and asks Thalamus for the retry model; nothing is sent unclicked", async () => {
    const m = await setup((method) =>
      method === "thalamus.retryPick" ? { ok: true, pick } : undefined,
    );
    const sg = (): DocumentFragment =>
      document.createRange().createContextualFragment(m.ui.afterRun(userRow(9_000), null, true));
    expect(sg().querySelector('[data-amy-act="rewind"]')).not.toBeNull();
    await vi.waitFor(() =>
      expect(sg().querySelector('[data-amy-act="rewind-retry"]')?.textContent).toContain(
        "Grok 4.7",
      ),
    );
    expect(m.calls.some(([method]) => method === "thalamus.retryPick")).toBe(true);
    expect(m.sendOneTurn).not.toHaveBeenCalled();
    expect(m.spies.setComposerText).not.toHaveBeenCalled();
  });

  it("a settled shadow refusal on a safeguard block still offers Rewind, which puts the prompt back in the composer", async () => {
    const m = await available({
      status: status({ mode: "shadow" }),
      interventions: [hold({ kind: "refusal", state: "settled", cmd: undefined })],
      decisionEvents: [dec("v1", { codeDid: "refusal", enforced: false })],
    });
    expect(m.ui.afterRun(userRow(9_000), null)).toBe("");
    const html = m.ui.afterRun(userRow(9_000), null, true);
    expect(html).toContain('data-amy-act="rewind"');
  });

  // 2026-10-22 14:55, the owner: "When Jev detects a refusal to respond, the ui should present a rewind button along its
  // detection". Amygdala runs in shadow, so an ordinary refusal is settled and unenforced, and the 10-15 rule hid it.
  const shadowRefusal = () => ({
    interventions: [hold({ kind: "refusal", state: "settled", cmd: undefined })],
    decisionEvents: [dec("v1", { codeDid: "refusal", enforced: false })],
  });

  it("any refusal Jev detects in shadow offers Rewind once the gateway's Rewind drops the exchange (rewind ≥ 2)", async () => {
    const m = await available({
      status: status({ mode: "shadow", rewind: 2 }),
      ...shadowRefusal(),
    });
    const html = m.ui.afterRun(userRow(9_000), null);
    expect(html).toContain('data-amy-act="rewind"');
    expect(html).toContain('data-amy-act="refusal-keep"');
    // A detection, not a withheld action: no "would have" in front of it.
    expect(html).toContain("Marked the reply as a refusal");
    expect(html).not.toContain("Would have");
  });

  it("an older gateway (no rewind level) draws nothing for an ordinary shadow refusal", async () => {
    const m = await available({ status: status({ mode: "shadow" }), ...shadowRefusal() });
    expect(m.ui.afterRun(userRow(9_000), null)).toBe("");
  });

  it("a turn Jev marked three times, with no decision rows (the live feed's shape, 2026-10-21), shows one strip", async () => {
    const iv = (id: string, ts: number) =>
      hold({ id, ts, kind: "refusal", state: "settled", cmd: undefined });
    const m = await available({
      status: status({ mode: "shadow", rewind: 2 }),
      interventions: [iv("r1", 10_000), iv("r2", 10_500), iv("r3", 11_000)],
    });
    const html = m.ui.afterRun(userRow(9_000), null);
    expect(frag(html).querySelectorAll('[data-amy-act="rewind"]')).toHaveLength(1);
  });

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

describe("Rewind next to a refusal takes the exchange off the page and keeps the owner's draft (2026-10-22)", () => {
  const refusal = (): InterventionView =>
    hold({ id: "iv-r", kind: "refusal", title: "This looks like a refusal", cmd: undefined });
  const NEWEST = { key: "K", prompt: "the refused request", at: 9_000 };
  const setup = async (
    extra: Partial<AmygdalaUiDeps> = {},
    rewind: (method: string, params?: unknown) => unknown = () => ({
      ok: true,
      restoredPrompt: "the refused request",
    }),
  ) => {
    const hideExchange = vi.fn();
    const showExchange = vi.fn();
    const sendOneTurn = vi.fn(async () => {});
    const m = make(
      (method, params) =>
        method === "amygdala2.rewind"
          ? rewind(method, params)
          : method === "amygdala2.status"
            ? status()
            : {
                status: status(),
                interventions: [refusal()],
                decisionEvents: [dec("v1", { codeDid: "refusal" })],
              },
      { newestExchange: () => NEWEST, hideExchange, showExchange, sendOneTurn, ...extra },
    );
    await m.ui.onConnected();
    const click = (attrs: Record<string, string> = {}) =>
      m.ui.handleClick(
        btn({ "data-amy-act": "rewind", "data-turn": `${TAB}#1`, "data-exchange": "K", ...attrs }),
      );
    const rewinds = () => m.calls.filter((c) => c[0] === "amygdala2.rewind");
    return { ...m, hideExchange, showExchange, sendOneTurn, click, rewinds };
  };

  // 2026-10-22, the architect: "Rewind should get attached to the turn, so I can remove from history more than one turn".
  it("level 3: an older refused turn offers Rewind for it and the exchange after it, and sends its prompt", async () => {
    const at = { key: "K", prompt: "the refused request", at: 9_000, later: 1 };
    const m = make(
      (method) =>
        method === "amygdala2.rewind"
          ? { ok: true, restoredPrompt: "the refused request", forkSessionId: "f1" }
          : method === "amygdala2.status"
            ? status({ mode: "shadow", rewind: 3 })
            : {
                status: status({ mode: "shadow", rewind: 3 }),
                interventions: [refusal()],
                decisionEvents: [dec("v1", { codeDid: "refusal", enforced: false })],
              },
      {
        exchangeKeyOf: () => "K",
        newestExchange: () => ({ key: "LATER", prompt: "no rewind button shows", at: 12_000 }),
        exchangeAt: (k) => (k === "K" ? at : null),
        hideExchange: vi.fn(),
      },
    );
    await m.ui.onConnected();
    const b = frag(m.ui.afterRun(userRow(9_000), null)).querySelector('[data-amy-act="rewind"]');
    expect(b?.textContent).toBe("⟲ Rewind 2 exchanges");
    expect(b?.hasAttribute("disabled")).toBe(false);
    await m.ui.handleClick(
      btn({ "data-amy-act": "rewind", "data-turn": `${TAB}#1`, "data-exchange": "K" }),
    );
    expect(m.calls.find((c) => c[0] === "amygdala2.rewind")?.[1]).toMatchObject({
      turnId: `${TAB}#1`,
      fromPrompt: "the refused request",
    });
    expect(m.spies.setComposerText).toHaveBeenCalledWith("the refused request");
  });

  it("level 3 with a reply still running: Rewind is greyed out, and nothing is sent", async () => {
    const m = make(
      (method) =>
        method === "amygdala2.status"
          ? status({ mode: "shadow", rewind: 3 })
          : {
              status: status({ mode: "shadow", rewind: 3 }),
              interventions: [refusal()],
              decisionEvents: [dec("v1", { codeDid: "refusal", enforced: false })],
            },
      { exchangeKeyOf: () => "K", exchangeAt: () => null },
    );
    await m.ui.onConnected();
    const strip = frag(m.ui.afterRun(userRow(9_000), null));
    expect(strip.querySelector('[data-amy-act="rewind"]')).toBeNull();
    const b = strip.querySelector(".amy-refstrip button[disabled]");
    expect(b?.textContent).toBe("⟲ Rewind");
    expect(b?.getAttribute("title")).toBe("Wait for the reply to finish");
  });

  it("the strip names its exchange, so a click can tell it went stale", async () => {
    const m = await setup({ exchangeKeyOf: () => "K" });
    const html = m.ui.afterRun(userRow(9_000), null);
    expect(frag(html).querySelector('[data-amy-act="rewind"]')?.getAttribute("data-exchange")).toBe(
      "K",
    );
  });

  it("success: the gateway rewinds, the exchange leaves the page, the prompt lands in the box, and nothing is sent", async () => {
    const m = await setup();
    await m.click();
    expect(m.rewinds()).toHaveLength(1);
    expect(m.hideExchange).toHaveBeenCalledWith({
      sessionKey: TAB,
      key: "K",
      prompt: "the refused request",
      at: 9_000,
      rewoundAt: 50_000,
      restored: "the refused request",
    });
    expect(m.spies.setComposerText).toHaveBeenCalledWith("the refused request");
    expect(m.sendOneTurn).not.toHaveBeenCalled();
  });

  it("a strip gone stale (another exchange is the newest now) rewinds nothing", async () => {
    const m = await setup({
      newestExchange: () => ({ key: "NEWER", prompt: "newer", at: 20_000 }),
    });
    await m.click();
    expect(m.rewinds()).toHaveLength(0);
    expect(m.hideExchange).not.toHaveBeenCalled();
    expect(m.spies.setComposerText).not.toHaveBeenCalled();
    expect(m.spies.notify).toHaveBeenCalled();
  });

  it("a reply still running (no newest exchange) rewinds nothing", async () => {
    const m = await setup({ newestExchange: () => null });
    await m.click();
    expect(m.rewinds()).toHaveLength(0);
    expect(m.spies.setComposerText).not.toHaveBeenCalled();
  });

  it("an unsent draft is asked about BEFORE anything is rewound: no keeps it, yes replaces it", async () => {
    const no = await setup({
      composerDraft: () => "half a thought",
      confirmReplaceDraft: () => false,
    });
    await no.click();
    expect(no.rewinds()).toHaveLength(0);
    expect(no.hideExchange).not.toHaveBeenCalled();
    expect(no.spies.setComposerText).not.toHaveBeenCalled();
    const yes = await setup({
      composerDraft: () => "half a thought",
      confirmReplaceDraft: () => true,
    });
    await yes.click();
    expect(yes.rewinds()).toHaveLength(1);
    expect(yes.spies.setComposerText).toHaveBeenCalledWith("the refused request");
  });

  it("an empty or blank box is not a draft: nothing is asked", async () => {
    const confirmReplaceDraft = vi.fn(() => false);
    const m = await setup({ composerDraft: () => "  \n ", confirmReplaceDraft });
    await m.click();
    expect(confirmReplaceDraft).not.toHaveBeenCalled();
    expect(m.spies.setComposerText).toHaveBeenCalled();
  });

  it("an older gateway's raw transcript prompt never reaches the box: the page's own words do; a gateway at rewind 2 is trusted", async () => {
    const blob = `<turn_context>${"x".repeat(500)}</turn_context>\n\n[Thu 2026-10-22 15:01 GMT+2] the refused request\n\n<!-- TINKERCLAW chat-row contract -->`;
    const older = await setup({}, () => ({ ok: true, restoredPrompt: blob }));
    await older.click();
    expect(older.spies.setComposerText).toHaveBeenCalledWith("the refused request");
    expect(older.hideExchange).toHaveBeenCalledWith(
      expect.objectContaining({ restored: "the refused request" }),
    );
    const newer = await setup({}, () => ({ ok: true, restoredPrompt: "words from the gateway" }));
    newer.ui.onEvent("amygdala2.status", status({ rewind: 2 }));
    await newer.click();
    expect(newer.spies.setComposerText).toHaveBeenCalledWith("words from the gateway");
  });

  it("a tab change while the gateway works: the exchange is hidden in ITS tab, and the other tab's box is left alone", async () => {
    let tab = TAB;
    const m = await setup({ tabKey: () => tab }, () => {
      tab = "agent:main:tinker:other";
      return { ok: true, restoredPrompt: "the refused request" };
    });
    await m.click();
    expect(m.hideExchange).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: TAB }));
    expect(m.spies.setComposerText).not.toHaveBeenCalled();
    expect(m.spies.notify).toHaveBeenCalled();
  });

  it("a rewind the gateway refuses (reply running, no capability) changes nothing on the page", async () => {
    const m = await setup({}, () => ({
      ok: false,
      reason: "a reply is still running in this tab",
    }));
    await m.click();
    expect(m.hideExchange).not.toHaveBeenCalled();
    expect(m.spies.setComposerText).not.toHaveBeenCalled();
    expect(m.spies.notify).toHaveBeenCalledWith(expect.stringContaining("still running"));
  });

  it("a gateway that throws leaves the page alone and says so", async () => {
    const m = await setup({}, () => {
      throw new Error("socket closed");
    });
    await m.click();
    expect(m.hideExchange).not.toHaveBeenCalled();
    expect(m.spies.setComposerText).not.toHaveBeenCalled();
    expect(m.spies.notify).toHaveBeenCalled();
  });

  it("a gateway that hands back no prompt hides the exchange but writes nothing into the box", async () => {
    const m = await setup({}, () => ({ ok: true, restoredPrompt: "" }));
    await m.click();
    expect(m.hideExchange).toHaveBeenCalledWith(expect.objectContaining({ restored: "" }));
    expect(m.spies.setComposerText).not.toHaveBeenCalled();
  });

  it("Undo on the placeholder asks the gateway to point the tab back, then brings the exchange back", async () => {
    const m = await setup();
    await m.click();
    await m.ui.handleClick(btn({ "data-amy-act": "rewind-exchange-undo", "data-exchange": "K" }));
    expect(m.rewinds()[1]?.[1]).toEqual({ sessionKey: TAB, turnId: "", undo: true });
    expect(m.showExchange).toHaveBeenCalledWith(TAB, "K");
    // The Jev strip of that turn is back too (it was marked rewound by the click).
    expect(m.ui.afterRun(userRow(9_000), null)).not.toContain("Rewound");
  });

  it("an Undo the gateway refuses leaves the exchange hidden", async () => {
    const m = await setup({}, (_method, params) =>
      (params as { undo?: boolean }).undo
        ? { ok: false, reason: "nothing to undo" }
        : { ok: true, restoredPrompt: "x" },
    );
    await m.ui.handleClick(btn({ "data-amy-act": "rewind-exchange-undo", "data-exchange": "K" }));
    expect(m.showExchange).not.toHaveBeenCalled();
  });

  it("a placeholder run draws none of the Jev turns of the exchange it replaced", async () => {
    const m = await setup();
    expect(m.ui.afterRun({ role: "user", ts: 9_000, _rewoundExchange: "r1" }, null)).toBe("");
  });
});

// the architect 2026-10-05 wanted "two kinds of messages"; since 2026-10-15 (the architect) neither window is drawn. Nothing
// else of Jev's is drawn per reply either: no chip on a tool row, no sent-back chip, no settled one-liners, no CHECKS.
describe("no windows per reply", () => {
  it("a reply with checks that all passed draws nothing after the run", async () => {
    const { ui } = await available({
      decisionEvents: [
        dec("o1", { codeDid: "ok", toolUseId: "toolu_1" }),
        dec("o2", { codeDid: "ok", turnId: `${TAB}#2`, ts: 11_000 }),
      ],
    });
    expect(ui.afterRun(userRow(9_000), userRow(20_000))).toBe("");
    expect(ui.inlineFor("toolu_1")).toBe("");
  });
  it("markers still land after the run", async () => {
    const { ui } = await available({ decisionEvents: [dec("o1", { codeDid: "ok" })] });
    ui.onEvent("amygdala2.marker", {
      id: "mk1",
      sessionKey: TAB,
      turnId: `${TAB}#1`,
      ts: 10_100,
      kind: "unsupported-after-two",
      items: ["amygdala2.rewind"],
    });
    const html = ui.afterRun(userRow(9_000), null);
    const f = frag(html);
    expect(f.querySelectorAll(".amy-jev")).toHaveLength(0);
    expect(html).toContain("amygdala2.rewind");
  });
});

// 2026-10-22, the architect: "Add the rewind every time Jev detects a refusal, not only complete but also partial".
describe("a partial refusal (a reply sent back for dodging part of the work) offers the same strip", () => {
  const sendBack = (id: string, decisionId: string) =>
    hold({
      id,
      decisionId,
      kind: "send-back",
      state: "settled",
      title: "Reply sent back",
      cmd: undefined,
    });
  const why = (id: string, decisionId: string, questionId: string) =>
    dec(id, {
      decisionId,
      questionId,
      codeDid: "sent-back",
      enforced: false,
      seam: "stop",
      stepLabel: "stop",
    });
  const shadow3 = () => status({ mode: "shadow", rewind: 3 });

  it("dodged work: the strip says partial refusal and offers Rewind", async () => {
    const m = await available({
      status: shadow3(),
      interventions: [sendBack("sb1", "d-sb")],
      decisionEvents: [why("e1", "d-sb", "dodged-work")],
    });
    const html = m.ui.afterRun(userRow(9_000), null);
    expect(html).toContain("This looks like a partial refusal");
    expect(frag(html).querySelectorAll('[data-amy-act="rewind"]')).toHaveLength(1);
  });

  it("a reply sent back for an unsupported claim is not a refusal: no strip", async () => {
    const m = await available({
      status: shadow3(),
      interventions: [sendBack("sb1", "d-sb")],
      decisionEvents: [why("e1", "d-sb", "claim-support")],
    });
    expect(m.ui.afterRun(userRow(9_000), null)).not.toContain("refusal");
  });

  it("a turn with a refusal and a dodged-work send-back (twice each, the 18:58 shape) shows one strip, the whole one", async () => {
    const m = await available({
      status: shadow3(),
      interventions: [
        hold({
          id: "r1",
          decisionId: "d1",
          kind: "refusal",
          state: "settled",
          cmd: undefined,
          ts: 10_000,
        }),
        sendBack("s1", "d1"),
        hold({
          id: "r2",
          decisionId: "d2",
          kind: "refusal",
          state: "settled",
          cmd: undefined,
          ts: 10_500,
        }),
        sendBack("s2", "d2"),
      ],
      decisionEvents: [why("e1", "d1", "dodged-work"), why("e2", "d2", "dodged-work")],
    });
    const html = m.ui.afterRun(userRow(9_000), null);
    expect(frag(html).querySelectorAll(".amy-refstrip")).toHaveLength(1);
    expect(html).toContain("This looks like a refusal");
    expect(html).not.toContain("partial refusal");
  });
});
