import { describe, expect, it } from "vitest";
import {
  agoLabel,
  modelRowHint,
  parseRecentModels,
  pruneRecentModels,
  RECENT_MODEL_STICKY_MS,
  recentUseForRow,
  recordLiveModels,
  serializeRecentModels,
  type RecentModelLedger,
} from "./model-recent-use.js";

const NOW = 1_790_000_000_000;
const MIN = 60_000;

const live = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

describe("recordLiveModels", () => {
  it("stamps each live model and its sessions, and reports growth only for new keys", () => {
    const ledger: RecentModelLedger = new Map();
    expect(recordLiveModels(ledger, live({ "codex/gpt-5.6-sol": ["tab-a", "tab-b"] }), NOW)).toBe(
      true,
    );
    expect(ledger.get("codex/gpt-5.6-sol")).toEqual(
      new Map([
        ["tab-a", NOW],
        ["tab-b", NOW],
      ]),
    );
    // same sessions again: restamped, nothing new
    expect(recordLiveModels(ledger, live({ "codex/gpt-5.6-sol": ["tab-a"] }), NOW + MIN)).toBe(
      false,
    );
    expect(ledger.get("codex/gpt-5.6-sol")?.get("tab-a")).toBe(NOW + MIN);
    expect(ledger.get("codex/gpt-5.6-sol")?.get("tab-b")).toBe(NOW);
    // empty lists are not use
    expect(recordLiveModels(ledger, live({ "xai/grok-5": [] }), NOW)).toBe(false);
    expect(ledger.has("xai/grok-5")).toBe(false);
  });
});

describe("recentUseForRow — the sticky window", () => {
  const ledgerAt = (stamps: Record<string, Record<string, number>>): RecentModelLedger =>
    parseRecentModels(JSON.stringify(stamps));

  it("THE ASK: a model stays recent long after a second model started (was: unpinned at once)", () => {
    const ledger = ledgerAt({
      "codex/gpt-5.6-sol": { "tab-a": NOW - 20 * MIN },
      "claude-code/claude-opus-5-5": { "tab-b": NOW },
    });
    expect(recentUseForRow(ledger, "codex/gpt-5.6-sol", NOW)).toBeDefined();
    expect(recentUseForRow(ledger, "claude-code/claude-opus-5-5", NOW)).toBeDefined();
  });

  it("lets a model go once it has been idle longer than the window", () => {
    const ledger = ledgerAt({
      "codex/gpt-5.6-sol": { "tab-a": NOW - RECENT_MODEL_STICKY_MS - 1 },
      "claude-code/claude-opus-5-5": { "tab-b": NOW - MIN },
    });
    expect(recentUseForRow(ledger, "codex/gpt-5.6-sol", NOW)).toBeUndefined();
  });

  it("bug #1 kept: the newest model stays pinned at any age", () => {
    const ledger = ledgerAt({ "codex/gpt-5.6-sol": { "tab-a": NOW - 5 * 60 * MIN } });
    expect(recentUseForRow(ledger, "codex/gpt-5.6-sol", NOW)?.lastAt).toBe(NOW - 5 * 60 * MIN);
  });

  it("reads a row through the count's key rule: no cross-provider twin, bare tail as fallback", () => {
    const ledger = ledgerAt({
      "codex/gpt-5.6-sol": { "tab-a": NOW },
      "gemini-3.1-pro-preview": { "tab-b": NOW },
    });
    expect(recentUseForRow(ledger, "github-copilot/gpt-5.6-sol", NOW)).toBeUndefined();
    expect(recentUseForRow(ledger, "google/gemini-3.1-pro-preview", NOW)?.sessions).toEqual([
      { key: "tab-b", at: NOW },
    ]);
  });

  it("lists the sessions of the last stretch, newest first", () => {
    const ledger = ledgerAt({
      "codex/gpt-5.6-sol": {
        old: NOW - RECENT_MODEL_STICKY_MS - 2 * MIN,
        mid: NOW - 10 * MIN,
        new: NOW - MIN,
      },
    });
    expect(recentUseForRow(ledger, "codex/gpt-5.6-sol", NOW)?.sessions.map((s) => s.key)).toEqual([
      "new",
      "mid",
    ]);
  });
});

