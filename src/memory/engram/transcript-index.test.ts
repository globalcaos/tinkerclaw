import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitJRecallResolve = vi.fn();
vi.mock("../../infra/events/j-rows.js", () => ({ emitJRecallResolve }));

const {
  createTranscriptCatchUp,
  extractTranscriptRecord,
  isTranscriptFileName,
  openTranscriptIndex,
  recallTranscripts,
} = await import("./transcript-index.js");

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const session = (id: string) =>
  line({ type: "session", version: 3, id, timestamp: "2026-10-01T06:00:00.000Z" });
const user = (text: string, ts = "2026-10-01T06:47:57.222Z") =>
  line({
    type: "message",
    timestamp: ts,
    message: { role: "user", content: [{ type: "text", text }] },
  });
const assistant = (text: string, ts = "2026-10-01T06:48:30.000Z") =>
  line({
    type: "message",
    timestamp: ts,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning zebra" },
        { type: "text", text },
      ],
    },
  });
const bridgeTool = (phase: "start" | "result", data: Record<string, unknown>) =>
  line({
    type: "custom",
    customType: "tinker-bridge-tool",
    data: { runId: "r1", phase, toolCallId: "t1", ...data },
    timestamp: "2026-10-01T06:59:20.684Z",
  });

describe("extractTranscriptRecord", () => {
  it("keeps the architect's words and drops the Fractal doctrine appended after them", () => {
    const rec = extractTranscriptRecord(
      user(
        "[Thu 2026-10-01 08:44 GMT+2] design a OrbisVision logo\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** doctrine words",
      ).trim(),
    );
    expect(rec).toEqual({
      role: "user",
      ts: "2026-10-01T06:47:57.222Z",
      text: "[Thu 2026-10-01 08:44 GMT+2] design a OrbisVision logo",
    });
  });

  it("keeps assistant text but not its thinking, and both halves of a worker tool call", () => {
    expect(extractTranscriptRecord(assistant("the answer").trim())?.text).toBe("the answer");
    expect(
      extractTranscriptRecord(
        bridgeTool("start", { name: "Bash", args: { command: "ls ~/logos" } }).trim(),
      ),
    ).toMatchObject({ role: "tool", text: 'Bash {"command":"ls ~/logos"}' });
    expect(
      extractTranscriptRecord(bridgeTool("result", { result: "orbis-logo.png" }).trim()),
    ).toMatchObject({ role: "tool", text: "orbis-logo.png" });
  });

  it("ignores bookkeeping lines and garbage", () => {
    expect(extractTranscriptRecord(session("s1").trim())).toBeNull();
    expect(
      extractTranscriptRecord(
        line({ type: "custom", customType: "openclaw.cache-ttl", data: {} }).trim(),
      ),
    ).toBeNull();
    expect(extractTranscriptRecord('{"type":"message", broken')).toBeNull();
  });

  it("treats checkpoint copies and prompt dumps as non-transcripts", () => {
    expect(isTranscriptFileName("abc.jsonl")).toBe(true);
    expect(isTranscriptFileName("abc.checkpoint.def.jsonl")).toBe(false);
    expect(isTranscriptFileName("abc.trajectory.jsonl")).toBe(false);
    expect(isTranscriptFileName("abc.jsonl.reset.2026-10-01")).toBe(false);
  });
});

