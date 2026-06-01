/**
 * U9 A-MEM Zettelkasten auto-linking: link-builder runtime registry tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLinkIndex } from "../../memory/engram/link-index.js";
import {
  createLinkBuilder,
  setLinkBuilderRuntime,
  getLinkBuilderRuntime,
} from "./link-builder-runtime.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-link-builder-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeBuilder(sessionKey = "test-session") {
  return createLinkBuilder(createLinkIndex({ baseDir: tmpDir, sessionKey }));
}

describe("link-builder-runtime registry", () => {
  it("set/get round-trips per SessionManager identity", () => {
    const sm = {};
    const builder = makeBuilder();
    setLinkBuilderRuntime(sm, builder);
    expect(getLinkBuilderRuntime(sm)).toBe(builder);
  });

  it("returns null for an unregistered session manager", () => {
    expect(getLinkBuilderRuntime({})).toBeNull();
  });

  it("clears with a null value", () => {
    const sm = {};
    const builder = makeBuilder();
    setLinkBuilderRuntime(sm, builder);
    setLinkBuilderRuntime(sm, null);
    expect(getLinkBuilderRuntime(sm)).toBeNull();
  });
});

describe("LinkBuilder.extractAndIndex", () => {
  it("creates one LinkRecord per parsed mention and indexes both directions", () => {
    const builder = makeBuilder();
    // One explicit wikilink + one entity ref ("project Falcon").
    const records = builder.extractAndIndex("evt-1", "shipping [[roadmap]] for project Falcon");
    const kinds = records.map((r) => r.kind).sort();
    expect(kinds).toContain("wikilink");
    expect(kinds).toContain("entity");

    // Forward edges from evt-1 include both targets.
    const fwd = builder
      .getLinks("evt-1")
      .map((r) => r.targetKey)
      .sort();
    expect(fwd).toContain("roadmap");
    expect(fwd).toContain("falcon");

    // Backward edge for the wikilink resolves to evt-1.
    expect(builder.getBacklinks("roadmap").map((r) => r.sourceId)).toEqual(["evt-1"]);
  });

  it("returns [] for content with no mentions", () => {
    const builder = makeBuilder();
    expect(builder.extractAndIndex("evt-2", "plain prose, nothing notable")).toEqual([]);
  });
});
