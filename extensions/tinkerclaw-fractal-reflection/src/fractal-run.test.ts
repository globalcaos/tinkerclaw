import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTurnDigest,
  readReplyWithBackoff,
  clearTriagePromptCache,
  DIGEST_CHAR_CEILING,
  parseTriageVerdict,
  runTriage,
} from "./fractal-run.js";
import type { FractalConfig } from "./types.js";

const TRIAGE_PROMPT_FIXTURE = "# FRACTAL TRIAGE TEST PROMPT\nReturn one fenced json block.";

let extDir: string;
let artifactDir: string;

beforeAll(async () => {
  extDir = await fs.mkdtemp(path.join(os.tmpdir(), "fractal-run-ext-"));
  await fs.writeFile(path.join(extDir, "triage-prompt.md"), TRIAGE_PROMPT_FIXTURE, "utf-8");
  artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "fractal-run-artifacts-"));
});

afterAll(async () => {
  await fs.rm(extDir, { recursive: true, force: true });
  await fs.rm(artifactDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearTriagePromptCache();
});

function fencedReply(payload: unknown): string {
  return `Triage complete.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

function makeSubagent(replyText: string) {
  return {
    run: vi.fn(async (_params: Record<string, unknown>) => ({ runId: "triage-run-1" })),
    waitForRun: vi.fn(async (_params: Record<string, unknown>) => ({ status: "ok" })),
    getSessionMessages: vi.fn(async (_params: Record<string, unknown>) => ({
      messages: [{ role: "assistant", content: replyText }],
    })),
  };
}

function makeDeps(
  subagent: ReturnType<typeof makeSubagent>,
  ledger?: { recurrenceCount: (kind: string, findingPath: string) => number | Promise<number> },
) {
  return {
    api: { rootDir: extDir, runtime: { subagent } },
    cfg: {} as FractalConfig,
    ledger: ledger ?? { recurrenceCount: vi.fn(() => 0) },
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

const baseMessages = [
  { role: "user", content: "earlier question about apples" },
  { role: "assistant", content: "earlier answer about apples" },
  { role: "user", content: "final question about pears" },
  { role: "assistant", content: "FINAL ANSWER about pears, in full." },
];

function makeInput(parentRunId: string, onPending = vi.fn()) {
  return { parentRunId, sessionKey: "agent:main:main", messages: baseMessages, onPending };
}

describe("readReplyWithBackoff", () => {
  const log = { info: () => {}, warn: () => {} };
  const surface = (reads: unknown[][]) => {
    let i = 0;
    return {
      run: async () => ({ runId: "r" }),
      waitForRun: async () => ({ status: "ok" }),
      getSessionMessages: async () => ({ messages: reads[Math.min(i++, reads.length - 1)] }),
    };
  };
  const assistant = (t: string) => ({ role: "assistant", content: t });
  const user = { role: "user", content: "the triage prompt" };

  it("returns on the first read without sleeping when the transcript is already there", async () => {
    const slept: number[] = [];
    const got = await readReplyWithBackoff({
      subagent: surface([[user, assistant("the verdict")]]),
      sessionKey: "fractal-reflection:x",
      log,
      parentRunId: "x",
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(got.text).toBe("the verdict");
    expect(got.attempts).toBe(1);
    // The common path must not pay the worst case — this is why it is a retry, not a fixed wait.
    expect(slept).toEqual([]);
    expect(got.waitedMs).toBe(0);
  });

  it("recovers the reply when the transcript lags the run's terminal event", async () => {
    // The measured bug: agent.wait returns, sessions.get still has only the prompt. 25 of 45
    // rows died here, and the text was present when re-read afterwards.
    const slept: number[] = [];
    const got = await readReplyWithBackoff({
      subagent: surface([[user], [user], [user, assistant("the late verdict")]]),
      sessionKey: "fractal-reflection:x",
      log,
      parentRunId: "x",
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(got.text).toBe("the late verdict");
    expect(got.attempts).toBe(3);
    expect(slept).toEqual([250, 500]);
    expect(got.waitedMs).toBe(750);
  });

  it("still fails — and says how long it waited — when the reply is genuinely absent", async () => {
    const got = await readReplyWithBackoff({
      subagent: surface([[user]]),
      sessionKey: "fractal-reflection:x",
      log,
      parentRunId: "x",
      backoffMs: [10, 20],
      sleep: async () => {},
    });
    expect(got.text).toBeNull();
    expect(got.attempts).toBe(3);
    expect(got.waitedMs).toBe(30);
  });

  it("survives a throwing read and recovers on the next attempt", async () => {
    let i = 0;
    const flaky = {
      run: async () => ({ runId: "r" }),
      waitForRun: async () => ({ status: "ok" }),
      getSessionMessages: async () => {
        i++;
        if (i === 1) throw new Error("transient store read failure");
        return { messages: [user, assistant("recovered")] };
      },
    };
    const got = await readReplyWithBackoff({
      subagent: flaky,
      sessionKey: "fractal-reflection:x",
      log,
      parentRunId: "x",
      sleep: async () => {},
    });
    expect(got.text).toBe("recovered");
    expect(got.attempts).toBe(2);
  });
});

describe("buildTurnDigest", () => {
  it("orders earlier-turn notes, last user message, then the full final answer, with the cold-arm header", () => {
    const digest = buildTurnDigest(baseMessages);
    expect(digest).toContain("COLD");
    expect(digest).toContain("conservative");
    const note1 = digest.indexOf("earlier question about apples");
    const note2 = digest.indexOf("earlier answer about apples");
    const user = digest.indexOf("final question about pears");
    const answer = digest.indexOf("FINAL ANSWER about pears, in full.");
    expect(note1).toBeGreaterThan(-1);
    expect(note2).toBeGreaterThan(note1);
    expect(user).toBeGreaterThan(note2);
    expect(answer).toBeGreaterThan(user);
  });

  it("never labels the reviewed turn as 'assistant' — the judge IS an assistant and adopts that voice", () => {
    // The bug this pins, reported 2026-08-05: fractal routinely wrote up the MAIN turn's file
    // edits as work it had done ("updated x.ts"). The judge receives the digest inside a single
    // user message; a block headed "## Final assistant answer" and notes tagged "[assistant]"
    // read, to an assistant, as its own prior output. A prompt rule does not survive that pull,
    // so attribution is carried by the LABELS and asserted here — prose can rot, this cannot.
    const digest = buildTurnDigest(baseMessages);

    expect(digest).not.toContain("[assistant]");
    expect(digest).not.toContain("Final assistant answer");
    expect(digest).toContain("[main-agent]");
    expect(digest).toContain("MAIN AGENT");

    // And the header must say plainly whose work it is, before any of it is quoted.
    expect(digest).toContain("ATTRIBUTION");
    expect(digest.indexOf("ATTRIBUTION")).toBeLessThan(
      digest.indexOf("FINAL ANSWER about pears, in full."),
    );
  });

  it("caps the digest at DIGEST_CHAR_CEILING dropping the OLDEST notes first", () => {
    const earlier = Array.from({ length: 120 }, (_, i) => ({
      role: "user",
      content: `earlier turn number ${i} ${"x".repeat(150)}`,
    }));
    const digest = buildTurnDigest([
      ...earlier,
      { role: "user", content: "the final user ask" },
      { role: "assistant", content: "the final assistant answer" },
    ]);
    expect(digest.length).toBeLessThanOrEqual(DIGEST_CHAR_CEILING);
    expect(digest).toContain("the final assistant answer");
    expect(digest).toContain("the final user ask");
    expect(digest).toContain("earlier turn number 119"); // newest note survives
    expect(digest).not.toContain("earlier turn number 0 "); // oldest dropped
  });

  it("keeps the TAIL of an oversized final answer (drops the head)", () => {
    const answer = `HEAD-MARKER ${"y".repeat(9_000)} TAIL-MARKER`;
    const digest = buildTurnDigest([
      { role: "user", content: "q" },
      { role: "assistant", content: answer },
    ]);
    expect(digest.length).toBeLessThanOrEqual(DIGEST_CHAR_CEILING);
    expect(digest).toContain("TAIL-MARKER");
    expect(digest).not.toContain("HEAD-MARKER");
  });
});

describe("parseTriageVerdict", () => {
  it("parses the LAST fenced json block", () => {
    const reply = [
      "```json",
      JSON.stringify({ verdict: "act", headline: "first", findings: [] }),
      "```",
      "…second thoughts…",
      "```json",
      JSON.stringify({ verdict: "clean", headline: "final", findings: [] }),
      "```",
    ].join("\n");
    const parsed = parseTriageVerdict(reply);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.verdict).toBe("clean");
      expect(parsed.headline).toBe("final");
    }
  });

  it("rejects malformed JSON, missing fences, and unknown verdicts", () => {
    expect("error" in parseTriageVerdict("```json\n{ not json }\n```")).toBe(true);
    expect("error" in parseTriageVerdict("no fence at all")).toBe(true);
    expect("error" in parseTriageVerdict('```json\n{"verdict":"maybe"}\n```')).toBe(true);
  });
});

