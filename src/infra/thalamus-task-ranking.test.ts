import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRanking } from "../shared/enhancement-task-rank.js";
import {
  hasTaskRanker,
  registerTaskRanker,
  requestTaskRanking,
  type TaskRankInput,
} from "./thalamus-task-ranking.js";

const input = (over: Partial<TaskRankInput> = {}): TaskRankInput => ({
  runId: "run-1",
  sessionKey: "agent:main:tinker:abc",
  text: "plan a family trip to Scotland in august",
  ...over,
});
const ranked = (runId = "run-1"): TaskRanking => ({
  ranked: true,
  runId,
  basis: "own",
  result: { use: [], inspire: [], source: "local", asked: 0, answered: 0, dropped: 0 },
});

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

describe("the once-per-run ranking slot", () => {
  it("answers undefined when no ranker is registered", () => {
    expect(hasTaskRanker()).toBe(false);
    expect(requestTaskRanking(input())).toBeUndefined();
  });

  it("runs the ranker once for a run, however many hooks ask, and gives each the same answer", async () => {
    const ranker = vi.fn(async () => ranked());
    offs.push(registerTaskRanker(ranker));
    const a = requestTaskRanking(input());
    const b = requestTaskRanking(input());
    expect(a).toBe(b);
    expect(await a).toEqual(ranked());
    expect(ranker).toHaveBeenCalledTimes(1);
  });

  it("ranks another run on its own", async () => {
    const ranker = vi.fn(async (i: TaskRankInput) => ranked(i.runId));
    offs.push(registerTaskRanker(ranker));
    await requestTaskRanking(input());
    await requestTaskRanking(input({ runId: "run-2" }));
    expect(ranker).toHaveBeenCalledTimes(2);
  });

  it("keys by session and text when a run has no id", async () => {
    const ranker = vi.fn(async () => ranked(""));
    offs.push(registerTaskRanker(ranker));
    await requestTaskRanking(input({ runId: "" }));
    await requestTaskRanking(input({ runId: "" }));
    await requestTaskRanking(
      input({ runId: "", text: "something else entirely, a different request" }),
    );
    expect(ranker).toHaveBeenCalledTimes(2);
  });

  it("turns a failing ranker into an unranked result and never throws", async () => {
    offs.push(registerTaskRanker(async () => Promise.reject(new Error("boom"))));
    await expect(requestTaskRanking(input())).resolves.toEqual({
      ranked: false,
      runId: "run-1",
      why: "error",
    });
  });

  it("removes only its own registration, and forgets the runs it answered", async () => {
    const first = vi.fn(async () => ranked());
    const offFirst = registerTaskRanker(first);
    await requestTaskRanking(input());
    const second = vi.fn(async () => ranked());
    offs.push(registerTaskRanker(second));
    offFirst();
    expect(hasTaskRanker()).toBe(true);
    await requestTaskRanking(input());
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("is shared through globalThis, so a second copy of the module sees the same ranker", async () => {
    const ranker = vi.fn(async () => ranked());
    offs.push(registerTaskRanker(ranker));
    const other = (
      await vi.importActual<typeof import("./thalamus-task-ranking.js")>(
        "./thalamus-task-ranking.js",
      )
    ).requestTaskRanking;
    await other(input());
    expect(ranker).toHaveBeenCalledTimes(1);
  });
});
