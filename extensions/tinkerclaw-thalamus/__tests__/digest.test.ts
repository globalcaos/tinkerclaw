import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  callParams,
  HAIKU,
  OPUS,
  R,
  taskRead,
} from "../../../src/shared/thalamus-v4.test-support.js";
import { parseConfig, type ThalamusConfig } from "../src/config.js";
import { createDigestService } from "../src/digest.js";
import type { ModelCaller } from "../src/model-caller.js";
import { createRawStore } from "../src/raw-store.js";
import { createRunStates } from "../src/run-state.js";
import { ThalamusStore } from "../src/store.js";

const tmp = mkdtempSync(join(tmpdir(), "thalamus-digest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const LONG = "line of tool output with a path /tmp/a and a number 4711\n".repeat(600); // ~35k chars, ~8.5k tokens
const meta = {
  runId: "run-1",
  sessionKey: "agent:main:tinker:x",
  provider: "claude-code",
  model: "claude-opus-5",
};
const input = (over: Record<string, unknown> = {}) => ({
  meta,
  toolName: "exec",
  toolCallId: "c1",
  params: {},
  text: LONG,
  ...over,
});

function setup(
  o: {
    mode?: "off" | "shadow" | "enforce";
    flag?: boolean;
    base?: Parameters<typeof callParams>[0];
    caller?: ModelCaller | null;
    maxBytes?: number;
    minResultTokens?: number;
  } = {},
) {
  const store = new ThalamusStore(":memory:");
  const runs = createRunStates();
  const cfg: ThalamusConfig = parseConfig({
    mode: o.mode ?? "enforce",
    enforce: { digest: o.flag ?? true },
    digest: { minResultTokens: o.minResultTokens ?? 2000 },
  });
  const queue: Array<() => void> = [];
  const errors: unknown[] = [];
  const raw = createRawStore({
    dir: join(tmp, `raw-${Math.random().toString(36).slice(2)}`),
    store: () => store,
    now: () => 1000,
    maxBytes: o.maxBytes,
  });
  runs.setBase(
    "run-1",
    callParams({ incumbentKey: OPUS, incumbentEffort: "high", ...(o.base ?? {}) }),
    { sessionKey: meta.sessionKey, aim: "find out why the build fails" },
  );
  const caller = vi.fn<ModelCaller>(async (req) => ({
    text: "DIGEST: build fails at step 3 (4711). ".repeat(20),
    input: 9000,
    output: 60,
  }));
  const svc = createDigestService({
    cfg: () => cfg,
    runs,
    store: () => store,
    raw,
    caller: () => (o.caller === null ? undefined : (o.caller ?? caller)),
    now: () => 2000,
    defer: (fn) => void queue.push(fn),
    onError: (e) => void errors.push(e),
  });
  const flush = () => queue.splice(0).forEach((fn) => fn());
  return { svc, store, runs, caller, raw, errors, flush, cfg };
}

describe("shadow: it records what it would do and touches nothing", () => {
  it("observe writes a decision for a long result: not acted, a reader named, no body stored", () => {
    const t = setup({ mode: "shadow" });
    t.svc.observe({ runId: "run-1", toolCallId: "c1", toolName: "exec", text: LONG });
    t.flush();
    const [row] = t.store.listFreshPoints({ kind: "digest" });
    expect(row).toMatchObject({ acted: false, reason: "pays", mode: "shadow", runId: "run-1" });
    expect(row.model).toBeTruthy();
    expect(row.detail).toMatchObject({ tool: "exec" });
    expect(JSON.stringify(row)).not.toContain("line of tool output");
    expect(t.caller).not.toHaveBeenCalled();
    expect(t.store.counts().rawResults).toBe(0);
  });

  it("digest() does nothing in shadow: no reader call, no raw file, no replacement", async () => {
    const t = setup({ mode: "shadow" });
    expect(await t.svc.digest(input())).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
    expect(t.store.counts().rawResults).toBe(0);
  });

  it("digest() does nothing in enforce with the flag off", async () => {
    const t = setup({ mode: "enforce", flag: false });
    expect(await t.svc.digest(input())).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
    expect(t.store.counts().rawResults).toBe(0);
  });

  it("a short result, or a run it has no context for, leaves no record at all", () => {
    const t = setup({ mode: "shadow" });
    t.svc.observe({ runId: "run-1", toolCallId: "c2", toolName: "read", text: "short" });
    t.svc.observe({ runId: "unknown", toolCallId: "c3", toolName: "read", text: LONG });
    t.flush();
    expect(t.store.counts().freshPoints).toBe(0);
  });

  it("a store that throws is counted, never raised", () => {
    const t = setup({ mode: "shadow" });
    t.store.close();
    t.svc.observe({ runId: "run-1", toolCallId: "c1", toolName: "exec", text: LONG });
    expect(() => t.flush()).not.toThrow();
    expect(t.errors.length).toBeGreaterThan(0);
  });
});

describe("enforce with the flag on", () => {
  it("returns a note that carries the digest and names where the full result is kept", async () => {
    const t = setup();
    const out = await t.svc.digest(input());
    expect(out).toContain("[Condensed:");
    expect(out).toContain("DIGEST: build fails at step 3");
    const kept = t.store.getRaw(out!.match(/res-[0-9a-f]{8}-[0-9a-z]+/)![0])!;
    expect(readFileSync(kept.path, "utf8")).toBe(LONG);
    expect(out).toContain(kept.path);
    expect(t.store.counts().rawResults).toBe(1);
  });

  it("the raw copy exists at the moment the reader is called", async () => {
    const seen: { existed?: boolean } = {};
    let holder: ReturnType<typeof setup>;
    const caller: ModelCaller = async () => {
      seen.existed = holder.store.counts().rawResults === 1;
      return { text: "short digest ".repeat(40) };
    };
    holder = setup({ caller });
    await holder.svc.digest(input());
    expect(seen.existed).toBe(true);
  });

  it("asks the reader the run's aim, the tool name and the raw text, with room for the digest", async () => {
    const t = setup();
    await t.svc.digest(input());
    const req = t.caller.mock.calls[0][0];
    expect(req.prompt).toContain("find out why the build fails");
    expect(req.prompt).toContain('"exec"');
    expect(req.prompt).toContain("RESULT:\n" + LONG);
    expect(req.maxTokens).toBeGreaterThan(0);
    expect(req.modelKey).toMatch(/\//);
    expect(req.timeoutMs).toBe(20_000);
  });

  it("records the digest as acted, counts another model in the run, and keeps usage numbers only", async () => {
    const t = setup();
    await t.svc.digest(input());
    t.flush();
    const [row] = t.store.listFreshPoints({ kind: "digest" });
    expect(row).toMatchObject({ acted: true, reason: "digested" });
    expect(row.detail).toMatchObject({ readerInput: 9000, readerOutput: 60 });
    expect(JSON.stringify(row)).not.toContain("DIGEST:");
    expect(t.runs.get("run-1")!.others).toBe(1);
  });

  it("recall gives the full result back by name, and counts it", async () => {
    const t = setup();
    const out = (await t.svc.digest(input()))!;
    const name = out.match(/res-[0-9a-f]{8}-[0-9a-z]+/)![0];
    expect(t.svc.recall(name)).toBe(LONG);
    expect(t.store.getRaw(name)!.recalls).toBe(1);
    expect(t.svc.recall("../../etc/passwd")).toBeUndefined();
  });
});

describe("enforce: every failure keeps the result as it was", () => {
  it("the reader gives nothing", async () => {
    const t = setup({ caller: async () => undefined });
    expect(await t.svc.digest(input())).toBeUndefined();
    t.flush();
    expect(t.store.listFreshPoints()[0]).toMatchObject({ acted: false, reason: "reader-failed" });
  });
  it("the reader throws", async () => {
    const t = setup({
      caller: async () => {
        throw new Error("boom");
      },
    });
    expect(await t.svc.digest(input())).toBeUndefined();
    expect(t.errors).toHaveLength(1);
  });
  it("the digest is not clearly shorter", async () => {
    const t = setup({
      caller: async () => ({ text: LONG.slice(0, Math.floor(LONG.length * 0.9)) }),
    });
    expect(await t.svc.digest(input())).toBeUndefined();
    t.flush();
    expect(t.store.listFreshPoints()[0].reason).toBe("not-shorter");
    expect(t.runs.get("run-1")!.others).toBe(0);
  });
  it("no reader is available", async () => {
    const t = setup({ caller: null });
    expect(await t.svc.digest(input())).toBeUndefined();
    t.flush();
    expect(t.store.listFreshPoints()[0].reason).toBe("no-reader");
  });
  it("the raw cannot be kept, so the reader is never asked", async () => {
    const t = setup({ maxBytes: 100 });
    expect(await t.svc.digest(input())).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
    t.flush();
    expect(t.store.listFreshPoints()[0].reason).toBe("raw-not-kept");
  });
  it("a short result is never offered to a reader", async () => {
    const t = setup();
    expect(await t.svc.digest(input({ text: "tiny" }))).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
  });
});

describe("who may be the reader", () => {
  it("a hand-picked model is never touched", async () => {
    const t = setup({ base: { handPicked: true } });
    expect(await t.svc.digest(input())).toBeUndefined();
    expect(t.caller).not.toHaveBeenCalled();
    t.flush();
    expect(t.store.listFreshPoints()[0]).toMatchObject({ acted: false, reason: "hand-picked" });
  });
  it("a private task only reaches an approved provider", async () => {
    const t = setup({
      base: {
        task: taskRead({ private: true }),
        approvedProviders: ["claude-code"],
        rungs: [R.opus, R.sonnet, R.haiku, R.grok],
      },
    });
    await t.svc.digest(input());
    for (const [req] of t.caller.mock.calls)
      expect(req.modelKey.startsWith("claude-code/")).toBe(true);
    expect(t.caller).toHaveBeenCalled();
  });
  it("a reader dearer than the saving is not used", async () => {
    const t = setup({ base: { incumbentKey: HAIKU, incumbentEffort: "", rungs: [R.opus] } });
    expect(await t.svc.digest(input())).toBeUndefined();
    t.flush();
    expect(t.store.listFreshPoints()[0]).toMatchObject({ acted: false, reason: "does-not-pay" });
    expect(t.caller).not.toHaveBeenCalled();
  });
});
