import { describe, expect, it } from "vitest";
import {
  classifyList,
  latencyStats,
  madridDay,
  nearestAsk,
  parseHookSpans,
  spanFor,
  summarizeAmygdala,
  type AmygdalaAsk,
} from "./enhancement-budget.js";

const JOURNAL = [
  "2026-10-05T10:00:00.100+02:00 [hooks] [hook-span] hook=before_prompt_build plugin=tinkerclaw-thalamus ms=420",
  "2026-10-05T10:00:00.101+02:00 [hooks] [hook-span] hook=before_prompt_build plugin=tinkerclaw-prefrontal ms=0",
  "2026-10-05T10:00:05.900+02:00 [hooks] [hook-span] hook=agent_end plugin=tinkerclaw-thalamus ms=3",
  "2026-10-05T10:01:00.850+02:00 [hooks] [hook-span] hook=before_prompt_build plugin=tinkerclaw-thalamus ms=812",
  "not a span line",
].join("\n");

describe("parseHookSpans", () => {
  it("keeps only the wanted plugin and hook, oldest first", () => {
    const spans = parseHookSpans(JOURNAL, {
      hook: "before_prompt_build",
      plugin: "tinkerclaw-thalamus",
    });
    expect(spans.map((s) => s.ms)).toEqual([420, 812]);
    expect(spans[0].ts).toBe(Date.parse("2026-10-05T10:00:00.100+02:00"));
  });
});

describe("spanFor", () => {
  const spans = parseHookSpans(JOURNAL, {
    hook: "before_prompt_build",
    plugin: "tinkerclaw-thalamus",
  });

  it("joins a ledger row to the span that ended a few ms after it", () => {
    expect(spanFor(spans, spans[0].ts - 4)?.ms).toBe(420);
    expect(spanFor(spans, spans[1].ts - 9)?.ms).toBe(812);
  });

  it("does not join a row that is far from every span", () => {
    expect(spanFor(spans, spans[0].ts - 5_000)).toBeNull();
    expect(spanFor(spans, spans[0].ts + 500)).toBeNull();
    expect(spanFor([], 1)).toBeNull();
  });
});

describe("classifyList", () => {
  const local = { listSource: "local" as const, listReason: "shown", source: "tinker" };

  it("separates a late local list, a fast one, a middling one and a Jev list", () => {
    expect(classifyList(local, { ts: 0, ms: 810 })).toBe("late-local");
    expect(classifyList(local, { ts: 0, ms: 2400 })).toBe("late-local");
    expect(classifyList(local, { ts: 0, ms: 12 })).toBe("fast-local");
    expect(classifyList(local, { ts: 0, ms: 500 })).toBe("mid-local");
    expect(classifyList({ ...local, listSource: "jev" }, { ts: 0, ms: 500 })).toBe("jev-answered");
  });

  it("reports a private source and a never-asked list before looking at time", () => {
    expect(classifyList({ ...local, source: "channel:whatsapp" }, { ts: 0, ms: 5 })).toBe(
      "private-source",
    );
    expect(classifyList({ ...local, listReason: "not-asked" }, null)).toBe("not-asked");
  });

  it("says no-span when the journal has no matching line", () => {
    expect(classifyList(local, null)).toBe("no-span");
  });

  it("takes the budget from the caller", () => {
    expect(classifyList(local, { ts: 0, ms: 900 }, { budgetMs: 1500 })).toBe("mid-local");
  });
});

describe("latencyStats", () => {
  it("counts the values at or over 800 and 1500 ms", () => {
    const s = latencyStats([100, 400, 800, 900, 1600]);
    expect(s).toMatchObject({ n: 5, p50: 800, max: 1600, over800: 3, over1500: 1 });
  });

  it("survives an empty list", () => {
    expect(latencyStats([])).toMatchObject({ n: 0, p50: 0, max: 0, over800: 0 });
  });
});

describe("amygdala asks", () => {
  const asks: AmygdalaAsk[] = [
    { ts: 1000, skipped: null, latencyMs: 300 },
    { ts: 2000, skipped: "breaker-open", latencyMs: 0 },
    { ts: 3000, skipped: "timeout", latencyMs: 1200 },
    { ts: 9000, skipped: null, latencyMs: 700 },
  ];

  it("counts skips by reason and takes latency from the answered asks only", () => {
    const s = summarizeAmygdala(asks);
    expect(s).toMatchObject({ asks: 4, answered: 2, bySkip: { "breaker-open": 1, timeout: 1 } });
    expect(s.answeredLatency).toMatchObject({ n: 2, max: 700 });
  });

  it("finds the nearest ask inside a window, and none outside it", () => {
    expect(nearestAsk(asks, 2100, 500)?.skipped).toBe("breaker-open");
    expect(nearestAsk(asks, 5000, 500)).toBeNull();
    expect(nearestAsk([], 5, 500)).toBeNull();
  });
});

describe("madridDay", () => {
  it("uses the Madrid calendar day, not UTC", () => {
    expect(madridDay(Date.parse("2026-10-05T22:30:00Z"))).toBe("2026-10-06");
  });
});
