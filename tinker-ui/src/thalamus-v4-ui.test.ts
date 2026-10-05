import { describe, expect, it, vi } from "vitest";
import { createThalamusV4Ui, readableMessage } from "./thalamus-v4-ui";

// Phase G, the panel's client: it asks at a sensible pace, stays absent when the plugin is, and never loops.

const PANEL = {
  ok: true,
  mode: "shadow",
  ts: 1,
  today: { calls: 2, wouldChange: 1 },
  decisions: [],
  uses: [],
  cardNames: {},
  plans: [],
};

function setup(reply: (n: number) => unknown | Promise<unknown>) {
  let t = 1_000_000;
  let calls = 0;
  const repaint = vi.fn();
  const req = vi.fn(async () => {
    calls += 1;
    const r = await reply(calls);
    if (r instanceof Error) throw r;
    return r;
  });
  const ui = createThalamusV4Ui({
    req: req as never,
    repaint,
    now: () => t,
    refreshMs: 15_000,
    absentMs: 300_000,
  });
  const advance = (ms: number) => void (t += ms);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { ui, req, repaint, advance, settle };
}

describe("the Thalamus v4 panel's client", () => {
  it("shows nothing until the first answer, then the panel, and asks for one repaint", async () => {
    const t = setup(() => PANEL);
    expect(t.ui.view()).toBeUndefined();
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.ui.view()).toMatchObject({
      state: "ok",
      panel: { mode: "shadow", today: { calls: 2, wouldChange: 1 } },
    });
    expect((t.ui.view() as { panel: Record<string, unknown> }).panel).not.toHaveProperty("ok");
    expect(t.repaint).toHaveBeenCalledTimes(1);
    expect(t.req).toHaveBeenCalledWith("thalamus.panel", {});
  });

  it("asks at most every fifteen seconds however often the panel is drawn, and only once at a time", async () => {
    const t = setup(() => PANEL);
    for (let i = 0; i < 10; i++) t.ui.refreshIfDue();
    await t.settle();
    expect(t.req).toHaveBeenCalledTimes(1);
    t.ui.refreshIfDue();
    t.advance(14_000);
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.req).toHaveBeenCalledTimes(1);
    t.advance(2_000);
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.req).toHaveBeenCalledTimes(2);
  });

  it("does not repaint for an answer that changed nothing on screen", async () => {
    const t = setup(() => PANEL);
    t.ui.refreshIfDue();
    await t.settle();
    t.advance(20_000);
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.req).toHaveBeenCalledTimes(2);
    expect(t.repaint).toHaveBeenCalledTimes(1);
    t.advance(20_000);
    const changed = setup(() => ({ ...PANEL, today: { calls: 3, wouldChange: 1 } }));
    changed.ui.refreshIfDue();
    await changed.settle();
    expect(changed.repaint).toHaveBeenCalledTimes(1);
  });

  it("an unknown method means the plugin is not there: nothing shown, and the gateway is left alone for five minutes", async () => {
    const t = setup(() => new Error("unknown method: thalamus.panel"));
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.ui.view()).toBeUndefined();
    expect(t.repaint).not.toHaveBeenCalled();
    t.advance(200_000);
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.req).toHaveBeenCalledTimes(1);
    t.advance(120_000);
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.req).toHaveBeenCalledTimes(2);
  });

  it("reads the gateway's own error shape, a plain { code, message } object, so an unknown method is still absent", async () => {
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const repaint = vi.fn();
    const rejecting = (e: unknown) =>
      createThalamusV4Ui({
        req: (async () => {
          throw e;
        }) as never,
        repaint,
        now: () => 1,
      });
    const absent = rejecting({ code: "UNAVAILABLE", message: "unknown method: thalamus.panel" });
    absent.refreshIfDue();
    await settle();
    expect(absent.view()).toBeUndefined();
    expect(repaint).not.toHaveBeenCalled();
    const failing = rejecting({ code: "TIMEOUT", message: "gateway timed out" });
    failing.refreshIfDue();
    await settle();
    expect(failing.view()).toEqual({ state: "error", message: "gateway timed out" });
  });

  it("makes a readable line out of any rejection", () => {
    expect(readableMessage("plain")).toBe("plain");
    expect(readableMessage(new Error("boom"))).toBe("boom");
    expect(readableMessage({ code: "X", message: "from the gateway" })).toBe("from the gateway");
    expect(readableMessage({ code: "X" })).toBe('{"code":"X"}');
    expect(readableMessage(undefined)).toBe("unknown error");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(readableMessage(cyclic)).toBe("unknown error");
  });

  it("a reconnect asks again at the next draw, so a plugin that appeared is found without waiting", async () => {
    const t = setup((n) => (n === 1 ? new Error("unknown method: thalamus.panel") : PANEL));
    t.ui.refreshIfDue();
    await t.settle();
    t.ui.reset();
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.ui.view()).toMatchObject({ state: "ok" });
  });

  it("a real failure stays visible as a quiet error, is tried again at the normal pace, and clears when the gateway recovers", async () => {
    const t = setup((n) => (n === 1 ? new Error("gateway timed out") : PANEL));
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.ui.view()).toEqual({ state: "error", message: "gateway timed out" });
    expect(t.repaint).toHaveBeenCalledTimes(1);
    t.advance(16_000);
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.ui.view()).toMatchObject({ state: "ok" });
    expect(t.repaint).toHaveBeenCalledTimes(2);
  });

  it("a plugin that is loaded but not started shows nothing yet, and is asked again soon", async () => {
    const t = setup(() => ({ ok: false, error: "not-running" }));
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.ui.view()).toBeUndefined();
    t.advance(31_000);
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.req).toHaveBeenCalledTimes(2);
  });

  it("goes back to showing nothing if a plugin that answered is switched off", async () => {
    const t = setup((n) => (n === 1 ? PANEL : new Error("unknown method: thalamus.panel")));
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.ui.view()).toBeDefined();
    t.advance(20_000);
    t.ui.refreshIfDue();
    await t.settle();
    expect(t.ui.view()).toBeUndefined();
    expect(t.repaint).toHaveBeenCalledTimes(2);
  });

  it("remembers which expanders are open, and forgets the ones that were closed", () => {
    const t = setup(() => PANEL);
    t.ui.onToggle("t4:block", true);
    t.ui.onToggle("t4:d:x", true);
    t.ui.onToggle("t4:d:x", false);
    expect([...t.ui.openKeys()]).toEqual(["t4:block"]);
  });
});
