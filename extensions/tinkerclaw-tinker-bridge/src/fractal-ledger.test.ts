import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLedgerRow,
  checkClaims,
  collectCommits,
  collectWrites,
  decideVerdict,
  extractClaimRefs,
  firstLineOf,
  inferRepoFromCommand,
  ledgerPathFor,
  parseCommitLines,
  parseTriggersLine,
  recordFractalLedger,
  type FractalLedgerRow,
} from "./fractal-ledger.js";
import type { ToolBufferedEvent } from "./tool-buffer.types.js";

// FORK 2026-10-09 (Fractal v2 M4, charter contract C2). The census of 2026-10-09 found 131 of 536
// failed Fractal claims pointing at files that were never on disk. These tests pin the ledger row
// the bridge writes for every `fractal-<P>` run: what the run itself wrote and committed, and an
// existence check for every path and commit its final text names.

const HOME = "/home/tester";

const start = (id: string, name: string, args: Record<string, unknown>): ToolBufferedEvent => ({
  phase: "start",
  toolCallId: id,
  name,
  args,
  startedAt: 1,
});
const result = (id: string, text: string, isError = false): ToolBufferedEvent => ({
  phase: "result",
  toolCallId: id,
  result: text,
  isError,
  endedAt: 2,
});

describe("parseTriggersLine", () => {
  it("reads the C4 Triggers line up to the dash that starts the gate reasons", () => {
    const prompt = [
      "⟦AGENT:🌿 Fractal · prompt 3⟧ background copy",
      "",
      "Triggers: friction, correction — 2 tool errors; the owner asked why",
      "",
      "⟦FRACTAL-DOCTRINE⟧",
    ].join("\n");
    expect(parseTriggersLine(prompt)).toEqual(["friction", "correction"]);
  });

  it("is empty without the line, and drops names outside the four triggers", () => {
    expect(parseTriggersLine("no line here")).toEqual([]);
    expect(parseTriggersLine("Triggers: delivery, vibes, channel")).toEqual([
      "delivery",
      "channel",
    ]);
    expect(parseTriggersLine("Triggers: none — worth=clear")).toEqual([]);
  });
});

describe("collectWrites", () => {
  it("keeps the paths of Edit/Write/NotebookEdit calls that did not fail, once each", () => {
    const events = [
      start("a", "Edit", { file_path: "/home/tester/src/x.ts" }),
      result("a", "ok"),
      start("b", "Write", { file_path: "~/notes/y.md" }),
      result("b", "ok"),
      start("c", "NotebookEdit", { notebook_path: "/home/tester/n.ipynb" }),
      result("c", "ok"),
      start("d", "Edit", { file_path: "/home/tester/src/failed.ts" }),
      result("d", "String to replace not found", true),
      start("e", "Read", { file_path: "/home/tester/src/read-only.ts" }),
      result("e", "contents"),
      start("f", "Edit", { file_path: "/home/tester/src/x.ts" }),
      result("f", "ok"),
    ];
    expect(collectWrites(events, HOME)).toEqual([
      "/home/tester/src/x.ts",
      "/home/tester/notes/y.md",
      "/home/tester/n.ipynb",
    ]);
  });
});

describe("parseCommitLines", () => {
  it("reads git's `[branch sha] subject` lines, root and detached commits included", () => {
    const out = [
      "[fx/bridge-ledger 1a2b3c4d] bridge: ledger row for Fractal runs",
      " 2 files changed, 40 insertions(+)",
      "[main (root-commit) abcdef1] first",
      "[detached HEAD 0f0f0f0] loose",
      "[not a commit] text",
    ].join("\n");
    expect(parseCommitLines(out)).toEqual([
      {
        branch: "fx/bridge-ledger",
        sha: "1a2b3c4d",
        subject: "bridge: ledger row for Fractal runs",
      },
      { branch: "main", sha: "abcdef1", subject: "first" },
      { branch: "detached HEAD", sha: "0f0f0f0", subject: "loose" },
    ]);
  });
});

