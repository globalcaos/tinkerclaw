import { describe, expect, it } from "vitest";
import {
  buildDecisionEvents,
  buildInterventionEvent,
  codeDidFor,
  isWeak,
  parseDrivers,
  stepLabel,
  withDrivers,
} from "../src/events.js";
import { QuestionBook } from "../src/question-book.js";
import { buildSituation } from "../src/situation.js";
import type { Decision, Verdict } from "../src/types.js";

const book = new QuestionBook({ seedDir: new URL("../questions", import.meta.url).pathname });
const s = buildSituation(
  {
    seam: "pre-tool",
    sessionKey: "sess",
    turnId: "t1",
    now: 1000,
    tool: "Bash",
    toolInput: { command: "rm -rf ./x" },
  },
  { workspaceRoot: "/w", homeDir: "/h" },
);
const v = (questionId: string, extra: Partial<Verdict> = {}): Verdict => ({
  id: `v-${questionId}`,
  situationId: s.id,
  questionId,
  questionVersion: 1,
  type: "score",
  answer: 3,
  prob: 1,
  confidence: 0.9,
  cacheHit: false,
  latencyMs: 120,
  tokensIn: 100,
  tokensOut: 5,
  costUsd: 0,
  ts: 1000,
  ...extra,
});
const decision: Decision = {
  situationId: s.id,
  response: { kind: "hold", ruleOrQuestion: "danger-level", releasable: "user-only" },
  family: "safety",
  reasonCode: withDrivers("table-d3-high", ["danger-level"]),
  verdictIds: ["v-danger-level", "v-runs-or-quotes"],
  mode: "enforce",
  enforced: true,
  degraded: false,
};

describe("events", () => {
  it("drivers round-trip through the reason code", () => {
    expect(parseDrivers(withDrivers("c", ["a", "b"]))).toEqual(["a", "b"]);
    expect(parseDrivers("plain")).toEqual([]);
    expect(parseDrivers(withDrivers("c", []))).toEqual([]);
  });
  it("codeDid names what code did", () => {
    expect(
      ["hold", "send-back", "proceed", "note", "proof", "ask"].map((k) => codeDidFor(k as never)),
    ).toEqual(["held", "sent-back", "ok", "note", "proof", "ask"]);
  });
  it("one event per ANSWERED question; drivers carry the action, the rest are ok; skipped are omitted", () => {
    const events = buildDecisionEvents({
      situation: s,
      decision,
      decisionId: "d1",
      book,
      interventionId: "iv1",
      verdicts: [
        v("danger-level"),
        v("runs-or-quotes", { type: "noul", answer: 0.96, prob: 0.96 }),
        v("data-tier", { skipped: "timeout" }),
      ],
    });
    expect(events.map((e) => [e.questionId, e.codeDid])).toEqual([
      ["danger-level", "held"],
      ["runs-or-quotes", "ok"],
    ]);
    expect(events[0].questionName).toBe("Danger level: how hard is this step to undo?");
    expect(events[0].interventionId).toBe("iv1");
    // A vote on a would-be change targets its decision (2026-10-02); only drivers carry it.
    expect(events[0].decisionId).toBe("d1");
    expect(events[1].decisionId).toBeUndefined();
    expect(events[1].interventionId).toBeUndefined();
    expect(JSON.stringify(events)).not.toMatch(/instructions/);
    expect(events[0].stepLabel).toBe("Bash rm -rf ./x");
  });
  it("weak = more than half of the fields the question reads are inferred", () => {
    expect(
      isWeak(
        {
          ...s,
          restatement: { value: "r", origin: "inferred" },
          request: { value: "q", origin: "derived" },
        },
        ["restatement", "request"],
      ),
    ).toBe(false);
    expect(
      isWeak(
        {
          ...s,
          restatement: { value: "r", origin: "inferred" },
          expectation: { value: "e", origin: "inferred" },
          request: { value: "q", origin: "derived" },
        },
        ["restatement", "expectation", "request"],
      ),
    ).toBe(true);
  });
  it("intervention event: none for proceed; hold has the command and effect chip", () => {
    expect(
      buildInterventionEvent({
        situation: s,
        verdicts: [],
        decisionId: "d",
        book,
        decision: { ...decision, response: { kind: "proceed" } },
        state: "settled",
      }),
    ).toBeNull();
    const e = buildInterventionEvent({
      situation: s,
      verdicts: [],
      decisionId: "d",
      book,
      interventionId: "iv1",
      decision,
      state: "open",
    });
    expect(e).toMatchObject({ id: "iv1", kind: "hold", state: "open", cmd: "rm -rf ./x" });
    expect(e?.chips).toContain("effect: delete");
  });
  it("stepLabel truncates", () => {
    const long = buildSituation(
      {
        seam: "pre-tool",
        sessionKey: "a",
        turnId: "b",
        now: 1,
        tool: "Bash",
        toolInput: { command: "echo " + "x".repeat(200) },
      },
      { workspaceRoot: "/w", homeDir: "/h" },
    );
    expect(stepLabel(long).length).toBe(80);
  });
});
