import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openTranscriptIndex } from "openclaw/plugin-sdk/memory-engram";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FactError,
  followUpPass,
  forgetState,
  runForget,
  type ForgetConfig,
  type ForgetEnv,
} from "./forget.js";
import type { MemoryIndexManager } from "./indexes.js";
import { buildMatcher } from "./matcher.js";
import type { Receipt } from "./receipt.js";

const FACT = "+34 600 11 12 22";
const SPELLED = "+34 600 11 12 22";
const NOW = new Date("2026-10-25T18:00:00Z");

let base: string;
let home: string;
let state: string;
let ws: string;

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const userLine = (text: string) =>
  `${JSON.stringify({
    type: "message",
    timestamp: "2026-10-20T10:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: "pipe",
  });

/** A memory search index that serves the fact until it is re-synced. */
function fakeMemoryIndex() {
  const calls: Array<Record<string, unknown> | undefined> = [];
  let clean = false;
  const manager: MemoryIndexManager = {
    async search() {
      return clean ? [] : [{ path: "MEMORY.md", snippet: `Dad: ${SPELLED}` }];
    },
    async sync(params) {
      calls.push(params);
      clean = true;
    },
  };
  return { manager, calls };
}

function world() {
  put(join(ws, "MEMORY.md"), `# Memory\n- Dad's phone: ${SPELLED}\n- other line\n`);
  put(join(ws, "TOOLS.md"), "nothing to forget here\n");
  put(join(ws, "memory", "2026-10-20.md"), `Talked to dad (34600111222).\n`);
  put(join(ws, "memory", "archive", "old.md"), `old copy ${SPELLED}\n`);
  put(
    join(ws, "memory", ".dreams", "short-term-recall.json"),
    JSON.stringify({ entries: [{ snippet: `dad ${SPELLED}` }] }, null, 2),
  );
  put(
    join(state, "agents", "main", "sessions", "s1.jsonl"),
    userLine("hello") + userLine(`dad is ${SPELLED}`),
  );
  put(
    join(state, "agents", "main", "sessions", "s1.checkpoint.1.jsonl"),
    userLine(`dad is ${SPELLED}`),
  );
  put(join(state, "agents", "main", "agent", "auth-profiles.json"), `{"note":"${SPELLED}"}`);
  put(
    join(state, "engram", "events", "agent_main.jsonl"),
    `${JSON.stringify({ content: `noted ${SPELLED}` })}\n`,
  );
  put(join(state, "engram", "packs", "p.json"), JSON.stringify({ pack: `dad ${SPELLED}` }));
  put(join(state, "wiki", "main", "entities", "dad.md"), `Phone ${SPELLED}\n`);
  put(join(state, "backups", "dump.jsonl"), `${JSON.stringify({ t: SPELLED })}\n`);
  put(join(state, "backups", "nightly.tar.gz"), "not really gzip");
  put(join(home, ".claude", "projects", "p", "abc.jsonl"), userLine(`dad is ${SPELLED}`));
  put(join(home, ".claude", "projects", "p", "memory", "dad.md"), `Dad ${SPELLED}\n`);
  // The engram transcript index, built the way total-recall builds it.
  const index = openTranscriptIndex(join(state, "engram", "transcripts-main.sqlite"));
  index.syncFile(join(state, "agents", "main", "sessions", "s1.jsonl"), Date.now() + 5000);
  index.close();
  // The workspace is a git repo with a remote, and the fact is in its history.
  git(ws, "init", "-q");
  git(ws, "add", "MEMORY.md");
  git(ws, "commit", "-qm", "memory");
  git(ws, "remote", "add", "origin", join(base, "nowhere.git"));
}

function env(mode: ForgetConfig["mode"], manager: MemoryIndexManager | null): ForgetEnv {
  return {
    stateDir: state,
    home,
    workspaceDirs: [ws],
    agentIds: ["main"],
    memoryExtraPaths: [],
    autoMemoryDir: null,
    config: {
      mode,
      extraRoots: [],
      backupDirs: [join(state, "backups")],
      remoteCopies: ["encrypted nightly backup on Google Drive"],
      claudeCode: true,
      gitHistory: true,
      maxBinaryScanMB: 64,
    },
    getMemoryManager: async () => ({
      manager,
      error: manager ? undefined : "memory plugin unavailable",
    }),
    now: () => NOW,
    followUpDelaysMs: [],
  };
}

