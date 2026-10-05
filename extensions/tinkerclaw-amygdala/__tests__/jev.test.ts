import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/breaker.js";
import { TtlLru, cacheKey } from "../src/cache.js";
import { JevClient, toEntry, type JevTransport } from "../src/jev.js";
import type { Field, Question, Situation, Verdict } from "../src/types.js";

const KEY = "sk-test-SECRET-123";

function fx(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

const f = <T>(value: T | null): Field<T> => ({
  value,
  origin: value === null ? "missing" : "observed",
});

function situation(request = "r1"): Situation {
  return {
    id: "sit-1",
    ts: 1,
    sessionKey: "k",
    turnId: "t",
    seam: "pre-tool",
    originKind: "synthetic",
    tool: f("t"),
    args: f(null),
    command: f(null),
    effectClass: f(null),
    targets: f(null),
    targetHistory: f(null),
    scratch: f(null),
    toolRecord: f(null),
    request: f(request),
    restatement: f(null),
    expectation: f(null),
    draftCommitments: f(null),
    repeatedErrors: f(null),
    stepsSinceNewFact: f(null),
    recentHolds: f(null),
    standingFacts: f(null),
    similarIncidents: f(null),
    reply: f(null),
    claims: f(null),
    provenance: f(null),
  };
}

function question(id: string, type: Question["type"], criteria: Question["criteria"]): Question {
  return {
    id,
    version: 1,
    family: "safety",
    seams: ["pre-tool"],
    type,
    criteria,
    instructions: "test-question",
    fields: ["request"],
    cutoff: { kind: "prob", at: 0.5 },
    purpose: "p",
    origin: "o",
    retirement: "r",
    mustCatch: [],
    status: "active",
    name: id,
  };
}

const qNoul = question("q-noul", "noul", {});
const qChoice = question("q-choice", "choice", { alpha: "a", beta: null, gamma: "g" });
const qScore = question("q-score", "score", ["none", "some", "lots"]);

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  timeoutMs: number;
}

class FakeTransport implements JevTransport {
  calls: Call[] = [];
  constructor(
    private readonly reply: () => { status: number; json: unknown; ms: number } | Error,
  ) {}
  async post(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number) {
    this.calls.push({ url, body: body as Record<string, unknown>, headers, timeoutMs });
    const r = this.reply();
    if (r instanceof Error) throw r;
    return r;
  }
}

function ok(...parts: Record<string, unknown>[]) {
  const answers: Record<string, unknown> = {};
  let inTok = 0;
  for (const p of parts) {
    Object.assign(answers, p.answers as object);
    inTok += (p.usage as { input_tokens: number }).input_tokens;
  }
  return {
    status: 200,
    json: { model: "m", answers, usage: { input_tokens: inTok, output_tokens: 0 } },
    ms: 42,
  };
}

function client(t: JevTransport, extra: Partial<ConstructorParameters<typeof JevClient>[0]> = {}) {
  let n = 0;
  return new JevClient({
    transport: t,
    apiKey: () => KEY,
    baseUrl: "https://example.invalid/",
    model: "jev-latest",
    buildState: (s) => ({ request: s.request.value }),
    idGen: () => `v${++n}`,
    ...extra,
  });
}

describe("toEntry", () => {
  it("shapes each type", () => {
    expect(toEntry(qNoul)).toEqual({ type: "noul", instructions: "test-question" });
    expect(toEntry(qChoice).criteria).toEqual({ alpha: "a", beta: null, gamma: "g" });
    expect(toEntry(qScore).criteria).toEqual(["none", "some", "lots"]);
  });
  it("rejects malformed criteria", () => {
    expect(() => toEntry(question("c", "choice", ["a", "b"]))).toThrow();
    expect(() => toEntry(question("s", "score", ["only"]))).toThrow();
    expect(() => toEntry(question("s", "score", { a: "b" }))).toThrow();
  });
});

