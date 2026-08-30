import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  augmentChatHistoryWithCliSessionImports,
  mergeImportedChatHistoryMessages,
} from "./cli-session-history.js";

// FORK 2026-08-05 — regressions for "the model picker deleted my chat history".
//
// augmentChatHistoryWithCliSessionImports used to gate the claude-cli transcript import on
// resolveSessionModelRef(...).provider, i.e. on whichever model the tab happened to have
// selected. Switching a tab to grok/qwen flipped providerOverride, the gate short-circuited,
// and hundreds of already-rendered messages vanished on the next reconcile; switching the
// picker back resurrected them. The gate now reads PROVENANCE instead — does this session
// genuinely have a claude-cli transcript behind it — which no model switch can change.

const ORIGINAL_HOME = process.env.HOME;

const IMPORT_USER_TS = "2026-03-26T16:29:54.800Z";
const IMPORT_ASSISTANT_TS = "2026-03-26T16:29:55.500Z";

function createTranscriptLines(): string {
  return [
    JSON.stringify({
      type: "user",
      uuid: "prov-user-1",
      timestamp: IMPORT_USER_TS,
      message: { role: "user", content: "walk me through the deployment pipeline" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "prov-assistant-1",
      timestamp: IMPORT_ASSISTANT_TS,
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "it builds, then it deploys" }],
        stop_reason: "end_turn",
      },
    }),
  ].join("\n");
}

async function withClaudeTranscript<T>(
  run: (params: { homeDir: string; sessionId: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-provenance-"));
  const homeDir = path.join(root, "home");
  const sessionId = "0a2c9f10-3f4e-4f0b-9b0a-6d5c1f2e3a4b";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(
    path.join(projectsDir, `${sessionId}.jsonl`),
    createTranscriptLines(),
    "utf-8",
  );
  process.env.HOME = homeDir;
  try {
    return await run({ homeDir, sessionId });
  } finally {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

function importedCliSessionIds(messages: unknown[]): Array<string | undefined> {
  return messages.map(
    (message) => (message as { __openclaw?: { cliSessionId?: string } }).__openclaw?.cliSessionId,
  );
}

describe("cli session history provenance gate", () => {
  afterEach(() => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
  });

  // (a) The defect the architect sees on grok/qwen: the tab keeps its claude-cli history.
  it.each(["grok", "qwen", "openai"])(
    "still imports the claude-cli transcript when the model picker says %s",
    async (provider) => {
      await withClaudeTranscript(async ({ homeDir, sessionId }) => {
        const entry = {
          sessionId: "openclaw-session-provenance",
          updatedAt: Date.now(),
          cliSessionBindings: { "claude-cli": { sessionId } },
        };
        // A local store that has genuinely accumulated messages — the exact case the old
        // `params.localMessages.length > 0` clause used to turn into a deletion.
        const localMessages = [
          {
            role: "user",
            content: "and now give me the rollback plan",
            timestamp: Date.parse("2026-03-26T16:35:00.000Z"),
          },
        ];

        const switched = augmentChatHistoryWithCliSessionImports({
          entry,
          provider,
          localMessages,
          homeDir,
        });
        expect(switched.length).toBeGreaterThan(localMessages.length);
        expect(importedCliSessionIds(switched)).toContain(sessionId);

        // The invariant, stated directly: chat history is not a function of the model picker.
        const onClaude = augmentChatHistoryWithCliSessionImports({
          entry,
          provider: "claude-cli",
          localMessages,
          homeDir,
        });
        expect(switched).toEqual(onClaude);
      });
    },
  );

  // (b) Presence-of-transcript and emptiness-of-local-store are different questions.
  it("does not inject a transcript into a session that has no claude-cli provenance", async () => {
    await withClaudeTranscript(async ({ homeDir }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: { sessionId: "openclaw-session-without-provenance", updatedAt: Date.now() },
        provider: "grok",
        // An empty local store is NOT evidence of anything — a fresh sessionFile, a /clear
        // and the 4am wipe all produce one.
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(0);
    });
  });

  it("does not inject anything when the recorded cli session has no transcript on disk", async () => {
    await withClaudeTranscript(async ({ homeDir }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session-dangling-binding",
          updatedAt: Date.now(),
          cliSessionBindings: { "claude-cli": { sessionId: "deleted-cli-session" } },
        },
        provider: "grok",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(0);
    });
  });
});

describe("history merge ordering", () => {
  // (c) An unknown timestamp is UNKNOWN, not "infinitely late".
  it("interleaves untimestamped messages in source order instead of sorting them to the tail", () => {
    const importedMessages = [
      {
        role: "user",
        content: "first prompt: walk me through the deployment pipeline",
        timestamp: Date.parse("2026-03-26T16:00:00.000Z"),
        __openclaw: { importedFrom: "claude-cli", externalId: "u-1" },
      },
      {
        // The claude-cli importer omits `timestamp` entirely when the JSONL entry has none
        // it can parse, which used to drag the message to the very end of the transcript.
        role: "assistant",
        content: [{ type: "text", text: "it builds, and then it deploys" }],
        __openclaw: { importedFrom: "claude-cli", externalId: "a-1" },
      },
      {
        role: "user",
        content: "second prompt: now give me the rollback plan",
        timestamp: Date.parse("2026-03-26T16:10:00.000Z"),
        __openclaw: { importedFrom: "claude-cli", externalId: "u-2" },
      },
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages: [], importedMessages });
    expect(
      merged.map(
        (message) => (message as { __openclaw?: { externalId?: string } }).__openclaw?.externalId,
      ),
    ).toEqual(["u-1", "a-1", "u-2"]);
    // The live symptom: the LAST user message must be the prompt typed last.
    expect(merged[merged.length - 1]).toMatchObject({
      content: "second prompt: now give me the rollback plan",
    });
  });

  it("orders ISO-string timestamps chronologically rather than by arrival", () => {
    const importedMessages = [
      {
        role: "user",
        content: "later prompt written second but stored first in the array",
        timestamp: "2026-03-26T16:00:00.000Z",
        __openclaw: { importedFrom: "claude-cli", externalId: "iso-later" },
      },
      {
        role: "user",
        content: "earlier prompt that actually came first in wall-clock time",
        timestamp: "2026-03-26T15:00:00.000Z",
        __openclaw: { importedFrom: "claude-cli", externalId: "iso-earlier" },
      },
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages: [], importedMessages });
    expect(
      merged.map(
        (message) => (message as { __openclaw?: { externalId?: string } }).__openclaw?.externalId,
      ),
    ).toEqual(["iso-earlier", "iso-later"]);
  });
});
