import type { OutcomeRead, ThalamusBoardLike } from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it } from "vitest";
import {
  answered,
  GROK,
  NOW,
  OPUS,
  R,
  supplies,
} from "../../../src/shared/thalamus-v4.test-support.js";
import { parseConfig } from "../src/config.js";
import { createRefusalWatcher } from "../src/refusal.js";

// the architect, 2026-10-02: refusals are DETECTED only. The watcher announces them and answers the retry question; it
// re-routes nothing, vetoes nothing, retries nothing.

const SESSION = "agent:main:tinker:abc";
const board = (over: Partial<ThalamusBoardLike> = {}): ThalamusBoardLike => ({
  rungs: [R.opus, R.sonnet, R.haiku, R.grok],
  supplies: supplies(),
  contextWindowFor: () => 1_000_000,
  dialIdx: 3,
  builtAtMs: NOW,
  ...over,
});

const outcome = (state: string, conf = 0.9, source: "jev" | "fallback" = "jev"): OutcomeRead => ({
  id: "o1",
  ts: NOW,
  callIndex: 0,
  state: answered(state as never, conf, source),
});

function setup(over: { board?: () => ThalamusBoardLike | undefined; mode?: object } = {}) {
  const events: Array<[string, unknown]> = [];
  const errors: unknown[] = [];
  const w = createRefusalWatcher({
    cfg: () => parseConfig({ mode: "shadow", ...(over.mode ?? {}) }),
    board: over.board ?? (() => board()),
    now: () => NOW,
    broadcast: (n, p) => void events.push([n, p]),
    onError: (e) => void errors.push(e),
  });
  const sawTurn = (model = OPUS, domain = "code", runId = "run-9") => {
    w.noteEvent({ runId, sessionKey: SESSION, stream: "lifecycle", data: { phase: "start" } });
    w.noteEvent({
      runId: `thalamus:${SESSION}`,
      sessionKey: SESSION,
      stream: "thalamus",
      data: { phase: "decision", model, effort: "max", domain },
    });
  };
  return { w, events, errors, sawTurn };
}

describe("the refusal watcher", () => {
  it("announces a sure refused read once, with the session, the run, the refusing model and its vendor, and the retry pick", () => {
    const t = setup();
    t.sawTurn();
    t.w.observeOutcome({ sessionKey: SESSION, turnId: "turn-1", outcome: outcome("refused") });
    expect(t.events).toHaveLength(1);
    expect(t.events[0][0]).toBe("thalamus.refusal");
    expect(t.events[0][1]).toMatchObject({
      sessionKey: SESSION,
      runId: "run-9",
      turnId: "turn-1",
      model: OPUS,
      family: "anthropic",
      domain: "code",
      retry: { model: GROK, family: "xai" },
      ts: NOW,
    });
    expect(t.w.stats()).toEqual({ refusals: 1, lastAt: NOW });
  });

  it("drops a second read of the same turn, and announces a different turn", () => {
    const t = setup();
    t.sawTurn();
    const read = { sessionKey: SESSION, turnId: "turn-1", outcome: outcome("refused") };
    t.w.observeOutcome(read);
    t.w.observeOutcome(read);
    expect(t.events).toHaveLength(1);
    t.w.observeOutcome({ ...read, turnId: "turn-2" });
    expect(t.events).toHaveLength(2);
  });

  it("says nothing for an unsure read, a fallback read, or any other outcome", () => {
    const t = setup();
    t.sawTurn();
    for (const o of [
      outcome("refused", 0.3),
      outcome("refused", 0.99, "fallback"),
      outcome("done"),
      outcome("stuck"),
      outcome("retry"),
    ]) {
      t.w.observeOutcome({ sessionKey: SESSION, turnId: "t", outcome: o });
    }
    expect(t.events).toEqual([]);
  });

  it("gives a null retry, with the reason, when the model that refused is not known", () => {
    const t = setup();
    t.w.observeOutcome({ sessionKey: SESSION, turnId: "t", outcome: outcome("refused") });
    expect(t.events[0][1]).toMatchObject({
      retry: null,
      retryReason: "the model that refused is not known",
    });
  });

  it("gives a null retry for a private source, which only approved providers may see", () => {
    const t = setup();
    const wa = "agent:main:whatsapp:direct:+34600000000";
    t.w.noteEvent({
      runId: `thalamus:${wa}`,
      sessionKey: wa,
      stream: "thalamus",
      data: { phase: "decision", model: OPUS, effort: "max", domain: "general" },
    });
    t.w.observeOutcome({ sessionKey: wa, turnId: "t", outcome: outcome("refused") });
    expect(t.events[0][1]).toMatchObject({ retry: null });
    expect((t.events[0][1] as { retryReason: string }).retryReason).toContain("private source");
  });

  it("gives a null retry when the other vendor is cooling", () => {
    const t = setup({ board: () => board({ cooling: new Set(["xai"]) }) });
    t.sawTurn();
    t.w.observeOutcome({ sessionKey: SESSION, turnId: "t", outcome: outcome("refused") });
    expect(t.events[0][1]).toMatchObject({ retry: null });
  });

  it("answers thalamus.retryPick from what the bus showed, or from the model the page names", () => {
    const t = setup();
    expect(t.w.retryPick({})).toEqual({ ok: false, error: "sessionKey is required" });
    expect(t.w.retryPick({ sessionKey: SESSION })).toMatchObject({ ok: true, pick: null });
    // a hand-picked tab has no gateway decision: the page says what the refused reply ran on
    const named = t.w.retryPick({ sessionKey: SESSION, model: OPUS, domain: "code" });
    expect(named).toMatchObject({
      ok: true,
      pick: { model: GROK },
      refusing: { model: OPUS, family: "anthropic" },
    });
    t.sawTurn(GROK, "general");
    expect(t.w.retryPick({ sessionKey: SESSION })).toMatchObject({
      ok: true,
      pick: { family: "anthropic" },
    });
  });

  it("changes nothing: the only thing it ever does is broadcast, and a throw is reported, not raised", () => {
    const t = setup({
      board: () => {
        throw new Error("board broke");
      },
    });
    t.sawTurn();
    expect(() =>
      t.w.observeOutcome({ sessionKey: SESSION, turnId: "t", outcome: outcome("refused") }),
    ).not.toThrow();
    expect(t.errors.length).toBeGreaterThan(0);
  });
});
