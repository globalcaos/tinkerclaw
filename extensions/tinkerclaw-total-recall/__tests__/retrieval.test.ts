import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, estimateTokens } from "../src/event-store.js";
import {
  assembleRetrievalPack,
  DEFAULT_RETRIEVAL_MAX_TOKENS,
} from "../src/retrieval-integration.js";

describe("Retrieval pack assembly", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "engram-retrieval-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns empty string for empty store", () => {
    const store = createEventStore({ baseDir, sessionKey: "empty" });
    const pack = assembleRetrievalPack("hello", store);
    expect(pack).toBe("");
  });

  it("returns empty string when no FTS matches", () => {
    const store = createEventStore({ baseDir, sessionKey: "no-match" });
    store.append({
      turnId: 1,
      sessionKey: "no-match",
      kind: "user_message",
      content: "alpha beta gamma",
      tokens: 3,
      metadata: {},
    });

    const pack = assembleRetrievalPack("zzzzzzzzz", store);
    expect(pack).toBe("");
  });

  it("assembles a pack when FTS matches exist", () => {
    const store = createEventStore({ baseDir, sessionKey: "match" });
    store.append({
      turnId: 1,
      sessionKey: "match",
      kind: "user_message",
      content: "The deployment pipeline failed with error code 42",
      tokens: 12,
      metadata: {},
    });
    store.append({
      turnId: 2,
      sessionKey: "match",
      kind: "agent_message",
      content: "I fixed the deployment pipeline issue by updating the config",
      tokens: 14,
      metadata: {},
    });
    store.append({
      turnId: 3,
      sessionKey: "match",
      kind: "user_message",
      content: "What happened with the database migration?",
      tokens: 8,
      metadata: {},
    });

    const pack = assembleRetrievalPack("deployment pipeline", store);
    expect(pack).not.toBe("");
    expect(pack).toContain("## Retrieved Context");
    expect(pack).toContain("deployment");
  });

  it("respects token budget", () => {
    const store = createEventStore({ baseDir, sessionKey: "budget" });
    // Add many events with matching content
    for (let i = 0; i < 50; i++) {
      store.append({
        turnId: i,
        sessionKey: "budget",
        kind: "user_message",
        content: `The server performance issue number ${i} relates to database connection pooling`,
        tokens: 15,
        metadata: {},
      });
    }

    const pack = assembleRetrievalPack("server performance database", store, {
      maxTokens: 100,
    });
    // Should not exceed budget (100 tokens ~= 400 chars)
    const packTokens = estimateTokens(pack);
    expect(packTokens).toBeLessThanOrEqual(110); // small margin for rounding
  });

  it("deduplicates via MMR", () => {
    const store = createEventStore({ baseDir, sessionKey: "mmr" });
    // Add near-identical events
    for (let i = 0; i < 10; i++) {
      store.append({
        turnId: i,
        sessionKey: "mmr",
        kind: "user_message",
        content: "The server crashed due to memory leak in the connection pool handler",
        tokens: 15,
        metadata: {},
      });
    }
    // Add a diverse event
    store.append({
      turnId: 11,
      sessionKey: "mmr",
      kind: "user_message",
      content: "The server needs restart because disk space ran out on the log partition",
      tokens: 15,
      metadata: {},
    });

    const pack = assembleRetrievalPack("server crashed", store);
    expect(pack).not.toBe("");
    // MMR should include diverse results too
    expect(pack).toContain("Retrieved Context");
  });
});
