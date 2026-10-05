import { afterEach, describe, expect, it } from "vitest";
import { __testing, awaitBridgeReattachScan, bridgeReattachFor } from "./bridge-reattach.js";

afterEach(() => {
  __testing.reset();
});

describe("bridge reattach registry", () => {
  it("answers per canonical session key", () => {
    __testing.set("agent:main:main", { unit: "tinkerclaw-worker-1", state: "pending" });
    expect(bridgeReattachFor("agent:main:main")?.unit).toBe("tinkerclaw-worker-1");
    expect(bridgeReattachFor("agent:main:other")).toBeUndefined();
    expect(bridgeReattachFor(undefined)).toBeUndefined();
  });

  it("runs the bridge's scan itself instead of waiting for a hook", async () => {
    let runs = 0;
    __testing.setScan(async () => {
      runs += 1;
      __testing.set("agent:main:main", { unit: "tinkerclaw-worker-2", state: "pending" });
    });
    await awaitBridgeReattachScan(5_000);
    expect(runs).toBe(1);
    expect(bridgeReattachFor("agent:main:main")?.state).toBe("pending");
  });

  it("never waits past the timeout for a scan that hangs", async () => {
    __testing.setScan(() => new Promise<void>(() => undefined));
    const started = Date.now();
    await awaitBridgeReattachScan(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it("does not wait when no bridge registered a scan", async () => {
    const started = Date.now();
    await awaitBridgeReattachScan(5_000);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
