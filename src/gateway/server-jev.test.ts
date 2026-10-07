import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jevAvailability, resetJevAvailabilityForTests } from "../infra/jev/availability.js";
import { startJevStatusFeed } from "./server-jev.js";
import { jevHandlers } from "./server-methods/jev.js";

// The gateway tells every open page when Jev goes dormant, arms or is refused, and answers `jev.status` on demand.

// The key file lives under a throwaway state dir; the operator's real one is never read.
let stateDir: string;
let savedState: string | undefined;
let savedKey: string | undefined;
const writeKey = (token: string) => {
  mkdirSync(join(stateDir, "jev"), { recursive: true });
  writeFileSync(join(stateDir, "jev", "token"), token);
};

beforeEach(() => {
  savedState = process.env.OPENCLAW_STATE_DIR;
  savedKey = process.env.TYPESAFE_API_KEY;
  stateDir = mkdtempSync(join(tmpdir(), "jev-status-test-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.TYPESAFE_API_KEY;
  resetJevAvailabilityForTests();
});

afterEach(() => {
  resetJevAvailabilityForTests();
  vi.useRealTimers();
  if (savedState === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = savedState;
  }
  if (savedKey === undefined) {
    delete process.env.TYPESAFE_API_KEY;
  } else {
    process.env.TYPESAFE_API_KEY = savedKey;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe("jev status feed", () => {
  it("broadcasts `jev.status` when the state changes, not on every poll", async () => {
    vi.useFakeTimers();
    const sent: { event: string; payload: { state: string } }[] = [];
    const stop = startJevStatusFeed((event, payload) =>
      sent.push({ event, payload: payload as { state: string } }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(0); // nothing changed: no event

    writeKey("tok-test");
    await vi.advanceTimersByTimeAsync(11_000);
    expect(sent.map((s) => [s.event, s.payload.state])).toEqual([["jev.status", "unverified"]]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
    stop();
    rmSync(join(stateDir, "jev", "token"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(1); // stopped: no more events
  });
});

describe("jev.status method", () => {
  it("answers the current snapshot, never the token", async () => {
    writeKey("tok-method-secret");
    let result: unknown;
    await jevHandlers["jev.status"]({
      req: { type: "req", id: "1", method: "jev.status" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: (_ok: boolean, payload: unknown) => {
        result = payload;
      },
      context: {} as never,
    } as never);
    expect(result).toMatchObject({ state: "unverified", on: true, keySource: "file" });
    expect(JSON.stringify(result)).not.toContain("tok-method-secret");
    expect(jevAvailability().state).toBe("unverified");
  });
});
