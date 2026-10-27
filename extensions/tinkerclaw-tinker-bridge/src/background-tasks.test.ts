import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FORK 2026-10-25 — a chat's live background tasks reach the page (background-tasks.ts), and every
// change of a worker's set is one `[bg-tasks]` journal line. The worker's logger is captured here.
const logged = vi.hoisted(() => ({ info: [] as string[] }));
vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    createSubsystemLogger: () => ({
      info: (line: string) => logged.info.push(line),
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  };
});

import {
  BACKGROUND_TASKS_METHOD,
  BRIDGE_BACKGROUND_TASKS_SLOT,
  backgroundJobsFor,
  type BackgroundTaskHolder,
  publishBackgroundTasksSeam,
  sessionKeysMatch,
} from "./background-tasks.js";
import { setUnpromptedWakeSender } from "./unprompted-turn.js";
import { ClaudeCodeWorker, type WorkerSpawnParams } from "./worker.js";

const T0 = 1_800_000_000_000;

function bgChanged(...tasks: Array<{ id: string; description?: string }>) {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((t) => ({
      task_id: t.id,
      task_type: "local_bash",
      ...(t.description ? { description: t.description } : {}),
    })),
  };
}

function idleWorker(openclawSessionKey = "agent:main:tinker:abc") {
  const w = new ClaudeCodeWorker({
    sessionKey: "tinker-sp-1",
    cwd: "/tmp",
    model: "claude-opus-5-5",
    openclawSessionKey,
  } as WorkerSpawnParams);
  // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
  const wAny = w as any;
  wAny.running = true;
  wAny.proc = { stdin: { write: () => true }, kill: () => true };
  const feed = (...lines: object[]) =>
    wAny.onStdoutChunk(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return { w, wAny, feed };
}

beforeEach(() => {
  logged.info.length = 0;
  setUnpromptedWakeSender(async () => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  setUnpromptedWakeSender(null);
  vi.useRealTimers();
});

describe("a worker's live background tasks", () => {
  it("keeps each task's first sighting as its start and logs only when the set changes", () => {
    const { w, feed } = idleWorker();
    feed(bgChanged({ id: "b1", description: "pnpm build" }));
    vi.setSystemTime(T0 + 30_000);
    feed(bgChanged({ id: "b1", description: "pnpm build" }, { id: "w2", description: "Review" }));
    // The same set again (the CLI repeats it on unrelated changes): no new line.
    feed(bgChanged({ id: "w2", description: "Review" }, { id: "b1", description: "pnpm build" }));

    expect(w.backgroundTasks()).toEqual([
      { id: "b1", description: "pnpm build", startedAt: T0 },
      { id: "w2", description: "Review", startedAt: T0 + 30_000 },
    ]);
    expect(logged.info.filter((l) => l.startsWith("[bg-tasks]"))).toEqual([
      "[bg-tasks] agent:main:tinker:abc live=1 [tinker-sp-1]",
      "[bg-tasks] agent:main:tinker:abc live=2 [tinker-sp-1]",
    ]);

    feed(bgChanged());
    expect(w.backgroundTasks()).toEqual([]);
    expect(logged.info.at(-1)).toBe("[bg-tasks] agent:main:tinker:abc live=0 [tinker-sp-1]");
  });

  it("a task with no description is named by its id", () => {
    const { w, feed } = idleWorker();
    feed(bgChanged({ id: "m9" }));
    expect(w.backgroundTasks()).toEqual([{ id: "m9", description: "m9", startedAt: T0 }]);
  });

  it("the tasks die with the CLI, and that is logged too", () => {
    const { w, wAny, feed } = idleWorker();
    feed(bgChanged({ id: "b1", description: "sleep 600" }));
    wAny.onExit(0, null);
    expect(w.backgroundTasks()).toEqual([]);
    expect(logged.info.filter((l) => l.startsWith("[bg-tasks]"))).toEqual([
      "[bg-tasks] agent:main:tinker:abc live=1 [tinker-sp-1]",
      "[bg-tasks] agent:main:tinker:abc live=0 [tinker-sp-1]",
    ]);
  });
});

describe("the list the page polls", () => {
  const holder = (
    session: string | undefined,
    tasks: Array<{ id: string; description: string; startedAt: number }>,
    alive = true,
  ): BackgroundTaskHolder => ({
    openclawSessionKey: session,
    isAlive: () => alive,
    backgroundTasks: () => tasks,
  });

  it("matches the chat up to the agent prefix, never a Fractal or another chat", () => {
    expect(sessionKeysMatch("agent:main:tinker:abc", "tinker:abc")).toBe(true);
    expect(sessionKeysMatch("agent:main:tinker:abc", "agent:main:tinker:abc")).toBe(true);
    expect(sessionKeysMatch("agent:main:fractal:p1", "agent:main:tinker:abc")).toBe(false);
    expect(sessionKeysMatch("agent:main:tinker:abcd", "tinker:abc")).toBe(false);
    expect(sessionKeysMatch(undefined, "tinker:abc")).toBe(false);
  });

  it("lists every live worker's tasks of that chat as background jobs, oldest first", () => {
    const jobs = backgroundJobsFor(
      [
        holder("agent:main:tinker:abc", [{ id: "w2", description: "Review", startedAt: T0 + 5 }]),
        holder("agent:main:tinker:other", [{ id: "x", description: "x", startedAt: T0 }]),
        holder("agent:main:tinker:abc", [{ id: "dead", description: "d", startedAt: T0 }], false),
        holder("agent:main:tinker:abc", [{ id: "b1", description: "pnpm build", startedAt: T0 }]),
        { openclawSessionKey: "agent:main:tinker:abc", isAlive: () => true },
      ],
      "tinker:abc",
    );
    expect(jobs).toEqual([
      {
        id: "b1",
        label: "pnpm build",
        kind: "background",
        session: "agent:main:tinker:abc",
        status: "running",
        startedAt: T0,
      },
      {
        id: "w2",
        label: "Review",
        kind: "background",
        session: "agent:main:tinker:abc",
        status: "running",
        startedAt: T0 + 5,
      },
    ]);
  });

  it("publishes the lookup on the slot core's ccBridge.backgroundTasks reads", () => {
    const { w, feed } = idleWorker();
    feed(bgChanged({ id: "b1", description: "pnpm build" }));
    publishBackgroundTasksSeam(() => ({ all: () => [w] }));
    const seam = (globalThis as Record<symbol, unknown>)[
      Symbol.for(BRIDGE_BACKGROUND_TASKS_SLOT)
    ] as (key: string) => unknown[];
    expect(seam("tinker:abc")).toEqual([
      expect.objectContaining({ id: "b1", label: "pnpm build", kind: "background" }),
    ]);
    expect(seam("tinker:other")).toEqual([]);
    const core = readFileSync(
      join(__dirname, "../../../src/gateway/server-methods/fractal.ts"),
      "utf8",
    );
    expect(core).toContain(`BRIDGE_BACKGROUND_TASKS_SLOT = "${BRIDGE_BACKGROUND_TASKS_SLOT}"`);
    expect(core).toContain(`"${BACKGROUND_TASKS_METHOD}"`);
  });
});
