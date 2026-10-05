import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getToolResultDigester,
  registerToolResultDigester,
  type CallRouteMeta,
  type ToolResultDigester,
} from "../../infra/thalamus-call-router.js";
import { wrapToolsWithDigest } from "./tool-result-digest.js";

const meta: CallRouteMeta = {
  runId: "run-1",
  sessionKey: "agent:main:tinker:x",
  provider: "claude-code",
  model: "claude-opus-5",
};

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: { status: "ok", n: 1 },
});
const makeTools = () => {
  const exec = vi.fn(async (_id: string, params: unknown) =>
    textResult(`raw:${JSON.stringify(params)}`),
  );
  return {
    exec,
    tools: [{ name: "exec", label: "Exec", execute: exec }, { name: "noexec" }] as Array<{
      name: string;
      execute?: typeof exec;
    }>,
  };
};

let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  off = undefined;
});

describe("wrapToolsWithDigest: inert when no digester is registered", () => {
  it("returns the very array it was given, with the very tool objects in it", () => {
    const { tools } = makeTools();
    const before = [...tools];
    const out = wrapToolsWithDigest(tools, meta);
    expect(out).toBe(tools);
    out.forEach((t, i) => expect(t).toBe(before[i]));
  });

  it("a tool run through it returns exactly what the tool returns", async () => {
    const { exec, tools } = makeTools();
    const out = wrapToolsWithDigest(tools, meta);
    const r = await out[0].execute!("c1", { a: 1 });
    expect(r).toEqual(textResult('raw:{"a":1}'));
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("wrapToolsWithDigest: with a digester", () => {
  const install = (digest: ToolResultDigester["digest"]) => {
    const d = { digest: vi.fn(digest) };
    off = registerToolResultDigester(d);
    return d;
  };

  it("offers a text result and puts the returned text in its place, keeping details", async () => {
    const d = install(async () => "SHORT");
    const { tools } = makeTools();
    const out = wrapToolsWithDigest(tools, meta);
    const r = (await out[0].execute!("c1", { a: 1 })) as ReturnType<typeof textResult>;
    expect(r.content).toEqual([{ type: "text", text: "SHORT" }]);
    expect(r.details).toEqual({ status: "ok", n: 1 });
    expect(d.digest).toHaveBeenCalledWith({
      meta,
      toolName: "exec",
      toolCallId: "c1",
      params: { a: 1 },
      text: 'raw:{"a":1}',
    });
  });

  it("passes the tool's own arguments through untouched, by reference", async () => {
    install(async () => undefined);
    const { exec, tools } = makeTools();
    const params = { deep: { x: 1 } };
    const signal = new AbortController().signal;
    const onUpdate = () => {};
    await wrapToolsWithDigest(tools, meta)[0].execute!("c9", params, signal, onUpdate);
    const args = exec.mock.calls[0] as unknown[];
    expect(args[0]).toBe("c9");
    expect(args[1]).toBe(params);
    expect(args[2]).toBe(signal);
    expect(args[3]).toBe(onUpdate);
  });

  it("does not modify the result the tool returned", async () => {
    install(async () => "SHORT");
    const original = textResult("RAW");
    const tools = [{ name: "t", execute: async () => original }];
    await wrapToolsWithDigest(tools, meta)[0].execute!("c", {});
    expect(original.content[0].text).toBe("RAW");
  });

  it("undefined, empty text, a throw and a rejection all keep the result as it was", async () => {
    for (const digest of [
      async () => undefined,
      async () => "",
      async () => {
        throw new Error("boom");
      },
      () => Promise.reject(new Error("no")),
    ]) {
      off?.();
      install(digest as never);
      const original = textResult("RAW");
      const out = wrapToolsWithDigest([{ name: "t", execute: async () => original }], meta);
      expect(await out[0].execute!("c", {})).toBe(original);
    }
  });

  it("never offers a result that has an image or any block that is not text", async () => {
    const d = install(async () => "SHORT");
    const mixed = {
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "x", mimeType: "image/png" },
      ],
      details: {},
    };
    const out = wrapToolsWithDigest([{ name: "shot", execute: async () => mixed }], meta);
    expect(await out[0].execute!("c", {})).toBe(mixed);
    expect(d.digest).not.toHaveBeenCalled();
  });

  it("never offers an empty result, or one with no content array", async () => {
    const d = install(async () => "SHORT");
    for (const r of [{ content: [], details: {} }, { details: {} }, "plain", null]) {
      const out = wrapToolsWithDigest([{ name: "t", execute: async () => r }], meta);
      expect(await out[0].execute!("c", {})).toBe(r);
    }
    expect(d.digest).not.toHaveBeenCalled();
  });

  it("skips a run that has been aborted", async () => {
    const d = install(async () => "SHORT");
    const ac = new AbortController();
    ac.abort();
    const original = textResult("RAW");
    const out = wrapToolsWithDigest([{ name: "t", execute: async () => original }], meta);
    expect(await out[0].execute!("c", {}, ac.signal)).toBe(original);
    expect(d.digest).not.toHaveBeenCalled();
  });

  it("a tool error still propagates as an error, and is not digested", async () => {
    const d = install(async () => "SHORT");
    const out = wrapToolsWithDigest(
      [
        {
          name: "t",
          execute: async () => {
            throw new Error("tool failed");
          },
        },
      ],
      meta,
    );
    await expect(out[0].execute!("c", {})).rejects.toThrow("tool failed");
    expect(d.digest).not.toHaveBeenCalled();
  });

  it("leaves a tool with no execute alone, and keeps the prototype of one that has it", async () => {
    install(async () => "SHORT");
    class Tool {
      name = "cls";
      greeting() {
        return "hi";
      }
      async execute() {
        return textResult("RAW");
      }
    }
    const t = new Tool();
    const noexec = { name: "noexec" };
    const out = wrapToolsWithDigest([t, noexec] as never[], meta) as unknown as Tool[];
    expect(out[1]).toBe(noexec);
    expect(out[0]).not.toBe(t);
    expect(out[0].greeting()).toBe("hi");
    expect(out[0].name).toBe("cls");
  });

  it("if the digester is removed after wiring, results pass through unchanged", async () => {
    install(async () => "SHORT");
    const original = textResult("RAW");
    const out = wrapToolsWithDigest([{ name: "t", execute: async () => original }], meta);
    off!();
    off = undefined;
    expect(await out[0].execute!("c", {})).toBe(original);
  });
});

describe("the digester slot", () => {
  it("unregistering removes only the one that was registered", () => {
    const a: ToolResultDigester = { digest: async () => undefined };
    const b: ToolResultDigester = { digest: async () => undefined };
    const offA = registerToolResultDigester(a);
    const offB = registerToolResultDigester(b);
    offA();
    expect(getToolResultDigester()).toBe(b);
    offB();
    expect(getToolResultDigester()).toBeUndefined();
  });
});
