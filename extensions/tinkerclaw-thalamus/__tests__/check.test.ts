import { describe, expect, it, vi } from "vitest";
import {
  answered,
  callParams,
  OPUS,
  R,
  stepRead,
  taskRead,
} from "../../../src/shared/thalamus-v4.test-support.js";
import { createCheckService } from "../src/check.js";
import { parseConfig } from "../src/config.js";
import { createFreshRecorder } from "../src/fresh-record.js";
import type { ModelCaller } from "../src/model-caller.js";
import { createRunStates } from "../src/run-state.js";
import { ThalamusStore } from "../src/store.js";

function setup(
  o: {
    mode?: "shadow" | "enforce";
    flag?: boolean;
    base?: Parameters<typeof callParams>[0];
    changed?: boolean;
    caller?: ModelCaller | null;
  } = {},
) {
  const store = new ThalamusStore(":memory:");
  const runs = createRunStates();
  const cfg = parseConfig({ mode: o.mode ?? "enforce", enforce: { check: o.flag ?? true } });
  const queue: Array<() => void> = [];
  const errors: unknown[] = [];
  runs.setBase(
    "run-1",
    callParams({
      incumbentKey: OPUS,
      incumbentEffort: "high",
      rungs: [R.opus, R.sonnet, R.haiku, R.grok],
      ...(o.base ?? {}),
    }),
    { sessionKey: "agent:main:tinker:x" },
  );
  if (o.changed !== false) {
    runs.toolStart("run-1", "t1", "edit", { path: "/src/a.ts", text: "fix" });
    runs.toolResult("run-1", "t1", "edit", "edited /src/a.ts", false);
  }
  const caller = vi.fn<ModelCaller>(async () => ({ text: "HOLDS", input: 3000, output: 4 }));
  const svc = createCheckService({
    cfg: () => cfg,
    runs,
    record: createFreshRecorder({
      cfg: () => cfg,
      store: () => store,
      now: () => 5000,
      defer: (fn) => void queue.push(fn),
      onError: (e) => void errors.push(e),
    }),
    caller: () => (o.caller === null ? undefined : (o.caller ?? caller)),
    onError: (e) => void errors.push(e),
  });
  const flush = () => queue.splice(0).forEach((fn) => fn());
  return { svc, store, runs, caller, errors, flush };
}
const rows = (t: ReturnType<typeof setup>) => t.store.listFreshPoints({ kind: "check" });
const CLAIM = "I fixed the failing test in a.ts and the suite is green.";

describe("shadow: who would check this run, recorded, nothing called", () => {
  it("a run that changed something would be checked by a model of another family", () => {
    const t = setup({ mode: "shadow" });
    t.svc.observeEnd("run-1");
    t.flush();
    expect(rows(t)[0]).toMatchObject({
      acted: false,
      reason: "would-check",
      mode: "shadow",
      family: "xai",
      model: "xai/grok-4.7",
    });
    expect(rows(t)[0].detail).toMatchObject({
      why: "changed-something",
      builder: OPUS,
      builderFamily: "anthropic",
    });
    expect(t.caller).not.toHaveBeenCalled();
  });
  it("a run that changed nothing and claimed nothing leaves no record", () => {
    const t = setup({ mode: "shadow", changed: false });
    t.svc.observeEnd("run-1");
    t.flush();
    expect(rows(t)).toHaveLength(0);
  });
  it("a step read that says it claims something is enough", () => {
    const t = setup({
      mode: "shadow",
      changed: false,
      base: { step: stepRead({ commitsOrClaims: answered(true) }) },
    });
    t.svc.observeEnd("run-1");
    t.flush();
    expect(rows(t)[0].detail).toMatchObject({ why: "commits-or-claims" });
  });
  it("with one family on the board there is no checker, and the record says so", () => {
    const t = setup({ mode: "shadow", base: { rungs: [R.opus, R.sonnet, R.haiku] } });
    t.svc.observeEnd("run-1");
    t.flush();
    expect(rows(t)[0]).toMatchObject({ acted: false, reason: "no-other-family" });
    expect(rows(t)[0].model).toBeUndefined();
  });
  it("a hand-picked model is not second-guessed, and no record is made of a check that will not happen", () => {
    const t = setup({ mode: "shadow", base: { handPicked: true } });
    t.svc.observeEnd("run-1");
    t.flush();
    expect(rows(t)).toHaveLength(0);
  });
  it("a run it has no context for is ignored", () => {
    const t = setup({ mode: "shadow" });
    t.svc.observeEnd("nope");
    t.flush();
    expect(rows(t)).toHaveLength(0);
  });
  it("finalize does nothing in shadow, or in enforce with the flag off", async () => {
    for (const t of [setup({ mode: "shadow" }), setup({ mode: "enforce", flag: false })]) {
      expect(await t.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM })).toBeUndefined();
      expect(t.caller).not.toHaveBeenCalled();
    }
  });
});

