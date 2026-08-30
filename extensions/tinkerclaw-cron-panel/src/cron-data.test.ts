import { describe, expect, it } from "vitest";
import { extractBriefPath, parseReport } from "./cron-data.js";

describe("extractBriefPath", () => {
  it("picks the cron-payloads file over the report contract", () => {
    const text =
      "SPAWN a subagent to execute the brief at ~/.openclaw/cron-payloads/life-butler.md " +
      "exactly as written; the subagent must ALSO write its report file per " +
      "~/.openclaw/workspace/CRON_REPORT_CONTRACT.md (Layer 1).";
    expect(extractBriefPath(text)).toBe("~/.openclaw/cron-payloads/life-butler.md");
  });

  it("falls back to a skill playbook when there is no payload file", () => {
    const text =
      "Execute the weekly inbound-marketing campaign per the playbook at " +
      "~/.openclaw/workspace/skills/moltbook/CAMPAIGN.md.";
    expect(extractBriefPath(text)).toBe("~/.openclaw/workspace/skills/moltbook/CAMPAIGN.md");
  });

  it("returns undefined when the only path is the report contract", () => {
    const text =
      "Read all report files plus ~/.openclaw/workspace/CRON-REPORT-CONTRACT.md for context.";
    expect(extractBriefPath(text)).toBeUndefined();
  });

  it("returns undefined when there is no path at all", () => {
    expect(extractBriefPath("just do the thing")).toBeUndefined();
  });
});

describe("parseReport keeps a title-plus-body bullet", () => {
  it("joins the indented second line onto the previous bullet", () => {
    const md = [
      "---",
      "job: life-butler",
      "ran: 2026-08-19T19:00:00+02:00",
      "status: ok",
      "headline: flowers are late",
      "---",
      "- CHANGED: Alex has a new job",
      "  He started at Ficosa. Evenings will be busier.",
      "- FLAG: The card on file expires in three days",
      "",
    ].join("\n");
    const report = parseReport(md, "2026-08-19");
    expect(report.deltas).toEqual([
      "CHANGED: Alex has a new job\nHe started at Ficosa. Evenings will be busier.",
      "FLAG: The card on file expires in three days",
    ]);
  });
});
