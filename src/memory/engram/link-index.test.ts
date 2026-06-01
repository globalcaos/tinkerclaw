/**
 * U9 A-MEM Zettelkasten auto-linking: link index unit tests.
 *
 * Harness mirrors ingestion.test.ts: mkdtempSync per test, rmSync afterEach.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore } from "./event-store.js";
import { createLinkIndex } from "./link-index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-link-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeIndex(sessionKey = "test-session") {
  return createLinkIndex({ baseDir: tmpDir, sessionKey });
}

describe("createLinkIndex — append + persistence", () => {
  it("append writes a JSONL line and returns a populated record", () => {
    const idx = makeIndex();
    const rec = idx.append("src-1", { raw: "Alpha", normalized: "alpha", kind: "wikilink" });
    expect(rec.id).toBeTruthy();
    expect(rec.sourceId).toBe("src-1");
    expect(rec.targetKey).toBe("alpha");
    expect(rec.mentionText).toBe("Alpha");
    expect(rec.kind).toBe("wikilink");
    expect(rec.createdAt).toBeTruthy();
    expect(existsSync(idx.filePath)).toBe(true);
    const lines = readFileSync(idx.filePath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).targetKey).toBe("alpha");
  });

  it("round-trips from disk: a fresh index over the same baseDir/sessionKey sees the record", () => {
    const a = makeIndex();
    a.append("src-1", { raw: "Beta", normalized: "beta", kind: "wikilink" });
    const b = makeIndex();
    expect(b.getLinks("src-1").map((r) => r.targetKey)).toEqual(["beta"]);
    expect(b.getBacklinks("beta").map((r) => r.sourceId)).toEqual(["src-1"]);
  });
});

describe("createLinkIndex — forward / backward edges", () => {
  it("getLinks returns forward edges for a source", () => {
    const idx = makeIndex();
    idx.append("src-1", { raw: "Alpha", normalized: "alpha", kind: "wikilink" });
    idx.append("src-1", { raw: "Beta", normalized: "beta", kind: "entity" });
    expect(
      idx
        .getLinks("src-1")
        .map((r) => r.targetKey)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  it("getBacklinks returns reverse edges and is case-insensitive", () => {
    const idx = makeIndex();
    idx.append("src-1", { raw: "Alpha", normalized: "alpha", kind: "wikilink" });
    idx.append("src-2", { raw: "ALPHA", normalized: "alpha", kind: "wikilink" });
    expect(
      idx
        .getBacklinks("Alpha")
        .map((r) => r.sourceId)
        .sort(),
    ).toEqual(["src-1", "src-2"]);
  });

  it("getLinks/getBacklinks return [] (not undefined) for unknown keys", () => {
    const idx = makeIndex();
    expect(idx.getLinks("nope")).toEqual([]);
    expect(idx.getBacklinks("nope")).toEqual([]);
  });
});

describe("createLinkIndex — backlinkCount", () => {
  it("counts distinct sources referencing one target", () => {
    const idx = makeIndex();
    idx.append("src-1", { raw: "Caixa", normalized: "caixa", kind: "entity" });
    idx.append("src-2", { raw: "caixa", normalized: "caixa", kind: "entity" });
    idx.append("src-3", { raw: "CAIXA", normalized: "caixa", kind: "entity" });
    expect(idx.backlinkCount("caixa")).toBe(3);
    expect(idx.backlinkCount("Caixa")).toBe(3);
  });
});

describe("createLinkIndex — resolveTargets late-binding", () => {
  it("late-binds a target mentioned before its event existed", () => {
    const store = createEventStore({ baseDir: tmpDir, sessionKey: "test-session" });
    const idx = makeIndex();

    // Mention [[caixa loan]] BEFORE any event names it.
    idx.append("src-1", { raw: "caixa loan", normalized: "caixa loan", kind: "wikilink" });

    // Later, an event whose content contains the target string is appended.
    const target = store.append({
      turnId: 1,
      sessionKey: "test-session",
      kind: "agent_message",
      content: "Updated the Caixa Loan terms today.",
      tokens: 8,
      metadata: {},
    });

    const resolved = idx.resolveTargets(store);
    expect(resolved.get("caixa loan")).toContain(target.id);
  });

  it("returns an empty resolution map when nothing matches", () => {
    const store = createEventStore({ baseDir: tmpDir, sessionKey: "test-session" });
    const idx = makeIndex();
    idx.append("src-1", { raw: "ghost ref", normalized: "ghost ref", kind: "wikilink" });
    const resolved = idx.resolveTargets(store);
    expect(resolved.get("ghost ref") ?? []).toEqual([]);
  });
});
