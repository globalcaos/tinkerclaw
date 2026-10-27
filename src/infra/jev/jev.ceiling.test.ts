import { describe, expect, it } from "vitest";
import { JEV_MAX_WAIT_MS, JevClient, type JevTransport } from "./jev.js";
import type { JevQuestion } from "./types.js";

// The owner's rule (2026-10-15): a Jev call with no answer within 1 s has failed. The client clamps every
// caller's budget, so the amygdala's 4.6 s stop budget or a plugin's own number cannot hold a turn longer.

const q: JevQuestion = {
  id: "a",
  version: 1,
  type: "noul",
  criteria: {},
  instructions: "x",
  fields: [],
};
const sit = { id: "s1" } as never;

async function waitGiven(budgetMs?: number): Promise<number> {
  let seen = -1;
  const transport: JevTransport = {
    post: async (_url, _body, _headers, timeoutMs) => {
      seen = timeoutMs;
      return { status: 200, json: { answers: { a: { noul: 0.9 } } }, ms: 3 };
    },
  };
  const c = new JevClient({
    transport,
    apiKey: () => "tok",
    baseUrl: "http://jev.test",
    model: "m",
    buildState: () => ({}),
  });
  await c.ask(sit, [q], budgetMs === undefined ? {} : { budgetMs });
  return seen;
}

describe("JevClient wait ceiling", () => {
  it("is one second", () => {
    expect(JEV_MAX_WAIT_MS).toBe(1_000);
  });

  it("clamps a longer budget to one second", async () => {
    expect(await waitGiven(4_600)).toBe(1_000);
  });

  it("waits one second when the caller names no budget", async () => {
    expect(await waitGiven()).toBe(1_000);
  });

  it("keeps a shorter budget", async () => {
    expect(await waitGiven(400)).toBe(400);
  });
});
