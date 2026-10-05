import { describe, expect, it } from "vitest";
import { __defaultSpawnForTest, headlessReason } from "./config-open-external.js";

describe("config.openExternalFile", () => {
  it("survives an opener that does not exist (it used to kill the gateway)", async () => {
    const errors: unknown[] = [];
    const onUncaught = (err: unknown) => errors.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      __defaultSpawnForTest("definitely-not-an-opener-9f3a", ["/tmp/x.md"]);
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(errors).toEqual([]);
  });

  it("refuses on a headless Linux host instead of reporting a false ok", () => {
    expect(headlessReason({}, "linux")).toMatch(/no desktop session/);
    expect(headlessReason({ DISPLAY: ":0" }, "linux")).toBeNull();
    expect(headlessReason({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBeNull();
    expect(headlessReason({}, "darwin")).toBeNull();
  });
});
