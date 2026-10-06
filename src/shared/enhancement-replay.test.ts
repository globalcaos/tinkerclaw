import { describe, expect, it } from "vitest";
import {
  casesFromRows,
  classifyCase,
  evaluate,
  groupCases,
  houseRuleUse,
  lastDays,
  misses,
  rate,
  repeatsOfTrain,
  splitByTime,
  taskUses,
  type LedgerRow,
  type ReplayCase,
} from "./enhancement-replay.js";
import { isHouseRule, taskText } from "./enhancement-text.js";

const DAY = 86_400_000;

function mk(over: Partial<ReplayCase> & { taskId: string; ts: number }): ReplayCase {
  return {
    session: "agent:main:tinker:s1",
    source: "tinker",
    text: "make a youtube video",
    shown: [],
    listSource: "local",
    listReason: "shown",
    used: [],
    ...over,
  };
}

describe("taskText", () => {
  it("strips the sender block, the delivery stamp and the reflection tail", () => {
    const raw =
      'Sender (untrusted metadata):\n```json\n{\n  "label": "Tinker UI"\n}\n```\n\n[Thu [number]:01 GMT+2] In personality, I cannot find the curiosity one\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** on its own line.';
    expect(taskText(raw)).toBe("In personality, I cannot find the curiosity one");
  });

  it("strips the abort note that precedes the sender block", () => {
    const raw =
      "Note: The previous agent run was aborted by the user. Resume carefully or ask for clarification.\n\nSender (untrusted metadata):\n```json\n{}\n```\n\n[Tue [number]:05 GMT+2] go again";
    expect(taskText(raw)).toBe("go again");
  });

  it("leaves a plain request alone", () => {
    expect(taskText("find my contract")).toBe("find my contract");
  });
});

describe("classifyCase", () => {
  it("calls a typed request interactive", () => {
    expect(classifyCase({ source: "tinker", text: "[Mon [number]:00 GMT+2] hello" })).toBe(
      "interactive",
    );
  });

  it("calls injected notices and agent sources runtime", () => {
    expect(
      classifyCase({
        source: "tinker",
        text: "[Thu [number]:56 GMT+2] [System] The gateway restarted",
      }),
    ).toBe("runtime");
    expect(
      classifyCase({ source: "tinker", text: "[Sat [number]:26 GMT+2] ⟦AGENT:Thalamus⟧ Turn 01" }),
    ).toBe("runtime");
    expect(
      classifyCase({
        source: "tinker",
        text: "System (untrusted): [[number]:50:12 GMT+2] Exec completed (ember-ze, code 0)",
      }),
    ).toBe("runtime");
    expect(classifyCase({ source: "subagent", text: "Begin." })).toBe("runtime");
    expect(classifyCase({ source: "orchestrator", text: "anything" })).toBe("runtime");
  });

  it("calls a cron brief automated", () => {
    expect(
      classifyCase({ source: "cron", text: "[cron:wind-down Wind Down] Execute the brief" }),
    ).toBe("automated");
  });
});

describe("house rules", () => {
  it("matches the name after any kind or namespace prefix, and nothing else", () => {
    expect(isHouseRule("skill:human-voice")).toBe(true);
    expect(isHouseRule("skill:jarvis-skills:human-voice")).toBe(true);
    expect(isHouseRule("skill:longjob")).toBe(true);
    expect(isHouseRule("skill:human-voice-extra")).toBe(false);
    expect(isHouseRule("recipe:Plan a family trip")).toBe(false);
  });

  it("taskUses drops them, and keeps a card used twice once", () => {
    const c = mk({
      taskId: "a",
      ts: 1,
      used: [
        { cardId: "skill:human-voice", onList: false },
        { cardId: "skill:outlook-hack", onList: false },
        { cardId: "skill:outlook-hack", onList: true },
      ],
    });
    expect(taskUses(c)).toEqual(["skill:outlook-hack"]);
  });

  it("houseRuleUse lists them apart with how often they were already on the list", () => {
    const rows = houseRuleUse([
      mk({ taskId: "a", ts: 1, used: [{ cardId: "skill:human-voice", onList: true }] }),
      mk({
        taskId: "b",
        ts: 2,
        used: [
          { cardId: "skill:human-voice", onList: false },
          { cardId: "skill:longjob", onList: false },
        ],
      }),
    ]);
    expect(rows).toEqual([
      { name: "skill:human-voice", uses: 2, onList: 1 },
      { name: "skill:longjob", uses: 1, onList: 0 },
    ]);
  });
});

