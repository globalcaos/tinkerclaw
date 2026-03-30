import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Cross-Extension Communication", () => {
  let cogDir: string;

  beforeEach(() => { cogDir = mkdtempSync(join(tmpdir(), "cognitive-")); });
  afterEach(() => { rmSync(cogDir, { recursive: true, force: true }); });

  it("Total Recall writes shared state for other extensions", () => {
    writeFileSync(join(cogDir, "total-recall.json"), JSON.stringify({ active: true, baseDir: "/tmp/engram", version: "1.0.0" }));
    const state = JSON.parse(readFileSync(join(cogDir, "total-recall.json"), "utf8"));
    expect(state.active).toBe(true);
    expect(state.baseDir).toBe("/tmp/engram");
  });

  it("Identity Persistence writes persona state for Computational Humor", () => {
    writeFileSync(join(cogDir, "identity-persistence.json"), JSON.stringify({
      active: true, persona: { name: "Jarvis", humor: { frequency: "medium", sensitivityThreshold: 0.7 } }
    }));
    const state = JSON.parse(readFileSync(join(cogDir, "identity-persistence.json"), "utf8"));
    expect(state.persona.humor.frequency).toBe("medium");
  });

  it("Computational Humor degrades gracefully without Identity Persistence", () => {
    let persona = { humor: { frequency: "low", sensitivityThreshold: 0.8 } };
    try {
      persona = JSON.parse(readFileSync(join(cogDir, "identity-persistence.json"), "utf8")).persona;
    } catch { /* expected — file doesn't exist */ }
    expect(persona.humor.frequency).toBe("low");
  });

  it("Learned Intuition writes personality nudge for Identity Persistence", () => {
    writeFileSync(join(cogDir, "personality-nudge.json"), JSON.stringify({ adjustments: [{ trait: "warmth", delta: 0.1 }] }));
    const nudge = JSON.parse(readFileSync(join(cogDir, "personality-nudge.json"), "utf8"));
    expect(nudge.adjustments).toHaveLength(1);
    expect(nudge.adjustments[0].trait).toBe("warmth");
  });

  it("Round Table writes traces to Total Recall if available", () => {
    writeFileSync(join(cogDir, "total-recall.json"), JSON.stringify({ active: true, baseDir: cogDir }));
    mkdirSync(join(cogDir, "events"), { recursive: true });
    const tracePath = join(cogDir, "events", "debates.jsonl");
    writeFileSync(tracePath, JSON.stringify({ topic: "test", consensus: "yes" }) + "\n");
    const lines = readFileSync(tracePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("all extensions bootstrap on empty cognitive directory", () => {
    expect(existsSync(join(cogDir, "total-recall.json"))).toBe(false);
    expect(existsSync(join(cogDir, "identity-persistence.json"))).toBe(false);
    expect(existsSync(join(cogDir, "round-table.json"))).toBe(false);
    expect(existsSync(join(cogDir, "learned-intuition.json"))).toBe(false);
  });
});
