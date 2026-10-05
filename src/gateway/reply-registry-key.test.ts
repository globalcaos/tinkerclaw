import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFollowupQueue, getFollowupQueue } from "../auto-reply/reply/queue/state.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import {
  __testing as replyRunTesting,
  createReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  deriveReplyRegistryKey,
  findReplyOperation,
  resolveReplyHolderKey,
  resolveReplyRegistryKeys,
} from "./reply-registry-key.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import {
  deriveSessionPendingPrompts,
  loadCombinedSessionStoreForGateway,
} from "./session-utils.js";

// FORK 2026-09-25 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 G5/G6, the key-canonicalisation
// follow-up. The reply pipeline keys its holders by initSessionState's derivation; the gateway
// reads them holding a RAW dispatch key or a STORE key. The `alias` config below (the G6 commit's:
// no `main` agent, default agent `ops`, main key `work`) parts all three. Every registered key
// comes from the REAL initSessionState and every store key from the REAL resolveSessionStoreKey,
// never from a copy of either, so a change to one that the helper does not follow fails here.
//
// CONTROL: on the parent tree reply-registry-key.ts does not exist and this file fails to import.
// The behavioural control is the pendingPrompts case: there, deriveSessionPendingPrompts reads the
// holders under the row's store key (`agent:ops:work`) and returns undefined.

type CfgShape = "default" | "alias" | "global" | "two-agents";

let tempDir = "";
const queueKeys: string[] = [];

const NOT_LIVE = { live: false };

