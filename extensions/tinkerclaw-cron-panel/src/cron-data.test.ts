import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractBriefPath,
  listJobsJoined,
  parseReport,
  type CronPanelResolvedConfig,
} from "./cron-data.js";

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

describe("listJobsJoined model overrides", () => {
  it("exposes payload.model as modelOverride and leaves inherited jobs unset", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-panel-model-"));
    const cfg: CronPanelResolvedConfig = {
      cronDir: root,
      jobsPath: path.join(root, "jobs.json"),
      statePath: path.join(root, "jobs-state.json"),
      reportsDir: path.join(root, "reports"),
    };
    try {
      fs.writeFileSync(
        cfg.jobsPath,
        JSON.stringify({
          jobs: [
            {
              id: "overridden",
              name: "Overridden",
              enabled: true,
              payload: {
                kind: "agentTurn",
                message: "run",
                model: "  anthropic/claude-sonnet-4-6  ",
              },
              schedule: { kind: "cron", expr: "0 7 * * *" },
            },
            {
              id: "inherited",
              name: "Inherited",
              enabled: true,
              payload: { kind: "agentTurn", message: "run" },
              schedule: { kind: "cron", expr: "0 8 * * *" },
            },
          ],
        }),
      );

      const rows = listJobsJoined(cfg);
      expect(rows.find((row) => row.id === "overridden")?.modelOverride).toBe(
        "anthropic/claude-sonnet-4-6",
      );
      expect(rows.find((row) => row.id === "inherited")?.modelOverride).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
