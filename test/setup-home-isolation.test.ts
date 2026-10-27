import os, { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "../src/config/config.js";

// Captured at import, the way modules build their paths (`const DIR = join(homedir(), …)`).
const HOME_AT_IMPORT = homedir();

describe("shared test setup home isolation", () => {
  // FORK 2026-10-10 — HOME was isolated but os.homedir() was not (vitest worker threads keep their
  // own process.env copy), so tests wrote the developer's real ~/.openclaw. Both forms of the call,
  // at import and at test time, must see the temp home.
  it("isolates os.homedir() and the named homedir import, not just process.env.HOME", () => {
    const testHome = process.env.OPENCLAW_TEST_HOME;
    expect(testHome).toBeTruthy();
    expect(os.homedir()).toBe(testHome);
    expect(homedir()).toBe(testHome);
    expect(HOME_AT_IMPORT).toBe(testHome);
  });

  it("routes default config IO through the per-worker temp home", () => {
    const testHome = process.env.OPENCLAW_TEST_HOME;
    expect(testHome).toBeTruthy();
    expect(process.env.HOME).toBe(testHome);
    expect(process.env.USERPROFILE).toBe(testHome);
    expect(createConfigIO().configPath).toBe(path.join(testHome!, ".openclaw", "openclaw.json"));
  });
});
