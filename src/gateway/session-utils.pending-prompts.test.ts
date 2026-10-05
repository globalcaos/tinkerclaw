import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { clearFollowupQueue, getFollowupQueue } from "../auto-reply/reply/queue/state.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import {
  __testing as replyRunTesting,
  createReplyOperation,
  listSteeredReplyPrompts,
  recordSteeredReplyPrompt,
  replyRunRegistry,
} from "../auto-reply/reply/reply-run-registry.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearSessionStoreCacheForTest, loadSessionStore } from "../config/sessions.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { deriveReplyRegistryKey, resolveReplyHolderKey } from "./reply-registry-key.js";
import {
  buildGatewaySessionRow,
  deriveSessionPendingPrompts,
  resetAcceptedChatSendsForTest,
  trackAcceptedChatSend,
} from "./session-utils.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.3 / §7 step G5. The sessions.list
// row's `pendingPrompts` is a DERIVATION over the in-memory holders; each test drives the REAL
// holder (follow-up queue, reply-run registry, run set) and reads the row the list builds.
//
// CONTROL (prompt-queue.md §7): on the tree before G5 neither `deriveSessionPendingPrompts` nor
// `recordSteeredReplyPrompt` exists, so this file fails to import and every test is red.

/** failures.md M21: every entry point that loads a session store, counted and passed through. */
const storeReads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../config/sessions/store-load.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/store-load.js")>();
  return {
    ...actual,
    loadSessionStore: (...args: Parameters<typeof actual.loadSessionStore>) => {
      storeReads.count += 1;
      return actual.loadSessionStore(...args);
    },
    loadSessionStoreEntry: (...args: Parameters<typeof actual.loadSessionStoreEntry>) => {
      storeReads.count += 1;
      return actual.loadSessionStoreEntry(...args);
    },
    hasSessionStoreEntry: (...args: Parameters<typeof actual.hasSessionStoreEntry>) => {
      storeReads.count += 1;
      return actual.hasSessionStoreEntry(...args);
    },
  };
});

const SESSION_KEY = "agent:main:tinker:pq-g5";
const OTHER_KEY = "agent:main:tinker:pq-g5-other";
const RUN_ID = "run-pq-g5";
const ROW_CFG = {
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } },
} as OpenClawConfig;
/**
 * A split-key session (reply-registry-key.ts): a turn dispatched with the bare key registers under
 * it, while the store folds the bare key into the default agent's row.
 */
const BARE_DISPATCH_KEY = "tinker:pq-g5-split";
const SPLIT_ROW_KEY = "agent:main:tinker:pq-g5-split";

function buildRow(key = SESSION_KEY): GatewaySessionRow {
  return buildGatewaySessionRow({
    cfg: ROW_CFG,
    storePath: "",
    store: {},
    key,
  });
}

/** chat.send's mark for a prompt acked and not yet placed (holder C), as chat.ts sets it. */
function accept(promptKey: string, since: number, sessionKey = SESSION_KEY) {
  return trackAcceptedChatSend({ promptKey, sessionKey, since });
}

/** One backlogged prompt, as agent-runner.ts's enqueue-followup branch leaves it. */
function queueFollowup(messageId: string | undefined, enqueuedAt: number, key = SESSION_KEY): void {
  getFollowupQueue(key, { mode: "steer-backlog" }).items.push({
    prompt: "typed while the current turn was running",
    messageId,
    enqueuedAt,
    run: { sessionKey: key },
  } as unknown as FollowupRun);
}

function beginTurn(promptKey?: string, key = SESSION_KEY) {
  return createReplyOperation({
    sessionKey: key,
    sessionId: `sess-${key}`,
    resetTriggered: false,
    promptKey,
  });
}

/** A turn whose run has registered: agent-runner.ts flips the phase, then the run context opens. */
function beginRunningTurn(promptKey?: string) {
  const operation = beginTurn(promptKey);
  operation.setPhase("running");
  registerAgentRunContext(RUN_ID, { sessionKey: SESSION_KEY });
  return operation;
}

afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  clearFollowupQueue(SESSION_KEY);
  clearFollowupQueue(OTHER_KEY);
  resetAcceptedChatSendsForTest();
  resetAgentRunContextForTest();
  clearSessionStoreCacheForTest();
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
  storeReads.count = 0;
});