describe("runTriage", () => {
  it("returns a clean row on a clean verdict, spawned with the contract identity", async () => {
    const subagent = makeSubagent(
      fencedReply({ verdict: "clean", headline: "all good", findings: [] }),
    );
    const row = await runTriage(makeDeps(subagent), makeInput("parent-1"));
    expect(row.status).toBe("clean");
    expect(row.parentRunId).toBe("parent-1");
    expect(row.triageRunId).toBe("triage-run-1");
    expect(row.escalated).toBe(false);
    expect(subagent.run).toHaveBeenCalledTimes(1);
    expect(subagent.run.mock.calls[0]?.[0]).toMatchObject({
      lane: "fractal-triage",
      deliver: false,
      sessionKey: "fractal-reflection:parent-1",
      idempotencyKey: "fractal:triage:parent-1",
    });
    const message = String(subagent.run.mock.calls[0]?.[0]?.message ?? "");
    expect(message).toContain("FRACTAL TRIAGE TEST PROMPT"); // prompt + digest
    expect(message).toContain("COLD");
  });

  it("flags a verified finding (quote present on disk) and stamps its recurrence count", async () => {
    const file = path.join(artifactDir, "verified.md");
    await fs.writeFile(file, "alpha\nthe quoted line is here\nomega\n", "utf-8");
    const ledger = { recurrenceCount: vi.fn(() => 3) };
    const subagent = makeSubagent(
      fencedReply({
        verdict: "act",
        headline: "stale doc",
        findings: [
          {
            kind: "staleness-artifact",
            claim: "doc contradicts the shipped behavior",
            path: file,
            quote: "the quoted line is here",
            fix_hint: "update the doc",
            hard: false,
          },
        ],
      }),
    );
    const row = await runTriage(makeDeps(subagent, ledger), makeInput("parent-2"));
    expect(row.status).toBe("flagged"); // Drop 1: never "acted" — no fix lane
    expect(row.findings).toHaveLength(1);
    expect(row.findings?.[0]).toMatchObject({
      kind: "staleness-artifact",
      recurrenceCount: 3,
      path: file,
      quote: "the quoted line is here",
    });
    expect(ledger.recurrenceCount).toHaveBeenCalledWith("staleness-artifact", file);
    expect(row.abstainedFindings).toBe(0);
  });

  it("drops a stale-quote finding into abstainedFindings (quote not on disk)", async () => {
    const file = path.join(artifactDir, "stale.md");
    await fs.writeFile(file, "this file does not contain the claimed text\n", "utf-8");
    const subagent = makeSubagent(
      fencedReply({
        verdict: "act",
        headline: "claim",
        findings: [
          {
            kind: "correctness",
            claim: "wrong on its face",
            path: file,
            quote: "NOT PRESENT ON DISK",
          },
        ],
      }),
    );
    const row = await runTriage(makeDeps(subagent), makeInput("parent-3"));
    expect(row.findings).toHaveLength(0);
    expect(row.abstainedFindings).toBe(1);
    expect(row.status).toBe("clean"); // no surviving finding, verdict act → clean
  });

  it("drops a finding whose file is missing entirely", async () => {
    const subagent = makeSubagent(
      fencedReply({
        verdict: "act",
        headline: "claim",
        findings: [
          {
            kind: "correctness",
            claim: "wrong",
            path: path.join(artifactDir, "does-not-exist.md"),
            quote: "anything",
          },
        ],
      }),
    );
    const row = await runTriage(makeDeps(subagent), makeInput("parent-4"));
    expect(row.findings).toHaveLength(0);
    expect(row.abstainedFindings).toBe(1);
  });

  it("returns a gap row when the verdict is gap and no finding survives", async () => {
    const file = path.join(artifactDir, "gap.md");
    await fs.writeFile(file, "nothing relevant here\n", "utf-8");
    const subagent = makeSubagent(
      fencedReply({
        verdict: "gap",
        headline: "answered owned knowledge from the model's head",
        findings: [
          {
            kind: "gap",
            claim: "should have retrieved from memory",
            path: file,
            quote: "QUOTE NOT ON DISK",
          },
        ],
      }),
    );
    const row = await runTriage(makeDeps(subagent), makeInput("parent-5"));
    expect(row.status).toBe("gap");
    expect(row.abstainedFindings).toBe(1);
  });

  it("returns an error row (never throws) on malformed verdict JSON", async () => {
    const subagent = makeSubagent("I forgot to emit any JSON block.");
    const row = await runTriage(makeDeps(subagent), makeInput("parent-6"));
    expect(row.status).toBe("error");
    expect(row.findings).toHaveLength(0);
  });

  it("emits the pending stub BEFORE spawning the subagent", async () => {
    const order: string[] = [];
    const subagent = makeSubagent(fencedReply({ verdict: "clean", headline: "", findings: [] }));
    subagent.run.mockImplementation(async (_params: Record<string, unknown>) => {
      order.push("spawn");
      return { runId: "triage-run-1" };
    });
    const onPending = vi.fn(() => {
      order.push("pending");
    });
    await runTriage(makeDeps(subagent), makeInput("parent-order", onPending));
    expect(order).toEqual(["pending", "spawn"]);
    expect(onPending.mock.calls[0]?.[0]).toMatchObject({
      status: "pending",
      parentRunId: "parent-order",
    });
  });
});
