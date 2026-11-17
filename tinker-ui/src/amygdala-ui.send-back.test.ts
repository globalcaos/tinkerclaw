// FORK 2026-11-13: what the page reads from a stop-check send-back. sendBackTimes feeds the narration rule
// (chat-units.ts); stopBubbles places a send-back no judge drove, and leaves a refusal mark to the closing block.
import { describe, expect, it, vi } from "vitest";
import type { InterventionView, JevDecision, StatusView } from "./amygdala-types.js";
import { createAmygdalaUi, type AmygdalaUiDeps } from "./amygdala-ui.js";

// The helpers of amygdala-ui.test.ts, copied: that file exports none.
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

function make(
  reqImpl?: (method: string, params?: unknown) => unknown,
  extra: Partial<AmygdalaUiDeps> = {},
) {
  const deps: AmygdalaUiDeps = {
    async req(method: string, params?: unknown) {
      const r = reqImpl ? await reqImpl(method, params) : {};
      return r as never;
    },
    tabKey: () => TAB,
    now: () => 50_000,
    repaintChat: vi.fn(),
    repaintPanel: vi.fn(),
    setComposerText: vi.fn(),
    notify: vi.fn(),
    openPanel: vi.fn(),
    ...extra,
  };
  return { ui: createAmygdalaUi(deps) };
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
const frag = (html: string): DocumentFragment =>
  document.createRange().createContextualFragment(html);

const stop = (id: string, over: Partial<JevDecision>): JevDecision =>
  dec(id, {
    seam: "stop",
    stepLabel: "stop",
    codeDid: "sent-back",
    decisionId: `d-${id}`,
    ...over,
  });
const sentBack = (id: string, over: Partial<InterventionView>): InterventionView =>
  hold({
    id,
    decisionId: `d-${id}`,
    kind: "send-back",
    title: "Reply sent back",
    cmd: undefined,
    ...over,
  });

// FORK 2026-11-13 (F1): the chat keeps the answer a send-back judged out of the Reasoning fold; this
// is where it learns when a reply of the tab was sent back.
describe("sendBackTimes: when a stop check sent this tab's reply back (2026-11-13)", () => {
  it("lists each send-back the gateway enforced, with or without a judge answer behind it", async () => {
    const { ui } = await available({
      decisionEvents: [
        // A judge answer drove it and it was enforced (the kinds before 2026-11-08).
        stop("s1", { ts: 13_000, turnId: `${TAB}#2` }),
        // A note on the same turn is no send-back.
        stop("n1", { ts: 16_000, turnId: `${TAB}#2`, codeDid: "note" }),
        // A shadow record: the reply was never sent back.
        stop("s2", { ts: 30_000, turnId: `${TAB}#4`, enforced: false }),
      ],
      interventions: [
        // No judge answer drove it (the unchecked admission, the only kind since 2026-11-10): open = enforced.
        sentBack("iv-sb", { ts: 21_000, turnId: `${TAB}#3` }),
        // Its shadow twin is a settled record.
        sentBack("iv-shadow", { ts: 40_000, turnId: `${TAB}#5`, state: "settled" }),
      ],
    });
    expect(ui.sendBackTimes()).toEqual([13_000, 21_000]);
  });

  it("keeps a time it already handed out when the store has dropped the turn", async () => {
    const { ui } = await available({
      interventions: [sentBack("iv-sb", { ts: 21_000, turnId: `${TAB}#3` })],
    });
    expect(ui.sendBackTimes()).toEqual([21_000]);
    // The store keeps the newest 60 turns of every tab the page hears.
    for (let n = 0; n < 60; n++) {
      ui.onEvent(
        "amygdala2.decision",
        dec(`later-${n}`, {
          ts: 30_000 + n,
          turnId: `agent:main:tinker:other#${n}`,
          sessionKey: "agent:main:tinker:other",
          codeDid: "ok",
        }),
      );
    }
    expect(ui.store.turnsFor(TAB)).toEqual([]);
    expect(ui.sendBackTimes()).toEqual([21_000]);
  });

  it("is empty while the gateway has no amygdala methods", async () => {
    const m = make(() => {
      throw { message: "unknown method: amygdala2.status" };
    });
    await m.ui.onConnected();
    expect(m.ui.sendBackTimes()).toEqual([]);
  });
});

// FORK 2026-11-13 (F2): since 2026-11-10 the only send-back left has no judge answer behind it, so
// it reached the page as an intervention with no decision row, and stopBubbles read the seam from a
// decision. Its card was never placed between the answer and the result.
describe("stopBubbles places a send-back no judge answer drove (2026-11-13)", () => {
  it("hands it to the run's placement as a stop check that opens another answer", async () => {
    const { ui } = await available({
      interventions: [sentBack("iv-sb", { decisionId: "d-sb", ts: 13_000, turnId: `${TAB}#2` })],
    });
    const got = ui
      .stopBubbles(userRow(9_000), userRow(20_000))
      .map((b) => ({ key: b.key, ts: b.ts, seam: b.seam, turnId: b.turnId, opens: b.opens }));
    expect(got).toEqual([
      { key: "iv-sb", ts: 13_000, seam: "stop", turnId: `${TAB}#2`, opens: true },
    ]);
    // Placed by the run, so the closing block does not draw it a second time.
    const placed = new Set(ui.stopBubbles(userRow(9_000), userRow(20_000)).map((b) => b.key));
    expect(ui.afterRun(userRow(9_000), userRow(20_000), false, placed)).not.toContain("amy-inline");
  });

  it("leaves a lone refusal mark and a lone note to the closing block, as before", async () => {
    const lone = (id: string, over: Partial<InterventionView>): InterventionView =>
      hold({ id, decisionId: `d-${id}`, turnId: `${TAB}#2`, cmd: undefined, ...over });
    const { ui } = await available({
      interventions: [
        lone("iv-r", { ts: 13_000, kind: "refusal", title: "This looks like a refusal" }),
        lone("iv-n", { ts: 14_000, kind: "note", state: "settled", title: "Note for the agent" }),
      ],
    });
    expect(ui.stopBubbles(userRow(9_000), userRow(20_000))).toEqual([]);
  });
});

// FORK 2026-11-13 (F3): a refusal the judge found at the stop seam was handed to the run's placement
// with `opens: true`, as if it had sent the reply back. It sends nothing back (hook-action.ts), so it
// was drawn above the reply it marks, and its strip, drawn outside afterRun, named no exchange.
describe("stopBubbles leaves a judged refusal to the closing block (2026-11-13)", () => {
  it("is not placed as a send-back, and its strip names its exchange", async () => {
    const at = { key: "K", prompt: "the refused request", at: 9_000, later: 1 };
    const feed = {
      status: status({ rewind: 3 }),
      interventions: [
        hold({ id: "iv-r", kind: "refusal", title: "This looks like a refusal", cmd: undefined }),
      ],
      // The driving answer: enforced, at the stop seam, tied to the intervention by its decision.
      decisionEvents: [
        dec("v1", {
          seam: "stop",
          stepLabel: "stop",
          questionId: "refusal",
          codeDid: "refusal",
          decisionId: "d1",
        }),
      ],
    };
    const m = make((method) => (method === "amygdala2.status" ? status({ rewind: 3 }) : feed), {
      exchangeKeyOf: () => "K",
      newestExchange: () => ({ key: "LATER", prompt: "a newer one", at: 12_000 }),
      exchangeAt: (k) => (k === "K" ? at : null),
    });
    await m.ui.onConnected();
    expect(m.ui.stopBubbles(userRow(9_000), null)).toEqual([]);
    const html = m.ui.afterRun(userRow(9_000), null, false, new Set());
    const b = frag(html).querySelector('[data-amy-act="rewind"]');
    expect(b?.getAttribute("data-exchange")).toBe("K");
    expect(b?.textContent).toBe("⟲ Rewind 2 exchanges");
  });
});
