import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_INDEX_CAP,
  clearRunWorkerIndex,
  forkParentRunId,
  forkSourceFor,
  noteRunWorker,
} from "./fork-parent.js";

const sessions: Record<string, string> = { "tinker-sp-chat": "cli-chat-1" };
const claudeSessionOf = (key: string) => sessions[key];

afterEach(() => clearRunWorkerIndex());

describe("forkParentRunId", () => {
  it("names the run a Fractal run reflects on, and nothing else", () => {
    expect(forkParentRunId("fractal-abc")).toBe("abc");
    expect(forkParentRunId("abc")).toBeNull();
    expect(forkParentRunId("fractal-")).toBeNull();
    expect(forkParentRunId(undefined)).toBeNull();
  });
});

describe("forkSourceFor", () => {
  it("forks the CLI session that served the parent run, for a fresh Fractal session", () => {
    noteRunWorker("abc", "tinker-sp-chat");
    expect(
      forkSourceFor({ runId: "fractal-abc", hasOwnConversation: false, claudeSessionOf }),
    ).toEqual({
      parentRunId: "abc",
      parentWorkerKey: "tinker-sp-chat",
      resumeSessionId: "cli-chat-1",
    });
  });

  it("keeps a session that already has a conversation on it (the 2026-10-08 same-session turn)", () => {
    noteRunWorker("abc", "tinker-sp-chat");
    expect(
      forkSourceFor({ runId: "fractal-abc", hasOwnConversation: true, claudeSessionOf }),
    ).toBeNull();
  });

  it("starts fresh when the parent run is unknown or its worker never got a CLI session", () => {
    expect(
      forkSourceFor({ runId: "fractal-abc", hasOwnConversation: false, claudeSessionOf }),
    ).toBeNull();
    noteRunWorker("xyz", "tinker-sp-unborn");
    expect(
      forkSourceFor({ runId: "fractal-xyz", hasOwnConversation: false, claudeSessionOf }),
    ).toBeNull();
  });

  it("never forks an ordinary run", () => {
    noteRunWorker("abc", "tinker-sp-chat");
    expect(forkSourceFor({ runId: "abc", hasOwnConversation: false, claudeSessionOf })).toBeNull();
  });
});

describe("noteRunWorker", () => {
  it("forgets the oldest run past the cap", () => {
    for (let i = 0; i <= RUN_INDEX_CAP; i++) {
      noteRunWorker(`run-${i}`, "tinker-sp-chat");
    }
    const source = (runId: string) =>
      forkSourceFor({ runId: `fractal-${runId}`, hasOwnConversation: false, claudeSessionOf });
    expect(source("run-0")).toBeNull();
    expect(source(`run-${RUN_INDEX_CAP}`)?.resumeSessionId).toBe("cli-chat-1");
  });
});
