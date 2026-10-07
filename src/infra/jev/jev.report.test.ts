import { describe, expect, it, vi } from "vitest";
import { createJevAvailability } from "./availability.js";
import { JevClient, type JevTransport } from "./jev.js";
import type { JevQuestion } from "./types.js";

// The client tells the availability source how Jev answered, so a token arms itself on the first good answer and a
// refused token turns Jev off; a client without a token asks nothing and reports nothing.

const q: JevQuestion = {
  id: "a",
  version: 1,
  type: "noul",
  criteria: {},
  instructions: "x",
  fields: [],
};
const sit = { id: "s1" } as never;

function client(transport: JevTransport, apiKey: () => string | undefined) {
  const j = createJevAvailability({
    env: () => ({ TYPESAFE_API_KEY: "tok" }),
    tokenFile: () => "/none",
    statFile: () => undefined,
  });
  const c = new JevClient({
    transport,
    apiKey,
    baseUrl: "http://jev.test",
    model: "m",
    buildState: () => ({}),
    report: (r) => j.report(r),
    onBreaker: (open, until) => j.noteBreaker("t", open, until),
  });
  return { j, c };
}

describe("JevClient reports to the availability source", () => {
  it("a 200 with an answer arms it", async () => {
    const t: JevTransport = {
      post: async () => ({ status: 200, json: { answers: { a: { noul: 0.9 } } }, ms: 3 }),
    };
    const { j, c } = client(t, () => "tok");
    await c.ask(sit, [q]);
    expect(j.snapshot().state).toBe("armed");
  });

  it("a 401 marks the token rejected", async () => {
    const t: JevTransport = { post: async () => ({ status: 401, json: {}, ms: 3 }) };
    const { j, c } = client(t, () => "tok");
    await c.ask(sit, [q]);
    expect(j.snapshot().state).toBe("rejected");
  });

  it("a network error is a failure without a status, and the state stays", async () => {
    const t: JevTransport = {
      post: async () => {
        const e = new Error("x");
        e.name = "NetworkError";
        throw e;
      },
    };
    const { j, c } = client(t, () => "tok");
    await c.ask(sit, [q]);
    expect(j.snapshot().state).toBe("unverified");
    expect(j.snapshot().lastProbe).toMatchObject({ ok: false });
  });

  it("three failures open the breaker, and the source hears it with an expiry", async () => {
    const t: JevTransport = { post: async () => ({ status: 500, json: {}, ms: 1 }) };
    const { j, c } = client(t, () => "tok");
    await c.ask(sit, [q]);
    await c.ask(sit, [q]);
    expect(j.snapshot().breakerOpen).toBe(false);
    await c.ask(sit, [q]);
    expect(j.snapshot().breakerOpen).toBe(true);
  });

  it("without a token it asks nothing and reports nothing", async () => {
    const post = vi.fn(async () => ({ status: 200, json: {}, ms: 1 }));
    const report = vi.fn();
    const c = new JevClient({
      transport: { post },
      apiKey: () => undefined,
      baseUrl: "u",
      model: "m",
      buildState: () => ({}),
      report,
    });
    const out = await c.ask(sit, [q]);
    expect(post).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(out[0].skipped).toBe("error");
  });
});
