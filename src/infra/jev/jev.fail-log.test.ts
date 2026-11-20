import { afterEach, describe, expect, it, vi } from "vitest";
import { JevClient, type JevTransport } from "./jev.js";
import type { JevQuestion } from "./types.js";

// A failed call leaves one journal line that names its cause, so a verdict skipped as "error" can be traced to
// the branch that failed. The line carries identifiers only: never the key, an error message or situation text.

const KEY = "sekrit-key-7731";
const q: JevQuestion = {
  id: "refusal",
  version: 1,
  type: "noul",
  criteria: {},
  instructions: "x",
  fields: [],
};
const sit = { id: "s1" } as never;

function client(
  transport: JevTransport,
  buildState: () => Record<string, unknown> = () => ({}),
  key = KEY,
) {
  return new JevClient({
    transport,
    apiKey: () => key || undefined,
    baseUrl: "http://jev.test",
    model: "m",
    buildState,
  });
}

function warnLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((c) => c.map(String).join(" "))
    .filter((l) => l.startsWith("[jev] ask failed"));
}

afterEach(() => vi.restoreAllMocks());

describe("JevClient names the cause of a failed call", () => {
  it("a state build that throws names the error type", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t: JevTransport = { post: async () => ({ status: 200, json: { answers: {} }, ms: 1 }) };
    const v = await client(t, () => {
      throw new TypeError(`bad field near ${KEY}`);
    }).ask(sit, [q]);
    expect(v[0].skipped).toBe("error");
    const lines = warnLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cause=state");
    expect(lines[0]).toContain("name=TypeError");
    expect(lines[0]).toContain("questions=refusal");
    expect(lines[0]).not.toContain(KEY);
  });

  it("a network error names its error name", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t: JevTransport = {
      post: async () => {
        const e = new Error(`refused for ${KEY}`);
        e.name = "NetworkError";
        throw e;
      },
    };
    await client(t).ask(sit, [q]);
    const lines = warnLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cause=network");
    expect(lines[0]).toContain("name=NetworkError");
    expect(lines[0]).not.toContain(KEY);
  });

  it("a timeout stays silent: it is already counted as a timeout", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t: JevTransport = {
      post: async () => {
        const e = new Error("late");
        e.name = "TimeoutError";
        throw e;
      },
    };
    const v = await client(t).ask(sit, [q]);
    expect(v[0].skipped).toBe("timeout");
    expect(warnLines(spy)).toHaveLength(0);
  });

  it("an HTTP error names the status and the error type, never the message", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t: JevTransport = {
      post: async () => ({
        status: 400,
        json: {
          error: { type: "invalid_request_error", message: `your text ${KEY} was too long` },
        },
        ms: 2,
      }),
    };
    await client(t).ask(sit, [q]);
    const lines = warnLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cause=http");
    expect(lines[0]).toContain("status=400");
    expect(lines[0]).toContain("errType=invalid_request_error");
    expect(lines[0]).not.toContain("too long");
    expect(lines[0]).not.toContain(KEY);
  });

  it("a 200 without an answers map names it", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t: JevTransport = { post: async () => ({ status: 200, json: { usage: {} }, ms: 2 }) };
    await client(t).ask(sit, [q]);
    const lines = warnLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cause=no-answers");
    expect(lines[0]).toContain("status=200");
  });

  it("an answer Jev left out or could not shape names the question and the shape it got", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q2: JevQuestion = { ...q, id: "other" };
    const t: JevTransport = {
      post: async () => ({
        status: 200,
        json: { answers: { refusal: { error: `no ${KEY}` } } },
        ms: 2,
      }),
    };
    const v = await client(t).ask(sit, [q, q2]);
    expect(v.map((x) => x.skipped)).toEqual(["error", "error"]);
    const lines = warnLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cause=answer");
    expect(lines[0]).toContain("questions=refusal,other");
    expect(lines[0]).toContain("got=refusal:error,other:undefined");
    expect(lines[0]).not.toContain(KEY);
  });

  it("a good answer and a missing key print nothing", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok: JevTransport = {
      post: async () => ({ status: 200, json: { answers: { refusal: { noul: 0.1 } } }, ms: 2 }),
    };
    const v = await client(ok).ask(sit, [q]);
    expect(v[0].skipped).toBeUndefined();
    const keyless = await client(ok, () => ({}), "").ask(sit, [q]);
    expect(keyless[0].skipped).toBe("error");
    expect(warnLines(spy)).toHaveLength(0);
  });
});
