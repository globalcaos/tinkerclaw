import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import { eventContentKey, storeContentIndex } from "./store-content-index.js";

function line(id: string, kind: string, content: string, metadata: object = {}): string {
  const e = {
    id,
    timestamp: "2026-10-11T00:00:00.000Z",
    turnId: 0,
    sessionKey: "s",
    kind,
    content,
    tokens: 1,
    metadata,
  };
  return JSON.stringify(e) + "\n";
}

describe("storeContentIndex", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-index-"));
    file = join(dir, "events", "s.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is empty for a store that does not exist yet", () => {
    expect(storeContentIndex(file).size).toBe(0);
  });

  it("keeps the FIRST event of each kind + content", () => {
    const store = createEventStore({ baseDir: dir, sessionKey: "s" });
    const first = store.append({
      turnId: 0,
      sessionKey: "s",
      kind: "user_message",
      content: "hello",
      tokens: 1,
      metadata: {},
    });
    store.append({
      turnId: 1,
      sessionKey: "s",
      kind: "user_message",
      content: "hello",
      tokens: 1,
      metadata: {},
    });
    store.append({
      turnId: 2,
      sessionKey: "s",
      kind: "agent_message",
      content: "hello",
      tokens: 1,
      metadata: {},
    });
    const index = storeContentIndex(file);
    expect(index.size).toBe(2);
    expect(index.get(eventContentKey("user_message", "hello"))?.id).toBe(first.id);
  });

  it("catches up on lines appended after the last call", () => {
    const store = createEventStore({ baseDir: dir, sessionKey: "s" });
    store.append({
      turnId: 0,
      sessionKey: "s",
      kind: "user_message",
      content: "a",
      tokens: 1,
      metadata: {},
    });
    expect(storeContentIndex(file).size).toBe(1);
    const b = store.append({
      turnId: 1,
      sessionKey: "s",
      kind: "user_message",
      content: "b",
      tokens: 1,
      metadata: {},
    });
    const index = storeContentIndex(file);
    expect(index.size).toBe(2);
    expect(index.get(eventContentKey("user_message", "b"))?.id).toBe(b.id);
  });

  it("leaves a line still being written for the next call", () => {
    createEventStore({ baseDir: dir, sessionKey: "s" });
    writeFileSync(
      file,
      line("A", "user_message", "a") + line("B", "user_message", "b").slice(0, 20),
    );
    expect(storeContentIndex(file).size).toBe(1);
    appendFileSync(file, line("B", "user_message", "b").slice(20));
    expect(storeContentIndex(file).get(eventContentKey("user_message", "b"))?.id).toBe("B");
  });

  it("reads a store rewritten by rename from the start", () => {
    createEventStore({ baseDir: dir, sessionKey: "s" });
    writeFileSync(file, line("A", "user_message", "a") + line("B", "user_message", "b"));
    expect(storeContentIndex(file).size).toBe(2);
    const tmp = file + ".tmp";
    writeFileSync(tmp, line("C", "user_message", "c"));
    renameSync(tmp, file);
    const index = storeContentIndex(file);
    expect([...index.values()].map((e: MemoryEvent) => e.id)).toEqual(["C"]);
  });

  it("keys an externalised tool result on its raw output, and skips a malformed line", () => {
    createEventStore({ baseDir: dir, sessionKey: "s" });
    const rawKey = eventContentKey("tool_result", '{"tool":"bash","output":"big"}');
    writeFileSync(
      file,
      "{not json\n" + line("R", "artifact_reference", '{"artifactId":"x"}', { rawKey }),
    );
    const index = storeContentIndex(file);
    expect(index.size).toBe(1);
    expect(index.get(rawKey)?.id).toBe("R");
  });
});
