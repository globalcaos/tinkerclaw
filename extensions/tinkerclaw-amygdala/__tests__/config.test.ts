import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "..", "openclaw.plugin.json"), "utf-8"));
const props = manifest.configSchema.properties;

describe("manifest", () => {
  it("ships disabled and never activates by default", () => {
    expect(manifest.id).toBe("tinkerclaw-amygdala");
    expect(manifest.enabledByDefault).toBe(false);
  });
});

describe("parseConfig", () => {
  const cfg = parseConfig(undefined);

  it("defaults match the manifest", () => {
    expect(cfg.mode).toBe(props.mode.default);
    expect(cfg.jev.baseUrl).toBe(props.jev.properties.baseUrl.default);
    expect(cfg.jev.model).toBe(props.jev.properties.model.default);
    expect(cfg.jev.timeoutMs).toBe(props.jev.properties.timeoutMs.default);
    expect(cfg.jev.sendRealSituations).toBe(props.jev.properties.sendRealSituations.default);
    expect(cfg.failClosedOnLevel3).toBe(props.failClosedOnLevel3.default);
    expect(cfg.cost.eurPerUsd).toBe(props.cost.properties.eurPerUsd.default);
    expect(cfg.learn.capsPerWeek).toBe(props.learn.properties.capsPerWeek.default);
    expect(cfg.learn.capsPerDay).toBe(props.learn.properties.capsPerDay.default);
    expect(cfg.learn.autoLoosen).toBe(props.learn.properties.autoLoosen.default);
    expect(cfg.hooks.enabled).toBe(props.hooks.properties.enabled.default);
    const f = props.families.properties;
    expect(cfg.families.safety).toBe(f.safety.default);
    expect(cfg.families["second-opinion"]).toBe(f.secondOpinion.default);
    expect(cfg.families["double-check"]).toBe(f.doubleCheck.default);
    expect(cfg.families.efficiency).toBe(f.efficiency.default);
    expect(cfg.families.personality).toBe(f.personality.default);
  });

  it("real situations stay local and the data dir is the coexistence one by default", () => {
    expect(cfg.jev.sendRealSituations).toBe(false);
    expect(cfg.dataDir.endsWith("/.openclaw/data/amygdala-jev")).toBe(true);
  });

  it("takes overrides and ignores wrong-typed values", () => {
    const c = parseConfig({
      mode: "enforce",
      jev: { timeoutMs: "fast", sendRealSituations: true },
      families: { efficiency: true },
    });
    expect(c.mode).toBe("enforce");
    expect(c.jev.timeoutMs).toBe(2600);
    expect(c.jev.sendRealSituations).toBe(true);
    expect(c.families.efficiency).toBe(true);
    expect(parseConfig({ mode: "loud" }).mode).toBe("shadow");
  });
});