describe("transcript index", () => {
  let dir: string;
  let sessionsDir: string;
  let index: ReturnType<typeof openTranscriptIndex>;
  const far = () => Date.now() + 60_000;

  beforeEach(() => {
    emitJRecallResolve.mockClear();
    dir = mkdtempSync(join(tmpdir(), "transcript-index-"));
    sessionsDir = join(dir, "sessions");
    index = openTranscriptIndex(join(dir, "engram", "transcripts-main.sqlite"));
  });

  afterEach(() => {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds what the user said and what a tool printed — the store recall used to search had neither", () => {
    const p = join(dir, "a.jsonl");
    writeFileSync(
      p,
      session("a") +
        user("Use the Llicència d'obres folder for Townsville") +
        assistant("Noted.") +
        bridgeTool("start", {
          name: "Bash",
          args: { command: "find ~/Documents -iname '*orbis*'" },
        }) +
        bridgeTool("result", { result: "/home/x/Documents/ORBIS/orbis-logo.png" }),
    );
    expect(index.syncFile(p, far())).toBe("done");

    // Accent-insensitive: the architect types "llicencia" without the accent.
    const userHits = index.search("llicencia townsville");
    expect(userHits).toHaveLength(1);
    expect(userHits[0]).toMatchObject({ path: p, role: "user" });
    expect(userHits[0].snippet).toContain("«Llicència»");

    const toolHits = index.search("orbis-logo.png");
    expect(toolHits.map((h) => h.role)).toContain("tool");
  });

  it("indexes only what was appended since the last sync, and waits for an unterminated line", () => {
    const p = join(dir, "b.jsonl");
    writeFileSync(p, session("b") + user("first quokka"));
    index.syncFile(p, far());
    appendFileSync(p, user("second quokka").trimEnd()); // no trailing newline yet
    index.syncFile(p, far());
    expect(index.search("quokka", { limit: 10 })).toHaveLength(1);

    appendFileSync(p, "\n");
    index.syncFile(p, far());
    index.syncFile(p, far()); // a repeat sync must not duplicate rows
    expect(index.search("quokka", { limit: 10 })).toHaveLength(2);
  });

  it("indexes a tool result longer than one sync chunk instead of skipping it", () => {
    const p = join(dir, "long.jsonl");
    const huge = `pangolin census ${"0123456789".repeat(40_000)}`; // ~400 KB on one line
    writeFileSync(p, session("long") + bridgeTool("result", { result: huge }) + user("after it"));
    expect(index.syncFile(p, far())).toBe("done");
    expect(index.search("pangolin")).toHaveLength(1);
    expect(index.search("after")).toHaveLength(1);
  });

  it("re-indexes a transcript rewritten in place instead of mixing old and new offsets", () => {
    const p = join(dir, "c.jsonl");
    writeFileSync(p, session("c-old") + user("old wombat") + user("old wombat again"));
    index.syncFile(p, far());
    writeFileSync(p, session("c-new") + user("new wombat"));
    index.syncFile(p, far());
    const hits = index.search("wombat", { limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("new");
  });

  it("forgetFile drops a redacted transcript's rows so a same-size rewrite is re-read; compact keeps search working", () => {
    const p = join(dir, "f.jsonl");
    const before = session("f") + user("a long first turn ".repeat(20));
    writeFileSync(p, before + user("call me on 600111222 please"));
    index.syncFile(p, far());
    expect(index.search("600111222")).toHaveLength(1);
    // A redaction past the first 256 bytes that keeps the size reads to syncFile as "nothing new".
    writeFileSync(p, before + user("call me on forgotten please"));
    index.syncFile(p, far());
    expect(index.search("600111222")).toHaveLength(1);
    index.forgetFile(p);
    expect(index.indexedPaths()).not.toContain(p);
    index.syncFile(p, far());
    index.compact();
    expect(index.search("600111222")).toHaveLength(0);
    expect(index.search("forgotten")).toHaveLength(1);
  });

  it("scope session searches only the caller's transcript and emits one j.recall.resolve row per call", async () => {
    const mine = join(dir, "mine.jsonl");
    const other = join(dir, "other.jsonl");
    writeFileSync(mine, session("mine") + user("capybara in my chat", "2026-10-09T10:00:00.000Z"));
    writeFileSync(other, session("other") + user("capybara elsewhere"));
    index.syncFile(other, far());

    // The caller's own transcript is synced by the call itself.
    const own = await recallTranscripts({
      index,
      query: "capybara",
      scope: "session",
      sessionFile: mine,
      sessionKey: "agent:main:tinker:x",
    });
    expect(own.sessionSynced).toBe(true);
    expect(own.hits.map((h) => h.path)).toEqual([mine]);

    const all = await recallTranscripts({
      index,
      query: "capybara",
      scope: "all",
      sessionFile: mine,
    });
    expect(new Set(all.hits.map((h) => h.path))).toEqual(new Set([mine, other]));

    const miss = await recallTranscripts({ index, query: "narwhal", scope: "all" });
    expect(miss.hits).toEqual([]);

    expect(emitJRecallResolve).toHaveBeenCalledTimes(3);
    expect(emitJRecallResolve.mock.calls[0][0]).toMatchObject({
      outcome: "hit",
      eventsReturned: 1,
      sessionKey: "agent:main:tinker:x",
    });
    expect(emitJRecallResolve.mock.calls[0][0].pointerAgeMs).toBeGreaterThan(0);
    expect(emitJRecallResolve.mock.calls[2][0]).toMatchObject({
      outcome: "miss",
      pointerAgeMs: null,
      eventsReturned: 0,
    });
  });

  it("catch-up indexes every transcript in the sessions dir in slices, skipping checkpoint copies", async () => {
    mkdirSync(sessionsDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(sessionsDir, `s${i}.jsonl`),
        session(`s${i}`) + user(`axolotl number ${i}`),
      );
    }
    writeFileSync(
      join(sessionsDir, "s0.checkpoint.x.jsonl"),
      session("s0") + user("axolotl number 0"),
    );
    const catchUp = createTranscriptCatchUp({ index, sessionsDir, sliceMs: 1 });
    catchUp.kick();
    catchUp.kick(); // a second kick while running is a no-op
    await catchUp.idle();
    expect(catchUp.pending()).toBe(0);
    expect(index.search("axolotl", { limit: 50 })).toHaveLength(5);

    // Each pass stats every transcript, so a kick right after one ends is ignored.
    writeFileSync(join(sessionsDir, "s5.jsonl"), session("s5") + user("axolotl number 5"));
    catchUp.kick();
    await catchUp.idle();
    expect(index.search("axolotl", { limit: 50 })).toHaveLength(5);
    catchUp.stop();
  });

  it("drops a transcript that left the sessions dir (deleted, or archived by /new) on the next pass", async () => {
    mkdirSync(sessionsDir, { recursive: true });
    const keep = join(sessionsDir, "keep.jsonl");
    const gone = join(sessionsDir, "gone.jsonl");
    writeFileSync(keep, session("keep") + user("ocelot kept"));
    writeFileSync(gone, session("gone") + user("ocelot reset"));
    const catchUp = createTranscriptCatchUp({
      index,
      sessionsDir,
      sliceMs: 1,
      minPassIntervalMs: 0,
    });
    catchUp.kick();
    await catchUp.idle();
    expect(index.search("ocelot", { limit: 10 })).toHaveLength(2);

    renameSync(gone, `${gone}.reset.2026-10-09T20-00-00.000Z`);
    catchUp.kick();
    await catchUp.idle();
    expect(index.search("ocelot", { limit: 10 }).map((h) => h.path)).toEqual([keep]);
    expect(index.indexedPaths()).toEqual([keep]);
    catchUp.stop();
  });
});
