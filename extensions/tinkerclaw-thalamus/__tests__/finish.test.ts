import { describe, expect, it, vi } from "vitest";
import {
  callParams,
  GROK,
  OPUS,
  R,
  taskRead,
} from "../../../src/shared/thalamus-v4.test-support.js";
import { parseConfig } from "../src/config.js";
import { createFinishService } from "../src/finish.js";
import { createFreshRecorder } from "../src/fresh-record.js";
import type { ModelCaller } from "../src/model-caller.js";
import { createRunStates } from "../src/run-state.js";
import { ThalamusStore } from "../src/store.js";

const CONTENT =
  "Deployed build 20260930 to https://example.com/x and ran `pnpm test`: 1,204 passed, none failed. " +
  "The digest reader condensed two long results and the checker from another family agreed with the summary. " +
  "Nothing else changed in the repository.";

function setup(
  o: {
    mode?: "shadow" | "enforce";
    flag?: boolean;
    base?: Parameters<typeof callParams>[0];
    others?: number;
    preferred?: string[];
    caller?: ModelCaller | null;
  } = {},
) {
  const store = new ThalamusStore(":memory:");
  const runs = createRunStates();
  const cfg = parseConfig({
    mode: o.mode ?? "enforce",
    enforce: { finish: o.flag ?? true },
    finish: { preferred: { default: o.preferred ?? [GROK] } },
  });
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
  for (let n = 0; n < (o.others ?? 1); n++) runs.noteOther("run-1");
  const caller = vi.fn<ModelCaller>(async () => ({ text: `${CONTENT}\n`, input: 800, output: 90 }));
  const svc = createFinishService({
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
const rows = (t: ReturnType<typeof setup>) => t.store.listFreshPoints({ kind: "finish" });

describe("shadow: which writer would finish the run, recorded, nothing called", () => {
  it("names the writer and the basis, and whether it is the builder", () => {
    const t = setup({ mode: "shadow" });
    t.svc.observeEnd("run-1");
    t.flush();
    expect(rows(t)[0]).toMatchObject({
      acted: false,
      reason: "would-write",
      model: GROK,
      mode: "shadow",
    });
    expect(rows(t)[0].detail).toMatchObject({
      basis: "preferred",
      builder: OPUS,
      sameAsBuilder: false,
    });
    expect(t.caller).not.toHaveBeenCalled();
  });
  it("without a preferred list the best quality wins", () => {
    const t = setup({ mode: "shadow", preferred: [] });
    t.svc.observeEnd("run-1");
    t.flush();
    expect(rows(t)[0].detail).toMatchObject({ basis: "best-quality" });
  });
  it("a hand-picked model is recorded as such, and no writer is named", () => {
    const t = setup({ mode: "shadow", base: { handPicked: true } });
    t.svc.observeEnd("run-1");
    t.flush();
    expect(rows(t)[0]).toMatchObject({ acted: false, reason: "hand-picked" });
    expect(rows(t)[0].model).toBeUndefined();
  });
  it("rewrite does nothing in shadow, or in enforce with the flag off", async () => {
    for (const t of [setup({ mode: "shadow" }), setup({ mode: "enforce", flag: false })]) {
      expect(await t.svc.rewrite(CONTENT, { runId: "run-1" })).toBeUndefined();
      expect(t.caller).not.toHaveBeenCalled();
    }
  });
});

describe("enforce with the flag on", () => {
  it("puts the content into the one writer's words and records it", async () => {
    const t = setup({
      caller: async () => ({
        text: CONTENT.replace("Deployed", "I deployed"),
        input: 800,
        output: 90,
      }),
    });
    const out = await t.svc.rewrite(CONTENT, { runId: "run-1" });
    expect(out).toContain("I deployed build 20260930");
    t.flush();
    expect(rows(t)[0]).toMatchObject({ acted: true, reason: "rewritten", model: GROK });
    expect(rows(t)[0].detail).toMatchObject({ writerInput: 800, writerOutput: 90 });
    expect(JSON.stringify(rows(t)[0])).not.toContain("build 20260930");
    expect(t.runs.get("run-1")!.writer).toBe(GROK);
  });
  it("asks the chosen writer for the language of the content, with the content", async () => {
    const t = setup();
    await t.svc.rewrite(CONTENT, { runId: "run-1" });
    const req = t.caller.mock.calls[0][0];
    expect(req.modelKey).toBe(GROK);
    expect(req.prompt).toContain("English");
    expect(req.prompt).toContain(`CONTENT:\n${CONTENT}`);
  });
  it("a rewrite that loses a fact is thrown away and the original goes out", async () => {
    const t = setup({ caller: async () => ({ text: CONTENT.replace("1,204", "many") }) });
    expect(await t.svc.rewrite(CONTENT, { runId: "run-1" })).toBeUndefined();
    t.flush();
    expect(rows(t)[0]).toMatchObject({ acted: false, reason: "rewrite-rejected" });
    expect(rows(t)[0].detail).toMatchObject({ because: "lost:number:1204" });
    expect(t.runs.get("run-1")!.writer).toBeUndefined();
  });
  it("the run keeps its writer: a later message goes to the same one", async () => {
    const t = setup();
    await t.svc.rewrite(CONTENT, { runId: "run-1" });
    expect(t.runs.get("run-1")!.writer).toBe(GROK);
    await t.svc.rewrite(CONTENT + " More.", { runId: "run-1" });
    expect(t.caller.mock.calls.map((c) => c[0].modelKey)).toEqual([GROK, GROK]);
  });
  it("when the writer is the model that wrote the content there is nothing to do", async () => {
    const t = setup({ preferred: [OPUS] });
    expect(await t.svc.rewrite(CONTENT, { runId: "run-1" })).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
    t.flush();
    expect(rows(t)[0].reason).toBe("writer-is-builder");
  });
  it("a run no other model worked on, and a short message, are left alone", async () => {
    const alone = setup({ others: 0 });
    expect(await alone.svc.rewrite(CONTENT, { runId: "run-1" })).toBeUndefined();
    const short = setup();
    expect(await short.svc.rewrite("Done.", { runId: "run-1" })).toBeUndefined();
    expect(alone.caller).not.toHaveBeenCalled();
    expect(short.caller).not.toHaveBeenCalled();
  });
  it("no run id, or a run it does not know, is left alone", async () => {
    const t = setup();
    expect(await t.svc.rewrite(CONTENT, {})).toBeUndefined();
    expect(await t.svc.rewrite(CONTENT, { runId: "nope" })).toBeUndefined();
  });
  it("a hand-picked model is never replaced as the writer", async () => {
    const t = setup({ base: { handPicked: true } });
    expect(await t.svc.rewrite(CONTENT, { runId: "run-1" })).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
  });
  it("a private task only reaches an approved provider: no writer outside it", async () => {
    const t = setup({
      base: { task: taskRead({ private: true }), approvedProviders: ["claude-code"] },
    });
    expect(await t.svc.rewrite(CONTENT, { runId: "run-1" })).toBeUndefined();
    for (const [req] of t.caller.mock.calls)
      expect(req.modelKey.startsWith("claude-code/")).toBe(true);
  });
  it("a writer that fails or throws, or no caller, sends the original", async () => {
    const failed = setup({ caller: async () => undefined });
    expect(await failed.svc.rewrite(CONTENT, { runId: "run-1" })).toBeUndefined();
    failed.flush();
    expect(rows(failed)[0].reason).toBe("writer-failed");
    const boom = setup({
      caller: async () => {
        throw new Error("x");
      },
    });
    expect(await boom.svc.rewrite(CONTENT, { runId: "run-1" })).toBeUndefined();
    expect(boom.errors).toHaveLength(1);
    const none = setup({ caller: null });
    expect(await none.svc.rewrite(CONTENT, { runId: "run-1" })).toBeUndefined();
    none.flush();
    expect(rows(none)[0].reason).toBe("no-caller");
  });
});
