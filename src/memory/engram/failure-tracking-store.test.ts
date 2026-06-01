/**
 * Tests — Upgrade 4 runtime wiring: atomic-write persistence of the
 * per-strategy failure-state map (failure-tracking-store.ts).
 *
 * Test target: src/memory/engram/failure-tracking-store.ts
 * I/O functions run against a temp dir via the `baseDir` override.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failureStatePath,
  loadFailureStateMap,
  saveFailureStateMap,
  updateFailureStateMap,
} from "./failure-tracking-store.js";
import {
  createInitialStrategyState,
  recordFailure,
  type FailureStateMap,
} from "./failure-tracking.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "failure-state-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("failureStatePath", () => {
  it("resolves under the engram base dir", () => {
    expect(failureStatePath(dir)).toBe(path.join(dir, "failure-state.json"));
  });

  it("defaults to ~/.openclaw/engram when no baseDir is given", () => {
    const p = failureStatePath();
    expect(p.endsWith(path.join(".openclaw", "engram", "failure-state.json"))).toBe(true);
  });
});

describe("loadFailureStateMap", () => {
  it("returns an empty map when the file does not exist", () => {
    expect(loadFailureStateMap(dir)).toEqual({});
  });

  it("returns an empty map when the file is corrupt (defensive)", () => {
    fs.writeFileSync(failureStatePath(dir), "{not json");
    expect(loadFailureStateMap(dir)).toEqual({});
  });

  it("round-trips a saved map", () => {
    const map: FailureStateMap = {
      "fork-sync:always-merge": recordFailure(
        createInitialStrategyState("fork-sync:always-merge"),
        "2026-05-30T10:00:00.000Z",
        "e1",
      ),
    };
    saveFailureStateMap(map, dir);
    expect(loadFailureStateMap(dir)).toEqual(map);
  });
});

describe("saveFailureStateMap (atomic)", () => {
  it("creates the directory lazily", () => {
    const nested = path.join(dir, "deep", "engram");
    saveFailureStateMap({}, nested);
    expect(fs.existsSync(path.join(nested, "failure-state.json"))).toBe(true);
  });

  it("does not leave a temp file behind after a successful write", () => {
    saveFailureStateMap({ x: createInitialStrategyState("x") }, dir);
    const stray = fs.readdirSync(dir).filter((f) => f !== "failure-state.json");
    expect(stray).toEqual([]);
  });

  it("writes pretty-printed JSON", () => {
    saveFailureStateMap({ x: createInitialStrategyState("x") }, dir);
    const raw = fs.readFileSync(failureStatePath(dir), "utf-8");
    expect(raw).toContain("\n  ");
  });
});

describe("updateFailureStateMap (read-modify-write)", () => {
  it("re-reads from disk before applying the mutator (no stale clobber)", () => {
    // Writer A persists strategy 'a'.
    saveFailureStateMap({ a: createInitialStrategyState("a") }, dir);
    // Writer B, holding a STALE empty snapshot, adds strategy 'b' via the
    // read-modify-write helper — must NOT drop 'a'.
    updateFailureStateMap(dir, (fresh) => {
      fresh["b"] = createInitialStrategyState("b");
      return fresh;
    });
    const after = loadFailureStateMap(dir);
    expect(Object.keys(after).sort()).toEqual(["a", "b"]);
  });

  it("returns the persisted map and applies the mutation", () => {
    const result = updateFailureStateMap(dir, (m) => {
      m["s"] = recordFailure(createInitialStrategyState("s"), "2026-05-30T10:00:00.000Z", "e1");
      return m;
    });
    expect(result["s"].consecutiveErrors).toBe(1);
    expect(loadFailureStateMap(dir)["s"].consecutiveErrors).toBe(1);
  });
});