const row = (r: Receipt, place: string) => r.places.find((p) => p.place === place);
const holds = (path: string) =>
  /600[\s().-]{0,3}11/.test(readFileSync(path, "utf8")) ||
  readFileSync(path, "utf8").includes("34600111222");

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "forget-e2e-"));
  home = join(base, "home");
  state = join(home, ".openclaw");
  ws = join(state, "workspace");
  mkdirSync(ws, { recursive: true });
  forgetState().pending.clear();
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("runForget", () => {
  it("previews every place, changes nothing, and in preview mode hands out no confirm code", async () => {
    world();
    const before = readFileSync(join(ws, "MEMORY.md"), "utf8");
    const { manager } = fakeMemoryIndex();
    const r = await runForget({ fact: FACT, label: "dad's number" }, env("preview", manager));
    expect(r.mode).toBe("preview");
    expect(r.confirm).toBeUndefined();
    expect(r.note).toMatch(/preview mode/);
    expect(readFileSync(join(ws, "MEMORY.md"), "utf8")).toBe(before);
    expect(row(r, "note")?.status).toBe("found");
    expect(row(r, "old_versions")?.status).toBe("out_of_reach"); // git history + checkpoint copy
    expect(row(r, "summaries")?.status).toBe("found");
    expect(row(r, "chat_record")?.status).toBe("found");
    expect(row(r, "search_index")?.status).toBe("found");
    expect(row(r, "backups")?.status).toBe("out_of_reach");
    expect(row(r, "provider")?.status).toBe("out_of_reach");
    // The agent's credentials folder is never part of the chat record.
    expect(JSON.stringify(r)).not.toContain("auth-profiles");
  });

  it("refuses an apply in preview mode, and an unknown or mismatched confirm code", async () => {
    world();
    await expect(runForget({ fact: FACT, confirm: "abc" }, env("preview", null))).rejects.toThrow(
      FactError,
    );
    const p = await runForget({ fact: FACT }, env("apply", null));
    expect(p.confirm).toMatch(/^[0-9a-f]{8}$/);
    await expect(
      runForget({ fact: "+34 600 99 99 99", confirm: p.confirm }, env("apply", null)),
    ).rejects.toThrow(/unknown, expired or for another fact/);
    await expect(
      runForget({ fact: FACT, label: `dad ${SPELLED}` }, env("apply", null)),
    ).rejects.toThrow(/without containing it/);
  });

  it("apply redacts every reachable copy, rebuilds the indexes, and writes a receipt without the fact", async () => {
    world();
    const mem = fakeMemoryIndex();
    const e = env("apply", mem.manager);
    const preview = await runForget({ fact: FACT, label: "dad's number" }, e);
    const r = await runForget({ fact: FACT, label: "dad's number", confirm: preview.confirm }, e);
    expect(r.mode).toBe("apply");

    for (const f of [
      join(ws, "MEMORY.md"),
      join(ws, "memory", "2026-10-20.md"),
      join(ws, "memory", "archive", "old.md"),
      join(ws, "memory", ".dreams", "short-term-recall.json"),
      join(state, "agents", "main", "sessions", "s1.jsonl"),
      join(state, "agents", "main", "sessions", "s1.checkpoint.1.jsonl"),
      join(state, "engram", "events", "agent_main.jsonl"),
      join(state, "engram", "packs", "p.json"),
      join(state, "wiki", "main", "entities", "dad.md"),
      join(state, "backups", "dump.jsonl"),
      join(home, ".claude", "projects", "p", "abc.jsonl"),
      join(home, ".claude", "projects", "p", "memory", "dad.md"),
    ]) {
      expect(holds(f), f).toBe(false);
    }
    expect(readFileSync(join(ws, "MEMORY.md"), "utf8")).toBe(
      "# Memory\n- Dad's phone: [forgotten 2026-10-25]\n- other line\n",
    );
    // The credentials file is outside every swept place and keeps its bytes.
    expect(holds(join(state, "agents", "main", "agent", "auth-profiles.json"))).toBe(true);

    expect(row(r, "note")?.status).toBe("done");
    expect(row(r, "summaries")?.status).toBe("done");
    expect(row(r, "chat_record")?.status).toBe("done");
    expect(row(r, "search_index")?.items.map((i) => i.status)).toEqual(
      expect.arrayContaining(["done"]),
    );
    expect(
      row(r, "old_versions")?.items.some(
        (i) => i.path.includes("git history") && i.status === "out_of_reach",
      ),
    ).toBe(true);
    expect(
      row(r, "backups")
        ?.items.map((i) => i.status)
        .toSorted(),
    ).toEqual(["done", "out_of_reach", "out_of_reach", "out_of_reach"]); // dump.jsonl cleaned; the archive, the git remote and the Drive copy out of reach
    expect(row(r, "provider")?.status).toBe("out_of_reach");

    // The engram transcript index answers from the redacted transcript.
    const index = openTranscriptIndex(join(state, "engram", "transcripts-main.sqlite"));
    expect(index.search("34600111222")).toHaveLength(0);
    expect(index.search("600")).toHaveLength(0);
    expect(index.search("forgotten")).toHaveLength(1);
    index.close();
    // The memory search index was re-synced with the redacted gateway transcript.
    expect(mem.calls).toContainEqual({
      reason: "forget",
      sessionFiles: [join(state, "agents", "main", "sessions", "s1.jsonl")],
    });

    // The receipt names places, never the fact.
    const file = readFileSync(join(state, "data", "forget", "receipts", `${r.id}.json`), "utf8");
    expect(buildMatcher(FACT).scan.test(file)).toBe(false);
    expect(JSON.parse(file).label).toBe("dad's number");
    expect(readFileSync(join(state, "data", "forget", "receipts.md"), "utf8")).toContain(
      "dad's number",
    );
    // A confirm code works once.
    await expect(runForget({ fact: FACT, confirm: preview.confirm }, e)).rejects.toThrow(FactError);
  });

  it("the follow-up pass cleans the copies the request itself added after the apply", async () => {
    world();
    const e = env("apply", null);
    const preview = await runForget({ fact: FACT }, e);
    await runForget({ fact: FACT, confirm: preview.confirm }, e);
    const s1 = join(state, "agents", "main", "sessions", "s1.jsonl");
    appendFileSync(s1, userLine(`please forget ${SPELLED}`));
    const pass = await followUpPass(e, {
      matcher: buildMatcher(FACT),
      token: "[forgotten 2026-10-25]",
      fact: FACT,
      startedMs: Date.now() - 60_000,
    });
    expect(pass).toMatchObject({ files: 1, copies: 1, failed: 0 });
    expect(holds(s1)).toBe(false);
  });
});
