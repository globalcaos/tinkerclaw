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
