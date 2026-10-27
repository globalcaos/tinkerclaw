import { describe, expect, it } from "vitest";
import { fieldValues, JevClient } from "./jev.js";
import type { JevQuestion } from "./types.js";

// A question declares the situation fields it reads. A situation that does not carry one of them must not make the
// client throw (measured live in phase H: the standalone step and outcome reads threw a TypeError before any call).

const q = (id: string, fields: string[]): JevQuestion => ({
  id,
  version: 1,
  type: "noul",
  criteria: {},
  instructions: "x",
  fields,
});

describe("fieldValues", () => {
  it("reads a declared field that is present", () => {
    expect(fieldValues({ id: "s", request: { value: "hi" } } as never, ["request"])).toEqual({
      request: "hi",
    });
  });

  it("reads a declared field the situation lacks as empty, and never throws", () => {
    const s = { id: "s", request: { value: "hi" } } as never;
    expect(fieldValues(s, ["request", "tool", "args"])).toEqual({
      request: "hi",
      tool: "",
      args: "",
    });
    expect(fieldValues({ id: "s", tool: null } as never, ["tool"])).toEqual({ tool: "" });
  });
});

describe("JevClient.ask with a situation that lacks declared fields", () => {
  const transport = {
    post: async () => ({
      status: 200,
      json: { answers: { a: { noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } },
      ms: 5,
    }),
  };
  const client = () =>
    new JevClient<{ id: string; request: { value: string } }>({
      transport,
      apiKey: () => "k",
      baseUrl: "http://x",
      model: "m",
      buildState: (s) => ({ request: s.request.value }),
    });

  it("makes the call and returns the answer instead of throwing", async () => {
    const out = await client().ask({ id: "s", request: { value: "hi" } }, [
      q("a", ["request", "tool", "toolRecord"]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ questionId: "a", answer: 0.9 });
    expect(out[0].skipped).toBeUndefined();
  });
});
