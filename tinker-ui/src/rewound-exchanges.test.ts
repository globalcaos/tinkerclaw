import { describe, expect, it } from "vitest";
import { buildChatUnits } from "./chat-units.js";
import {
  exchangeByKey,
  exchangeKey,
  hideRewound,
  newestExchange,
  placeholderRow,
  REWOUND_STORAGE_KEY,
  RewoundStore,
  rowTimeMs,
  type ExchangeDeps,
  type RewoundExchange,
} from "./rewound-exchanges.js";

const user = (text: string, ts: number) => ({ role: "user", content: text, ts });
const reply = (text: string, ts: number) => ({ role: "assistant", content: text, ts });
const deps: ExchangeDeps = {
  promptOf: (row) => {
    const r = row as { role?: string; content?: string; _rewoundExchange?: string };
    return r.role === "user" && !r._rewoundExchange ? String(r.content) : null;
  },
  timeOf: rowTimeMs,
};
const record = (over: Partial<RewoundExchange> = {}): RewoundExchange => ({
  id: "r1",
  sessionKey: "tab",
  key: exchangeKey("the refused ask"),
  prompt: "the refused ask",
  at: 2_000,
  rewoundAt: 9_000,
  ...over,
});

describe("newestExchange", () => {
  it("is the last real prompt; a placeholder and replies are not prompts", () => {
    const view = [user("a", 1), reply("ra", 2), placeholderRow(record()), reply("x", 3)];
    expect(newestExchange(view, deps)).toMatchObject({ prompt: "a", index: 0 });
    expect(newestExchange([reply("only a reply", 1)], deps)).toBeNull();
  });
});

describe("hideRewound", () => {
  it("swaps the rewound prompt and everything it was answered with for one placeholder, and touches nothing else", () => {
    const view = [
      user("first", 1_000),
      reply("first answer", 1_500),
      user("the refused ask", 2_000),
      reply("API Error: safeguards flagged", 2_100),
      { role: "assistant", content: "timing", _isPhaseTiming: true, ts: 2_200 },
    ];
    const out = hideRewound(view, [record()], deps);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(view[0]);
    expect(out[1]).toBe(view[1]);
    expect(out[2]).toMatchObject({
      role: "user",
      _rewoundExchange: "r1",
      _rewoundAt: 9_000,
      ts: 2_000,
    });
    expect(JSON.stringify(out)).not.toContain("safeguards flagged");
  });

  it("stops at the next real prompt: what was said after the rewind stays", () => {
    const view = [
      user("first", 1_000),
      user("the refused ask", 2_000),
      reply("API Error", 2_100),
      user("the edited ask", 20_000),
      reply("a real answer", 21_000),
    ];
    const out = hideRewound(view, [record()], deps);
    expect(
      out.map((r) =>
        (r as { _rewoundExchange?: string })._rewoundExchange
          ? "PLACEHOLDER"
          : (r as { content?: unknown }).content,
      ),
    ).toEqual(["first", "PLACEHOLDER", "the edited ask", "a real answer"]);
  });

  it("the same words sent again later are another prompt: only the one at the record's time goes", () => {
    const view = [
      user("the refused ask", 2_000),
      reply("API Error", 2_100),
      user("the refused ask", 600_000),
      reply("an answer this time", 601_000),
    ];
    const out = hideRewound(view, [record()], deps);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ _rewoundExchange: "r1" });
    expect(out[1]).toBe(view[2]);
    expect(out[2]).toBe(view[3]);
  });

  it("a record that matches no prompt hides nothing, and no record returns the view itself", () => {
    const view = [user("something else", 1), reply("r", 2)];
    expect(hideRewound(view, [record()], deps)).toEqual(view);
    expect(hideRewound(view, [], deps)).toBe(view);
  });

  it("two records for two different exchanges each take their own", () => {
    const view = [user("one", 1_000), reply("x", 1_100), user("two", 3_000), reply("y", 3_100)];
    const out = hideRewound(
      view,
      [
        record({ id: "a", key: exchangeKey("one"), at: 1_000 }),
        record({ id: "b", key: exchangeKey("two"), at: 3_000 }),
      ],
      deps,
    );
    expect(out.map((r) => (r as { _rewoundExchange?: string })._rewoundExchange)).toEqual([
      "a",
      "b",
    ]);
  });

  it("the real run builder draws the earlier exchange untouched and the placeholder once, as its own boundary", () => {
    const view = hideRewound(
      [
        user("first", 1_000),
        reply("first answer", 1_500),
        user("the refused ask", 2_000),
        reply("API Error: safeguards flagged", 2_100),
      ],
      [record()],
      deps,
    );
    const units = buildChatUnits(view, {
      renderMsg: (m) => {
        const r = m as { role: string; content: string; _rewoundExchange?: string };
        return r._rewoundExchange ? "<i>REWOUND</i>" : `<p>${r.role}:${r.content}</p>`;
      },
      extractUserText: (m) => ((m as { role: string }).role === "user" ? "x" : null),
      expandedTools: new Set(),
      streamRunId: null,
      streamMsgUid: null,
      esc: (s) => s,
      skillNoticesHtmlAfter: () => "",
      renderThinkingIndicator: () => "",
      queuedRows: () => [],
    });
    const html = units.map((u) => u.html).join("");
    expect(html).toBe("<p>user:first</p><p>assistant:first answer</p><i>REWOUND</i>");
    expect(units.filter((u) => u.html.includes("REWOUND"))).toHaveLength(1);
    expect(new Set(units.map((u) => u.key)).size).toBe(units.length);
  });
});

