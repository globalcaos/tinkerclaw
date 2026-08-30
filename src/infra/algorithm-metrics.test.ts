import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAlgorithmOutcome, recordCompactionOutcome } from "./algorithm-metrics.js";
import { reportInstrumentLiveness, resetInstrumentLivenessForTest } from "./instrument-liveness.js";

// FORK 2026-07-28 — these tests exist because this module, within an hour of shipping, wrote 32
// SYNTHETIC rows into the production ledger at ~/.openclaw/data/algorithm-metrics.jsonl during a
// vitest run. The ledger feeds published papers, so fixture data mixed with real measurements is
// contamination, not untidiness. Same class as the test that unlinked the live session map and
// the one that wrote to the production context-anatomy DB.
describe("algorithm metrics ledger", () => {
  const saved = process.env.OPENCLAW_ALGORITHM_METRICS_PATH;
  let dir: string;

  beforeEach(() => {
    resetInstrumentLivenessForTest();
    dir = mkdtempSync(join(tmpdir(), "algo-metrics-"));
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.OPENCLAW_ALGORITHM_METRICS_PATH;
    } else {
      process.env.OPENCLAW_ALGORITHM_METRICS_PATH = saved;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("REFUSES the production ledger under a test runner", async () => {
    delete process.env.OPENCLAW_ALGORITHM_METRICS_PATH;
    const production = join(
      process.env.HOME ?? "/nonexistent",
      ".openclaw",
      "data",
      "algorithm-metrics.jsonl",
    );
    const before = existsSync(production) ? readFileSync(production, "utf8").length : 0;

    recordAlgorithmOutcome({
      algorithm: "compaction",
      variant: "fixture",
      outcome: "fired",
      metrics: { contextTokens: 999_999 },
      provenance: { contextTokens: "estimated" },
    });
    await new Promise((r) => setTimeout(r, 60));

    const after = existsSync(production) ? readFileSync(production, "utf8").length : 0;
    expect(after).toBe(before);
  });

  it("writes to an explicitly sandboxed path when one is given", async () => {
    const p = join(dir, "ledger.jsonl");
    process.env.OPENCLAW_ALGORITHM_METRICS_PATH = p;

    recordCompactionOutcome({
      variant: "preemptive",
      outcome: "skipped",
      contextTokens: 52_116,
      contextTokensSource: "per-call-measured",
      windowTokens: 1_000_000,
      sessionKey: "s1",
    });
    await new Promise((r) => setTimeout(r, 60));

    const rows = readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].algorithm).toBe("compaction");
    expect(rows[0].variant).toBe("preemptive");
    // Parts, not ratios — the denominator must be recoverable at analysis time.
    expect(rows[0].metrics.contextTokens).toBe(52_116);
    expect(rows[0].metrics.windowTokens).toBe(1_000_000);
    expect(rows[0].metrics.fillPercent).toBeUndefined();
    // Provenance is what distinguishes a per-call snapshot from a turn aggregate.
    expect(rows[0].provenance.contextTokens).toBe("per-call-measured");
    expect(rows[0].v).toBe(1);
  });

  it("drops non-finite metrics rather than poisoning a later mean", async () => {
    const p = join(dir, "ledger.jsonl");
    process.env.OPENCLAW_ALGORITHM_METRICS_PATH = p;

    recordAlgorithmOutcome({
      algorithm: "compression",
      variant: "x",
      outcome: "observed",
      metrics: { good: 1, nan: Number.NaN, inf: Number.POSITIVE_INFINITY },
      provenance: { good: "local-measured" },
    });
    await new Promise((r) => setTimeout(r, 60));

    const row = JSON.parse(readFileSync(p, "utf8").trim());
    expect(row.metrics.good).toBe(1);
    expect(row.metrics).not.toHaveProperty("nan");
    expect(row.metrics).not.toHaveProperty("inf");
  });

  it("still records liveness even when the ledger write is sandboxed away", () => {
    delete process.env.OPENCLAW_ALGORITHM_METRICS_PATH;
    recordAlgorithmOutcome({
      algorithm: "prompt-cache",
      variant: "embedded",
      outcome: "observed",
      metrics: { inputTokens: 1 },
      provenance: { inputTokens: "per-call-measured" },
    });
    const row = reportInstrumentLiveness().find((r) => r.id === "algorithm:prompt-cache");
    expect(row?.fireCount).toBe(1);
  });
});
