import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findArchiveCliSessionIds,
  listResetArchives,
  listSessionArchives,
  readArchiveHead,
  readArchiveSessionId,
  readArchiveToolCallIds,
} from "./chat-history-archive.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-archive-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const touch = (name: string, body = "") => fs.writeFileSync(path.join(dir, name), body);

describe("listResetArchives", () => {
  it("lists this transcript's reset archives, newest first, and nothing else", () => {
    const live = path.join(dir, "abc.jsonl");
    touch("abc.jsonl");
    touch("abc.jsonl.reset.2026-10-02T05-50-19.607Z");
    touch("abc.jsonl.reset.2026-10-02T10-13-40.719Z");
    touch("abc.jsonl.reset.2026-10-01T19-06-30Z");
    // Not reset archives of abc.jsonl:
    touch("abc.jsonl.deleted.2026-10-02T11-00-00.000Z");
    touch("abc.jsonl.bak.2026-10-02T11-00-00.000Z");
    touch("abcd.jsonl.reset.2026-10-02T11-00-00.000Z");
    touch("abc.jsonl.reset.not-a-time");
    touch("abc.trajectory.jsonl");
    expect(listResetArchives(live).map((a) => [path.basename(a.path), a.resetAt])).toEqual([
      ["abc.jsonl.reset.2026-10-02T10-13-40.719Z", Date.parse("2026-10-02T10:13:40.719Z")],
      ["abc.jsonl.reset.2026-10-02T05-50-19.607Z", Date.parse("2026-10-02T05:50:19.607Z")],
      ["abc.jsonl.reset.2026-10-01T19-06-30Z", Date.parse("2026-10-01T19:06:30Z")],
    ]);
  });

  it("has none for a transcript in a directory it cannot read", () => {
    expect(listResetArchives(path.join(dir, "missing", "x.jsonl"))).toEqual([]);
  });
});

// FORK 2026-10-03 (the architect: "There are still tabs where the history has been erased") — Main's
// `/new` at 2026-10-02 12:12 moved it to a NEW transcript path, so its earlier resets sat beside a
// path nothing named any more. Each session's trajectory names its key and transcript, and that is
// how a tab's every earlier transcript is found: resets, the left file itself, repair backups
// (`.bak-<pid>-<ms>`) and compaction checkpoints.
describe("listSessionArchives", () => {
  const KEY = "agent:main:main";
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const trajectory = (sessionId: string, sessionKey: string | undefined, file: string) =>
    touch(
      `${sessionId}.trajectory.jsonl`,
      line({
        traceSchema: "openclaw-trajectory",
        type: "session.started",
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        data: { trigger: "user", sessionFile: path.join(dir, file) },
      }),
    );
  const transcript = (name: string, id: string, lastIso: string) =>
    touch(
      name,
      line({ type: "session", id, timestamp: "2026-09-01T00:00:00.000Z" }) +
        line({ type: "message", id: "m1", timestamp: lastIso, message: { role: "user" } }),
    );
  const listed = (live: string) =>
    listSessionArchives({ sessionKey: KEY, transcriptPath: path.join(dir, live) }).map((a) => [
      path.basename(a.path),
      a.kind,
      a.resetAt,
    ]);

  it("follows the tab into a transcript it left: the resets beside every path its trajectories name", () => {
    trajectory("old", KEY, "old.jsonl");
    trajectory("new", KEY, "new.jsonl");
    touch("new.jsonl");
    touch("old.jsonl.reset.2026-09-25T12-06-25.796Z");
    touch("old.jsonl.reset.2026-10-02T12-12-09.612Z");
    // Another tab's reset is not this one's.
    trajectory("other", "agent:main:tinker:other", "other.jsonl");
    touch("other.jsonl.reset.2026-10-01T00-00-00.000Z");
    expect(listed("new.jsonl")).toEqual([
      ["old.jsonl.reset.2026-10-02T12-12-09.612Z", "reset", Date.parse("2026-10-02T12:12:09.612Z")],
      ["old.jsonl.reset.2026-09-25T12-06-25.796Z", "reset", Date.parse("2026-09-25T12:06:25.796Z")],
    ]);
  });

  it("lists the left file, its repair backups and compaction checkpoints by when each ends", () => {
    trajectory("old", KEY, "old.jsonl");
    touch("new.jsonl");
    transcript("old.jsonl", "old", "2026-09-20T10:00:00.000Z");
    touch("old.jsonl.bak-1567-1787226075384", line({ type: "session", id: "old" }));
    transcript("old.checkpoint.1195c0c2-c271.jsonl", "old", "2026-07-29T07:32:57.239Z");
    // A repair backup of the LIVE file is an earlier copy of this tab too.
    touch("new.jsonl.bak-9-1790000000000", line({ type: "session", id: "new" }));
    expect(listed("new.jsonl")).toEqual([
      ["new.jsonl.bak-9-1790000000000", "copy", 1790000000000],
      ["old.jsonl", "earlier", Date.parse("2026-09-20T10:00:00.000Z")],
      ["old.jsonl.bak-1567-1787226075384", "copy", 1787226075384],
      ["old.checkpoint.1195c0c2-c271.jsonl", "copy", Date.parse("2026-07-29T07:32:57.239Z")],
    ]);
  });

  it("counts no transcript whose trajectory names another key or none, and never the live file", () => {
    trajectory("anon", undefined, "anon.jsonl");
    trajectory("other", "agent:main:tinker:other", "other.jsonl");
    transcript("anon.jsonl", "anon", "2026-09-20T10:00:00.000Z");
    transcript("other.jsonl", "other", "2026-09-20T10:00:00.000Z");
    trajectory("new", KEY, "new.jsonl");
    transcript("new.jsonl", "new", "2026-10-03T00:00:00.000Z");
    touch("new.jsonl.reset.2026-10-02T00-00-00.000Z");
    expect(listed("new.jsonl")).toEqual([
      ["new.jsonl.reset.2026-10-02T00-00-00.000Z", "reset", Date.parse("2026-10-02T00:00:00.000Z")],
    ]);
  });

  it("sees a trajectory written after an earlier listing", () => {
    touch("new.jsonl");
    touch("old.jsonl.reset.2026-09-25T12-06-25.796Z");
    expect(listed("new.jsonl")).toEqual([]);
    trajectory("old", KEY, "old.jsonl");
    expect(listed("new.jsonl").map((r) => r[0])).toEqual([
      "old.jsonl.reset.2026-09-25T12-06-25.796Z",
    ]);
  });
});

