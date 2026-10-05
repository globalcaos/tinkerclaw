import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RewindRegistry, rewindTurn, type SessionMap } from "../src/rewind.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "amy-rewind-m-"));
  dirs.push(d);
  return d;
};
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

const S = "sess-orig";
const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: S, ...o });
const transcript = () =>
  [
    line({ type: "attachment", uuid: "a1" }),
    line({ type: "user", uuid: "u1", message: { content: "first question" } }),
    line({
      type: "assistant",
      uuid: "r1",
      message: { content: [{ type: "text", text: "answer" }] },
    }),
    line({ type: "user", uuid: "u2", message: { content: "the refused request" } }),
    line({
      type: "assistant",
      uuid: "r2",
      message: { content: [{ type: "text", text: "I can't help with that" }] },
    }),
  ].join("\n") + "\n";

class FakeMap implements SessionMap {
  pointed: Array<[string, string]> = [];
  constructor(
    private readonly path: string | null,
    private readonly runner = "cc-bridge",
    private readonly allow = true,
  ) {}
  transcriptPathFor() {
    return this.path;
  }
  runnerFor() {
    return this.runner;
  }
  currentSessionId() {
    return S;
  }
  point(key: string, id: string) {
    if (!this.allow) return false;
    this.pointed.push([key, id]);
    return true;
  }
}

function setup() {
  const d = tmp();
  const path = join(d, `${S}.jsonl`);
  writeFileSync(path, transcript());
  return { d, path, registry: new RewindRegistry(join(d, "state", "rewinds.json")) };
}

describe("rewind targets only the newest exchange (2026-09-30)", () => {
  it("Rewind pressed on an older turn is refused: no fork, no re-point, nothing recorded", () => {
    const { d, path, registry } = setup();
    const map = new FakeMap(path);
    const r = rewindTurn({
      sessionMap: map,
      registry,
      sessionKey: "k",
      turnId: "k#1",
      newestTurnId: "k#2",
      now: 5,
    });
    expect(r).toMatchObject({ ok: false, capability: "claude-fork" });
    expect(r.reason).toMatch(/newest exchange/);
    expect(map.pointed).toEqual([]);
    expect(registry.latestFor("k")).toBeUndefined();
    expect(readdirSync(d).filter((f) => f.endsWith(".jsonl"))).toEqual([`${S}.jsonl`]);
  });

  it("the newest turn rewinds, and then counts as rewound for the next one", () => {
    const { path, registry } = setup();
    const map = new FakeMap(path);
    const r = rewindTurn({
      sessionMap: map,
      registry,
      sessionKey: "k",
      turnId: "k#2",
      newestTurnId: "k#2",
      now: 5,
    });
    expect(r.ok).toBe(true);
    expect([...registry.rewoundTurns("k")]).toEqual(["k#2"]);
  });
});

describe("amygdala2.rewind against an injected session map", () => {
  it("inert with no session map: nothing is read or written", () => {
    const { registry } = setup();
    const r = rewindTurn({ registry, sessionKey: "k", turnId: "t", now: 1 });
    expect(r).toMatchObject({ ok: false, capability: "unsupported" });
    expect(registry.latestFor("k")).toBeUndefined();
  });

  it("unsupported runner: no fork, no re-point", () => {
    const { path, registry } = setup();
    const map = new FakeMap(path, "native");
    const r = rewindTurn({ sessionMap: map, registry, sessionKey: "k", turnId: "t", now: 1 });
    expect(r).toMatchObject({ ok: false, capability: "unsupported" });
    expect(map.pointed).toEqual([]);
  });

  it("writes the truncated copy under a new id, points the tab at it, never modifies the original, returns the prompt", () => {
    const { d, path, registry } = setup();
    const before = sha(path);
    const map = new FakeMap(path);
    const r = rewindTurn({ sessionMap: map, registry, sessionKey: "k", turnId: "t", now: 5 });
    expect(r).toMatchObject({
      ok: true,
      capability: "claude-fork",
      originalSessionId: S,
      restoredPrompt: "the refused request",
    });
    expect(r.forkSessionId).toBeTruthy();
    expect(map.pointed).toEqual([["k", r.forkSessionId]]);
    const forkPath = join(d, `${r.forkSessionId}.jsonl`);
    expect(existsSync(forkPath)).toBe(true);
    expect(readFileSync(forkPath, "utf-8")).not.toContain("the refused request");
    expect(sha(path)).toBe(before);
  });

  it("Undo points the tab back at the original and marks the rewind undone; a second Undo has nothing to do", () => {
    const { path, registry } = setup();
    const map = new FakeMap(path);
    const r = rewindTurn({ sessionMap: map, registry, sessionKey: "k", turnId: "t", now: 5 });
    const u = rewindTurn({
      sessionMap: map,
      registry,
      sessionKey: "k",
      turnId: "t",
      undo: true,
      now: 6,
    });
    expect(u).toMatchObject({
      ok: true,
      restoredSessionId: S,
      restoredPrompt: "the refused request",
    });
    expect(map.pointed.at(-1)).toEqual(["k", S]);
    expect(registry.latestFor("k")).toBeUndefined();
    expect(
      rewindTurn({ sessionMap: map, registry, sessionKey: "k", turnId: "t", undo: true, now: 7 }),
    ).toMatchObject({
      ok: false,
      reason: "nothing to undo",
    });
    expect(r.forkSessionId).toBeTruthy();
  });

  it("if the tab cannot be re-pointed, our unused copy is removed and the original is untouched", () => {
    const { d, path, registry } = setup();
    const before = sha(path);
    const map = new FakeMap(path, "cc-bridge", false);
    const r = rewindTurn({ sessionMap: map, registry, sessionKey: "k", turnId: "t", now: 1 });
    expect(r.ok).toBe(false);
    expect(sha(path)).toBe(before);
    const jsonl = readdirSync(d).filter((f) => f.endsWith(".jsonl"));
    expect(jsonl).toEqual([`${S}.jsonl`]);
    expect(registry.latestFor("k")).toBeUndefined();
  });

  it("no transcript for the tab, or nothing to rewind to, fails cleanly", () => {
    const { d, registry } = setup();
    expect(
      rewindTurn({ sessionMap: new FakeMap(null), registry, sessionKey: "k", turnId: "t", now: 1 }),
    ).toMatchObject({ ok: false });
    const lone = join(d, "lone.jsonl");
    writeFileSync(lone, `${line({ type: "user", uuid: "u", message: { content: "only" } })}\n`);
    expect(
      rewindTurn({ sessionMap: new FakeMap(lone), registry, sessionKey: "k", turnId: "t", now: 1 }),
    ).toMatchObject({ ok: false });
  });

  it("the registry survives a restart and is written 0600", () => {
    const { d, path } = setup();
    const file = join(d, "state", "rewinds.json");
    const reg1 = new RewindRegistry(file);
    rewindTurn({
      sessionMap: new FakeMap(path),
      registry: reg1,
      sessionKey: "k",
      turnId: "t",
      now: 1,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const reg2 = new RewindRegistry(file);
    expect(reg2.latestFor("k")?.originalSessionId).toBe(S);
  });
});
