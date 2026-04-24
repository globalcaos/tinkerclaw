import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, generateULID, estimateTokens } from "../src/event-store.js";
import type { MemoryEvent } from "../src/event-types.js";

describe("EventStore", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "engram-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("appends and reads events", () => {
    const store = createEventStore({ baseDir, sessionKey: "test-session" });
    const ev = store.append({
      turnId: 1,
      sessionKey: "test-session",
      kind: "user_message",
      content: "Hello world",
      tokens: estimateTokens("Hello world"),
      metadata: {},
    });

    expect(ev.id).toBeTruthy();
    expect(ev.timestamp).toBeTruthy();
    expect(ev.content).toBe("Hello world");

    const all = store.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(ev.id);
  });

  it("generates ULIDs in monotonically increasing order", () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(generateULID());
    }
    const sorted = [...ids].toSorted();
    expect(ids).toEqual(sorted);
  });

  it("reads by kind", () => {
    const store = createEventStore({ baseDir, sessionKey: "test-session" });
    store.append({
      turnId: 1,
      sessionKey: "test-session",
      kind: "user_message",
      content: "hi",
      tokens: 1,
      metadata: {},
    });
    store.append({
      turnId: 1,
      sessionKey: "test-session",
      kind: "agent_message",
      content: "hello",
      tokens: 2,
      metadata: {},
    });
    store.append({
      turnId: 2,
      sessionKey: "test-session",
      kind: "user_message",
      content: "bye",
      tokens: 1,
      metadata: {},
    });

    const userMsgs = store.readByKind("user_message");
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs.every((e) => e.kind === "user_message")).toBe(true);
  });

  it("isolates sessions", () => {
    const store1 = createEventStore({ baseDir, sessionKey: "session-a" });
    const store2 = createEventStore({ baseDir, sessionKey: "session-b" });

    store1.append({
      turnId: 1,
      sessionKey: "session-a",
      kind: "user_message",
      content: "a",
      tokens: 1,
      metadata: {},
    });
    store2.append({
      turnId: 1,
      sessionKey: "session-b",
      kind: "user_message",
      content: "b",
      tokens: 1,
      metadata: {},
    });

    expect(store1.readAll()).toHaveLength(1);
    expect(store2.readAll()).toHaveLength(1);
    expect(store1.readAll()[0].content).toBe("a");
    expect(store2.readAll()[0].content).toBe("b");
  });

  it("reads by range", () => {
    const store = createEventStore({ baseDir, sessionKey: "test-session" });
    for (let i = 1; i <= 10; i++) {
      store.append({
        turnId: i,
        sessionKey: "test-session",
        kind: "user_message",
        content: `msg ${i}`,
        tokens: 2,
        metadata: {},
      });
    }

    const range = store.readRange(3, 7);
    expect(range).toHaveLength(5);
    expect(range[0].turnId).toBe(3);
    expect(range[4].turnId).toBe(7);
  });

  it("reads by id", () => {
    const store = createEventStore({ baseDir, sessionKey: "test-session" });
    const ev = store.append({
      turnId: 1,
      sessionKey: "test-session",
      kind: "user_message",
      content: "find me",
      tokens: 2,
      metadata: {},
    });

    const found = store.readById(ev.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe("find me");

    const notFound = store.readById("nonexistent");
    expect(notFound).toBeUndefined();
  });

  it("handles corrupted lines gracefully via appendRaw", () => {
    const store = createEventStore({ baseDir, sessionKey: "test-session" });
    const ev: MemoryEvent = {
      id: generateULID(),
      timestamp: new Date().toISOString(),
      turnId: 1,
      sessionKey: "test-session",
      kind: "user_message",
      content: "raw event",
      tokens: 3,
      metadata: {},
    };
    store.appendRaw(ev);

    const all = store.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("raw event");
  });

  it("counts events correctly", () => {
    const store = createEventStore({ baseDir, sessionKey: "test-session" });
    expect(store.count()).toBe(0);
    store.append({
      turnId: 1,
      sessionKey: "test-session",
      kind: "user_message",
      content: "one",
      tokens: 1,
      metadata: {},
    });
    store.append({
      turnId: 2,
      sessionKey: "test-session",
      kind: "user_message",
      content: "two",
      tokens: 1,
      metadata: {},
    });
    expect(store.count()).toBe(2);
  });
});
