import { describe, expect, it } from "vitest";
import { PENDING_RAIL } from "./chat-rail.js";
import { buildChatUnits, chatRowKey, THINKING_UNIT_KEY, type ChatUnitDeps } from "./chat-units.js";

type Row = Record<string, unknown>;

const user = (uid: string, text: string, extra: Row = {}): Row => ({
  role: "user",
  _uid: uid,
  content: [{ type: "text", text }],
  ...extra,
});
const say = (uid: string, text: string, extra: Row = {}): Row => ({
  role: "assistant",
  _uid: uid,
  content: [{ type: "text", text }],
  ...extra,
});
const tool = (uid: string, id: string, extra: Row = {}): Row => ({
  role: "assistant",
  _uid: uid,
  content: [
    { type: "text", text: `checking ${id}` },
    { type: "tool_use", id, name: "read", input: {} },
  ],
  ...extra,
});
const result = (uid: string, id: string): Row => ({
  role: "user",
  _uid: uid,
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});

function deps(over: Partial<ChatUnitDeps> = {}): ChatUnitDeps {
  return {
    renderMsg: (msg, idx, thinking) =>
      `<div class="msg" data-uid="${String((msg as Row)._uid)}" data-i="${idx}"${thinking ? " data-thinking" : ""}></div>`,
    extractUserText: (msg) => {
      const c = (msg as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      return c.find((b) => b.type === "text")?.text ?? null;
    },
    expandedTools: new Set(),
    streamRunId: null,
    streamMsgUid: null,
    esc: (s) => s,
    skillNoticesHtmlAfter: () => "",
    renderThinkingIndicator: () => "",
    queuedRows: () => [],
    ...over,
  };
}

const turn = (): Row[] => [
  user("u1", "hello"),
  tool("a1", "t1"),
  result("r1", "t1"),
  // Longer than the narration: reply-grouping never folds the run's largest text bubble.
  say("a2", "the answer, longer than the narration above it"),
];

describe("buildChatUnits", () => {
  it("makes a finished run's Reasoning group ONE unit, keyed by its first intermediate", () => {
    const units = buildChatUnits(turn(), deps());
    expect(units.map((u) => u.key)).toEqual(["u:u1", "g:u:a1", "u:a2", THINKING_UNIT_KEY]);
    const group = units[1].html;
    expect(group.startsWith('<div class="reasoning-group">')).toBe(true);
    expect(group).toContain('data-uid="a1"');
    expect(group).toContain('data-uid="r1"');
    expect(group).not.toContain('data-uid="a2"');
  });

  it("renders a streaming run flat: one unit per row", () => {
    const rows = turn();
    rows[1]._temporary = true;
    const units = buildChatUnits(rows, deps({ streamRunId: "run-1" }));
    expect(units.map((u) => u.key)).toEqual(["u:u1", "u:a1", "u:r1", "u:a2", THINKING_UNIT_KEY]);
  });

  it("keys a row by Task 8's identity, then its client _uid, then its position", () => {
    expect(chatRowKey({ __openclaw: { id: "abc" }, _uid: "m1" }, 3)).toBe("oc:abc");
    expect(chatRowKey({ __openclaw: { externalId: "cli-9" }, _uid: "m1" }, 3)).toBe("ext:cli-9");
    expect(chatRowKey({ _uid: "m1" }, 3)).toBe("u:m1");
    expect(chatRowKey({}, 3)).toBe("i:3");
  });

  it("ends with the thinking indicator, then the queued prompts", () => {
    const units = buildChatUnits(
      turn(),
      deps({
        renderThinkingIndicator: () => `<div class="thinking-indicator"></div>`,
        queuedRows: () => [{ role: "user", content: [{ type: "text", text: "next" }] }],
      }),
    );
    expect(units.slice(-2).map((u) => u.key)).toEqual([THINKING_UNIT_KEY, "q:i:4"]);
    expect(units.at(-2)?.html).toBe(`<div class="thinking-indicator"></div>`);
  });

  it("draws the amygdala's window after the run it judged, before the next prompt, and passes both prompts", () => {
    const rows = [...turn(), user("u2", "again"), say("a3", "second answer")];
    const seen: Array<[unknown, unknown]> = [];
    const units = buildChatUnits(
      rows,
      deps({
        amygdalaAfterRun: (a, b) => {
          seen.push([a, b]);
          return (a as Row | null)?._uid === "u1" ? `<div class="amy-turn"></div>` : "";
        },
      }),
    );
    expect(units.map((u) => u.key)).toEqual([
      "u:u1",
      "g:u:a1",
      "u:a2",
      "amy:u:u1",
      "u:u2",
      "u:a3",
      THINKING_UNIT_KEY,
    ]);
    expect(
      seen.map(([a, b]) => [(a as Row | null)?._uid ?? null, (b as Row | null)?._uid ?? null]),
    ).toEqual([
      [null, "u1"],
      ["u1", "u2"],
      ["u2", null],
    ]);
  });

  it("puts the amygdala's tail above the thinking indicator, and nothing when both hooks are absent or empty", () => {
    const withTail = buildChatUnits(
      turn(),
      deps({ amygdalaTail: () => `<div class="amy-tail"></div>` }),
    );
    expect(withTail.slice(-2).map((u) => u.key)).toEqual(["amy:tail", THINKING_UNIT_KEY]);
    const bare = buildChatUnits(turn(), deps());
    const empty = buildChatUnits(
      turn(),
      deps({ amygdalaAfterRun: () => "", amygdalaTail: () => "" }),
    );
    expect(empty).toEqual(bare);
  });

  it("carries a prompt's skill chips in the prompt's own unit", () => {
    const units = buildChatUnits(
      turn(),
      deps({ skillNoticesHtmlAfter: (_v, i) => (i === 0 ? `<div class="chip"></div>` : "") }),
    );
    expect(units[0].html).toBe(
      `<div class="msg" data-uid="u1" data-i="0"></div><div class="chip"></div>`,
    );
  });

  // FORK 2026-10-02 (the architect: "when we expand anything, it should not compact automatically as it
  // used to do when new messages appear at the bottom") — the turn-end fold must not swallow a row
  // he opened while the turn ran.
  it("asks once, as a group forms, whether it opens — and hands the hook the members' markup", () => {
    const asked: Array<[string, string]> = [];
    const units = buildChatUnits(
      turn(),
      deps({
        openGroupOnForm: (id, inner) => {
          asked.push([id, inner]);
          return inner.includes('data-uid="r1"');
        },
      }),
    );
    expect(asked.map(([id]) => id)).toEqual(["rg-a1"]);
    expect(asked[0][1]).toContain('data-uid="a1"');
    expect(asked[0][1]).toContain('data-uid="r1"');
    expect(units[1].html).toContain('data-tid="rg-a1">▾ Reasoning');
    expect(units[1].html).toContain('<div class="reasoning-content">');
  });

  it("a group the expanded set already decides never asks the hook", () => {
    let calls = 0;
    const units = buildChatUnits(
      turn(),
      deps({
        expandedTools: new Set(["rg-a1"]),
        openGroupOnForm: () => {
          calls++;
          return false;
        },
      }),
    );
    expect(calls).toBe(0);
    expect(units[1].html).toContain("▾ Reasoning");
  });

  // FORK 2026-10-02 — a reset divider (history-paging.ts resetDividerRow) closes the archive's last
  // run like a prompt does; otherwise it would fold into that run's Reasoning group and disappear.
  it("a reset divider is a run boundary, painted as its own unit", () => {
    const divider = { role: "system", _uid: "d1", _resetDivider: true, _resetAt: 1, content: [] };
    const units = buildChatUnits([...turn(), divider, user("u2", "after the reset")], deps());
    expect(units.map((u) => u.key)).toEqual([
      "u:u1",
      "g:u:a1",
      "u:a2",
      "u:d1",
      "u:u2",
      THINKING_UNIT_KEY,
    ]);
  });

  // FORK 2026-10-05 (the architect: "the 'TURN TIMING' box disappears after a while, not being visible when
  // the answer appears, it should stay exactly where it was. The chat should work like a very long
  // paper, when something is written here it stays, it might expand and contract, but never
  // disappear"). Measured on the live page the same day: 59 of 64 blocks sat in a hidden group.
  const timing = (uid: string, extra: Row = {}): Row => ({
    role: "assistant",
    _uid: uid,
    _isPhaseTiming: true,
    content: "turn timing",
    ...extra,
  });

  it("keeps the TURN TIMING block where it was when the run folds: its own unit, above the group", () => {
    const [prompt, ...rest] = turn();
    const units = buildChatUnits([prompt, timing("tm"), ...rest], deps());
    expect(units.map((u) => u.key)).toEqual(["u:u1", "u:tm", "g:u:a1", "u:a2", THINKING_UNIT_KEY]);
    expect(units[1].html).toContain('data-uid="tm"');
    expect(units[2].html).not.toContain('data-uid="tm"');
  });

  it("a block written after an intermediate stays at its place too, never inside the fold", () => {
    const view = [
      user("u1", "hello"),
      tool("a1", "t1"),
      timing("tm"),
      result("r1", "t1"),
      say("a2", "the answer, longer than the narration above it"),
    ];
    const units = buildChatUnits(view, deps());
    expect(units.map((u) => u.key)).toEqual(["u:u1", "g:u:a1", "u:tm", "u:a2", THINKING_UNIT_KEY]);
    expect(units[1].html).not.toContain('data-uid="tm"');
  });

  it("a run of only the block and the answer has nothing to fold", () => {
    const units = buildChatUnits(
      [user("u1", "hi"), timing("tm"), say("a2", "short answer")],
      deps(),
    );
    expect(units.map((u) => u.key)).toEqual(["u:u1", "u:tm", "u:a2", THINKING_UNIT_KEY]);
  });

  it("never grafts the turn's own block into a 🌿 section; only one written after the answer goes", () => {
    const fractal = say("fr", "🌿 FRACTAL: a lesson");
    const view = [
      user("u1", "hello"),
      // Tagged as the reflection's by runId because the 🌿 text streamed in the SAME run.
      timing("tm", { _fractalPass: true }),
      tool("a1", "t1"),
      result("r1", "t1"),
      say("a2", "the answer, longer than the narration above it"),
      timing("tm-r"),
      fractal,
    ];
    const units = buildChatUnits(view, deps());
    const html = (key: string) => units.find((u) => u.key === key)?.html ?? "";
    expect(html("u:tm")).not.toContain("mpg-graft");
    expect(html("u:tm-r")).toContain('data-phase-graft-into="fr"');
  });

  it("joins back into the exact page string, in row order", () => {
    const units = buildChatUnits(turn(), deps());
    expect(units.map((u) => u.html).join("")).toBe(
      '<div class="msg" data-uid="u1" data-i="0"></div>' +
        '<div class="reasoning-group"><div class="reasoning-header" data-tid="rg-a1">▸ Reasoning (1 step, 1 tool call)</div>' +
        '<div class="reasoning-content" hidden>' +
        '<div class="msg" data-uid="a1" data-i="1" data-thinking></div>' +
        '<div class="msg" data-uid="r1" data-i="2"></div>' +
        "</div></div>" +
        '<div class="msg" data-uid="a2" data-i="3"></div>',
    );
  });
});

// FORK 2026-10-01 (the architect): the answering model's rail — logo, line, logo — beside the answer only.
describe("buildChatUnits — the answering model's rail", () => {
  const railDeps = (seen: unknown[][] = []): Partial<ChatUnitDeps> => ({
    runRail: (rows) => {
      seen.push([...rows]);
      return {
        rail: {
          color: "#d97757",
          logoHtml: "<i>L</i>",
          title: "Opus 5.5 — claude-code/claude-opus-5-5",
        },
        model: { model: "claude-opus-5-5", provider: "claude-code" },
      };
    },
  });

  it("opens the rail before the answer, closes it after, and wraps every unit between", () => {
    const units = buildChatUnits(turn(), deps(railDeps()));
    expect(units.map((u) => u.key)).toEqual([
      "u:u1",
      "rail-start:u:a1",
      "g:u:a1",
      "u:a2",
      "rail-end:u:a1",
      THINKING_UNIT_KEY,
    ]);
    expect(units[1].html).toContain("turn-rail-cap--start");
    expect(units[2].html.startsWith('<div class="turn-seg" style="--rail:#d97757">')).toBe(true);
    expect(units[3].html).toContain('data-uid="a2"');
    expect(units[3].html.startsWith('<div class="turn-seg"')).toBe(true);
    expect(units[4].html).toContain("turn-rail-cap--end");
  });

  it("never draws the rail beside a prompt", () => {
    const view = [...turn(), user("u2", "and again"), say("a3", "second answer")];
    const units = buildChatUnits(view, deps(railDeps()));
    for (const u of units.filter((x) => x.key === "u:u1" || x.key === "u:u2")) {
      expect(u.html).not.toContain("turn-");
    }
    // The second answer has its own rail, opened after the prompt that asked for it.
    const keys = units.map((u) => u.key);
    expect(keys.indexOf("rail-start:u:a3")).toBe(keys.indexOf("u:u2") + 1);
  });

  it("hands the resolver the run's own rows, and draws nothing for a run with nothing painted", () => {
    const seen: unknown[][] = [];
    buildChatUnits(turn(), deps(railDeps(seen)));
    // The empty run before the first prompt is never asked about.
    expect(seen).toHaveLength(1);
    expect(seen[0].map((r) => (r as Row)._uid)).toEqual(["a1", "r1", "a2"]);
  });

  it("keeps an earlier unit's markup when a row arrives after it, so nothing above re-parses", () => {
    const live = { streamRunId: "run-1", streamMsgUid: "a9" };
    const before = buildChatUnits(
      [user("u1", "go"), say("a8", "first bubble")],
      deps({ ...railDeps(), ...live }),
    );
    const after = buildChatUnits(
      [user("u1", "go"), say("a8", "first bubble"), say("a9", "second bubble")],
      deps({ ...railDeps(), ...live }),
    );
    const html = (us: typeof before, key: string) => us.find((u) => u.key === key)?.html;
    expect(html(after, "u:a8")).toBe(html(before, "u:a8"));
    expect(html(after, "rail-start:u:a8")).toBe(html(before, "rail-start:u:a8"));
    expect(html(after, "rail-end:u:a8")).toBe(html(before, "rail-end:u:a8"));
  });

  // FORK 2026-10-06 (the architect: "I still see the line next to 'TURN TIMING', which does not make sense
  // because this part does not use any agent to be computed"). The block is the browser's and the
  // gateway's measurement of the turn, like the prompt it sits under: the model wrote none of it.
  const timingRow = (uid: string): Row => ({
    role: "assistant",
    _uid: uid,
    _isPhaseTiming: true,
    content: "turn timing",
  });

  it("never draws the line beside TURN TIMING: the rail opens below it, at the model's first row", () => {
    const [prompt, ...rest] = turn();
    const units = buildChatUnits([prompt, timingRow("tm"), ...rest], deps(railDeps()));
    expect(units.map((u) => u.key)).toEqual([
      "u:u1",
      "u:tm",
      "rail-start:u:tm",
      "g:u:a1",
      "u:a2",
      "rail-end:u:tm",
      THINKING_UNIT_KEY,
    ]);
    expect(units[1].html).not.toContain("turn-");
  });

  it("a run holding only TURN TIMING draws no rail, not even a pending one, and asks no resolver", () => {
    let asked = 0;
    const units = buildChatUnits(
      [user("u1", "hello"), timingRow("tm")],
      deps({
        runRail: () => {
          asked++;
          return { rail: PENDING_RAIL, model: null };
        },
      }),
    );
    expect(asked).toBe(0);
    expect(units.map((u) => u.key)).toEqual(["u:u1", "u:tm", THINKING_UNIT_KEY]);
    expect(units[1].html).not.toContain("turn-");
  });

  it("a TURN TIMING block written after the answer stays outside the rail, which closes above it", () => {
    const view = [...turn(), timingRow("tm-r")];
    const units = buildChatUnits(view, deps(railDeps()));
    const keys = units.map((u) => u.key);
    expect(keys.indexOf("rail-end:u:a1")).toBe(keys.indexOf("u:a2") + 1);
    expect(keys.indexOf("u:tm-r")).toBe(keys.indexOf("rail-end:u:a1") + 1);
    expect(units.find((u) => u.key === "u:tm-r")?.html).not.toContain("turn-");
  });

  it("tells the resolver which run is the last one, the only one a turn in flight can be", () => {
    const tails: boolean[] = [];
    const view = [...turn(), user("u2", "and again"), say("a3", "second answer")];
    buildChatUnits(
      view,
      deps({
        runRail: (_rows, _prev, tail) => {
          tails.push(tail);
          return null;
        },
      }),
    );
    expect(tails).toEqual([false, true]);
  });

  it("a pending rail keeps the run's room and carries no model to the next run", () => {
    const prevs: unknown[] = [];
    const view = [...turn(), user("u2", "and again"), say("a3", "second answer")];
    const units = buildChatUnits(
      view,
      deps({
        runRail: (_rows, prev) => {
          prevs.push(prev);
          return { rail: PENDING_RAIL, model: null };
        },
      }),
    );
    expect(prevs).toEqual([null, null]);
    const cap = units.find((u) => u.key === "rail-start:u:a1")?.html ?? "";
    expect(cap).toContain("is-pending");
    expect(
      units.find((u) => u.key === "u:a2")?.html.startsWith('<div class="turn-seg is-pending">'),
    ).toBe(true);
  });

  it("changes nothing when no resolver is wired", () => {
    expect(buildChatUnits(turn(), deps()).map((u) => u.key)).toEqual([
      "u:u1",
      "g:u:a1",
      "u:a2",
      THINKING_UNIT_KEY,
    ]);
  });
});
