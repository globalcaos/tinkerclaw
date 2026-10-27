import { describe, expect, it } from "vitest";
import {
  aggregateModelTokenUsage,
  canonicalWindowLabel,
  formatResetCountdown,
  formatUsageTooltip,
  getModelUsage,
  pickResetIso,
  refreshTooltipReset,
} from "./model-usage";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");

describe("unified usage tooltip", () => {
  it("renders the architect's three-line block when every field is available", () => {
    const tip = formatUsageTooltip(
      [
        { label: "5h", pct: 20 },
        { label: "7d", pct: 34 },
      ],
      "2026-07-30T00:34:00.000Z",
      NOW,
    );
    const [first, second, third] = tip.split("\n");
    expect(first).toBe("5h: 20%");
    expect(second).toBe("7d: 34%");
    expect(third).toMatch(/^reset: 3d 12h 34m/);
  });

  it("drops the reset row rather than inventing one the provider never sent", () => {
    expect(formatUsageTooltip([{ label: "rpd", pct: 4, suffix: "60/1500" }])).toBe(
      "rpd: 4% (60/1500)",
    );
  });

  it("formats a countdown down to the unit that still matters", () => {
    const at = (ms: number) => formatResetCountdown(new Date(NOW + ms).toISOString(), NOW);
    expect(at(3 * 86400000 + 12 * 3600000 + 34 * 60000)).toBe("3d 12h 34m");
    expect(at(12 * 3600000 + 34 * 60000)).toBe("12h 34m");
    expect(at(34 * 60000)).toBe("34m");
    expect(at(30 * 1000)).toBe("<1m");
    expect(at(-1000)).toBe("now");
  });

  it("quotes the LONGEST window's reset while there is still headroom", () => {
    expect(
      pickResetIso([
        { pct: 70, iso: "2026-07-26T15:00:00.000Z" },
        { pct: 40, iso: "2026-07-30T12:00:00.000Z" },
      ]),
    ).toBe("2026-07-30T12:00:00.000Z");
  });

  it("switches to the exhausted short window's reset once it is full", () => {
    // The question a full window asks is "when can I send again", and the weekly
    // reset is a week away while capacity is 100 minutes away.
    expect(
      pickResetIso([
        { pct: 100, iso: "2026-07-26T13:40:00.000Z" },
        { pct: 16, iso: "2026-09-04T09:00:00.000Z" },
      ]),
    ).toBe("2026-07-26T13:40:00.000Z");
  });

  it("prefers the SHORTEST exhausted window when both are full", () => {
    expect(
      pickResetIso([
        { pct: 100, iso: "2026-07-26T13:40:00.000Z" },
        { pct: 100, iso: "2026-09-04T09:00:00.000Z" },
      ]),
    ).toBe("2026-07-26T13:40:00.000Z");
  });

  it("falls back down the ladder rather than dropping the row on a missing timestamp", () => {
    // A capped window with no timestamp cannot answer anything; a shorter window
    // with one still can.
    expect(
      pickResetIso([
        { pct: 30, iso: "2026-07-26T15:00:00.000Z" },
        { pct: 100, iso: null },
      ]),
    ).toBe("2026-07-26T15:00:00.000Z");
    expect(pickResetIso([{ pct: 100, iso: null }])).toBeNull();
  });

  it("re-stamps only the reset row, leaving the window percentages alone", () => {
    const iso = "2026-07-26T13:40:00.000Z";
    const tip = formatUsageTooltip(
      [
        { label: "5h", pct: 100 },
        { label: "7d", pct: 16 },
      ],
      iso,
      NOW,
    );
    expect(tip.split("\n")[2]).toMatch(/^reset: 1h 40m/);

    const later = refreshTooltipReset(tip, iso, NOW + 60_000);
    expect(later.split("\n").slice(0, 2)).toEqual(["5h: 100%", "7d: 16%"]);
    expect(later.split("\n")[2]).toMatch(/^reset: 1h 39m/);
  });

  it("leaves a hover that never carried a reset row untouched", () => {
    // Refreshing a row is not licence to invent one — Gemini and Copilot publish no
    // reset at all, and their hovers pass through this tick too.
    expect(refreshTooltipReset("rpd: 4% (60/1500)", "2026-07-26T13:40:00.000Z", NOW)).toBe(
      "rpd: 4% (60/1500)",
    );
    // Nor does an absent instant blank out a row that IS there.
    expect(refreshTooltipReset("5h: 20%\nreset: 3d 12h 34m", null, NOW)).toBe(
      "5h: 20%\nreset: 3d 12h 34m",
    );
  });

  it("collapses vendor window names onto the shared vocabulary", () => {
    expect(canonicalWindowLabel("Weekly")).toBe("7d");
    expect(canonicalWindowLabel("Five hour")).toBe("5h");
    expect(canonicalWindowLabel("5h")).toBe("5h");
    expect(canonicalWindowLabel("Monthly")).toBe("30d");
    // Unrecognised names still render, lowercased, rather than disappearing.
    expect(canonicalWindowLabel("Bursty")).toBe("bursty");
  });
});

