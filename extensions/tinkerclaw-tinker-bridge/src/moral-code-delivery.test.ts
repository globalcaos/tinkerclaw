import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MORAL_CODE_MARKER,
  readMaterializedMoralCode,
  resolveCorePluginDir,
  transcriptHasMoralCode,
} from "./moral-code-delivery.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-moral-"));
afterEach(() => {
  delete process.env.TINKERCLAW_CC_CORE_PLUGIN_DIR;
});

describe("moral-code delivery (bridge)", () => {
  it("finds the repo's tinkerclaw-core plugin", () => {
    const dir = resolveCorePluginDir(__dirname);
    expect(dir && fs.existsSync(path.join(dir, "hooks", "hooks.json"))).toBe(true);
  });

  it("returns undefined when no candidate holds a plugin", () => {
    process.env.TINKERCLAW_CC_CORE_PLUGIN_DIR = path.join(tmp, "nope");
    expect(resolveCorePluginDir(path.join(tmp, "a", "b", "c"))?.startsWith(tmp)).not.toBe(true);
  });

  // FORK 2026-10-02 — a delivery is the WHOLE pack in what the CLI sends (src/moral-code/contract.ts
  // moralCodeDeliveredIn); the opening marker alone, as in the CLI's 2 KB preview, is not.
  it("detects a complete pack in a transcript, not a bare marker; unreadable counts as delivered", () => {
    const with_ = path.join(tmp, "with.jsonl");
    const markerOnly = path.join(tmp, "marker-only.jsonl");
    const without = path.join(tmp, "without.jsonl");
    const pack = `${MORAL_CODE_MARKER}\nX\n</moral_code>`;
    fs.writeFileSync(
      with_,
      `${JSON.stringify({ type: "user", message: { role: "user", content: pack } })}\n`,
    );
    fs.writeFileSync(markerOnly, `{"x":"${MORAL_CODE_MARKER.replace(/"/g, '\\"')}"}\n`);
    fs.writeFileSync(without, '{"x":"hello"}\n');
    expect(transcriptHasMoralCode(with_)).toBe(true);
    expect(transcriptHasMoralCode(markerOnly)).toBe(false);
    expect(transcriptHasMoralCode(without)).toBe(false);
    expect(transcriptHasMoralCode(path.join(tmp, "missing.jsonl"))).toBe(true);
  });

  it("reads the materialized pack, empty when absent", () => {
    expect(readMaterializedMoralCode(tmp)).toBe("");
    fs.mkdirSync(path.join(tmp, "moral-code"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "moral-code", "moral-code.md"), `${MORAL_CODE_MARKER}\nX\n`);
    expect(readMaterializedMoralCode(tmp)).toBe(`${MORAL_CODE_MARKER}\nX`);
  });
});
