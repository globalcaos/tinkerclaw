// FORK 2026-11-03 (context-window-panel.md A11) — the evicted fork of a Claude Code transcript. What makes it safe
// to resume: the chain is unbroken from the CLI's compaction boundary to the newest entry, no tool_result lost its
// tool_use, every entry carries the fork's session id, the moral code's SessionStart delivery survives, and the
// original file is untouched. What makes it J1: a pointer to the record, the owner's words verbatim, exact strings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { forkEvictedTranscript, isPromptEntry } from "./cli-evict.js";

const FORK_ID = "fork-0000-0000";
const BIG = "x".repeat(8_000);

/** Three turns; the first is big (a long tool result), and carries the hook delivery. */
function transcript(): unknown[] {
  return [
    { type: "queue-operation", operation: "enqueue", content: "First ask" },
    {
      uuid: "u1",
      parentUuid: null,
      type: "user",
      sessionId: "orig",
      timestamp: "2026-11-03T10:00:00.000Z",
      cwd: "/work",
      message: {
        role: "user",
        content: "First ask: read /srv/app/conf/blue.yaml and check commit 1a2b3c4d",
      },
    },
    {
      uuid: "a1",
      parentUuid: "u1",
      type: "assistant",
      sessionId: "orig",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading /srv/app/conf/blue.yaml now." },
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/srv/app/conf/blue.yaml" },
          },
        ],
      },
    },
    {
      uuid: "r1",
      parentUuid: "a1",
      type: "user",
      sessionId: "orig",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: BIG }],
      },
    },
    {
      uuid: "at1",
      parentUuid: "r1",
      type: "attachment",
      sessionId: "orig",
      attachment: {
        type: "hook_additional_context",
        hookEvent: "SessionStart",
        content: ["<moral_code>rules</moral_code>"],
      },
    },
    {
      uuid: "a2",
      parentUuid: "at1",
      type: "assistant",
      sessionId: "orig",
      timestamp: "2026-11-03T10:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    },
    {
      uuid: "u2",
      parentUuid: "a2",
      type: "user",
      sessionId: "orig",
      message: { role: "user", content: "Second ask" },
    },
    {
      uuid: "a3",
      parentUuid: "u2",
      type: "assistant",
      sessionId: "orig",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }],
      },
    },
    {
      uuid: "r3",
      parentUuid: "a3",
      type: "user",
      sessionId: "orig",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "a b" }],
      },
    },
    {
      uuid: "side",
      parentUuid: "r3",
      type: "assistant",
      isSidechain: true,
      sessionId: "orig",
      message: { content: [] },
    },
    {
      uuid: "u3",
      parentUuid: "r3",
      type: "user",
      sessionId: "orig",
      message: { role: "user", content: "Third ask" },
    },
    {
      uuid: "a4",
      parentUuid: "u3",
      type: "assistant",
      sessionId: "orig",
      cwd: "/work",
      version: "2.1.314",
      message: { role: "assistant", content: [{ type: "text", text: "Fine." }] },
    },
  ];
}

