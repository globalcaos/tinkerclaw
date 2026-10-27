import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/templates.js";
import { WaitRegistry } from "../src/wait-registry.js";

describe("WaitRegistry", () => {
  it("an answer that arrives before wait is remembered and wait resolves at once", async () => {
    const r = new WaitRegistry();
    r.register({ interventionId: "i1", ttlMs: 10_000 });
    expect(r.answer("i1", "allow-once")).toBe(true);
    expect(await r.wait("i1", 5_000)).toEqual({ answer: "allow-once" });
    expect(r.pending()).toBe(0);
  });

  it("wait blocks until answer is called", async () => {
    const r = new WaitRegistry();
    r.register({ interventionId: "i1", ttlMs: 10_000 });
    const p = r.wait("i1", 5_000);
    setTimeout(() => r.answer("i1", "keep-held"), 10);
    expect(await p).toEqual({ answer: "keep-held" });
  });

  it("timeout resolves to timeout and removes the pending entry", async () => {
    const r = new WaitRegistry();
    r.register({ interventionId: "i1", ttlMs: 10_000 });
    expect(await r.wait("i1", 20)).toEqual({ answer: "timeout" });
    expect(r.pending()).toBe(0);
    expect(r.answer("i1", "allow-once")).toBe(false);
  });

  it("an unknown id times out immediately", async () => {
    const r = new WaitRegistry();
    expect(await r.wait("nope", 60_000)).toEqual({ answer: "timeout" });
  });

  it("option answers carry the rendered user-picked text with the option label", async () => {
    const r = new WaitRegistry();
    r.register({
      interventionId: "i1",
      options: [
        { id: "a", label: "Label A" },
        { id: "b", label: "Label B" },
      ],
      ttlMs: 10_000,
    });
    const p = r.wait("i1", 5_000);
    r.answer("i1", "option:b");
    expect(await p).toEqual({
      answer: "option:b",
      text: renderTemplate("user-picked", { reading: "Label B" }),
    });
  });

  it("a remembered answer expires with its ttl", () => {
    let t = 1000;
    const r = new WaitRegistry({ now: () => t });
    r.register({ interventionId: "i1", ttlMs: 100 });
    t += 200;
    expect(r.answer("i1", "allow-once")).toBe(false);
  });

  it("the first answer wins", () => {
    const r = new WaitRegistry();
    r.register({ interventionId: "i1", ttlMs: 10_000 });
    expect(r.answer("i1", "allow-once")).toBe(true);
    expect(r.answer("i1", "keep-held")).toBe(false);
  });

  it("dispose releases every waiter", async () => {
    const r = new WaitRegistry();
    r.register({ interventionId: "i1", ttlMs: 10_000 });
    const p = r.wait("i1", 60_000);
    r.dispose();
    expect(await p).toEqual({ answer: "timeout" });
  });
});
