import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownerRoot, placeOf, resolveEngramBaseDir, resolveRoots, type Root } from "./places.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "forget-places-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("placeOf", () => {
  const note: Root = { path: "/w/memory", place: "note" };
  const engram = (): Root =>
    resolveRoots({
      stateDir: base,
      home: base,
      workspaceDirs: [],
      memoryExtraPaths: [],
      autoMemoryDir: null,
      engramBaseDir: join(base, "engram"),
      claudeCode: false,
      extraRoots: [],
      backupDirs: [],
    })[0];

  it("moves archives and copies to old versions, dreaming and consolidation to summaries", () => {
    expect(placeOf(note, "people/dad.md", "text")).toBe("note");
    expect(placeOf(note, "archive/2026/old.md", "text")).toBe("old_versions");
    expect(placeOf(note, "MEMORY.md.bak-20261001", "text")).toBe("old_versions");
    expect(placeOf(note, ".dreams/short-term-recall.json", "text")).toBe("summaries");
    expect(placeOf(note, "consolidation-logs/2026-09-12.md", "text")).toBe("summaries");
    expect(placeOf(note, "index.sqlite", "binary")).toBe("search_index");
    expect(placeOf({ path: "/b", place: "backups" }, "x.sqlite", "binary")).toBe("backups");
  });

  it("files engram events and tool-result artifacts under the chat record, packs under summaries", () => {
    mkdirSync(join(base, "engram"), { recursive: true });
    const root = engram();
    expect(placeOf(root, join("events", "agent_main.jsonl"), "text")).toBe("chat_record");
    expect(placeOf(root, join("artifacts", "01KVZ8MZQX0000CM"), "text")).toBe("chat_record");
    expect(placeOf(root, "2026-05-24.jsonl", "text")).toBe("chat_record");
    expect(placeOf(root, join("packs", "p.json"), "text")).toBe("summaries");
  });
});

describe("resolveRoots", () => {
  it("lists only existing roots, most specific first, and keeps agent folders other than sessions out", () => {
    const ws = join(base, "ws");
    mkdirSync(join(ws, "memory"), { recursive: true });
    mkdirSync(join(base, "agents", "main", "sessions"), { recursive: true });
    mkdirSync(join(base, "agents", "main", "agent"), { recursive: true });
    const roots = resolveRoots({
      stateDir: base,
      home: base,
      workspaceDirs: [ws],
      memoryExtraPaths: ["bank"],
      autoMemoryDir: null,
      engramBaseDir: join(base, "engram"),
      claudeCode: true,
      extraRoots: [],
      backupDirs: [join(base, "backups")],
    });
    expect(roots.map((r) => r.path)).toEqual([join(ws, "memory"), join(base, "agents"), ws]);
    const agents = roots.find((r) => r.path === join(base, "agents"));
    expect(agents?.include?.(join("main", "sessions", "s.jsonl"))).toBe(true);
    expect(agents?.include?.(join("main", "agent", "auth-profiles.json"))).toBe(false);
    expect(ownerRoot(roots, join(ws, "memory", "a.md"))?.path).toBe(join(ws, "memory"));
  });

  it("finds the engram stores through total-recall's discovery file", () => {
    mkdirSync(join(base, "cognitive"), { recursive: true });
    writeFileSync(
      join(base, "cognitive", "total-recall.json"),
      JSON.stringify({ baseDir: "/x/engram" }),
    );
    expect(resolveEngramBaseDir(base)).toBe("/x/engram");
    expect(resolveEngramBaseDir(join(base, "none"))).toBe(join(base, "none", "engram"));
  });
});
