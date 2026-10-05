import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDefaultCwd } from "./defaults.js";

describe("resolveDefaultCwd", () => {
  const home = "/home/u";
  const legacy = path.join(home, ".openclaw", "jarvis-workspace");

  it("keeps ~/.openclaw/jarvis-workspace when that directory exists", () => {
    expect(resolveDefaultCwd({}, home, (p) => p === legacy)).toBe(legacy);
  });

  it("falls back to OpenClaw's default agent workspace on a fresh install", () => {
    // A clone has no jarvis-workspace; spawning into it failed every turn as `spawn systemd-run ENOENT`.
    expect(resolveDefaultCwd({}, home, () => false)).toBe(
      path.join(home, ".openclaw", "workspace"),
    );
  });

  it("follows OPENCLAW_PROFILE like the core workspace resolver", () => {
    expect(resolveDefaultCwd({ OPENCLAW_PROFILE: "work" }, home, () => false)).toBe(
      path.join(home, ".openclaw", "workspace-work"),
    );
    expect(resolveDefaultCwd({ OPENCLAW_PROFILE: "Default" }, home, () => false)).toBe(
      path.join(home, ".openclaw", "workspace"),
    );
  });
});
