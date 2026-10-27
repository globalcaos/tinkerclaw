import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NOW, R, supplies } from "../../../src/shared/thalamus-v4.test-support.js";
import { parseConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";
import { ThalamusStore } from "../src/store.js";
import {
  buildEnhReviewPrompt,
  buildRoutingReviewPrompt,
  createTutor,
  parseEnhReview,
  parseRoutingReview,
  type EnhReviewRow,
  type EnhSnapshot,
  type RoutingReviewRow,
  type RoutingSnapshot,
} from "../src/tutor.js";

// The tutors (2026-10-25): every routing outcome row said `done`, so no review of the model that ran existed, and the
// enhancement list had no judge of its misses. These review a sample of finished runs and only record.

const routing = (over: Partial<RoutingSnapshot> = {}): RoutingSnapshot => ({
  runId: "run-1",
  sessionKey: "agent:main:tinker:a",
  ts: NOW,
  aim: "rename /home/owner/x.txt",
  ran: ["claude-code/claude-opus-5-5"],
  effort: "max",
  pick: { model: "claude-code/claude-haiku-4-5", effort: "low", applied: false },
  calls: 1,
  toolCalls: 1,
  toolErrors: 0,
  ended: "end",
  stopReasons: ["end_turn"],
  outputTokens: 40,
  refused: false,
  ...over,
});

const enh: EnhSnapshot = {
  taskId: "run-1",
  sessionKey: "agent:main:tinker:a",
  ts: NOW,
  aim: "find the youtube transcript",
  shown: [
    { cardId: "skill:gog", name: "gog", purpose: "Gmail and Drive" },
    { cardId: "skill:weather", name: "weather", purpose: "forecasts" },
  ],
  used: [
    {
      cardId: "skill:youtube-ultimate",
      name: "youtube-ultimate",
      purpose: "videos",
      onList: false,
    },
  ],
  outcome: "done",
};

describe("prompts and answers", () => {
  it("redact the home folder and say when the owner has not written again", () => {
    const p = buildRoutingReviewPrompt(routing(), "/home/owner");
    expect(p).not.toContain("/home/owner");
    expect(p).toContain('"ownerNext": "none yet"');
    expect(buildEnhReviewPrompt(enh, "/home/owner")).toContain('"onList": false');
  });

  it("read a routing verdict; refuse anything else", () => {
    expect(parseRoutingReview('{"verdict":"too-strong","reason":"a rename on Opus max"}')).toEqual({
      verdict: "too-strong",
      reason: "a rename on Opus max",
      confidence: "medium",
    });
    expect(parseRoutingReview('{"verdict":"fine","reason":"x"}')).toBeNull();
  });

  it("keep only ids the list showed or the agent used off it", () => {
    expect(
      parseEnhReview(
        '{"notFit":["skill:weather","skill:made-up"],"shouldSuggest":["skill:youtube-ultimate","skill:gog"],"reason":"r","confidence":"high"}',
        enh,
      ),
    ).toEqual({
      notFit: ["skill:weather"],
      shouldSuggest: ["skill:youtube-ultimate"],
      reason: "r",
      confidence: "high",
    });
    expect(parseEnhReview('{"notFit":"x","shouldSuggest":[],"reason":"r"}', enh)).toBeNull();
  });
});

describe("createTutor", () => {
  function make(o: { sampleRate?: number; cap?: number; answer?: string } = {}) {
    const routed: RoutingReviewRow[] = [];
    const listed: EnhReviewRow[] = [];
    const timers: (() => void)[] = [];
    const prompts: string[] = [];
    const tutor = createTutor({
      run: async (prompt) => {
        prompts.push(prompt);
        return (
          o.answer ??
          (prompt.includes('"shown"')
            ? '{"notFit":["skill:weather"],"shouldSuggest":[],"reason":"weather is off topic"}'
            : '{"verdict":"too-weak","reason":"he corrected it"}')
        );
      },
      ladder: ["m/x"],
      timeoutMs: 1000,
      dailyCap: { routing: o.cap ?? 5, enh: o.cap ?? 5 },
      sampleRate: o.sampleRate ?? 1,
      followUpMs: 600_000,
      save: { routing: (r) => routed.push(r), enh: (r) => listed.push(r) },
      now: () => NOW,
      random: () => 0.5,
      homeDir: "/home/owner",
      schedule: (fn) => timers.push(fn),
    });
    return { tutor, routed, listed, timers, prompts };
  }

  it("a routing review waits for the owner's next prompt and reads it; the list is judged at once", async () => {
    const t = make();
    t.tutor.afterRun(
      () => routing(),
      () => enh,
    );
    await t.tutor.idle();
    expect(t.listed).toMatchObject([
      {
        taskId: "run-1",
        status: "done",
        review: { notFit: ["skill:weather"] },
        usedOffList: ["skill:youtube-ultimate"],
      },
    ]);
    expect(t.routed).toHaveLength(0);
    t.tutor.noteRefusal("agent:main:tinker:a");
    t.tutor.notePrompt(
      "agent:main:tinker:a",
      "[Sat 2026-10-25 01:00 GMT+2] no, that is wrong, redo it",
    );
    await t.tutor.idle();
    expect(t.routed).toMatchObject([
      { runId: "run-1", status: "done", hadNext: true, review: { verdict: "too-weak" } },
    ]);
    const last = t.prompts.at(-1) ?? "";
    expect(last).toContain('"ownerNext": "no, that is wrong, redo it"');
    expect(last).toContain('"refused": true');
  });

  it("with no next prompt the wait ends on its own; a newer run in the chat releases the older one", async () => {
    const t = make();
    t.tutor.afterRun(
      () => routing({ runId: "a" }),
      () => undefined,
    );
    t.tutor.afterRun(
      () => routing({ runId: "b" }),
      () => undefined,
    );
    await t.tutor.idle();
    expect(t.routed.map((r) => [r.runId, r.hadNext])).toEqual([["a", false]]);
    for (const f of t.timers) {
      f();
    }
    await t.tutor.idle();
    expect(t.routed.map((r) => r.runId)).toEqual(["a", "b"]);
  });

  it("spends no slot on an untaken run or one with nothing to judge, and honours the cap and the sample", async () => {
    const off = make({ sampleRate: 0.4 });
    let built = 0;
    off.tutor.afterRun(
      () => {
        built++;
        return routing();
      },
      () => {
        built++;
        return enh;
      },
    );
    expect(built).toBe(0);
    const t = make({ cap: 1 });
    t.tutor.afterRun(
      () => undefined,
      () => ({ ...enh, shown: [], used: [] }),
    );
    t.tutor.afterRun(
      () => routing(),
      () => enh,
    );
    t.tutor.afterRun(
      () => routing({ runId: "x", sessionKey: "agent:main:tinker:b" }),
      () => enh,
    );
    await t.tutor.idle();
    expect(t.listed).toHaveLength(1);
    expect(t.tutor.waiting()).toBe(1);
  });

  it("a failed ladder is saved as failed", async () => {
    const t = make({ answer: "nonsense" });
    t.tutor.afterRun(
      () => undefined,
      () => enh,
    );
    await t.tutor.idle();
    expect(t.listed[0]).toMatchObject({ status: "failed", error: "m/x: not an answer" });
  });
});

describe("the tutor tables", () => {
  it("round-trip a routing and an enhancement review", () => {
    const store = new ThalamusStore(":memory:");
    store.insertRoutingReview({
      runId: "r",
      ts: 5,
      session: "s",
      ran: "a/b",
      effort: "max",
      pick: "a/c/low",
      hadNext: true,
      status: "done",
      reviewer: "m/x",
      review: { verdict: "too-strong", reason: "trivial", confidence: "high" },
    });
    store.insertEnhReview({
      taskId: "t",
      ts: 6,
      session: "s",
      shown: ["skill:a"],
      usedOffList: ["skill:b"],
      status: "failed",
      error: "m/x: timeout",
    });
    expect(store.listRoutingReviews()).toEqual([
      {
        runId: "r",
        ts: 5,
        session: "s",
        ran: "a/b",
        effort: "max",
        pick: "a/c/low",
        hadNext: true,
        status: "done",
        reviewer: "m/x",
        review: { verdict: "too-strong", reason: "trivial", confidence: "high" },
      },
    ]);
    expect(store.listEnhReviews()).toEqual([
      {
        taskId: "t",
        ts: 6,
        session: "s",
        shown: ["skill:a"],
        usedOffList: ["skill:b"],
        status: "failed",
        error: "m/x: timeout",
      },
    ]);
  });
});

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) {
    s();
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("through the runtime", () => {
  it("a finished run's list is judged and stored; a temp one-shot or a private chat never is", async () => {
    const root = mkdtempSync(join(tmpdir(), "thalamus-tutor-"));
    dirs.push(root);
    const store = new ThalamusStore(":memory:");
    const listeners: ((e: never) => void)[] = [];
    const asked: string[] = [];
    const rt = createRuntime({
      config: parseConfig({
        dataDir: join(root, "data"),
        mode: "shadow",
        tutor: { sampleRate: 1 },
      }),
      extensionRoot,
      gatewayPort: 18789,
      gatewayCfg: () => ({}),
      onAgentEvent: (l) => {
        listeners.push(l as never);
        return () => void listeners.splice(listeners.indexOf(l as never), 1);
      },
      broadcast: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => NOW,
      readBoard: () => ({
        rungs: [R.opus, R.haiku],
        supplies: supplies(),
        contextWindowFor: () => 1_000_000,
        dialIdx: 1,
        builtAtMs: NOW,
      }),
      handPicked: () => false,
      listing: () => [{ kind: "skill", name: "gog", path: "/s/gog/SKILL.md" }],
      attribute: (c) => (c.name === "Read" ? [{ kind: "skill", name: "gog", via: "manual" }] : []),
      readText: () => "---\nname: gog\ndescription: Google Workspace CLI for Gmail.\n---\n",
      defer: (fn: () => void) => fn(),
      store,
      tutorRun: async (prompt) => {
        asked.push(prompt);
        return '{"notFit":[],"shouldSuggest":["skill:gog"],"reason":"gog was the tool for mail"}';
      },
    });
    stops.push(() => rt.stop());
    await rt.start();
    const emit = (e: Record<string, unknown>) => {
      for (const l of listeners) {
        l(e as never);
      }
    };
    const run = async (runId: string, sessionKey: string) => {
      await rt.shortlist()?.prepare({
        id: runId,
        runId,
        ts: NOW,
        sessionKey,
        text: "read my last mail",
        source: "tinker",
      });
      emit({
        runId,
        sessionKey,
        stream: "tool",
        data: { phase: "start", name: "Read", toolCallId: "t1", args: {} },
      });
      emit({ runId, sessionKey, stream: "lifecycle", data: { phase: "end" } });
    };
    await run("run-a", "agent:main:tinker:a");
    await run("run-tmp", "temp:jev-explain:x");
    await run("run-wa", "agent:main:whatsapp:direct:+1");
    await new Promise((r) => setTimeout(r, 20));
    expect(store.listEnhReviews().map((r) => [r.taskId, r.review?.shouldSuggest])).toEqual([
      ["run-a", ["skill:gog"]],
    ]);
    expect(asked).toHaveLength(1);
  });
});
