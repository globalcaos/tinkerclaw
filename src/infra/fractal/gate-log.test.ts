import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendFractalJsonl,
  fractalGateRow,
  resolveFractalGateLogPath,
  resolveFractalGateReviewsPath,
} from "./gate-log.js";
import { fractalGateRules, normalizeFractalGateParams, decideFractalGate } from "./gate.js";

// The gate's own log (2026-10-25): one row per decision; a skipped row keeps the text its tutor needs.

const params = normalizeFractalGateParams({
  sessionKey: "agent:main:tinker:a",
  parentRunId: "P",
  prompt: "[Sat 2026-10-25 01:00 GMT+2] what time is it?",
  reply: "It is 01:00.",
  trail: { calls: 1, toolCalls: 0, toolErrors: 0, repeated: [], tools: [] },
});

describe("fractalGateRow", () => {
  it("a skip keeps the owner's words and the reply's end; a fire keeps no text", () => {
    const rules = fractalGateRules(params);
    const skip = decideFractalGate(rules, { probs: { correction: 0.05 }, worth: "nothing" });
    expect(skip.fire).toBe(false);
    const row = fractalGateRow({ params, rules, jev: "answered", result: skip }, 5);
    expect(row).toMatchObject({
      v: 1,
      ts: 5,
      sessionKey: "agent:main:tinker:a",
      parentRunId: "P",
      fire: false,
      source: "jev",
      jev: "answered",
      probs: { correction: 0.05 },
      rules: { triggers: [], weak: [], longTurn: false },
      trail: { calls: 1, toolCalls: 0, toolErrors: 0, repeated: [] },
      prompt: "what time is it?",
      reply: "It is 01:00.",
    });
    const fire = decideFractalGate(rules, undefined);
    const fired = fractalGateRow({ params, rules, jev: "unavailable", result: fire }, 6);
    expect(fired.fire).toBe(true);
    expect(fired.jev).toBe("unavailable");
    expect(fired.prompt).toBeUndefined();
    expect(fired.reply).toBeUndefined();
  });
});

describe("appendFractalJsonl", () => {
  it("appends one line per row and makes the folder; the paths sit beside the ledger", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fractal-gate-log-"));
    try {
      const file = path.join(dir, "deep", "gate.jsonl");
      await appendFractalJsonl(file, { a: 1 });
      await appendFractalJsonl(file, { a: 2 });
      expect((await fs.readFile(file, "utf-8")).trim().split("\n")).toEqual(['{"a":1}', '{"a":2}']);
      expect(resolveFractalGateLogPath("/s")).toBe("/s/data/fractal/gate.jsonl");
      expect(resolveFractalGateReviewsPath("/s")).toBe("/s/data/fractal/gate-reviews.jsonl");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
