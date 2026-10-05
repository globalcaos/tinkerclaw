import { describe, expect, it } from "vitest";
import type { JevVerdict } from "../infra/jev/types.js";
import { classifySubject } from "./thalamus-feasibility.js";
import { classifyTaskDomain } from "./thalamus-frontier.js";
import {
  answeredChoice,
  answeredNoul,
  answeredScore,
  CAUTIOUS,
  LOCAL_CONFIDENCE,
  localOutcomeRead,
  localStepRead,
  localTaskRead,
  outcomeReadFromVerdicts,
  READ_CONFIDENCE_FLOOR,
  stepReadFromVerdicts,
  taskReadFromVerdicts,
  TOPIC_CLASSES,
  WORK_KINDS,
} from "./thalamus-reads.js";
import { routeCall, stepUnsure, topicUnsure } from "./thalamus-route-call.js";
import { callParams, NOW, OPUS } from "./thalamus-v4.test-support.js";

const v = (
  questionId: string,
  type: JevVerdict["type"],
  answer: string | number,
  confidence = 0.9,
  extra: Partial<JevVerdict> = {},
): JevVerdict => ({
  id: `v-${questionId}`,
  situationId: "s",
  questionId,
  questionVersion: 1,
  type,
  answer,
  prob: 0.9,
  confidence,
  cacheHit: false,
  latencyMs: 100,
  tokensIn: 10,
  tokensOut: 0,
  costUsd: 0,
  ts: NOW,
  ...extra,
});

const env = { id: "r1", ts: NOW, sessionKey: "s" };
const stepEnv = { ...env, callIndex: 4 };