function write(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-evict-"));
  const file = path.join(dir, "orig.jsonl");
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n{garbled\n`);
  return file;
}

type Out = Record<string, unknown> & {
  uuid: string;
  parentUuid: string | null;
  message?: { content?: unknown };
};

function readFork(file: string): Out[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Out);
}

describe("forkEvictedTranscript", () => {
  it("evicts the oldest turns into a fork the CLI can resume, and leaves the original alone", () => {
    const src = write(transcript());
    const before = fs.readFileSync(src, "utf8");
    const res = forkEvictedTranscript(src, { keepFraction: 0.5, newId: FORK_ID, recallHint: true });
    if (!res.ok) {
      throw new Error(res.reason);
    }
    expect(res).toMatchObject({ forkSessionId: FORK_ID, evictedPrompts: 1, keptPrompts: 2 });
    expect(res.forkPath).toBe(path.join(path.dirname(src), `${FORK_ID}.jsonl`));
    expect(res.tokensAfter).toBeLessThan(res.tokensBefore);
    expect(res.evictedTokens).toBeGreaterThan(2_000);
    expect(fs.readFileSync(src, "utf8")).toBe(before);

    const fork = readFork(res.forkPath);
    // The CLI's own compaction layout: a parentless boundary, then the summary entry.
    expect(fork[0]).toMatchObject({
      parentUuid: null,
      type: "system",
      subtype: "compact_boundary",
    });
    expect(fork[1]).toMatchObject({
      parentUuid: fork[0].uuid,
      type: "user",
      isCompactSummary: true,
    });
    // The SessionStart delivery (moral code) survives, right after the marker; then the kept turns.
    expect(fork[2]).toMatchObject({
      type: "attachment",
      attachment: { hookEvent: "SessionStart" },
    });
    expect(fork.slice(3).map((e) => e.uuid)).toEqual(["u2", "a3", "r3", "u3", "a4"]);
    // One unbroken chain, every entry in the fork's session; no side chain, queue line or garbled line.
    for (let i = 1; i < fork.length; i++) {
      expect(fork[i].parentUuid).toBe(fork[i - 1].uuid);
    }
    expect(new Set(fork.map((e) => e.sessionId))).toEqual(new Set([FORK_ID]));
    // No tool_result without its tool_use.
    const uses = new Set<string>();
    for (const e of fork) {
      const c = e.message?.content;
      for (const b of Array.isArray(c) ? (c as Array<Record<string, unknown>>) : []) {
        if (b.type === "tool_use") {
          uses.add(b.id as string);
        }
        if (b.type === "tool_result") {
          expect(uses.has(b.tool_use_id as string)).toBe(true);
        }
      }
    }
  });

  it("writes a J1 marker: the record's path, the owner's words verbatim, exact strings", () => {
    const src = write(transcript());
    const res = forkEvictedTranscript(src, { keepFraction: 0.5, newId: FORK_ID, recallHint: true });
    if (!res.ok) {
      throw new Error(res.reason);
    }
    const marker = readFork(res.forkPath)[1].message?.content as string;
    expect(marker).toMatch(/^<context_eviction source="tinker-bridge">\n/);
    expect(marker).toContain("Turns 1 to 1 of this conversation");
    expect(marker).toContain(`\n${src}\n`);
    expect(marker).toContain("They were not summarised");
    expect(marker).toContain("- First ask: read /srv/app/conf/blue.yaml and check commit 1a2b3c4d");
    expect(marker).toContain("- /srv/app/conf/blue.yaml");
    expect(marker).toContain("- 1a2b3c4d");
    expect(marker).toContain("recall tool");
    expect(marker).not.toContain(BIG.slice(0, 50));
  });

  it("keeps only the last turn when no older cut fits the fraction", () => {
    const res = forkEvictedTranscript(write(transcript()), { keepFraction: 0, newId: FORK_ID });
    expect(res).toMatchObject({ ok: true, evictedPrompts: 2, keptPrompts: 1 });
  });

  it("declines a one-turn conversation as nothing to do, and writes nothing", () => {
    const src = write(transcript().slice(0, 6));
    const res = forkEvictedTranscript(src, { keepFraction: 0.5, newId: FORK_ID });
    expect(res).toMatchObject({ ok: false, nothingToDo: true });
    expect(fs.existsSync(path.join(path.dirname(src), `${FORK_ID}.jsonl`))).toBe(false);
  });

  it("declines a transcript that is not on disk", () => {
    expect(forkEvictedTranscript("/nonexistent/orig.jsonl", { keepFraction: 0.5 })).toMatchObject({
      ok: false,
    });
  });
});

describe("isPromptEntry", () => {
  it("is a user turn, never a tool result, a meta line or a compaction summary", () => {
    expect(isPromptEntry({ type: "user", message: { content: "hi" } })).toBe(true);
    expect(
      isPromptEntry({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }),
    ).toBe(true);
    expect(
      isPromptEntry({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t" }] },
      }),
    ).toBe(false);
    expect(isPromptEntry({ type: "user", isMeta: true, message: { content: "x" } })).toBe(false);
    expect(isPromptEntry({ type: "user", isCompactSummary: true, message: { content: "x" } })).toBe(
      false,
    );
    expect(isPromptEntry({ type: "assistant", message: { content: "x" } })).toBe(false);
  });
});