const session = (key: string, totalTokens: number) => ({
  key,
  usage: {
    modelUsage: [
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        totals: { totalTokens },
      },
    ],
  },
});

describe("aggregateModelTokenUsage", () => {
  it("keeps the explicitly fetched viewed session when it is absent from the general list", () => {
    const result = aggregateModelTokenUsage(
      [session("agent:main:tinker:other", 10)],
      [session("agent:main:tinker:ms0apjk9", 87_303)],
    );

    expect(result.bySession["agent:main:tinker:ms0apjk9"]).toEqual({
      "codex/gpt-5.6-sol": 87_303,
    });
    expect(result.all["codex/gpt-5.6-sol"]).toBe(87_313);
  });

  it("does not double-count a viewed session also present in the general list", () => {
    const duplicate = session("agent:main:tinker:ms0apjk9", 87_303);
    const result = aggregateModelTokenUsage([duplicate], [duplicate]);

    expect(result.all["codex/gpt-5.6-sol"]).toBe(87_303);
    expect(result.bySession["agent:main:tinker:ms0apjk9"]["codex/gpt-5.6-sol"]).toBe(87_303);
  });
});

describe("getModelUsage", () => {
  const chatgptBudget = {
    chatgpt: {
      api_key_status: "Team",
      models: {
        Weekly: {
          utilization_pct: 2,
          status: "active",
          reset_at: "2026-07-27T12:00:00.000Z",
        },
        "Five hour": { utilization_pct: 12.5 },
        Ignored: { utilization_pct: 90 },
      },
    },
  };

  it.each(["codex", "openai-codex"])("%s reads ChatGPT subscription windows", (provider) => {
    const usage = getModelUsage(
      provider,
      `${provider}/gpt-5.6-sol`,
      undefined,
      chatgptBudget,
      null,
      NOW,
    );

    // Vendor window names collapse onto the shared vocabulary, so this row can be
    // compared at a glance with the Anthropic row directly above it in the panel —
    // including the BARS: top is always the short window, bottom the long one,
    // regardless of the order the vendor serialised them in.
    expect(usage).toMatchObject({ topPct: 12.5, bottomPct: 2 });
    expect(usage?.tooltip).toContain("7d: 2%");
    expect(usage?.tooltip).toContain("5h: 13%");
    // The reset is the point of the third row (the architect 2026-07-31: "for
    // sol-terra-luna, I am missing the reset time and do not care about plan").
    expect(usage?.tooltip).toContain("reset: ");
    expect(usage?.tooltip).not.toContain("plan:");
    expect(usage?.tooltip).not.toContain("Ignored");
    expect(usage?.tooltip).not.toContain("Weekly");
  });

  // the architect 2026-07-31: "is there no 5h window in openai?" — correct, and it is not
  // us hiding it: chatgpt.com/backend-api/wham/usage returns `secondary_window:
  // null` with a single 604800s primary, because OpenAI suspended the 5-hour limit
  // on 2026-07-12 and began restoring it on 2026-07-30. Nothing needs changing when
  // it comes back — the refresher labels any sub-24h window `${h}h` and this maps it
  // onto the 5h row — so this test pins that path shut rather than leaving us to
  // rediscover it the day the window reappears.
  it("shows the 5h row automatically if OpenAI restores the short window", () => {
    const usage = getModelUsage(
      "codex",
      "codex/gpt-5.6-sol",
      undefined,
      {
        chatgpt: {
          models: {
            Weekly: { utilization_pct: 40, resets_at: "2026-07-30T12:00:00.000Z" },
            "5h": { utilization_pct: 70, resets_at: "2026-07-26T15:00:00.000Z" },
          },
        },
      },
      null,
      NOW,
    );

    // Short window on top, long below, reset from the LONG one — identical to the
    // Anthropic row, which is the whole point of the shared shape.
    expect(usage).toMatchObject({ topPct: 70, bottomPct: 40 });
    expect(usage?.tooltip.split("\n")).toEqual([
      "5h: 70%",
      "7d: 40%",
      expect.stringContaining("reset: 4d"),
    ]);
  });

  // the architect 2026-08-28, with codex/sol sitting at 0 of 100 requests: "when a model
  // reaches the 5-hour window limit, the message about reset time should be set to
  // the reset time of the 5-hour window". Verbatim payload from
  // ~/.openclaw/workspace/memory/chatgpt-usage.json at 12:19Z that day, only the
  // dates shifted onto this file's NOW.
  it("quotes the 5h reset, not the weekly one, once codex/sol has spent the 5h window", () => {
    const usage = getModelUsage(
      "openai-codex",
      "openai-codex/gpt-5.6-sol",
      undefined,
      {
        chatgpt: {
          models: {
            "5h": {
              status: "active",
              utilization_pct: 100,
              requests: { used: 100, limit: 100, remaining: 0 },
              resets_at: "2026-07-26T13:40:00.000Z",
            },
            Weekly: {
              status: "active",
              utilization_pct: 16,
              resets_at: "2026-08-02T09:00:00.000Z",
            },
          },
        },
      },
      null,
      NOW,
    );

    expect(usage).toMatchObject({ topPct: 100, bottomPct: 16 });
    // 1h 40m — the 5h window. The weekly reset is 6d 21h out and would have been
    // the answer to a question nobody asked.
    expect(usage?.tooltip.split("\n")).toEqual([
      "5h: 100%",
      "7d: 16%",
      expect.stringMatching(/^reset: 1h 40m/),
    ]);
    // The instant travels with the row so the minute tick can re-stamp it.
    expect(usage?.resetIso).toBe("2026-07-26T13:40:00.000Z");
  });

  it("applies the same rule to an exhausted Anthropic 5h pool", () => {
    const usage = getModelUsage(
      "claude-code",
      "claude-code/claude-opus-5",
      undefined,
      {
        claude: {
          limits: {
            five_hour: { utilization: 100, resets_at: "2026-07-26T13:40:00.000Z" },
            seven_day: { utilization: 44, resets_at: "2026-08-01T09:00:00.000Z" },
          },
        },
      },
      null,
      NOW,
    );

    expect(usage).toMatchObject({ topPct: 100, bottomPct: 44 });
    expect(usage?.tooltip).toMatch(/reset: 1h 40m/);
    expect(usage?.resetIso).toBe("2026-07-26T13:40:00.000Z");
  });

  it("keeps the Anthropic reset on the weekly window while the 5h pool has room", () => {
    const usage = getModelUsage(
      "claude-code",
      "claude-code/claude-opus-5",
      undefined,
      {
        claude: {
          limits: {
            five_hour: { utilization: 20, resets_at: "2026-07-26T13:40:00.000Z" },
            seven_day: { utilization: 44, resets_at: "2026-08-01T09:00:00.000Z" },
          },
        },
      },
      null,
      NOW,
    );

    expect(usage?.resetIso).toBe("2026-08-01T09:00:00.000Z");
    expect(usage?.tooltip).toMatch(/reset: 5d 21h 0m/);
  });

  it("uses 0 for a missing second ChatGPT window", () => {
    const usage = getModelUsage(
      "codex",
      "codex/gpt-5.6-terra",
      undefined,
      { chatgpt: { models: { Weekly: { utilization_pct: 2 } } } },
      null,
      NOW,
    );

    expect(usage).toMatchObject({ topPct: 2, bottomPct: 0 });
  });

  it("keeps regular OpenAI on API spend rather than ChatGPT subscription usage", () => {
    const usage = getModelUsage(
      "openai",
      "openai/gpt-5.4",
      undefined,
      {
        ...chatgptBudget,
        openaiCosts: {
          monthSpend: 10,
          dailyBreakdown: [{ date: "2026-07-26", amount: 5 }],
        },
      },
      null,
      NOW,
    );

    expect(usage).toMatchObject({ topPct: 10, bottomPct: 20 });
    expect(usage?.tooltip).toContain("today: 10% ($5.00)");
    expect(usage?.tooltip).toContain("month: 20% ($10.00/$50)");
    expect(usage?.tooltip).not.toContain("Weekly");
  });

  it.each(["codex", "openai-codex"])("%s returns null without ChatGPT data", (provider) => {
    expect(
      getModelUsage(provider, `${provider}/gpt-5.6-luna`, undefined, {}, null, NOW),
    ).toBeNull();
  });

  it("xai renders the weekly pool with no 5h row, because Grok has no short window", () => {
    const usage = getModelUsage(
      "xai",
      "xai/grok-4.5",
      undefined,
      {
        xai: {
          usage_pct: 79,
          period_type: "weekly",
          period_end: "2026-07-29T18:00:00.000Z",
          products: [{ product: "GrokBuild", usage_pct: 79 }],
        },
      },
      null,
      NOW,
    );

    expect(usage).toMatchObject({ topPct: 79, bottomPct: 79 });
    // Two lines, not three: the absent 5h window must not render as "5h: 0%".
    // The wall-clock half is locale-formatted, so match its shape, not its digits.
    expect(usage?.tooltip.split("\n")).toHaveLength(2);
    expect(usage?.tooltip).toContain("7d: 79%");
    expect(usage?.tooltip).toMatch(/reset: 3d 6h 0m \(.+\)/);
    expect(usage?.tooltip).not.toContain("5h");
  });

  it("xai surfaces a product only when it disagrees with the headline", () => {
    const usage = getModelUsage(
      "xai",
      "xai/grok-4.5",
      undefined,
      {
        xai: {
          usage_pct: 40,
          period_type: "monthly",
          products: [
            { product: "GrokBuild", usage_pct: 40 },
            { product: "Imagine", usage_pct: 90 },
          ],
        },
      },
      null,
      NOW,
    );

    expect(usage?.tooltip).toContain("30d: 40%");
    expect(usage?.tooltip).toContain("Imagine: 90%");
    expect(usage?.tooltip).not.toContain("GrokBuild");
  });

  it("github-copilot uses the third line for the plan, having no reset to show", () => {
    const usage = getModelUsage(
      "github-copilot",
      "github-copilot/gpt-5.5",
      undefined,
      {
        copilot: {
          premium_used_pct: 100,
          chat_used_pct: 0,
          plan: "Pro (individual)",
          plan_price_usd: 10,
        },
      },
      null,
      NOW,
    );

    expect(usage).toMatchObject({ topPct: 100, bottomPct: 0 });
    expect(usage?.tooltip).toBe("premium: 100%\nchat: 0%\nplan: Pro (individual) · $10/mo");
    expect(usage?.tooltip).not.toContain("reset:");
  });

  // The picker crosses a model out when a row says it cannot serve. `disconnected`
  // already said that for a dead auth profile; these say it for a spent quota.
  describe("exhaustion", () => {
    const claudeAt = (utilization: number, resetsAt: string) =>
      getModelUsage(
        "claude-code",
        "claude-code/claude-opus-5",
        undefined,
        {
          claude: {
            limits: {
              five_hour: { utilization, resets_at: resetsAt },
              seven_day: { utilization: 44, resets_at: "2026-08-01T09:00:00.000Z" },
            },
          },
        },
        null,
        NOW,
      );

    it("marks a full 5h pool exhausted until the instant it rolls over", () => {
      const usage = claudeAt(100, "2026-07-26T13:40:00.000Z");

      expect(usage?.exhausted).toBe(true);
      // The BINDING window's reset — 1h40m out — not the weekly one 5d away that
      // the row would otherwise plan around.
      expect(usage?.resetAtMs).toBe(Date.parse("2026-07-26T13:40:00.000Z"));
    });

    it("stops calling it exhausted once that reset is in the past", () => {
      // The pool rolled over 20 minutes ago; the utilization number is just stale,
      // and treating stale-and-past as exhausted would cross out a model that can
      // serve right now.
      const usage = claudeAt(100, "2026-07-26T11:40:00.000Z");

      expect(usage?.exhausted).toBeFalsy();
      expect(usage?.resetAtMs).toBeUndefined();
      // Still a live row, unchanged in every other respect.
      expect(usage).toMatchObject({ topPct: 100, bottomPct: 44 });
    });

    it("stamps the codex row from its own exhausted 5h window", () => {
      // Same rule through the ChatGPT branch, whose windows come from the vendor
      // payload (utilization_pct + resets_at) rather than the claude limits block.
      const usage = getModelUsage(
        "codex",
        "codex/gpt-5.6-sol",
        undefined,
        {
          chatgpt: {
            models: {
              "5h": { utilization_pct: 100, resets_at: "2026-07-26T13:40:00.000Z" },
              Weekly: { utilization_pct: 16, resets_at: "2026-08-02T09:00:00.000Z" },
            },
          },
        },
        null,
        NOW,
      );

      expect(usage?.exhausted).toBe(true);
      expect(usage?.resetAtMs).toBe(Date.parse("2026-07-26T13:40:00.000Z"));
    });

    it("keeps a copilot pool exhausted with no reset to wait for", () => {
      // Deliberate: Copilot's quota rolls on a billing date the payload never
      // carries, so "100% used, no idea when it rolls over" reads as exhausted.
      // Reading a missing timestamp the other way would route traffic to a
      // provider that will reject it.
      const usage = getModelUsage(
        "github-copilot",
        "github-copilot/gpt-5.5",
        undefined,
        { copilot: { premium_used_pct: 100, chat_used_pct: 0, plan: "Pro (individual)" } },
        null,
        NOW,
      );

      expect(usage?.exhausted).toBe(true);
      expect(usage?.resetAtMs).toBeUndefined();
    });

    it("does not claim capacity it never measured for openrouter", () => {
      // Not "there is room" — no quota signal AT ALL. Every openrouter model in the
      // picker lands here, so a falsy exhausted on this path means nothing.
      expect(
        getModelUsage(
          "openrouter",
          "openrouter/moonshotai/kimi-k2.5",
          undefined,
          { claude: { limits: { five_hour: { utilization: 100 } } } },
          null,
          NOW,
        ),
      ).toBeNull();
    });

    it("leaves openai alone while local spend is under the cap", () => {
      const usage = getModelUsage(
        "openai",
        "openai/gpt-5.4",
        undefined,
        { openaiCosts: { monthSpend: 10, dailyBreakdown: [{ date: "2026-07-26", amount: 5 }] } },
        null,
        NOW,
      );

      expect(usage?.exhausted).toBeFalsy();
      expect(usage?.resetAtMs).toBeUndefined();
    });

    it("adds NOTHING to a row with headroom — not even a false", () => {
      // The extension contract, pinned: below 100% the two new fields are ABSENT,
      // not false/undefined-valued, so a row with headroom is byte-identical to
      // what it was before `exhausted` existed and no consumer can observe it.
      const usage = claudeAt(20, "2026-07-26T13:40:00.000Z");

      expect(usage).not.toBeNull();
      expect(usage && "exhausted" in usage).toBe(false);
      expect(usage && "resetAtMs" in usage).toBe(false);
    });
  });

  it("xai and github-copilot return null without their budget blocks", () => {
    expect(getModelUsage("xai", "xai/grok-4.5", undefined, {}, null, NOW)).toBeNull();
    expect(
      getModelUsage("github-copilot", "github-copilot/gpt-5.5", undefined, {}, null, NOW),
    ).toBeNull();
  });
});