describe("pruneRecentModels", () => {
  it("drops expired models but never the newest, and caps sessions per model", () => {
    const sessions: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      sessions[`tab-${i}`] = NOW - i * 1000;
    }
    const ledger = parseRecentModels(
      JSON.stringify({
        "codex/gpt-5.6-sol": sessions,
        "xai/grok-5": { "tab-x": NOW - RECENT_MODEL_STICKY_MS - 1 },
      }),
    );
    pruneRecentModels(ledger, NOW);
    expect(ledger.has("xai/grok-5")).toBe(false);
    const kept = ledger.get("codex/gpt-5.6-sol");
    expect(kept?.size).toBe(12);
    expect(kept?.has("tab-0")).toBe(true);
    expect(kept?.has("tab-19")).toBe(false);

    const lone = parseRecentModels(
      JSON.stringify({ "xai/grok-5": { "tab-x": NOW - 9 * 60 * MIN } }),
    );
    pruneRecentModels(lone, NOW);
    expect(lone.has("xai/grok-5")).toBe(true);
  });
});

describe("serialize / parse", () => {
  it("round-trips, and tolerates anything malformed", () => {
    const ledger: RecentModelLedger = new Map([["codex/gpt-5.6-sol", new Map([["tab-a", NOW]])]]);
    expect(parseRecentModels(serializeRecentModels(ledger))).toEqual(ledger);
    expect(parseRecentModels(null).size).toBe(0);
    expect(parseRecentModels("not json").size).toBe(0);
    expect(parseRecentModels("[1,2]").size).toBe(0);
    expect(
      parseRecentModels(JSON.stringify({ a: { s: "x" }, b: [1], c: { s: 5 }, d: null })),
    ).toEqual(new Map([["c", new Map([["s", 5]])]]));
  });
});

describe("modelRowHint", () => {
  const names: Record<string, string> = {
    "agent:main:tinker:a": "🔧 Fix auth bug",
    "agent:main:tinker:b": "🏠 Main",
    "agent:main:subagent:s1": "🔧 Fix auth bug › subagent",
  };
  const nameOf = (k: string) => names[k] ?? k;

  it("THE ASK: a live row names the tabs running it, adding up to the badge", () => {
    const hint = modelRowHint({
      live: ["agent:main:tinker:a", "agent:main:tinker:b", "agent:main:tinker:a"],
      nameOf,
      now: NOW,
    });
    expect(hint).toBe("Running now:\n• 🔧 Fix auth bug ×2\n• 🏠 Main");
  });

  it("an idle pinned row names who ran it, with ages", () => {
    const hint = modelRowHint({
      live: [],
      recent: {
        lastAt: NOW - 4 * MIN,
        sessions: [
          { key: "agent:main:tinker:a", at: NOW - 4 * MIN },
          { key: "agent:main:subagent:s1", at: NOW - 12 * MIN },
        ],
      },
      nameOf,
      now: NOW,
    });
    expect(hint).toBe(
      "Used 4m ago:\n• 🔧 Fix auth bug · 4m ago\n• 🔧 Fix auth bug › subagent · 12m ago",
    );
  });

  it("live wins over recent, and neither means no hint", () => {
    const recent = { lastAt: NOW, sessions: [{ key: "x", at: NOW }] };
    expect(modelRowHint({ live: ["agent:main:tinker:b"], recent, nameOf, now: NOW })).toBe(
      "Running now:\n• 🏠 Main",
    );
    expect(modelRowHint({ live: [], nameOf, now: NOW })).toBe("");
  });

  it("folds a long list", () => {
    const many = Array.from({ length: 11 }, (_, i) => `s${i}`);
    const lines = modelRowHint({ live: many, nameOf, now: NOW }).split("\n");
    expect(lines).toHaveLength(1 + 8 + 1);
    expect(lines.at(-1)).toBe("+3 more");
  });

  it("agoLabel", () => {
    expect(agoLabel(NOW - 5_000, NOW)).toBe("just now");
    expect(agoLabel(NOW - 42 * MIN, NOW)).toBe("42m ago");
    expect(agoLabel(NOW - 3 * 60 * MIN, NOW)).toBe("3h ago");
    expect(agoLabel(NOW - 49 * 60 * MIN, NOW)).toBe("2d ago");
  });
});
