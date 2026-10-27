import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { parseConfig } from "../src/config.js";

// the architect's decision 7 of 2026-10-02 (full deploy) as the master amended it at 14:44: enforce with perCall OFF (the swap seam is not
// built; a switch that is on and does nothing reads as a lie), midThread off, orchestrateAuto on, the short list on (its own switch);
// digest, check, finish and hedge off. This is the staged config as written to build-full/staged-thalamus-enforce.json: the two
// must stay equal, and the manifest's schema must accept every key in it (it is `additionalProperties: false`, so a
// key the schema does not name would fail the gateway's config validation).
const STAGED = {
  mode: "enforce",
  enforce: {
    perCall: false,
    midThread: false,
    orchestrateAuto: true,
    shortlist: true,
    digest: false,
    check: false,
    finish: false,
    hedge: false,
  },
};

describe("the enforce flags of decision 7", () => {
  it("parses to exactly the flags the owner chose, and leaves the Claude Code lane flags off", () => {
    const c = parseConfig(STAGED);
    expect(c.mode).toBe("enforce");
    expect(c.enforce).toMatchObject({
      perCall: false,
      midThread: false,
      orchestrateAuto: true,
      shortlist: true,
      digest: false,
      check: false,
      finish: false,
      hedge: false,
      workerAgents: false,
      workerModel: false,
    });
  });

  it("defaults perCall and midThread to off, the safe default, and the short list to on", () => {
    expect(parseConfig({}).enforce.perCall).toBe(false);
    expect(parseConfig({ mode: "enforce" }).enforce.midThread).toBe(false);
    expect(parseConfig({ mode: "enforce" }).enforce.shortlist).toBe(true);
    expect(parseConfig({ enforce: { shortlist: false } }).enforce.shortlist).toBe(false);
  });

  it("the staged file on disk, when present, equals the STAGED object", () => {
    const path = join(
      homedir(),
      "Documents/AI_reports/Papers/J19_maestro/build-full/staged-thalamus-enforce.json",
    );
    if (!existsSync(path)) return;
    const staged = JSON.parse(readFileSync(path, "utf8")) as {
      plugins: { entries: { "tinkerclaw-thalamus": { config: unknown } } };
    };
    expect(staged.plugins.entries["tinkerclaw-thalamus"].config).toEqual(STAGED);
  });

  it("owns no fixed model choice by default; the architect's 2026-10-03 switch is its own declared key", () => {
    expect(parseConfig({}).enforce.ownModelChoices).toBe(false);
    expect(parseConfig({ mode: "enforce" }).enforce.ownModelChoices).toBe(false);
    expect(parseConfig({ enforce: { ownModelChoices: true } }).enforce.ownModelChoices).toBe(true);
    const schema = manifest.configSchema as {
      properties: { enforce: { properties: Record<string, { default?: unknown }> } };
    };
    expect(schema.properties.enforce.properties.ownModelChoices?.default).toBe(false);
  });

  it("is accepted by the plugin manifest's schema: every staged key is a declared property", () => {
    const schema = manifest.configSchema as {
      properties: {
        enforce: { properties: Record<string, unknown>; additionalProperties: boolean };
      };
    };
    expect(schema.properties.enforce.additionalProperties).toBe(false);
    for (const key of Object.keys(STAGED.enforce)) {
      expect(Object.keys(schema.properties.enforce.properties)).toContain(key);
    }
  });
});