describe("enforce with the flag on", () => {
  it("PROBLEMS asks the agent for one more pass, with the finding as the reason", async () => {
    const t = setup({
      caller: async () => ({
        text: "PROBLEMS: the test still fails on line 40",
        input: 3000,
        output: 12,
      }),
    });
    const out = await t.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM });
    expect(out).toMatchObject({ action: "revise" });
    expect(out!.reason).toContain("the test still fails on line 40");
    t.flush();
    expect(rows(t)[0]).toMatchObject({ acted: true, reason: "problems", family: "xai" });
    expect(rows(t)[0].detail).toMatchObject({ checkerInput: 3000, checkerOutput: 12 });
    expect(JSON.stringify(rows(t)[0])).not.toContain("line 40");
    expect(t.runs.get("run-1")!.others).toBe(1);
  });
  it("HOLDS lets the run finish", async () => {
    const t = setup();
    expect(await t.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM })).toBeUndefined();
    t.flush();
    expect(rows(t)[0]).toMatchObject({ acted: true, reason: "holds" });
  });
  it("an answer that is neither is unclear and changes nothing", async () => {
    const t = setup({ caller: async () => ({ text: "Looks fine to me." }) });
    expect(await t.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM })).toBeUndefined();
    t.flush();
    expect(rows(t)[0].reason).toBe("unclear");
  });
  it("the checker is handed the work and the claim, from another family, and not asked for more than it needs", async () => {
    const t = setup();
    await t.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM });
    const req = t.caller.mock.calls[0][0];
    expect(req.modelKey).toBe("xai/grok-4.7");
    expect(req.prompt).toContain(`CLAIM:\n${CLAIM}`);
    expect(req.prompt).toContain("edit");
    expect(req.prompt).toContain("edited /src/a.ts");
    expect(req.prompt).toContain("[changes something]");
    expect(req.maxTokens).toBeLessThanOrEqual(1000);
    expect(req.timeoutMs).toBe(20_000);
  });
  it("only one round: a finalize that is already a second attempt is left alone", async () => {
    const t = setup();
    expect(
      await t.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM, stopHookActive: true }),
    ).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
  });
  it("no claim to check, no call", async () => {
    const t = setup();
    expect(await t.svc.finalize({ runId: "run-1", lastAssistantMessage: "  " })).toBeUndefined();
    expect(await t.svc.finalize({ lastAssistantMessage: CLAIM })).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
  });
  it("a hand-picked model is never checked", async () => {
    const t = setup({ base: { handPicked: true } });
    expect(await t.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM })).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
  });
  it("a private task never reaches a provider that is not approved: with only the builder's family approved there is no checker", async () => {
    const t = setup({
      base: { task: taskRead({ private: true }), approvedProviders: ["claude-code"] },
    });
    expect(await t.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM })).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
    t.flush();
    expect(rows(t)[0]).toMatchObject({ acted: false, reason: "no-other-family" });
  });
  it("a checker that fails or throws lets the run finish", async () => {
    const failed = setup({ caller: async () => undefined });
    expect(
      await failed.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM }),
    ).toBeUndefined();
    failed.flush();
    expect(rows(failed)[0].reason).toBe("checker-failed");
    const boom = setup({
      caller: async () => {
        throw new Error("x");
      },
    });
    expect(
      await boom.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM }),
    ).toBeUndefined();
    expect(boom.errors).toHaveLength(1);
  });
  it("with no caller at all the run finishes and the record says so", async () => {
    const t = setup({ caller: null });
    expect(await t.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM })).toBeUndefined();
    t.flush();
    expect(rows(t)[0].reason).toBe("no-caller");
  });
  it("a PROBLEMS with nothing after it changes nothing", async () => {
    const t = setup({ caller: async () => ({ text: "PROBLEMS:" }) });
    expect(await t.svc.finalize({ runId: "run-1", lastAssistantMessage: CLAIM })).toBeUndefined();
  });
});
