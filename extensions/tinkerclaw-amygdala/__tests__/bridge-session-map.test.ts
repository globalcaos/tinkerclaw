import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeSessionMap, SeenSessions, defaultBridgeMapPath } from "../src/bridge-session-map.js";
import { RewindRegistry, rewindTurn } from "../src/rewind.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "amy-bmap-"));
  dirs.push(d);
  return d;
};

const S1 = "11111111-1111-1111-1111-111111111111";
const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: S1, ...o });

function setup() {
  const d = tmp();
  const transcript = join(d, `${S1}.jsonl`);
  writeFileSync(
    transcript,
    [
      line({ type: "user", uuid: "u1", message: { content: "first" } }),
      line({ type: "assistant", uuid: "r1", message: { content: [{ type: "text", text: "ok" }] } }),
      line({ type: "user", uuid: "u2", message: { content: "the refused ask" } }),
      line({ type: "assistant", uuid: "r2", message: { content: [{ type: "text", text: "no" }] } }),
    ].join("\n") + "\n",
  );
  const mapFile = join(d, "session-map.json");
  writeFileSync(
    mapFile,
    JSON.stringify({
      "tinker-sp-aaa": { sessionId: S1, updatedAt: 1 },
      "tinker-sp-bbb": { sessionId: "22222222-2222-2222-2222-222222222222", updatedAt: 2 },
    }),
  );
  const seen = new SeenSessions();
  seen.note("agent:main:tinker:t1", { session_id: S1, transcript_path: transcript, cwd: d }, 100);
  const map = new BridgeSessionMap({ mapFile, seen, now: () => 999 });
  return { d, transcript, mapFile, seen, map };
}