describe("sessions.list row pendingPrompts (prompt-queue.md §6.3 / G5)", () => {
  test("absent, not an empty list, when no holder has a prompt", () => {
    expect(deriveSessionPendingPrompts(SESSION_KEY)).toBeUndefined();
    const row = buildRow();
    expect(row).not.toHaveProperty("pendingPrompts");
    expect(JSON.parse(JSON.stringify(row))).not.toHaveProperty("pendingPrompts");
  });

  test("BEHIND: every keyed follow-up queue item, in queue order, since its enqueuedAt", () => {
    queueFollowup("prompt-a", 1_000);
    queueFollowup("prompt-b", 2_000);
    expect(buildRow().pendingPrompts).toEqual([
      { key: "prompt-a", state: "behind", since: 1_000 },
      { key: "prompt-b", state: "behind", since: 2_000 },
    ]);
  });

  test("PREPARING: the reply operation's own prompt, in every phase before its run", () => {
    const operation = replyRunRegistry.begin({
      sessionKey: SESSION_KEY,
      sessionId: "sess-pq-g5",
      resetTriggered: false,
      promptKey: "prompt-p",
    });
    expect(operation.promptKey).toBe("prompt-p");
    // followup-runner.ts opens the run context BEFORE preflight: the phase decides, not the run set.
    registerAgentRunContext(RUN_ID, { sessionKey: SESSION_KEY });
    for (const phase of ["queued", "preflight_compacting", "memory_flushing"] as const) {
      operation.setPhase(phase);
      expect(buildRow().pendingPrompts).toEqual([
        { key: "prompt-p", state: "preparing", since: operation.startedAt },
      ]);
    }
  });

  test("RUNNING: the operation's prompt once its phase is running and its run is registered", () => {
    const operation = beginRunningTurn("prompt-r");
    expect(buildRow().pendingPrompts).toEqual([
      { key: "prompt-r", state: "running", since: operation.startedAt },
    ]);
  });

  test("STEERED: a prompt the running turn accepted, until that turn's run ends", () => {
    const operation = beginRunningTurn("prompt-host");
    expect(recordSteeredReplyPrompt(SESSION_KEY, "prompt-s", 5_000)).toBe(true);
    expect(buildRow().pendingPrompts).toEqual([
      { key: "prompt-host", state: "running", since: operation.startedAt },
      { key: "prompt-s", state: "steered", since: 5_000 },
    ]);
    // server-chat.ts clears the run context when the run's lifecycle ends: the host turn is over,
    // and with it both its own prompt and the prompts folded into it (§2 STEERED → ANSWERED), even
    // while the operation is still finishing up.
    clearAgentRunContext(RUN_ID);
    expect(buildRow()).not.toHaveProperty("pendingPrompts");
    operation.complete();
    expect(listSteeredReplyPrompts(SESSION_KEY)).toEqual([]);
  });

  test("a steer is recorded only on an unsettled turn", () => {
    expect(recordSteeredReplyPrompt(SESSION_KEY, "prompt-s")).toBe(false);
    const operation = beginTurn("prompt-host");
    operation.setPhase("running");
    // A running-phase abort settles the operation but leaves it registered until its backend lets go.
    operation.abortByUser();
    expect(recordSteeredReplyPrompt(SESSION_KEY, "prompt-s")).toBe(false);
    expect(listSteeredReplyPrompts(SESSION_KEY)).toEqual([]);
  });

  test("an earlier turn's silent run does not make this turn RUNNING", () => {
    const operation = beginTurn("prompt-r");
    registerAgentRunContext("run-orphan", {
      sessionKey: SESSION_KEY,
      registeredAt: (operation.startedAt ?? Date.now()) - 60_000,
    });
    operation.setPhase("running");
    expect(buildRow()).not.toHaveProperty("pendingPrompts");
  });

  test("the prompt a follow-up turn is answering is RUNNING, not BEHIND", () => {
    // drain.ts leaves the item in queue.items until its run returns.
    queueFollowup("prompt-f", 1_000);
    queueFollowup("prompt-g", 2_000);
    const operation = beginRunningTurn("prompt-f");
    expect(buildRow().pendingPrompts).toEqual([
      { key: "prompt-f", state: "running", since: operation.startedAt },
      { key: "prompt-g", state: "behind", since: 2_000 },
    ]);
  });

  test("a steer whose delivery was lost and was re-enqueued is BEHIND, not STEERED", () => {
    const operation = beginRunningTurn("prompt-host");
    recordSteeredReplyPrompt(SESSION_KEY, "prompt-lost", 5_000);
    queueFollowup("prompt-lost", 5_100);
    expect(buildRow().pendingPrompts).toEqual([
      { key: "prompt-host", state: "running", since: operation.startedAt },
      { key: "prompt-lost", state: "behind", since: 5_100 },
    ]);
  });

  test("a prompt with no key is never reported under a synthetic one (PQ-1)", () => {
    queueFollowup(undefined, 1_000);
    beginRunningTurn(undefined);
    expect(buildRow()).not.toHaveProperty("pendingPrompts");
  });

  test("a settled operation is not pending", () => {
    const operation = beginRunningTurn("prompt-r");
    operation.abortByUser();
    expect(replyRunRegistry.get(SESSION_KEY)).toBe(operation);
    expect(buildRow()).not.toHaveProperty("pendingPrompts");
  });

  test("another session's holders never reach this row (keys match exactly)", () => {
    queueFollowup("prompt-other", 1_000, OTHER_KEY);
    beginTurn("prompt-other-op", OTHER_KEY).setPhase("running");
    registerAgentRunContext("run-other", { sessionKey: OTHER_KEY });
    recordSteeredReplyPrompt(OTHER_KEY, "prompt-other-steer");
    accept("prompt-other-accepted", 1_000, OTHER_KEY);
    expect(buildRow()).not.toHaveProperty("pendingPrompts");
    expect(deriveSessionPendingPrompts(OTHER_KEY)).toHaveLength(4);
  });

  test("deriving it adds no session-store read (failures.md M21)", () => {
    // Positive control: a store load through the barrel session-utils.ts imports IS counted, so a
    // zero below cannot come from a spy that is not wired.
    loadSessionStore(path.join(os.tmpdir(), "openclaw-pq-g5-no-store", "sessions.json"), {
      skipCache: true,
    });
    expect(storeReads.count).toBeGreaterThan(0);

    storeReads.count = 0;
    buildRow();
    const idleRowReads = storeReads.count;

    queueFollowup("prompt-b", 1_000);
    beginRunningTurn("prompt-r");
    recordSteeredReplyPrompt(SESSION_KEY, "prompt-s", 2_000);
    accept("prompt-c", 3_000);

    storeReads.count = 0;
    expect(deriveSessionPendingPrompts(SESSION_KEY)).toHaveLength(4);
    expect(storeReads.count).toBe(0);

    storeReads.count = 0;
    expect(buildRow().pendingPrompts).toHaveLength(4);
    expect(storeReads.count).toBe(idleRowReads);
  });

  test("CONTROL: a split-key row reads the run set under its holder key (RUNNING, run.live)", () => {
    // The fold this test needs, from the REAL derivations, never a copy of them.
    const holderKey = deriveReplyRegistryKey(ROW_CFG, BARE_DISPATCH_KEY);
    expect(holderKey).not.toBe(SPLIT_ROW_KEY);
    const operation = beginTurn("prompt-split", holderKey);
    operation.setPhase("running");
    registerAgentRunContext(RUN_ID, { sessionKey: holderKey });
    expect(resolveReplyHolderKey(SPLIT_ROW_KEY, () => ROW_CFG)).toBe(holderKey);

    // On the parent tree the row read the run set under its own key: `run.live` false, and the
    // running prompt reported as nothing.
    const row = buildRow(SPLIT_ROW_KEY);
    expect(row.run).toMatchObject({ live: true, count: 1 });
    expect(row.pendingPrompts).toEqual([
      { key: "prompt-split", state: "running", since: operation.startedAt },
    ]);
    // deriveSessionPendingPrompts' own default reading follows the holder key too.
    expect(deriveSessionPendingPrompts(SPLIT_ROW_KEY, undefined, () => ROW_CFG)).toEqual(
      row.pendingPrompts,
    );

    // A run context registered under the row key itself still counts: the row joins both
    // readings and never trades one for the other.
    registerAgentRunContext("run-pq-g5-row-key", { sessionKey: SPLIT_ROW_KEY });
    expect(buildRow(SPLIT_ROW_KEY).run).toMatchObject({ live: true, count: 2 });
  });

  test("CONTROL: an accepted chat.send prompt nothing has placed yet is PREPARING (holder C)", () => {
    // chat.send's span between its ack and runReplyAgent: only the controller holds the prompt.
    // On the parent tree no holder named the key, so the row carried no pendingPrompts at all.
    const release = accept("prompt-accepted", 3_000);
    expect(buildRow().pendingPrompts).toEqual([
      { key: "prompt-accepted", state: "preparing", since: 3_000 },
    ]);
    release();
    expect(buildRow()).not.toHaveProperty("pendingPrompts");
  });

  test("holder C yields: other holders win, and the operation's keys stay the operation's", () => {
    accept("prompt-op", 1);
    accept("prompt-q", 1);
    queueFollowup("prompt-q", 2_000);
    const operation = beginTurn("prompt-op");
    expect(buildRow().pendingPrompts).toEqual([
      { key: "prompt-op", state: "preparing", since: operation.startedAt },
      { key: "prompt-q", state: "behind", since: 2_000 },
    ]);
    // The operation's run has ended (phase running, nothing in the run set): it reports its prompt
    // as nothing, and holder C must not bring it back as PREPARING.
    operation.setPhase("running");
    expect(buildRow().pendingPrompts).toEqual([{ key: "prompt-q", state: "behind", since: 2_000 }]);
  });

  test("a release drops only its own mark, and an unkeyed prompt is never marked (PQ-1)", () => {
    const first = accept("prompt-reused", 1_000);
    first();
    const second = accept("prompt-reused", 2_000);
    // The first send's late exit (its dispatch settling after the key was sent again).
    first();
    expect(buildRow().pendingPrompts).toEqual([
      { key: "prompt-reused", state: "preparing", since: 2_000 },
    ]);
    second();
    second();
    expect(buildRow()).not.toHaveProperty("pendingPrompts");

    accept("  ", 1);
    // Straight to the tracker: `accept`'s default would fill an undefined session back in.
    trackAcceptedChatSend({ promptKey: "prompt-nowhere", sessionKey: undefined, since: 1 });
    expect(buildRow()).not.toHaveProperty("pendingPrompts");
    expect(deriveSessionPendingPrompts(SESSION_KEY)).toBeUndefined();
  });
});
