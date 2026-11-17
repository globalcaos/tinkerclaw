import { describe, expect, it, vi } from "vitest";
import { defaults } from "./settings.js";
import {
  SUGGEST_MAX_MS,
  SuggestRuns,
  lastAssistantText,
  modelProblem,
  parseProposal,
  suggestPrompt,
  type SuggestSubagent,
} from "./suggest.js";

const CFG = { agents: { defaults: { model: { primary: "anthropic/sonnet-4.6" } } } };
const ANSWER = {
  role: "assistant",
  content: [
    {
      type: "text",
      text: 'Here it is:\n{"objective":"backlog","strategy":"one parked project a night\\nverify with its tests","why":"many parked projects"}',
    },
  ],
};

function fakeSubagent(over: Partial<SuggestSubagent> = {}): SuggestSubagent {
  return {
    run: vi.fn(async () => ({ runId: "run-1" })),
    waitForRun: vi.fn(async () => ({ status: "ok" })),
    getSessionMessages: vi.fn(async () => ({ messages: [{ role: "user", content: "x" }, ANSWER] })),
    deleteSession: vi.fn(async () => {}),
    ...over,
  };
}

describe("modelProblem", () => {
  it("is null with a default model and explains itself without one", () => {
    expect(modelProblem(CFG)).toBeNull();
    expect(modelProblem({ agents: { defaults: { model: "openai/gpt-5.4" } } })).toBeNull();
    expect(modelProblem({})).toMatch(/No model is set/);
    expect(modelProblem(undefined)).toMatch(/Config/);
  });
});

describe("parseProposal", () => {
  it("reads the JSON object out of the agent's text", () => {
    const p = parseProposal(lastAssistantText([ANSWER]));
    expect(p).toEqual({
      objective: "backlog",
      customName: "",
      strategy: "one parked project a night\nverify with its tests",
      why: "many parked projects",
    });
  });

  it("refuses answers that cannot become settings", () => {
    expect(() => parseProposal("no json here")).toThrow(/did not answer/);
    expect(() => parseProposal('{"objective":"fame","strategy":"x"}')).toThrow(/not on the list/);
    expect(() => parseProposal('{"objective":"code","strategy":""}')).toThrow(/no strategy/);
    expect(() => parseProposal('{"objective":"custom","strategy":"x"}')).toThrow(/without a name/);
  });
});

describe("suggestPrompt", () => {
  it("lists every objective id and asks for JSON only", () => {
    const text = suggestPrompt(defaults("/state"));
    for (const id of ["revenue", "code", "research", "backlog", "custom"]) {
      expect(text).toContain(`- ${id}:`);
    }
    expect(text).toMatch(/one JSON object and nothing else/);
  });
});

describe("SuggestRuns", () => {
  it("starts a run, reports it running, then hands back the proposal and cleans up", async () => {
    let status = "timeout";
    const sub = fakeSubagent({ waitForRun: vi.fn(async () => ({ status })) });
    const runs = new SuggestRuns(
      () => sub,
      () => 1_000,
    );
    const started = await runs.start(CFG, defaults("/state"));
    expect(started).toEqual({ ok: true, runId: "run-1" });
    expect(sub.run).toHaveBeenCalledWith(
      expect.objectContaining({ deliver: false, sessionKey: "token-burner-suggest-1000" }),
    );
    expect(await runs.poll("run-1")).toEqual({ status: "running", startedAt: 1_000 });
    status = "ok";
    const done = await runs.poll("run-1");
    expect(done.status).toBe("done");
    expect(sub.deleteSession).toHaveBeenCalledWith({ sessionKey: "token-burner-suggest-1000" });
    expect((await runs.poll("run-1")).status).toBe("failed");
  });

  it("explains instead of starting when no model is set", async () => {
    const sub = fakeSubagent();
    const out = await new SuggestRuns(() => sub).start({}, defaults("/state"));
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/No model/) });
    expect(sub.run).not.toHaveBeenCalled();
  });

  it("explains a spawn error and refuses a second run while one is going", async () => {
    const broken = fakeSubagent({ run: vi.fn(async () => Promise.reject(new Error("no auth"))) });
    expect(await new SuggestRuns(() => broken).start(CFG, defaults("/s"))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/could not start: no auth/),
    });
    const runs = new SuggestRuns(
      () => fakeSubagent(),
      () => 0,
    );
    await runs.start(CFG, defaults("/s"));
    expect(await runs.start(CFG, defaults("/s"))).toMatchObject({ ok: false });
  });

  it("gives up after the time limit and never polls an id it did not hand out", async () => {
    let now = 0;
    const sub = fakeSubagent({ waitForRun: vi.fn(async () => ({ status: "timeout" })) });
    const runs = new SuggestRuns(
      () => sub,
      () => now,
    );
    await runs.start(CFG, defaults("/s"));
    now = SUGGEST_MAX_MS + 1;
    expect(await runs.poll("run-1")).toMatchObject({ status: "failed" });
    expect(await runs.poll("someone-else")).toMatchObject({ status: "failed" });
    expect(sub.getSessionMessages).not.toHaveBeenCalled();
  });

  it("reports a bad answer as failed", async () => {
    const sub = fakeSubagent({
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "assistant", content: "sorry" }],
      })),
    });
    const runs = new SuggestRuns(() => sub);
    await runs.start(CFG, defaults("/s"));
    expect(await runs.poll("run-1")).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/No proposal/),
    });
  });
});
