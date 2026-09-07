import { describe, expect, it } from "vitest";
import {
  cronCardChrome,
  cronSkimTag,
  parseCronItemText,
  pathToFsLink,
  stripCronKindPrefix,
} from "./cron-item-voice";

describe("cronSkimTag", () => {
  it("maps leftover FLAG/CHANGED kinds onto skim verbs", () => {
    expect(cronSkimTag("flag")).toBe("act");
    expect(cronSkimTag("failed")).toBe("broke");
    expect(cronSkimTag("realized")).toBe("found");
    expect(cronSkimTag("changed")).toBe("fyi");
    expect(cronSkimTag("note")).toBe("fyi");
    expect(cronSkimTag("dead")).toBe("found");
    expect(cronSkimTag("ask")).toBe("ask");
    expect(cronSkimTag("watch")).toBe("watch");
  });
});

describe("parseCronItemText", () => {
  it("splits a title line from an indented body", () => {
    expect(
      parseCronItemText(
        "ASK: Confirm Thursday at Dexeus\nTwo minutes in the portal. Tell me who it is for.",
      ),
    ).toEqual({
      title: "Confirm Thursday at Dexeus",
      body: "Two minutes in the portal. Tell me who it is for.",
    });
  });

  it("keeps a one-line leftover as the title, no fake body", () => {
    expect(parseCronItemText("ACT: The card on file expires in 3 days")).toEqual({
      title: "The card on file expires in 3 days",
      body: "",
    });
  });

  it("never lets a filename be the title — path moves into the body as a link", () => {
    const parsed = parseCronItemText(
      "CHANGED: memory/consolidation-logs/2026-08-19.md — full pass log with open items",
    );
    expect(parsed.title.toLowerCase()).not.toMatch(/\.md/);
    expect(parsed.title).toMatch(/full pass log/i);
    expect(parsed.body).toContain(
      "`~/.openclaw/workspace/memory/consolidation-logs/2026-08-19.md`",
    );
  });

  it("strips a trailing path from a prose title and linkifies it", () => {
    const parsed = parseCronItemText(
      "archived 10 cron receipts older than 60 days to `memory/archive/cron-receipts/`.",
    );
    expect(parsed.title.toLowerCase()).not.toContain("memory/");
    expect(parsed.title).toMatch(/archived 10 cron receipts/i);
    expect(parsed.body).toContain("`~/.openclaw/workspace/memory/archive/cron-receipts/`");
  });

  it("pathToFsLink promotes workspace-relative paths", () => {
    expect(pathToFsLink("memory/people/alex.md")).toBe(
      "`~/.openclaw/workspace/memory/people/alex.md`",
    );
    expect(pathToFsLink("~/.openclaw/cron-payloads/life-butler.md")).toBe(
      "`~/.openclaw/cron-payloads/life-butler.md`",
    );
  });

  it("stripCronKindPrefix leaves plain prose alone", () => {
    expect(stripCronKindPrefix("just a thought")).toBe("just a thought");
  });
});

describe("cronCardChrome", () => {
  it("puts the registry name on the left and a prompt-skim on the right, never the report headline", () => {
    expect(
      cronCardChrome({
        name: "Memory Consolidation (Sleep Cycle)",
        description:
          "Nightly sleep-consolidation pass per J5 paper — ENGRAM + daily-log → knowledge.",
      }),
    ).toEqual({
      name: "Memory Consolidation (Sleep Cycle)",
      promptSkim: "Nightly sleep-consolidation pass per J5 paper — ENGRAM + daily-log → knowledge.",
    });
  });

  it("clips a long prompt description to a first-sentence skim", () => {
    const chrome = cronCardChrome({
      name: "Life Butler",
      description:
        "19:00 personal-admin assistant. Self-improving scope (butler-scope.md) — calendar, flowers, tradesmen, and a long tail of household errands that must not leak into the briefing.",
    });
    expect(chrome.name).toBe("Life Butler");
    expect(chrome.promptSkim).toBe("19:00 personal-admin assistant.");
    expect(chrome.promptSkim.length).toBeLessThanOrEqual(80);
  });

  it("has no skim when the job has no description", () => {
    expect(cronCardChrome({ name: "Night Digest (main tab)" })).toEqual({
      name: "Night Digest (main tab)",
      promptSkim: "",
    });
  });
});