describe("readArchiveSessionId", () => {
  it("reads the session id from the archive's header line", () => {
    touch(
      "a.jsonl.reset.2026-10-02T05-50-19.607Z",
      `${JSON.stringify({ type: "session", version: 3, id: "104c24ce-977c", cwd: "/x" })}\n` +
        `${JSON.stringify({ type: "message", id: "m1" })}\n`,
    );
    expect(readArchiveSessionId(path.join(dir, "a.jsonl.reset.2026-10-02T05-50-19.607Z"))).toBe(
      "104c24ce-977c",
    );
  });

  it("is undefined for a file with no session header, an empty file, or no file", () => {
    touch("b", `${JSON.stringify({ type: "message", id: "m1" })}\n`);
    touch("c", "");
    touch("d", "{not json\n");
    for (const name of ["b", "c", "d", "missing"]) {
      expect(readArchiveSessionId(path.join(dir, name))).toBeUndefined();
    }
  });
});

// FORK 2026-10-02 — newer archives carry a header id the tinker-bridge map does not know (measured:
// the worker's 14:50 archive), so the CLI transcript is found by the archive's own tool-call ids.
describe("readArchiveHead / readArchiveToolCallIds", () => {
  it("reads the header's id and start time, and the first tool-call ids", () => {
    touch(
      "w.jsonl.reset.2026-10-02T12-50-23.991Z",
      [
        { type: "session", id: "01a0fc8b", timestamp: "2026-10-02T10:13:40.800Z" },
        { type: "custom", customType: "tinker-bridge-tool", data: { toolCallId: "toolu_A" } },
        { type: "custom", customType: "tinker-bridge-tool", data: { toolCallId: "toolu_A" } },
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "toolCall", id: "toolu_B" }] },
        },
        { type: "custom", customType: "tinker-bridge-tool", data: { toolCallId: "toolu_C" } },
        { type: "custom", customType: "tinker-bridge-tool", data: { toolCallId: "toolu_D" } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const p = path.join(dir, "w.jsonl.reset.2026-10-02T12-50-23.991Z");
    expect(readArchiveHead(p)).toEqual({
      sessionId: "01a0fc8b",
      startedAt: Date.parse("2026-10-02T10:13:40.800Z"),
    });
    expect(readArchiveToolCallIds(p, 3)).toEqual(["toolu_A", "toolu_B", "toolu_C"]);
  });
});

describe("findArchiveCliSessionIds", () => {
  const T = Date.parse("2026-10-02T12:00:00Z");
  const cli = (project: string, id: string, body: string, mtimeMs: number) => {
    fs.mkdirSync(path.join(dir, project), { recursive: true });
    const f = path.join(dir, project, `${id}.jsonl`);
    fs.writeFileSync(f, body);
    fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  };

  it("names the CLI transcripts written in the window that hold one of the tool-call ids", async () => {
    cli("ws", "match-1", '{"x":"toolu_B"}\n', T);
    cli("ws", "other-1", '{"x":"toolu_Z"}\n', T);
    cli("ws2", "match-old", '{"x":"toolu_B"}\n', T - 86_400_000); // outside the window
    const ids = await findArchiveCliSessionIds({
      toolCallIds: ["toolu_A", "toolu_B"],
      fromMs: T - 3_600_000,
      toMs: T + 3_600_000,
      projectsDir: dir,
    });
    expect(ids).toEqual(["match-1"]);
  });

  // Measured 2026-10-02: a worker's CLI transcript opens with hook context and the prompt, so its
  // first tool call sits ~370-390 KB in; a 256 KB head read matched nothing.
  it("finds a tool-call id that sits far past the transcript's head", async () => {
    cli("ws", "deep-1", `${"x".repeat(400 * 1024)}{"id":"toolu_DEEP"}\n`, T);
    expect(
      await findArchiveCliSessionIds({
        toolCallIds: ["toolu_DEEP"],
        fromMs: T - 3_600_000,
        toMs: T + 3_600_000,
        projectsDir: dir,
      }),
    ).toEqual(["deep-1"]);
  });

  it("finds nothing without tool-call ids or without a projects directory", async () => {
    cli("ws", "match-1", '{"x":"toolu_B"}\n', T);
    expect(
      await findArchiveCliSessionIds({ toolCallIds: [], fromMs: 0, toMs: T * 2, projectsDir: dir }),
    ).toEqual([]);
    expect(
      await findArchiveCliSessionIds({
        toolCallIds: ["toolu_B"],
        fromMs: 0,
        toMs: T * 2,
        projectsDir: path.join(dir, "missing"),
      }),
    ).toEqual([]);
  });
});
