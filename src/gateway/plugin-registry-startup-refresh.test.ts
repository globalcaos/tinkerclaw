import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshStalePluginRegistryAtStartup } from "./plugin-registry-startup-refresh.js";

// bug-log `stale-plugin-registry-rebuild-storm` (2026-10-15): a stale persisted registry, never refreshed after
// 2026-09-23, made every embedded run rebuild the plugin index on the gateway's one thread.

const config = {} as OpenClawConfig;

function deps(state: "fresh" | "stale" | "missing", refreshThrows = false) {
  const warn = vi.fn();
  const inspect = vi.fn(async () => ({
    state,
    refreshReasons: state === "stale" ? ["policy-changed", "source-changed"] : [],
    persisted: null,
    current: { plugins: [] },
  }));
  const refresh = vi.fn(async () => {
    if (refreshThrows) {
      throw new Error("disk full");
    }
    return { plugins: [{}, {}, {}] };
  });
  return {
    warn,
    inspect,
    refresh,
    params: {
      config,
      log: { info: vi.fn(), warn },
      inspect: inspect as never,
      refresh: refresh as never,
    },
  };
}

describe("refreshStalePluginRegistryAtStartup", () => {
  it("leaves a fresh registry alone", async () => {
    const d = deps("fresh");
    expect(await refreshStalePluginRegistryAtStartup(d.params)).toBe("fresh");
    expect(d.refresh).not.toHaveBeenCalled();
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("refreshes a stale registry once and says why", async () => {
    const d = deps("stale");
    expect(await refreshStalePluginRegistryAtStartup(d.params)).toBe("refreshed");
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledWith({ config, reason: "manual" });
    expect(d.warn.mock.calls[0][0]).toContain("policy-changed, source-changed");
    expect(d.warn.mock.calls[0][0]).toContain("3 plugins indexed");
  });

  it("refreshes a missing registry", async () => {
    const d = deps("missing");
    expect(await refreshStalePluginRegistryAtStartup(d.params)).toBe("refreshed");
  });

  it("never blocks the start when the refresh fails", async () => {
    const d = deps("stale", true);
    expect(await refreshStalePluginRegistryAtStartup(d.params)).toBe("failed");
    expect(d.warn.mock.calls[0][0]).toContain("disk full");
  });
});