describe("time split", () => {
  const cases = Array.from({ length: 10 }, (_, i) => mk({ taskId: `t${i}`, ts: 1000 + i * 10 }));

  it("trains on the earlier cases and tests on the later ones, with no overlap", () => {
    const s = splitByTime(cases, 0.3);
    expect(s.test.map((c) => c.taskId)).toEqual(["t7", "t8", "t9"]);
    expect(s.train).toHaveLength(7);
    expect(Math.max(...s.train.map((c) => c.ts))).toBeLessThan(
      Math.min(...s.test.map((c) => c.ts)),
    );
    expect(new Set([...s.train, ...s.test].map((c) => c.taskId)).size).toBe(10);
  });

  it("puts every case sharing the cutoff timestamp in the test half", () => {
    const tied = [
      mk({ taskId: "a", ts: 1 }),
      mk({ taskId: "b", ts: 5 }),
      mk({ taskId: "c", ts: 5 }),
      mk({ taskId: "d", ts: 9 }),
    ];
    const s = splitByTime(tied, 0.5);
    expect(s.test.map((c) => c.taskId)).toEqual(["b", "c", "d"]);
    expect(s.train.map((c) => c.taskId)).toEqual(["a"]);
  });

  it("copes with an empty list and with a single case", () => {
    expect(splitByTime([])).toEqual({ train: [], test: [], cutoffTs: 0 });
    expect(splitByTime([mk({ taskId: "x", ts: 3 })]).test).toHaveLength(1);
  });

  it("lastDays counts back from the newest case, not from the clock", () => {
    const old = mk({ taskId: "old", ts: 1 });
    const recent = mk({ taskId: "recent", ts: 10 * DAY });
    const newest = mk({ taskId: "newest", ts: 10 * DAY + 5 });
    expect(lastDays([old, recent, newest], 7).map((c) => c.taskId)).toEqual(["recent", "newest"]);
  });

  it("repeatsOfTrain flags a held-out request the training half already had", () => {
    const train = [
      mk({ taskId: "a", ts: 1, text: "[Mon [number]:00 GMT+2] Run the nightly brief" }),
    ];
    const test = [
      mk({ taskId: "b", ts: 5, text: "Run the nightly brief" }),
      mk({ taskId: "c", ts: 6, text: "something new" }),
    ];
    expect([...repeatsOfTrain({ train, test, cutoffTs: 5 })]).toEqual(["b"]);
  });
});

describe("evaluate", () => {
  const cases: ReplayCase[] = [
    mk({ taskId: "1", ts: 1, used: [{ cardId: "skill:a", onList: false }] }),
    mk({
      taskId: "2",
      ts: 2,
      used: [
        { cardId: "skill:b", onList: false },
        { cardId: "skill:c", onList: false },
      ],
    }),
    mk({ taskId: "3", ts: 3, used: [{ cardId: "skill:human-voice", onList: false }] }),
    mk({ taskId: "4", ts: 4, used: [] }),
    mk({ taskId: "5", ts: 5, used: [{ cardId: "skill:z", onList: false }] }),
  ];
  const ranks: Record<string, string[]> = {
    "1": ["skill:a"],
    "2": ["skill:x", "skill:y", "skill:c", "skill:b"],
    "3": ["skill:human-voice"],
    "4": ["skill:a"],
    "5": ["skill:human-voice", "skill:tinker-rebuild", "skill:longjob", "skill:z"],
  };
  const rank = (c: ReplayCase) => ranks[c.taskId] ?? [];

  it("counts hits at 1, 3, 5 and 15 over the scored cases only, and reports the rest apart", () => {
    const s = evaluate(cases, rank);
    expect(s).toMatchObject({ cases: 5, houseOnly: 1, zeroUse: 1, scored: 3 });
    expect(s).toMatchObject({ hit1: 1, hit3: 2, hit5: 3, hit15: 3 });
    expect(s).toMatchObject({ pairs: 4, pairs15: 4 });
  });

  it("can drop house rules from the ranking before positions are counted", () => {
    const s = evaluate(cases, rank, { dropHouse: true });
    // case 5 had three house rules ahead of skill:z; without them it is first, not fourth
    expect(s).toMatchObject({ hit1: 2, hit3: 3, hit5: 3 });
  });

  it("lists the misses with the position the card had, or null", () => {
    const m = misses(cases, (c) => (c.taskId === "2" ? ["skill:b"] : []), 15);
    expect(m).toContainEqual({ taskId: "2", cardId: "skill:c", position: null });
    expect(m).not.toContainEqual(expect.objectContaining({ cardId: "skill:b" }));
  });

  it("splits a set by a key", () => {
    const g = groupCases(cases, (c) => (Number(c.taskId) % 2 ? "odd" : "even"));
    expect(g.get("odd")).toHaveLength(3);
    expect(g.get("even")).toHaveLength(2);
  });

  it("prints a rate with its denominator, and survives a zero denominator", () => {
    expect(rate(1, 8)).toBe("12.5% (1/8)");
    expect(rate(0, 0)).toBe("n/a (0/0)");
  });
});

describe("casesFromRows", () => {
  it("reads the two JSON columns and tolerates a broken or missing one", () => {
    const rows: LedgerRow[] = [
      {
        task_id: "a",
        ts: 5,
        session: "s",
        source: "tinker",
        text_redacted: "hi",
        shown_json: '[{"cardId":"skill:a","rank":1,"prob":0.9}]',
        list_source: "jev",
        list_reason: "shown",
        used_json: '[{"cardId":"skill:a","onList":true,"via":"exec","how":"unknown"}]',
      },
      {
        task_id: "b",
        ts: 6,
        session: null,
        source: null,
        text_redacted: "hi",
        shown_json: "not json",
        list_source: null,
        list_reason: null,
        used_json: null,
      },
    ];
    const [a, b] = casesFromRows(rows);
    expect(a).toMatchObject({
      shown: ["skill:a"],
      listSource: "jev",
      used: [{ cardId: "skill:a", onList: true }],
    });
    expect(b).toMatchObject({ shown: [], listSource: "local", used: [], session: "", source: "" });
  });
});