function makeCfg(shape: CfgShape): OpenClawConfig {
  const store = path.join(tempDir, "sessions.json");
  if (shape === "alias") {
    return {
      session: { store, mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    };
  }
  if (shape === "global") {
    return { session: { store, scope: "global" } };
  }
  if (shape === "two-agents") {
    return {
      session: { store },
      agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
    };
  }
  return { session: { store } };
}

/** The key the REAL initSessionState registers a turn under (it also writes the store entry). */
async function registeredKeyFor(ctxSessionKey: string, cfg: OpenClawConfig) {
  const session = await initSessionState({
    ctx: {
      Body: "hello",
      From: "user-key-audit",
      To: "bot-key-audit",
      SessionKey: ctxSessionKey,
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      CommandAuthorized: true,
    },
    cfg,
    commandAuthorized: true,
  });
  return { registeredKey: session.sessionKey, sessionId: session.sessionId };
}

const DISPATCH_SPELLINGS: Array<[label: string, ctxSessionKey: string, shape: CfgShape]> = [
  ["its canonical key", "agent:main:main", "default"],
  ["a short alias of the main session", "main", "alias"],
  ["a legacy main key under another default agent", "agent:main:main", "alias"],
  ["a mixed-case spelling", "Agent:Main:Main", "default"],
  ["the main key under scope global", "agent:main:main", "global"],
  ["a bare key", "tinker:pq-key-bare", "default"],
];

describe("reply-registry-key: the key the reply pipeline holds a session's turns under", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reply-key-"));
    replyRunTesting.resetReplyRunRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    replyRunTesting.resetReplyRunRegistry();
    for (const key of queueKeys.splice(0)) {
      clearFollowupQueue(key);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(DISPATCH_SPELLINGS)(
    "deriveReplyRegistryKey is initSessionState's own key for %s",
    async (_label, ctxSessionKey, shape) => {
      const cfg = makeCfg(shape);
      const { registeredKey } = await registeredKeyFor(ctxSessionKey, cfg);
      expect(deriveReplyRegistryKey(cfg, ctxSessionKey)).toBe(registeredKey);
    },
  );

  it("a row's store key names the legacy registry key the store folds into it", async () => {
    const cfg = makeCfg("alias");
    const { registeredKey } = await registeredKeyFor("agent:main:main", cfg);
    const storeKey = resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" });
    // The split this file exists for: the store folds the legacy key onto the default agent.
    expect(storeKey).not.toBe(registeredKey);
    expect(resolveReplyRegistryKeys(cfg, storeKey)).toContain(registeredKey);
  });

  it("a row's store key names the bare registry key the store prefixes", async () => {
    const cfg = makeCfg("default");
    const { registeredKey } = await registeredKeyFor("tinker:pq-key-bare", cfg);
    const storeKey = resolveSessionStoreKey({ cfg, sessionKey: "tinker:pq-key-bare" });
    expect(resolveReplyRegistryKeys(cfg, storeKey)).toContain(registeredKey);
    // An ordinary key on an ordinary config adds nothing.
    expect(resolveReplyRegistryKeys(cfg, "agent:main:main")).toEqual(["agent:main:main"]);
    expect(resolveReplyRegistryKeys(cfg, "  ")).toEqual([]);
  });

  it("the widening is by spelling, never by session", () => {
    // Another agent's bare key is the DEFAULT agent's session, not this one.
    const twoAgents = makeCfg("two-agents");
    expect(resolveReplyRegistryKeys(twoAgents, "agent:ops:tinker:x")).toEqual([
      "agent:ops:tinker:x",
    ]);
    // A legacy `agent:main:<rest>` folds only for the main key, so a sibling stays out.
    const alias = makeCfg("alias");
    expect(resolveReplyRegistryKeys(alias, "agent:ops:elsewhere")).not.toContain(
      "agent:main:elsewhere",
    );
  });

  it("findReplyOperation follows a DISPATCH: exact, then its registry key, never a row key", async () => {
    const cfg = makeCfg("alias");
    const { registeredKey, sessionId } = await registeredKeyFor("agent:main:main", cfg);
    const operation = createReplyOperation({
      sessionKey: registeredKey,
      sessionId,
      resetTriggered: false,
    });
    const getConfig = vi.fn(() => cfg);

    expect(findReplyOperation(registeredKey, getConfig)).toBe(operation);
    expect(getConfig).not.toHaveBeenCalled(); // an exact hit reads no config
    expect(findReplyOperation("agent:main:main", getConfig)).toBe(operation);
    // A turn dispatched with the row key registers under the row key; the legacy dispatch's turn
    // is not that turn, so the probe must not report its phase there.
    const storeKey = resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" });
    expect(findReplyOperation(storeKey, getConfig)).toBeUndefined();

    operation.complete();
    getConfig.mockClear();
    expect(findReplyOperation("agent:main:main", getConfig)).toBeUndefined();
    expect(getConfig).not.toHaveBeenCalled(); // nothing registered: nothing derived
  });

  it("CONTROL: a row's store key finds the pending prompts held under the legacy registry key", async () => {
    const cfg = makeCfg("alias");
    const { registeredKey, sessionId } = await registeredKeyFor("agent:main:main", cfg);
    const operation = createReplyOperation({
      sessionKey: registeredKey,
      sessionId,
      resetTriggered: false,
      promptKey: "prompt-split-preparing",
    });
    queueKeys.push(registeredKey);
    getFollowupQueue(registeredKey, { mode: "steer-backlog" }).items.push({
      prompt: "typed while that turn was preparing",
      messageId: "prompt-split-behind",
      enqueuedAt: 1_000,
      run: { sessionKey: registeredKey },
    } as unknown as FollowupRun);
    // sessions.list keys this session's row by its store key, not by the key its turn registered.
    const storeKey = resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" });
    const rowKeys = Object.keys(loadCombinedSessionStoreForGateway(cfg).store);
    expect(rowKeys).toContain(storeKey);
    expect(rowKeys).not.toContain(registeredKey);

    expect(deriveSessionPendingPrompts(storeKey, NOT_LIVE, () => cfg)).toEqual([
      { key: "prompt-split-preparing", state: "preparing", since: operation.startedAt },
      { key: "prompt-split-behind", state: "behind", since: 1_000 },
    ]);
    // Read under the registered key, the same holders, unchanged.
    expect(deriveSessionPendingPrompts(registeredKey, NOT_LIVE, () => cfg)).toHaveLength(2);
    // Another session of the same agent stays empty.
    expect(deriveSessionPendingPrompts("agent:ops:elsewhere", NOT_LIVE, () => cfg)).toBeUndefined();
  });

  it("resolveReplyHolderKey: the row's own key wins; an unreadable config costs only the derivation", async () => {
    const cfg = makeCfg("alias");
    const { registeredKey, sessionId } = await registeredKeyFor("agent:main:main", cfg);
    createReplyOperation({ sessionKey: registeredKey, sessionId, resetTriggered: false });
    const storeKey = resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" });
    const getConfig = vi.fn(() => cfg);

    expect(resolveReplyHolderKey(registeredKey, getConfig)).toBe(registeredKey);
    expect(getConfig).not.toHaveBeenCalled();
    expect(resolveReplyHolderKey(storeKey, getConfig)).toBe(registeredKey);
    const unreadable = () => {
      throw new Error("config unreadable");
    };
    expect(resolveReplyHolderKey(storeKey, unreadable)).toBe(storeKey);
  });
});