// 2026-10-22: Rewind attaches to a turn, so more than one turn can be removed from history.
describe("a rewind to an older turn", () => {
  const view = () => [
    user("first", 1_000),
    reply("r1", 1_100),
    user("the refused ask", 2_000),
    reply("no", 2_100),
    user("no rewind button shows", 3_000),
    reply("checking", 3_100),
  ];
  it("exchangeByKey finds the turn and counts the prompts after it", () => {
    expect(exchangeByKey(view(), exchangeKey("the refused ask"), deps)).toMatchObject({
      prompt: "the refused ask",
      index: 2,
      later: 1,
    });
    expect(exchangeByKey(view(), exchangeKey("no rewind button shows"), deps)?.later).toBe(0);
    expect(exchangeByKey(view(), exchangeKey("never said"), deps)).toBeNull();
  });
  it("one placeholder takes that exchange and every later one; the earlier ones stay", () => {
    const out = hideRewound(view(), [record({ count: 2 })], deps);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ content: "first" });
    expect(out[2]).toMatchObject({ _rewoundCount: 2 });
    expect(JSON.stringify(out[2])).toContain("Rewound 2 exchanges");
  });
  it("what is said after the rewind stays on the page", () => {
    const later = [...view(), user("a fresh question", 9_500), reply("ok", 9_600)];
    const out = hideRewound(later, [record({ count: 2 })], deps);
    expect(out.slice(-2)).toEqual([user("a fresh question", 9_500), reply("ok", 9_600)]);
  });
});

describe("RewoundStore", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      data,
      storage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
      },
    };
  };
  const base = { sessionKey: "tab", key: "k1", prompt: "p", at: 1, rewoundAt: 5 };

  it("keeps the record per tab, survives a reload, and Undo removes only the newest one with those words", () => {
    const m = memory();
    const s = new RewoundStore(() => m.storage);
    s.add(base);
    s.add({ ...base, rewoundAt: 6 });
    s.add({ ...base, sessionKey: "other" });
    expect(s.list("tab")).toHaveLength(2);
    expect(new RewoundStore(() => m.storage).list("tab")).toHaveLength(2);
    expect(s.removeNewest("tab", "k1")).toBe(true);
    expect(s.list("tab").map((r) => r.rewoundAt)).toEqual([5]);
    expect(s.list("other")).toHaveLength(1);
    expect(s.removeNewest("tab", "nope")).toBe(false);
  });

  it("is bounded per tab and per page, and a corrupt record or no storage reads as nothing rewound", () => {
    const m = memory();
    const s = new RewoundStore(() => m.storage);
    for (let i = 0; i < 30; i++) s.add({ ...base, rewoundAt: i + 1 });
    expect(s.list("tab")).toHaveLength(20);
    for (let i = 0; i < 30; i++) s.add({ ...base, sessionKey: `t${i}` });
    expect(
      Object.keys(JSON.parse(m.data.get(REWOUND_STORAGE_KEY) as string)).length,
    ).toBeLessThanOrEqual(24);
    m.data.set(REWOUND_STORAGE_KEY, "{not json");
    const fresh = new RewoundStore(() => m.storage);
    expect(fresh.list("tab")).toEqual([]);
    expect(new RewoundStore(() => null).list("tab")).toEqual([]);
  });

  it("reads once, until another page changes the record", () => {
    const m = memory();
    let reads = 0;
    const s = new RewoundStore(() => ({
      getItem: (k) => (reads++, m.storage.getItem(k)),
      setItem: m.storage.setItem,
    }));
    s.list("tab");
    s.list("tab");
    expect(reads).toBe(1);
    s.invalidate();
    s.list("tab");
    expect(reads).toBe(2);
  });
});