describe("inferRepoFromCommand", () => {
  it("takes the last cd or git -C before the commit, expanding ~", () => {
    expect(inferRepoFromCommand("cd ~/src/tinkerclaw && git commit -m x -- a", HOME)).toBe(
      "/home/tester/src/tinkerclaw",
    );
    expect(inferRepoFromCommand('git -C "/home/tester/.openclaw" commit -m x', HOME)).toBe(
      "/home/tester/.openclaw",
    );
    expect(
      inferRepoFromCommand("cd /tmp && cd $HOME/src/jarvis-icu && git commit -am x", HOME),
    ).toBe("/home/tester/src/jarvis-icu");
    expect(inferRepoFromCommand("git commit -m x", HOME)).toBeUndefined();
  });
});

describe("collectCommits", () => {
  it("reads commits from Bash results only, with the repo its command names", () => {
    const events = [
      start("a", "Bash", { command: "cd ~/src/tinkerclaw && git commit -m s -- f" }),
      result("a", "[develop 1234abc] s\n 1 file changed"),
      start("b", "Read", { file_path: "/home/tester/log.txt" }),
      result("b", "[develop 9999fff] an old commit quoted in a log"),
      start("c", "Bash", { command: "git commit -m t" }),
      result("c", "[main 5678def] t"),
      start("d", "Bash", { command: "cd ~/src/tinkerclaw && git commit -m s -- f" }),
      result("d", "[develop 1234abc] s"),
    ];
    expect(collectCommits(events, HOME)).toEqual([
      { sha: "1234abc", repo: "/home/tester/src/tinkerclaw" },
      { sha: "5678def" },
    ]);
  });
});

describe("extractClaimRefs", () => {
  it("finds backticked paths, bare ~/ and /home/ paths, and commit SHAs", () => {
    const text = [
      "🌿 FRACTAL ACTION: fixed the gate in `extensions/foo/src/gate.ts:42`.",
      "Also edited ~/.openclaw/workspace/recipes/x.md, and `/tmp/scratch.txt` holds the probe.",
      "Notes at /home/tester/Documents/c.md (see /home/tester/x.ts:12). are untouched.",
      "Committed `1a2b3c4` and 5e6f7a8b9c on develop; branch fx/bridge-ledger stays.",
      "Session 0d6b2a1c-4f3e-4a1b-9c2d-123456789abc is not a sha, nor is 20261009 or deadbeefcafe.",
      "See https://example.com/home/x for nothing.",
    ].join("\n");
    expect(extractClaimRefs(text)).toEqual([
      { ref: "extensions/foo/src/gate.ts", kind: "path" },
      { ref: "~/.openclaw/workspace/recipes/x.md", kind: "path" },
      { ref: "/tmp/scratch.txt", kind: "path" },
      { ref: "/home/tester/Documents/c.md", kind: "path" },
      { ref: "/home/tester/x.ts", kind: "path" },
      { ref: "1a2b3c4", kind: "commit" },
      { ref: "5e6f7a8b9c", kind: "commit" },
    ]);
  });

  it("takes a whole backticked absolute path even when it has spaces", () => {
    expect(extractClaimRefs("Copied to `/home/tester/Contractes i  documents/x.pdf`.")).toEqual([
      { ref: "/home/tester/Contractes i  documents/x.pdf", kind: "path" },
    ]);
  });

  it("ignores branch names, module specifiers and globs", () => {
    expect(
      extractClaimRefs("`fx/bridge-ledger` `openclaw/plugin-sdk` `~/x/*.md` `<stateDir>/a.json`"),
    ).toEqual([]);
  });
});

