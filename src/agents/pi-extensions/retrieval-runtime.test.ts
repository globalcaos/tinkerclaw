/**
 * ENGRAM retrieval runtime tests.
 *
 * Focus: U9 1-hop Zettelkasten backlink expansion. The retrieval-runtime header
 * promised 1-hop expansion but had zero backlink usage; these tests pin the
 * additive, flag-safe behavior — primary hits are augmented with events that
 * co-mention the same target, and behavior is unchanged when no link builder is
 * registered.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventStore, type EventStore } from "../../memory/engram/event-store.js";
import type { MemoryEvent } from "../../memory/engram/event-types.js";
import { createLinkIndex } from "../../memory/engram/link-index.js";
import type { SearchResult } from "../../memory/engram/search-index.js";
import { createLinkBuilder, type LinkBuilder } from "./link-builder-runtime.js";
import { setRetrievalRuntime, getRetrievalRuntime } from "./retrieval-runtime.js";

let tmpDir: string;
let homeBackup: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-retrieval-test-"));
  // Point HOME at the tmp dir so loadTodayDailyLog finds no daily log file and
  // the assembled pack contains only the retrieval sections under test.
  homeBackup = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  if (homeBackup === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = homeBackup;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(sessionKey = "retr-test"): EventStore {
  return createEventStore({ baseDir: tmpDir, sessionKey });
}

function appendEvent(store: EventStore, content: string): MemoryEvent {
  return store.append({
    turnId: 1,
    sessionKey: store.sessionKey,
    kind: "user_message",
    content,
    tokens: 0,
    metadata: {},
  });
}

/** Index every mention in `event` content keyed to its real event-store id. */
function indexEvent(builder: LinkBuilder, event: MemoryEvent): void {
  builder.extractAndIndex(event.id, event.content);
}

describe("retrieval-runtime 1-hop backlink expansion", () => {
  it("adds co-mentioned events as a secondary 'Linked Memory' set when a link builder is present", async () => {
    const store = makeStore();
    // Primary hit (the only event the search index returns) mentions [[roadmap]].
    const primary = appendEvent(store, "planning the [[roadmap]] for Q3");
    // Neighbor co-mentions [[roadmap]] but is NOT returned by the search index.
    const neighbor = appendEvent(store, "[[roadmap]] needs a security review first");

    const linkBuilder = createLinkBuilder(
      createLinkIndex({ baseDir: tmpDir, sessionKey: "retr-test" }),
    );
    // Index both events so getBacklinks("roadmap") resolves to both ids.
    indexEvent(linkBuilder, primary);
    indexEvent(linkBuilder, neighbor);

    // Inject a search index that returns ONLY the primary hit.
    const searchIndex = (): SearchResult[] => [{ event: primary, score: 1, matchType: "fts" }];

    const sm = {};
    setRetrievalRuntime(sm, { eventStore: store, searchIndex, linkBuilder });
    const runtime = getRetrievalRuntime(sm);
    expect(runtime?.assemble).toBeDefined();

    // A query of only stopwords/short tokens yields zero extracted entities, so
    // assemble takes the injectable `searchIndex` path (not globalFtsMultiSearch,
    // which reads a global SQLite DB). The 1-hop expansion runs regardless of
    // which search path produced the candidates.
    const pack = await runtime!.assemble!("the it is", 2000);
    expect(pack).not.toBeNull();
    // Primary hit present.
    expect(pack).toContain("planning the [[roadmap]] for Q3");
    // 1-hop neighbor pulled in via backlink expansion.
    expect(pack).toContain("## Linked Memory (1-hop)");
    expect(pack).toContain("[[roadmap]] needs a security review first");
  });

  it("leaves retrieval unchanged when no link builder is registered", async () => {
    const store = makeStore("retr-test-2");
    const primary = appendEvent(store, "planning the [[roadmap]] for Q3");
    appendEvent(store, "[[roadmap]] needs a security review first");

    const searchIndex = (): SearchResult[] => [{ event: primary, score: 1, matchType: "fts" }];

    const sm = {};
    // No linkBuilder => expansion must not run.
    setRetrievalRuntime(sm, { eventStore: store, searchIndex });
    const runtime = getRetrievalRuntime(sm);

    // Same stopword-only query → injectable searchIndex path (see sibling test).
    const pack = await runtime!.assemble!("the it is", 2000);
    expect(pack).not.toBeNull();
    expect(pack).toContain("planning the [[roadmap]] for Q3");
    expect(pack).not.toContain("## Linked Memory (1-hop)");
    expect(pack).not.toContain("needs a security review first");
  });
});