describe("BridgeSessionMap with the bridge's rewind seam published (2026-10-22)", () => {
  const SLOT = Symbol.for("openclaw.bridgeRewind");
  const g = globalThis as Record<symbol, unknown>;
  afterEach(() => {
    delete g[SLOT];
  });

  it("point asks the bridge to rebind (its cache and warm worker), follows the fork, and does not rewrite the file itself", () => {
    const { mapFile, seen, map } = setup();
    const before = readFileSync(mapFile, "utf-8");
    const calls: Array<[string, string]> = [];
    g[SLOT] = {
      busy: () => false,
      rebind: (from: string, to: string) => (calls.push([from, to]), { ok: true }),
    };
    expect(map.point("agent:main:tinker:t1", "33333333-3333-3333-3333-333333333333")).toBe(true);
    expect(calls).toEqual([[S1, "33333333-3333-3333-3333-333333333333"]]);
    expect(readFileSync(mapFile, "utf-8")).toBe(before);
    expect(seen.get("agent:main:tinker:t1")?.sessionId).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("a refused or throwing rebind leaves the tab where it was", () => {
    const { seen, map } = setup();
    g[SLOT] = { busy: () => false, rebind: () => ({ ok: false, reason: "busy" }) };
    expect(map.point("agent:main:tinker:t1", "33333333-3333-3333-3333-333333333333")).toBe(false);
    g[SLOT] = {
      busy: () => false,
      rebind: () => {
        throw new Error("boom");
      },
    };
    expect(map.point("agent:main:tinker:t1", "33333333-3333-3333-3333-333333333333")).toBe(false);
    expect(seen.get("agent:main:tinker:t1")?.sessionId).toBe(S1);
  });

  it("busy reads the bridge by the tab's Claude session; an unknown tab, or no bridge, is not busy", () => {
    const { map } = setup();
    expect(map.busy("agent:main:tinker:t1")).toBe(false); // no bridge published
    g[SLOT] = { busy: (id: string) => id === S1, rebind: () => ({ ok: true }) };
    expect(map.busy("agent:main:tinker:t1")).toBe(true);
    expect(map.busy("agent:main:tinker:unknown")).toBe(false);
  });
});

describe("BridgeSessionMap on temp copies", () => {
  it("knows only tabs whose hooks it has heard from", () => {
    const { map, transcript } = setup();
    expect(map.runnerFor("agent:main:tinker:t1")).toBe("cc-bridge");
    expect(map.runnerFor("agent:main:tinker:unknown")).toBe("unknown");
    expect(map.transcriptPathFor("agent:main:tinker:t1")).toBe(transcript);
    expect(map.transcriptPathFor("agent:main:tinker:unknown")).toBeNull();
    expect(map.currentSessionId("agent:main:tinker:t1")).toBe(S1);
  });

  it("point rewrites only the entries bound to that tab's session, atomically, preserving the rest", () => {
    const { d, mapFile, seen, map } = setup();
    expect(map.point("agent:main:tinker:t1", "33333333-3333-3333-3333-333333333333")).toBe(true);
    const m = JSON.parse(readFileSync(mapFile, "utf-8")) as Record<
      string,
      { sessionId: string; updatedAt: number }
    >;
    expect(m["tinker-sp-aaa"]).toEqual({
      sessionId: "33333333-3333-3333-3333-333333333333",
      updatedAt: 999,
    });
    expect(m["tinker-sp-bbb"]).toEqual({
      sessionId: "22222222-2222-2222-2222-222222222222",
      updatedAt: 2,
    });
    expect(readdirSync(d).some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(seen.get("agent:main:tinker:t1")?.sessionId).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("a tab with no binding in the map, an unknown tab or a missing map file fails cleanly and writes nothing", () => {
    const { d, seen } = setup();
    seen.note("agent:main:tinker:t2", { session_id: "99999999-9999-9999-9999-999999999999" }, 1);
    const map = new BridgeSessionMap({ mapFile: join(d, "session-map.json"), seen });
    expect(map.point("agent:main:tinker:t2", "x")).toBe(false);
    expect(map.point("agent:main:tinker:never", "x")).toBe(false);
    const absent = new BridgeSessionMap({ mapFile: join(d, "nope.json"), seen });
    expect(absent.point("agent:main:tinker:t1", "x")).toBe(false);
    expect(existsSync(join(d, "nope.json"))).toBe(false);
  });

  it("the default path honours the bridge's own env override and is resolved at call time", () => {
    const before = process.env.OPENCLAW_TINKER_BRIDGE_SESSION_MAP;
    process.env.OPENCLAW_TINKER_BRIDGE_SESSION_MAP = "/tmp/override-map.json";
    try {
      expect(defaultBridgeMapPath()).toBe("/tmp/override-map.json");
    } finally {
      if (before === undefined) delete process.env.OPENCLAW_TINKER_BRIDGE_SESSION_MAP;
      else process.env.OPENCLAW_TINKER_BRIDGE_SESSION_MAP = before;
    }
    expect(defaultBridgeMapPath().endsWith("session-map.json")).toBe(true);
  });

  it("end to end with the rewind method: fork written, map re-pointed, Undo points back; original transcript untouched", () => {
    const { d, transcript, mapFile, map } = setup();
    const before = readFileSync(transcript, "utf-8");
    const registry = new RewindRegistry(join(d, "state", "rewinds.json"));
    const r = rewindTurn({
      sessionMap: map,
      registry,
      sessionKey: "agent:main:tinker:t1",
      turnId: "t",
      now: 5,
    });
    expect(r).toMatchObject({
      ok: true,
      capability: "claude-fork",
      restoredPrompt: "the refused ask",
    });
    const forkId = r.forkSessionId as string;
    const bound = JSON.parse(readFileSync(mapFile, "utf-8")) as Record<
      string,
      { sessionId: string }
    >;
    expect(bound["tinker-sp-aaa"]?.sessionId).toBe(forkId);
    expect(readFileSync(transcript, "utf-8")).toBe(before);

    const u = rewindTurn({
      sessionMap: map,
      registry,
      sessionKey: "agent:main:tinker:t1",
      turnId: "t",
      undo: true,
      now: 6,
    });
    expect(u).toMatchObject({ ok: true, restoredSessionId: S1 });
    const back = JSON.parse(readFileSync(mapFile, "utf-8")) as Record<
      string,
      { sessionId: string }
    >;
    expect(back["tinker-sp-aaa"]?.sessionId).toBe(S1);
  });
});

// 2026-11-13: the map was memory only, so after each gateway restart every tab answered "this runner cannot rewind"
// until it ran a new turn; a chat stuck on a refusal is exactly the one that will not run one.
describe("SeenSessions survives a restart when given a file", () => {
  const hook = (id: string, path: string) => ({ session_id: id, transcript_path: path, cwd: "/w" });

  it("a new instance on the same file knows the tabs the old one saw, and the rewind works", () => {
    const { d, transcript, mapFile } = setup();
    const file = join(d, "state", "seen-sessions.json");
    new SeenSessions(file).note("tab-1", hook(S1, transcript), 5);
    const after = new SeenSessions(file);
    expect(after.get("tab-1")).toMatchObject({ sessionId: S1, transcriptPath: transcript });
    const map = new BridgeSessionMap({ mapFile, seen: after });
    expect(map.runnerFor("tab-1")).toBe("cc-bridge");
    const r = rewindTurn({
      sessionMap: map,
      registry: new RewindRegistry(),
      sessionKey: "tab-1",
      turnId: "",
      now: 6,
    });
    expect(r.ok).toBe(true);
  });

  it("a re-pointed tab is saved too, and a repeated hook with the same session does not write again", () => {
    const { d, transcript } = setup();
    const file = join(d, "seen.json");
    const seen = new SeenSessions(file);
    seen.note("tab-1", hook(S1, transcript), 5);
    const written = readFileSync(file, "utf-8");
    seen.note("tab-1", hook(S1, transcript), 9);
    expect(readFileSync(file, "utf-8")).toBe(written);
    seen.set("tab-1", { sessionId: "fork-1", transcriptPath: null, cwd: null, ts: 10 });
    expect(new SeenSessions(file).get("tab-1")?.sessionId).toBe("fork-1");
  });

  it("a missing or broken file starts empty, and with no file nothing is written", () => {
    const d = tmp();
    const file = join(d, "seen.json");
    writeFileSync(file, "not json");
    expect(new SeenSessions(file).get("tab-1")).toBeUndefined();
    const mem = new SeenSessions();
    mem.note("tab-1", { session_id: S1 }, 1);
    expect(readdirSync(d)).toEqual(["seen.json"]);
  });
});

// 2026-11-13: a chat whose transcript passed the bridge's resume limit runs on a new Claude session; the page still
// shows the older turns, and a Rewind to one of them answered that the context was empty.
describe("Rewind reaches a prompt in an earlier session of the same tab", () => {
  const S0 = "00000000-0000-0000-0000-000000000000";
  const ln = (sid: string, o: Record<string, unknown>) => JSON.stringify({ sessionId: sid, ...o });
  function twoSessions(oldBytes = 0) {
    const d = tmp();
    const old = join(d, `${S0}.jsonl`);
    writeFileSync(
      old,
      [
        ln(S0, { type: "user", uuid: "o1", message: { content: "old first" } }),
        ln(S0, {
          type: "assistant",
          uuid: "o2",
          message: { content: [{ type: "text", text: "x".repeat(oldBytes) }] },
        }),
        ln(S0, { type: "user", uuid: "o3", message: { content: "the old ask" } }),
        ln(S0, {
          type: "assistant",
          uuid: "o4",
          message: { content: [{ type: "text", text: "old answer" }] },
        }),
      ].join("\n") + "\n",
    );
    const cur = join(d, `${S1}.jsonl`);
    writeFileSync(
      cur,
      [ln(S1, { type: "user", uuid: "n1", message: { content: "new ask" } })].join("\n") + "\n",
    );
    const mapFile = join(d, "session-map.json");
    writeFileSync(
      mapFile,
      JSON.stringify({
        "tinker-sp-old": { sessionId: S0, updatedAt: 1, openclawSessionId: "oc-1" },
        "tinker-sp-new": { sessionId: S1, updatedAt: 2, openclawSessionId: "oc-1" },
        "tinker-sp-other": {
          sessionId: "99999999-9999-9999-9999-999999999999",
          updatedAt: 3,
          openclawSessionId: "oc-2",
        },
      }),
    );
    const seen = new SeenSessions();
    seen.note("tab-1", { session_id: S1, transcript_path: cur }, 1);
    return { d, old, cur, mapFile, seen, map: new BridgeSessionMap({ mapFile, seen }) };
  }

  it("lists only this tab's earlier sessions", () => {
    const { old, map } = twoSessions();
    expect(map.earlierTranscriptsFor("tab-1")).toEqual([old]);
  });

  it("cuts the earlier session before that prompt, points the tab at the copy, and Undo returns to the current one", () => {
    const { d, old, map } = twoSessions();
    const before = readFileSync(old, "utf-8");
    const registry = new RewindRegistry();
    const r = rewindTurn({
      sessionMap: map,
      registry,
      sessionKey: "tab-1",
      turnId: "",
      fromPrompt: "the old ask",
      now: 5,
    });
    expect(r).toMatchObject({ ok: true, restoredPrompt: "the old ask", originalSessionId: S1 });
    const fork = readFileSync(join(d, `${r.forkSessionId}.jsonl`), "utf-8");
    expect(fork).toContain("old first");
    expect(fork).not.toContain("the old ask");
    expect(readFileSync(old, "utf-8")).toBe(before);
    const u = rewindTurn({
      sessionMap: map,
      registry,
      sessionKey: "tab-1",
      turnId: "",
      undo: true,
      now: 6,
    });
    expect(u).toMatchObject({ ok: true, restoredSessionId: S1 });
  });

  it("a copy too large for the bridge to resume is refused, and no copy stays", () => {
    const { d, map } = twoSessions(8_100_000);
    const r = rewindTurn({
      sessionMap: map,
      registry: new RewindRegistry(),
      sessionKey: "tab-1",
      turnId: "",
      fromPrompt: "the old ask",
      now: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/MB the bridge resumes/);
    expect(
      readdirSync(d)
        .filter((f) => f.endsWith(".jsonl"))
        .sort(),
    ).toEqual([`${S0}.jsonl`, `${S1}.jsonl`].sort());
  });
});