describe("JevClient.ask", () => {
  it("sends one call for several questions with the wire shape", async () => {
    const t = new FakeTransport(() => ok(fx("jev-noul"), fx("jev-choice"), fx("jev-score")));
    const vs = await client(t).ask(situation(), [qNoul, qChoice, qScore]);
    expect(t.calls).toHaveLength(1);
    const c = t.calls[0];
    expect(c.url).toBe("https://example.invalid/v1/systemone");
    expect(c.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(c.timeoutMs).toBe(2000);
    expect(c.body.model).toBe("jev-latest");
    expect(Object.keys(c.body.questions as object)).toEqual(["q-noul", "q-choice", "q-score"]);
    expect(vs.map((v) => v.questionId)).toEqual(["q-noul", "q-choice", "q-score"]);
  });

  it("maps answers per type", async () => {
    const t = new FakeTransport(() => ok(fx("jev-noul"), fx("jev-choice"), fx("jev-score")));
    const [n, c, s] = await client(t).ask(situation(), [qNoul, qChoice, qScore]);
    expect(n).toMatchObject({ answer: 0.83, prob: 0.83, confidence: 0.9, type: "noul" });
    expect(c).toMatchObject({ answer: "beta", prob: 0.7, confidence: 0.8 });
    expect(c.probs).toEqual({ alpha: 0.1, beta: 0.7, gamma: 0.2 });
    expect(s).toMatchObject({ answer: 2, prob: 1, confidence: 0 });
  });

  it("computes cost from input tokens", async () => {
    const t = new FakeTransport(() => ok(fx("jev-noul")));
    const [v] = await client(t).ask(situation(), [qNoul]);
    expect(v.tokensIn).toBe(35088);
    expect(v.costUsd).toBeCloseTo(0.00147, 5);
    expect(v.latencyMs).toBe(42);
  });

  it("caches: hit costs 0, miss on changed fields, expiry by TTL", async () => {
    let clock = 0;
    const now = () => clock;
    const t = new FakeTransport(() => ok(fx("jev-noul")));
    const c = client(t, { now, cache: new TtlLru<Verdict>({ ttlMs: 1000, now }) });
    await c.ask(situation("a"), [qNoul]);
    const [hit] = await c.ask(situation("a"), [qNoul]);
    expect(t.calls).toHaveLength(1);
    expect(hit).toMatchObject({
      cacheHit: true,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: 0,
    });
    await c.ask(situation("b"), [qNoul]);
    expect(t.calls).toHaveLength(2);
    clock = 5000;
    await c.ask(situation("a"), [qNoul]);
    expect(t.calls).toHaveLength(3);
  });

  it("maps a timeout to skipped:timeout and counts it on the breaker", async () => {
    const e = new Error("slow");
    e.name = "TimeoutError";
    const t = new FakeTransport(() => e);
    const br = new CircuitBreaker();
    const [v] = await client(t, { breaker: br }).ask(situation(), [qNoul]);
    expect(v.skipped).toBe("timeout");
    expect(t.calls).toHaveLength(1);
    // two more failures open it
    const c = client(t, { breaker: br });
    await c.ask(situation(), [qNoul]);
    await c.ask(situation(), [qNoul]);
    expect(br.state).toBe("open");
  });

  it("maps non-200, malformed and missing answers to skipped:error", async () => {
    const t500 = new FakeTransport(() => ({ status: 500, json: {}, ms: 1 }));
    expect((await client(t500).ask(situation(), [qNoul]))[0].skipped).toBe("error");
    const tBad = new FakeTransport(() => ({ status: 200, json: undefined, ms: 1 }));
    expect((await client(tBad).ask(situation(), [qNoul]))[0].skipped).toBe("error");
    const tMissing = new FakeTransport(() => ok(fx("jev-noul")));
    const [a, b] = await client(tMissing).ask(situation(), [qNoul, qScore]);
    expect(a.skipped).toBeUndefined();
    expect(b.skipped).toBe("error");
  });

  it("breaker: opens after 3 failures, blocks calls, half-opens, closes on success", async () => {
    let clock = 0;
    const now = () => clock;
    let good = false;
    const t = new FakeTransport(() =>
      good ? ok(fx("jev-noul")) : { status: 503, json: {}, ms: 1 },
    );
    const br = new CircuitBreaker({ now, resetMs: 30_000 });
    const c = client(t, { now, breaker: br, cache: new TtlLru<Verdict>({ now, ttlMs: 1 }) });
    for (let i = 0; i < 3; i++) await c.ask(situation(), [qNoul]);
    expect(t.calls).toHaveLength(3);
    expect(br.state).toBe("open");
    const [blocked] = await c.ask(situation(), [qNoul]);
    expect(blocked.skipped).toBe("breaker-open");
    expect(t.calls).toHaveLength(3);
    clock = 30_000;
    expect(br.state).toBe("half-open");
    good = true;
    const [probe] = await c.ask(situation(), [qNoul]);
    expect(probe.skipped).toBeUndefined();
    expect(t.calls).toHaveLength(4);
    expect(br.state).toBe("closed");
  });

  it("half-open lets only one probe through and re-opens on its failure", () => {
    let clock = 0;
    const br = new CircuitBreaker({ failures: 1, resetMs: 10, now: () => clock });
    br.recordFailure();
    expect(br.isOpen()).toBe(true);
    clock = 10;
    expect(br.isOpen()).toBe(false);
    expect(br.isOpen()).toBe(true);
    br.recordFailure();
    expect(br.state).toBe("open");
  });

  it("no key: skipped, no call, breaker untouched", async () => {
    const t = new FakeTransport(() => ok(fx("jev-noul")));
    const br = new CircuitBreaker({ failures: 1 });
    const vs = await client(t, { apiKey: () => undefined, breaker: br }).ask(situation(), [
      qNoul,
      qScore,
    ]);
    expect(vs.map((v) => v.skipped)).toEqual(["error", "error"]);
    expect(t.calls).toHaveLength(0);
    expect(br.state).toBe("closed");
  });

  it("SendBlocked: not-allowed, no call, breaker untouched", async () => {
    const t = new FakeTransport(() => ok(fx("jev-noul")));
    const br = new CircuitBreaker({ failures: 1 });
    const blocked = () => {
      const e = new Error("blocked");
      e.name = "SendBlocked";
      throw e;
    };
    const vs = await client(t, { buildState: blocked, breaker: br }).ask(situation(), [qNoul]);
    expect(vs[0].skipped).toBe("not-allowed");
    expect(t.calls).toHaveLength(0);
    expect(br.state).toBe("closed");
  });

  it("never leaks the key into verdicts or error text", async () => {
    const leaky = new FakeTransport(() => new Error(`connect failed with ${KEY}`));
    const vs = await client(leaky).ask(situation(), [qNoul]);
    expect(JSON.stringify(vs)).not.toContain(KEY);
    const t = new FakeTransport(() => ok(fx("jev-noul")));
    expect(JSON.stringify(await client(t).ask(situation(), [qNoul]))).not.toContain(KEY);
  });
});

describe("cache primitives", () => {
  it("cacheKey is stable across key order and sensitive to version", () => {
    const a = cacheKey({ id: "q", version: 1 }, { x: 1, y: { b: 1, a: 2 } });
    const b = cacheKey({ id: "q", version: 1 }, { y: { a: 2, b: 1 }, x: 1 });
    expect(a).toBe(b);
    expect(cacheKey({ id: "q", version: 2 }, { x: 1, y: { b: 1, a: 2 } })).not.toBe(a);
  });
  it("evicts least recently used", () => {
    const c = new TtlLru<number>({ max: 2 });
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.size).toBe(2);
  });
});
