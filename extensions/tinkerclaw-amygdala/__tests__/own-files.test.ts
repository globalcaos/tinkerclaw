import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { candidateRoots, listTree, OwnFiles } from "../src/own-files.js";
import { SessionTracker } from "../src/session-tracker.js";
import { ownedTargetsOf } from "../src/situation.js";

// 2026-11-16, the owner's order: the agent can always delete the files it created, also the ones he does not know
// of. The incident: a wildcard copy put eight files into a new folder; 46 minutes later their removal was refused,
// because no layer of the guard knew them as the agent's own (not under /tmp, older than five minutes, and their
// names never appeared in a command).

const base = mkdtempSync(join(tmpdir(), "amy-own-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(base, `case${n++}`);
  mkdirSync(d);
  return d;
};

describe("own-files list", () => {
  it("files a call puts into a new folder are the agent's own, and so is the folder", () => {
    const d = fresh();
    writeFileSync(join(d, "his.txt"), "x");
    const own = new OwnFiles(join(d, "own.jsonl"));
    const t0 = Date.now();
    const before = listTree([d]);
    mkdirSync(join(d, "out"));
    writeFileSync(join(d, "out", "part1.js"), "a");
    writeFileSync(join(d, "out", "part2.js"), "b");
    own.noteCall({ before, absent: [], written: [], t0, now: Date.now() });
    expect(own.isOwn(join(d, "out", "part1.js"))).toBe(true);
    expect(own.isOwn(join(d, "out", "part2.js"))).toBe(true);
    expect(own.isOwn(join(d, "out"))).toBe(true);
    expect(own.isOwn(join(d, "his.txt"))).toBe(false);
  });

  it("the list survives a restart", () => {
    const d = fresh();
    const file = join(d, "own.jsonl");
    const own = new OwnFiles(file);
    const t0 = Date.now();
    const before = listTree([d]);
    writeFileSync(join(d, "made.txt"), "a");
    own.noteCall({ before, absent: [], written: [], t0, now: Date.now() });
    expect(new OwnFiles(file).isOwn(join(d, "made.txt"))).toBe(true);
  });

  it("a file that existed before the call stays his, also when the call replaces it by a new one", () => {
    const d = fresh();
    const his = join(d, "config.json");
    writeFileSync(his, "old");
    const own = new OwnFiles(join(d, "own.jsonl"));
    const t0 = Date.now();
    const before = listTree([d]);
    // An atomic save: a new file takes the old path, so its birth time lies inside the call.
    writeFileSync(join(d, ".config.tmp"), "new");
    renameSync(join(d, ".config.tmp"), his);
    own.noteCall({ before, absent: [], written: [his], t0, now: Date.now() });
    expect(own.isOwn(his)).toBe(false);
  });

  it("a file somebody else changed after the agent's last write is not the agent's own any more", () => {
    const d = fresh();
    const f = join(d, "draft.md");
    const own = new OwnFiles(join(d, "own.jsonl"));
    let t0 = Date.now();
    let before = listTree([d]);
    writeFileSync(f, "mine");
    own.noteCall({ before, absent: [], written: [], t0, now: Date.now() });
    expect(own.isOwn(f)).toBe(true);
    // The agent's own later write, seen by a call that names the file: still its own.
    t0 = Date.now();
    before = listTree([d]);
    writeFileSync(f, "mine, second version");
    own.noteCall({ before, absent: [], written: [f], t0, now: Date.now() });
    expect(own.isOwn(f)).toBe(true);
    // A change no call of the agent made (the owner edited it): his again.
    const later = new Date(Date.now() + 60_000);
    utimesSync(f, later, later);
    expect(own.isOwn(f)).toBe(false);
  });

  it("a file born outside the call is not recorded", () => {
    const d = fresh();
    const own = new OwnFiles(join(d, "own.jsonl"));
    const before = listTree([d]);
    writeFileSync(join(d, "late.txt"), "x");
    // The call ended a minute before this file was born.
    own.noteCall({
      before,
      absent: [],
      written: [],
      t0: Date.now() - 120_000,
      now: Date.now() - 60_000,
    });
    expect(own.isOwn(join(d, "late.txt"))).toBe(false);
  });

  it("a folder of the agent's own that holds a file of his does not count whole", () => {
    const d = fresh();
    const own = new OwnFiles(join(d, "own.jsonl"));
    const t0 = Date.now();
    const before = listTree([d]);
    mkdirSync(join(d, "out"));
    writeFileSync(join(d, "out", "a.js"), "a");
    own.noteCall({ before, absent: [], written: [], t0, now: Date.now() });
    expect(own.isOwn(join(d, "out"))).toBe(true);
    copyFileSync(join(d, "out", "a.js"), join(d, "out", "his-notes.txt"));
    expect(own.isOwn(join(d, "out"))).toBe(false);
  });

  it("home and the folders above it are never listed; /tmp is skipped unless told otherwise", () => {
    const d = fresh();
    mkdirSync(join(d, "home", "u", "proj"), { recursive: true });
    const home = join(d, "home", "u");
    expect(candidateRoots([home, join(d, "home"), "/"], home, [])).toEqual([]);
    expect(candidateRoots([join(home, "proj", "new-file.txt")], home, [])).toEqual([
      join(home, "proj"),
    ]);
    expect(candidateRoots([join(home, "proj")], home)).toEqual([]); // under /tmp here
  });
});

describe("session tracker feeds the list", () => {
  it("a shell call's wildcard copy into a new folder: the judge layer reads the copies as created", () => {
    const d = fresh();
    const repo = join(d, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "his.txt"), "x");
    const file = join(d, "own.jsonl");
    const t = new SessionTracker({ homeDir: d, ownFilesPath: file, ownSkipRoots: [] });
    const hook = {
      tool_name: "Bash",
      tool_input: { command: `mkdir -p content-src && cp /somewhere/part?.js content-src/` },
      tool_use_id: "1",
      cwd: repo,
    };
    t.notePreTool("tab", hook);
    mkdirSync(join(repo, "content-src"));
    writeFileSync(join(repo, "content-src", "part1.js"), "a");
    t.recordToolResult("tab", { ...hook, tool_response: { stdout: "" } });

    // Another chat, after a restart: a new tracker on the same list.
    const c = new SessionTracker({ homeDir: d, ownFilesPath: file }).sessionContext("other");
    const p = join(repo, "content-src", "part1.js");
    const targets = [
      { path: p, kind: "file" as const, resolvedFrom: p },
      { path: join(repo, "his.txt"), kind: "file" as const, resolvedFrom: "his.txt" },
    ];
    expect(ownedTargetsOf(targets, { own: c.ownPath })).toEqual([{ path: p, why: "created" }]);
    expect(readFileSync(file, "utf-8")).toContain("part1.js");
  });

  it("a read-only call records nothing", () => {
    const d = fresh();
    const repo = join(d, "repo");
    mkdirSync(repo);
    const t = new SessionTracker({
      homeDir: d,
      ownFilesPath: join(d, "own.jsonl"),
      ownSkipRoots: [],
    });
    const hook = {
      tool_name: "Bash",
      tool_input: { command: "ls -la ." },
      tool_use_id: "1",
      cwd: repo,
    };
    t.notePreTool("tab", hook);
    writeFileSync(join(repo, "someone-elses.txt"), "x"); // born during the call, by another program
    t.recordToolResult("tab", { ...hook, tool_response: { stdout: "" } });
    expect(t.sessionContext("tab").ownPath?.(join(repo, "someone-elses.txt"))).toBe(false);
  });
});