describe("verdict -> answer", () => {
  it("takes a choice from the allowed options, with its confidence and source", () => {
    expect(
      answeredChoice(v("q", "choice", "waiting"), ["waiting", "today", "whenever"], "today"),
    ).toEqual({
      value: "waiting",
      conf: 0.9,
      source: "jev",
    });
  });

  it("falls back to the cautious value when the verdict is missing, skipped, of the wrong type or off-list", () => {
    const allowed = ["waiting", "today", "whenever"] as const;
    for (const bad of [
      undefined,
      v("q", "choice", "waiting", 0.9, { skipped: "timeout" }),
      v("q", "score", 1),
      v("q", "choice", "tomorrow"),
    ]) {
      expect(answeredChoice(bad, allowed, "today")).toMatchObject({
        value: "today",
        conf: 0,
        source: "fallback",
      });
    }
  });

  it("falls back, keeping the confidence it had, when the answer is below the floor", () => {
    const a = answeredChoice(v("q", "choice", "waiting", 0.3), ["waiting", "today"], "today");
    expect(a).toEqual({ value: "today", conf: 0.3, source: "fallback" });
    expect(
      answeredChoice(
        v("q", "choice", "waiting", READ_CONFIDENCE_FLOOR),
        ["waiting", "today"],
        "today",
      ).source,
    ).toBe("jev");
  });

  it("maps a score level onto its value, and rejects a level far outside the scale", () => {
    expect(answeredScore(v("q", "score", 0), 5, 1, 4)).toMatchObject({ value: 1, source: "jev" });
    expect(answeredScore(v("q", "score", 4), 5, 1, 4)).toMatchObject({ value: 5 });
    expect(answeredScore(v("q", "score", 6), 5, 1, 4)).toMatchObject({
      value: 4,
      source: "fallback",
    });
    expect(answeredScore(v("q", "score", -2), 5, 1, 4).source).toBe("fallback");
  });

  it("rounds the fractional level Jev really returns to the nearest level, and keeps a clamp for the ends", () => {
    // Measured live: Jev answers 3.24, 2.08, 3.88, not whole levels.
    expect(answeredScore(v("q", "score", 3.24), 5, 1, 4)).toMatchObject({
      value: 4,
      source: "jev",
    });
    expect(answeredScore(v("q", "score", 3.5), 5, 1, 4)).toMatchObject({ value: 5, source: "jev" });
    expect(answeredScore(v("q", "score", 2.08), 5, 1, 4)).toMatchObject({ value: 3 });
    // 4.88 on a 0..4 scale rounds to 5, one past the top: clamped to the top level.
    expect(answeredScore(v("q", "score", 4.88), 5, 1, 4)).toMatchObject({
      value: 5,
      source: "jev",
    });
    expect(answeredScore(v("q", "score", -0.4), 5, 1, 4)).toMatchObject({
      value: 1,
      source: "jev",
    });
    // Far outside the scale is a malformed answer, not an extreme one.
    for (const bad of [6, 9, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(answeredScore(v("q", "score", bad), 5, 1, 4)).toMatchObject({
        value: 4,
        source: "fallback",
      });
    }
    // The confidence floor still applies to a rounded answer.
    expect(answeredScore(v("q", "score", 3.24, 0.3), 5, 1, 4).source).toBe("fallback");
  });

  it("derives a true/false confidence from the probability, because Jev sends none", () => {
    // Measured live: the client sets confidence 0 for a noul. Sure = distance from a coin toss: max(p, 1 - p).
    expect(answeredNoul(v("q", "noul", 0.95, 0), false)).toMatchObject({
      value: true,
      conf: 0.95,
      source: "jev",
    });
    expect(answeredNoul(v("q", "noul", 0.05, 0), true)).toMatchObject({
      value: false,
      conf: 0.95,
      source: "jev",
    });
    expect(answeredNoul(v("q", "noul", 0.7, 0), false)).toMatchObject({
      value: true,
      source: "jev",
    });
    // The middle reads as unsure: below the floor it falls back to the cautious value.
    expect(answeredNoul(v("q", "noul", 0.5, 0), true)).toMatchObject({
      value: true,
      conf: 0.5,
      source: "fallback",
    });
    expect(answeredNoul(v("q", "noul", 0.55, 0), false)).toMatchObject({
      value: false,
      source: "fallback",
    });
    // A confidence the vendor does send can only lower it, never raise it.
    expect(answeredNoul(v("q", "noul", 0.95, 0.4), false)).toMatchObject({
      conf: 0.4,
      source: "fallback",
    });
    // Not a probability: fallback.
    expect(answeredNoul(v("q", "noul", 1.4, 0), false).source).toBe("fallback");
    expect(answeredNoul(v("q", "noul", Number.NaN, 0), false).source).toBe("fallback");
  });

  it("reads a noul as more likely true than not", () => {
    expect(answeredNoul(v("q", "noul", 0.8), false)).toMatchObject({ value: true, source: "jev" });
    expect(answeredNoul(v("q", "noul", 0.2), true)).toMatchObject({ value: false, source: "jev" });
    expect(answeredNoul(v("q", "noul", 0.8, 0.2), false)).toMatchObject({
      value: false,
      source: "fallback",
    });
    expect(answeredNoul(undefined, true)).toMatchObject({ value: true, source: "fallback" });
  });
});

describe("the task read", () => {
  const good = [
    v("route-work-kind", "choice", "code"),
    v("route-difficulty", "score", 3),
    v("route-topic-class", "choice", "security"),
    v("route-urgency", "choice", "waiting"),
    v("route-shape", "choice", "parts"),
  ];

  it("builds a read from a full set of verdicts", () => {
    const r = taskReadFromVerdicts(env, good, false);
    expect(r.kind.value).toBe("code");
    expect(r.difficulty.value).toBe(4);
    expect(r.topic.value).toBe("security");
    expect(r.urgency.value).toBe("waiting");
    expect(r.shape.value).toBe("parts");
    expect(r.private).toBe(false);
    expect(topicUnsure(r)).toBe(false);
  });

  it("is entirely cautious when Jev was silent, and the router treats it as unsure", () => {
    const r = taskReadFromVerdicts(env, [], false);
    expect(r.kind).toMatchObject({ value: CAUTIOUS.kind, source: "fallback" });
    expect(r.difficulty.value).toBe(CAUTIOUS.difficulty);
    expect(r.topic).toMatchObject({ value: "none", source: "fallback" });
    expect(topicUnsure(r)).toBe(true);
  });

  it("is cautious answer by answer when only some are below the floor", () => {
    const r = taskReadFromVerdicts(
      env,
      [...good.slice(0, 2), v("route-topic-class", "choice", "none", 0.2), ...good.slice(3)],
      false,
    );
    expect(r.kind.source).toBe("jev");
    expect(r.topic.source).toBe("fallback");
    expect(topicUnsure(r)).toBe(true);
  });

  it("carries the privacy decision it was given", () => {
    expect(taskReadFromVerdicts(env, good, true).private).toBe(true);
  });

  it("accepts every work kind and topic class the router knows", () => {
    for (const k of WORK_KINDS) {
      expect(taskReadFromVerdicts(env, [v("route-work-kind", "choice", k)], false).kind.value).toBe(
        k,
      );
    }
    for (const t of TOPIC_CLASSES) {
      expect(
        taskReadFromVerdicts(env, [v("route-topic-class", "choice", t)], false).topic.value,
      ).toBe(t);
    }
  });
});

describe("the step read", () => {
  const good = [
    v("step-kind", "choice", "read"),
    v("step-depth", "score", 0),
    v("step-context-need", "choice", "item"),
    v("step-run-length", "score", 3),
    v("step-commits-or-claims", "noul", 0.1),
    v("step-parallel-ok-1", "noul", 0.9),
    v("step-parallel-ok-2", "noul", 0.1),
  ];

  it("builds a read, mapping the depth score onto its name", () => {
    const r = stepReadFromVerdicts(stepEnv, good, ["a", "b"]);
    expect(r.kind.value).toBe("read");
    expect(r.depth.value).toBe("mechanical");
    expect(r.needs.value).toBe("item");
    expect(r.runLength.value).toBe(3);
    expect(r.commitsOrClaims.value).toBe(false);
    expect(r.parallelOk.a.value).toBe(true);
    expect(r.parallelOk.b.value).toBe(false);
    expect(r.callIndex).toBe(4);
    expect(stepUnsure(r)).toBe(false);
  });

  it("maps all three depth levels", () => {
    for (const [score, name] of [
      [0, "mechanical"],
      [1, "routine"],
      [2, "deep"],
    ] as const) {
      expect(stepReadFromVerdicts(stepEnv, [v("step-depth", "score", score)]).depth.value).toBe(
        name,
      );
    }
  });

  it("is cautious when Jev is silent: deep, the whole thread, no run ahead, assumed to commit", () => {
    const r = stepReadFromVerdicts(stepEnv, []);
    expect(r.depth).toMatchObject({ value: "deep", source: "fallback" });
    expect(r.needs.value).toBe("all");
    expect(r.runLength.value).toBe(0);
    expect(r.commitsOrClaims.value).toBe(true);
    expect(r.parallelOk).toEqual({});
    expect(stepUnsure(r)).toBe(true);
  });

  it("treats an unanswered pending item as not parallel", () => {
    const r = stepReadFromVerdicts(
      stepEnv,
      [v("step-parallel-ok-1", "noul", 0.9, 0.1)],
      ["a", "b"],
    );
    expect(r.parallelOk.a).toMatchObject({ value: false, source: "fallback" });
    expect(r.parallelOk.b).toMatchObject({ value: false, source: "fallback" });
  });
});

describe("the outcome read", () => {
  it("reads the state from Jev", () => {
    expect(
      outcomeReadFromVerdicts(stepEnv, [v("outcome-state", "choice", "retry")]).state.value,
    ).toBe("retry");
  });

  it("is `stuck` from the repeated-error count alone, without a verdict", () => {
    expect(outcomeReadFromVerdicts(stepEnv, [], 2).state).toEqual({
      value: "stuck",
      conf: 1,
      source: "local",
    });
    expect(
      outcomeReadFromVerdicts(stepEnv, [v("outcome-state", "choice", "done")], 3).state.value,
    ).toBe("stuck");
    expect(
      outcomeReadFromVerdicts(stepEnv, [v("outcome-state", "choice", "done")], 1).state.value,
    ).toBe("done");
  });

  it("asks for a check when Jev is silent", () => {
    expect(outcomeReadFromVerdicts(stepEnv, [], 0).state).toMatchObject({
      value: "check",
      source: "fallback",
    });
  });
});

describe("local rules", () => {
  const text =
    "Please implement the retry logic and fix the bug in the uploader, then run the tests.";

  it("reuse v2's classifiers, so the shadow data stays comparable", () => {
    const r = localTaskRead({ ...env, text, private: true });
    expect(r.kind.value).toBe(classifyTaskDomain(text));
    expect(r.topic.value).toBe(classifySubject(text));
    expect(r.private).toBe(true);
  });

  it("put a person waiting on a user turn and nobody on background work", () => {
    expect(localTaskRead({ ...env, text, trigger: "user", private: false }).urgency.value).toBe(
      "waiting",
    );
    for (const t of ["cron", "heartbeat", "background"]) {
      expect(localTaskRead({ ...env, text, trigger: t, private: false }).urgency.value).toBe(
        "whenever",
      );
    }
  });

  it("read a list of items as parts and a short question as one answer", () => {
    const list = "Check these:\n- one\n- two\n- three\n";
    expect(localTaskRead({ ...env, text: list, private: false }).shape.value).toBe("parts");
    expect(localTaskRead({ ...env, text: "What is a mutex?", private: false }).shape.value).toBe(
      "answer",
    );
    expect(localTaskRead({ ...env, text, private: false }).shape.value).toBe("chain");
  });

  it("rate research harder than a lookup", () => {
    const hard = localTaskRead({
      ...env,
      text: "Prove the bound and derive the constant.",
      private: false,
    });
    const easy = localTaskRead({ ...env, text: "What time is it in Tokyo?", private: false });
    expect(hard.difficulty.value).toBeGreaterThan(easy.difficulty.value);
  });

  it("sit below the confidence floor, on purpose", () => {
    expect(LOCAL_CONFIDENCE).toBeLessThan(READ_CONFIDENCE_FLOOR);
    const r = localTaskRead({ ...env, text, private: false });
    expect(r.kind).toMatchObject({ conf: LOCAL_CONFIDENCE, source: "local" });
    expect(topicUnsure(r)).toBe(true);
    expect(stepUnsure(localStepRead({ ...stepEnv, toolName: "Read" }))).toBe(true);
  });

  it("classify a step from its tool name and the harness's own effect class", () => {
    expect(localStepRead({ ...stepEnv, toolName: "Read" }).kind.value).toBe("read");
    expect(localStepRead({ ...stepEnv, toolName: "Edit" }).kind.value).toBe("write");
    expect(localStepRead({ ...stepEnv, toolName: "Task" }).kind.value).toBe("plan");
    expect(localStepRead({ ...stepEnv, toolName: "Bash" }).kind.value).toBe("tool");
    expect(
      localStepRead({ ...stepEnv, toolName: "Bash", external: true }).commitsOrClaims.value,
    ).toBe(true);
    expect(localStepRead({ ...stepEnv, toolName: "Read" }).commitsOrClaims.value).toBe(false);
    expect(localStepRead({ ...stepEnv, toolName: "Write" }).commitsOrClaims.value).toBe(true);
  });

  it("read an outcome from what the harness saw", () => {
    const o = (over: Partial<Parameters<typeof localOutcomeRead>[0]>) =>
      localOutcomeRead({ ...stepEnv, ...over });
    expect(o({}).state.value).toBe("done");
    expect(o({ failed: true }).state.value).toBe("retry");
    expect(o({ refused: true }).state.value).toBe("refused");
    expect(o({ repeatedErrors: 2 }).state).toMatchObject({ value: "stuck", conf: 1 });
  });
});

describe("reads fed to routeCall", () => {
  it("a silent Jev gives a cautious decision: the whole thread, no switch", () => {
    const task = taskReadFromVerdicts(env, [], false);
    const step = stepReadFromVerdicts(stepEnv, []);
    const d = routeCall(callParams({ task, step }))!;
    expect(d.degraded).toBe(true);
    expect(d.options.every((o) => o.feed === "thread")).toBe(true);
    expect(d.switch.kind).toBe("keep");
    expect(d.chosen.rung.key).toBe(OPUS);
  });

  it("local reads give the same cautious decision", () => {
    const task = localTaskRead({
      ...env,
      text: "Summarise this contract clause by clause.",
      private: true,
    });
    const step = localStepRead({ ...stepEnv, toolName: "Read" });
    const d = routeCall(callParams({ task, step }))!;
    expect(d.degraded).toBe(true);
    expect(d.switch.kind).toBe("keep");
    expect(d.options.every((o) => o.feed === "thread")).toBe(true);
  });
});