describe("checkClaims", () => {
  const exists = new Set([
    "/home/tester/src/tinkerclaw/extensions/foo/src/gate.ts",
    "/home/tester/.openclaw/workspace/recipes/x.md",
  ]);
  const commitsIn: Record<string, string[]> = {
    "/home/tester/src/tinkerclaw": ["1a2b3c4d5e"],
    "/home/tester/.openclaw": ["77aa88b"],
  };
  const deps = {
    home: HOME,
    repos: ["/home/tester/src/tinkerclaw", "/home/tester/src/jarvis-icu", "/home/tester/.openclaw"],
    bases: ["/home/tester/src/tinkerclaw", "/home/tester/.openclaw/workspace"],
    pathExists: async (p: string) => exists.has(p),
    commitExists: async (repo: string, sha: string) =>
      (commitsIn[repo] ?? []).some((full) => full.startsWith(sha) || sha.startsWith(full)),
  };

  it("marks each claim ok or not, and whether this run made it", async () => {
    const claims = await checkClaims(
      [
        { ref: "extensions/foo/src/gate.ts", kind: "path" },
        { ref: "~/.openclaw/workspace/recipes/x.md", kind: "path" },
        { ref: "/home/tester/ghost.md", kind: "path" },
        { ref: "1a2b3c4", kind: "commit" },
        { ref: "77aa88b", kind: "commit" },
        { ref: "abcdef9", kind: "commit" },
      ],
      {
        writes: ["/home/tester/src/tinkerclaw/extensions/foo/src/gate.ts"],
        commits: [{ sha: "1a2b3c4d5e", repo: "/home/tester/src/tinkerclaw" }],
      },
      deps,
    );
    expect(claims).toEqual([
      {
        ref: "extensions/foo/src/gate.ts",
        kind: "path",
        ok: true,
        byThisRun: true,
        why: "written by this run",
      },
      {
        ref: "~/.openclaw/workspace/recipes/x.md",
        kind: "path",
        ok: true,
        byThisRun: false,
        why: "exists",
      },
      {
        ref: "/home/tester/ghost.md",
        kind: "path",
        ok: false,
        byThisRun: false,
        why: "not on disk",
      },
      {
        ref: "1a2b3c4",
        kind: "commit",
        ok: true,
        byThisRun: true,
        why: "committed by this run",
      },
      {
        ref: "77aa88b",
        kind: "commit",
        ok: true,
        byThisRun: false,
        why: "in /home/tester/.openclaw",
      },
      {
        ref: "abcdef9",
        kind: "commit",
        ok: false,
        byThisRun: false,
        why: "in none of tinkerclaw, jarvis-icu, .openclaw",
      },
    ]);
  });

  it("says when a file this run wrote is gone again", async () => {
    const [claim] = await checkClaims(
      [{ ref: "/home/tester/tmp.md", kind: "path" }],
      { writes: ["/home/tester/tmp.md"], commits: [] },
      deps,
    );
    expect(claim).toMatchObject({
      ok: false,
      byThisRun: true,
      why: "written by this run, gone now",
    });
  });
});

describe("decideVerdict", () => {
  const ok = { ref: "x", kind: "path" as const, ok: true, byThisRun: false, why: "exists" };
  const bad = { ...ok, ok: false, why: "not on disk" };
  it("is acted when the run changed something and every claim holds", () => {
    expect(decideVerdict(["/a"], [], [ok])).toBe("acted");
    expect(decideVerdict([], [{ sha: "1234abc" }], [])).toBe("acted");
  });
  it("is unverified when any claim fails, clean when nothing changed", () => {
    expect(decideVerdict(["/a"], [], [ok, bad])).toBe("unverified");
    expect(decideVerdict([], [], [bad])).toBe("unverified");
    expect(decideVerdict([], [], [ok])).toBe("clean");
  });
});

describe("firstLineOf", () => {
  it("is the first non-empty line, trimmed and capped", () => {
    expect(firstLineOf("\n\n  🌿 FRACTAL ACTION: x  \nmore")).toBe("🌿 FRACTAL ACTION: x");
    expect(firstLineOf("a".repeat(400))).toHaveLength(240);
    expect(firstLineOf("")).toBe("");
  });
});

