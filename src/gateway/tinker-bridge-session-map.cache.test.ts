/**
 * FORK 2026-09-21 — the mtime+size-validated cache in tinker-bridge-session-map.ts.
 *
 * Contract under test: a second lookup against an unchanged file costs no disk read; a rewrite
 * (different mtime/size) is picked up on the next lookup. The map was 1.86 MB on the live gateway
 * and was re-read + re-parsed on EVERY chat.history call — twice, counting the [duprep-history]
 * logging branch — the same stall class store-cache.ts documents for sessions.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __tinkerBridgeSessionMapCacheTesting as cache,
  resolveTinkerBridgeCliSessionIdForOpenclawSession,
} from "./tinker-bridge-session-map.js";

let homeDir = "";

function mapFile(): string {
  return path.join(homeDir, ".openclaw", "tinker-bridge", "session-map.json");
}

function writeMap(map: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(mapFile()), { recursive: true });
  fs.writeFileSync(mapFile(), JSON.stringify(map), "utf-8");
}

/** Bump mtime past clock granularity so a rewrite is observable even at equal size. */
function touchLater(p: string, plusMs = 2_000): void {
  const st = fs.statSync(p);
  const later = new Date(st.mtimeMs + plusMs);
  fs.utimesSync(p, later, later);
}

function resolve(openclawSessionId: string): string | undefined {
  return resolveTinkerBridgeCliSessionIdForOpenclawSession({ openclawSessionId, homeDir });
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tinker-bridge-map-cache-"));
  cache.clear();
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("tinker-bridge session-map cache", () => {
  it("serves a repeat lookup from the parsed cache — no second disk read", () => {
    writeMap({
      "tinker-sp-a": { sessionId: "cli-1", updatedAt: 10, openclawSessionId: "oc-1" },
    });
    expect(resolve("oc-1")).toBe("cli-1");
    const readsAfterFirst = cache.diskReads;
    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(resolve("oc-1")).toBe("cli-1");
    expect(resolve("oc-1")).toBe("cli-1");
    expect(cache.diskReads).toBe(readsAfterFirst);
  });

  it("picks up a rewrite of the file (mtime/size changed)", () => {
    writeMap({
      "tinker-sp-a": { sessionId: "cli-1", updatedAt: 10, openclawSessionId: "oc-1" },
    });
    expect(resolve("oc-1")).toBe("cli-1");
    writeMap({
      "tinker-sp-a": { sessionId: "cli-2-rewritten", updatedAt: 20, openclawSessionId: "oc-1" },
    });
    touchLater(mapFile());
    expect(resolve("oc-1")).toBe("cli-2-rewritten");
  });

  it("a missing file resolves undefined and does not poison later lookups", () => {
    expect(resolve("oc-1")).toBeUndefined();
    writeMap({
      "tinker-sp-a": { sessionId: "cli-1", updatedAt: 10, openclawSessionId: "oc-1" },
    });
    expect(resolve("oc-1")).toBe("cli-1");
  });
});
