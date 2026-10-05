import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVENTS_DB_DEFAULT_MAX_BYTES,
  eventsDbDisabled,
  resolveEventsDbBudgetBytes,
  resolveEventsDbPath,
} from "./paths.js";

describe("resolveEventsDbPath (logging.md §7.1, §9 step 3)", () => {
  it("REFUSES the production path under a test runner — sandboxed by construction", () => {
    // The canonical detector (isVitestRuntimeEnv), not a second weaker one: a vitest pool
    // worker's env can carry VITEST_WORKER_ID without VITEST.
    for (const env of [
      { VITEST: "1" },
      { VITEST: "true" },
      { NODE_ENV: "test" },
      { VITEST_WORKER_ID: "2" },
      { VITEST_POOL_ID: "1" },
    ] satisfies NodeJS.ProcessEnv[]) {
      expect(resolveEventsDbPath(env)).toEqual({ enabled: false, reason: "test_runner" });
    }
  });

  it("CONTROL: the real runner's env is detected as a test runner", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.OPENCLAW_EVENTS_DB_PATH;
    delete env.OPENCLAW_EVENTS_DB;
    const resolved = resolveEventsDbPath(env);
    expect(resolved.enabled).toBe(false);
    if (!resolved.enabled) {
      expect(resolved.reason).toBe("test_runner");
    }
  });

  it("an explicit OPENCLAW_EVENTS_DB_PATH opts in even under a test runner, salt beside it", () => {
    const resolved = resolveEventsDbPath({
      VITEST: "1",
      OPENCLAW_EVENTS_DB_PATH: "/tmp/sandbox/events.sqlite",
    });
    expect(resolved).toEqual({
      enabled: true,
      dbPath: "/tmp/sandbox/events.sqlite",
      saltPath: "/tmp/sandbox/events.salt",
    });
  });

  it("OPENCLAW_EVENTS_DB=0 disables outright, even with an explicit path", () => {
    expect(
      resolveEventsDbPath({ OPENCLAW_EVENTS_DB: "0", OPENCLAW_EVENTS_DB_PATH: "/tmp/x.sqlite" }),
    ).toEqual({ enabled: false, reason: "disabled" });
    for (const value of ["0", "false", "off", "no", " OFF "]) {
      expect(eventsDbDisabled({ OPENCLAW_EVENTS_DB: value })).toBe(true);
    }
    expect(eventsDbDisabled({ OPENCLAW_EVENTS_DB: "1" })).toBe(false);
    expect(eventsDbDisabled({})).toBe(false);
  });

  it("resolves <state>/logs/events.sqlite from the state dir, never a hardcoded home", () => {
    const stateDir = "/tmp/openclaw-events-paths-test-state";
    const resolved = resolveEventsDbPath({ OPENCLAW_STATE_DIR: stateDir });
    expect(resolved).toEqual({
      enabled: true,
      dbPath: join(stateDir, "logs", "events.sqlite"),
      saltPath: join(stateDir, "logs", "events.salt"),
    });
  });
});

describe("resolveEventsDbBudgetBytes (§7.4)", () => {
  it("defaults to 512 MiB and rejects nonsense", () => {
    expect(resolveEventsDbBudgetBytes({})).toBe(EVENTS_DB_DEFAULT_MAX_BYTES);
    expect(resolveEventsDbBudgetBytes({ OPENCLAW_EVENTS_DB_MAX_BYTES: "garbage" })).toBe(
      EVENTS_DB_DEFAULT_MAX_BYTES,
    );
    expect(resolveEventsDbBudgetBytes({ OPENCLAW_EVENTS_DB_MAX_BYTES: "0" })).toBe(
      EVENTS_DB_DEFAULT_MAX_BYTES,
    );
    expect(resolveEventsDbBudgetBytes({ OPENCLAW_EVENTS_DB_MAX_BYTES: "104857600" })).toBe(
      104_857_600,
    );
  });
});