describe("buildLedgerRow", () => {
  it("lays out the C2 row", () => {
    const row = buildLedgerRow({
      ts: 1000,
      runId: "fractal-P1",
      parentRunId: "P1",
      sessionKey: "agent:main:fractal:P1",
      model: "claude-opus-5-5",
      durationMs: 5000,
      usage: { cacheRead: 4, cacheWrite: 3, input: 2, output: 1 },
      triggers: ["friction"],
      writes: ["/a"],
      commits: [{ sha: "1234abc", repo: "/r" }],
      claims: [],
      finalText: "\n🌿 FRACTAL ACTION: fixed\nrest",
    });
    expect(row).toEqual({
      v: 1,
      ts: 1000,
      parentRunId: "P1",
      runId: "fractal-P1",
      sessionKey: "agent:main:fractal:P1",
      model: "claude-opus-5-5",
      durationMs: 5000,
      usage: { cacheRead: 4, cacheWrite: 3, input: 2, output: 1 },
      triggers: ["friction"],
      writes: ["/a"],
      commits: [{ sha: "1234abc", repo: "/r" }],
      claims: [],
      verdict: "acted",
      firstLine: "🌿 FRACTAL ACTION: fixed",
    });
  });
});

describe("recordFractalLedger", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends one JSON line under <stateDir>/data/fractal and emits fractal-check", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fractal-ledger-"));
    dirs.push(stateDir);
    const written = path.join(stateDir, "written.md");
    fs.writeFileSync(written, "x");
    const emitted: Array<{ runId: string; sessionKey?: string; stream: string; data: unknown }> =
      [];
    const input = {
      runId: "fractal-P2",
      sessionKey: "agent:main:fractal:P2",
      model: "claude-opus-5-5",
      prompt: "Triggers: channel — he did not see the card",
      finalText: `🌿 FRACTAL ACTION: wrote \`${written}\` and committed 1234abc`,
      usage: { cacheRead: 10, cacheWrite: 20, input: 30, output: 40 },
      durationMs: 1234,
      cwd: stateDir,
      toolEvents: [
        start("a", "Write", { file_path: written }),
        result("a", "ok"),
        start("b", "Bash", { command: `cd ${stateDir} && git commit -m s` }),
        result("b", "[develop 1234abc] s"),
      ],
    };
    const deps = {
      stateDir,
      home: HOME,
      repos: [stateDir],
      bases: [stateDir],
      commitExists: async (_repo: string, sha: string) => sha === "1234abc",
      emit: (event: { runId: string; sessionKey?: string; stream: string; data: unknown }) => {
        emitted.push(event);
      },
      now: () => 42,
    };
    const row = (await recordFractalLedger(input, deps)) as FractalLedgerRow;
    await recordFractalLedger({ ...input, runId: "fractal-P3" }, deps);

    expect(ledgerPathFor(stateDir)).toBe(path.join(stateDir, "data", "fractal", "ledger.jsonl"));
    const lines = fs.readFileSync(ledgerPathFor(stateDir), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(row);
    expect(row).toMatchObject({
      v: 1,
      ts: 42,
      parentRunId: "P2",
      runId: "fractal-P2",
      triggers: ["channel"],
      writes: [written],
      commits: [{ sha: "1234abc", repo: stateDir }],
      verdict: "acted",
    });
    expect(row.claims.map((c) => [c.ref, c.ok, c.byThisRun])).toEqual([
      [written, true, true],
      ["1234abc", true, true],
    ]);
    expect(emitted[0]).toEqual({
      runId: "fractal-P2",
      sessionKey: "agent:main:fractal:P2",
      stream: "fractal-check",
      data: row,
    });
  });

  it("does nothing for a run that is not a Fractal run", async () => {
    const emitted: unknown[] = [];
    const row = await recordFractalLedger(
      {
        runId: "plain-run",
        model: "m",
        prompt: "",
        finalText: "`/home/tester/x`",
        usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        durationMs: 0,
        toolEvents: [],
      },
      {
        stateDir: "/nonexistent-state-dir-for-test",
        emit: (event) => emitted.push(event),
        append: async () => {
          throw new Error("must not write");
        },
      },
    );
    expect(row).toBeNull();
    expect(emitted).toEqual([]);
  });
});
