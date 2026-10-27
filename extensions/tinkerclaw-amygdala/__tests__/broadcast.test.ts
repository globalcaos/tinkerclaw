import { afterEach, describe, expect, it, vi } from "vitest";
import { captureBroadcast, currentBroadcast, resetBroadcastForTests } from "../src/broadcast.js";

afterEach(() => resetBroadcastForTests());

describe("the live-event broadcast (2026-10-22: api.broadcast does not exist, every event was dropped)", () => {
  it("nothing to send through until a method call hands one over", () => {
    expect(currentBroadcast({})).toBeUndefined();
    captureBroadcast(undefined);
    captureBroadcast({ broadcast: "not a function" });
    expect(currentBroadcast({})).toBeUndefined();
  });
  it("keeps the first one handed over, for every start of the plugin in the process", () => {
    const a = vi.fn();
    const b = vi.fn();
    captureBroadcast({ broadcast: a });
    captureBroadcast({ broadcast: b });
    currentBroadcast({})?.("amygdala2.intervention", { id: "x" });
    expect(a).toHaveBeenCalledWith("amygdala2.intervention", { id: "x" });
    expect(b).not.toHaveBeenCalled();
  });
  it("a host that does give the API a broadcast wins", () => {
    const own = vi.fn();
    captureBroadcast({ broadcast: vi.fn() });
    expect(currentBroadcast({ broadcast: own })).toBe(own);
  });
});
