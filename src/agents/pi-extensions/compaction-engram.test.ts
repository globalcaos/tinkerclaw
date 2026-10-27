import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import compactionEngramExtension from "./compaction-engram.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function compactWith(messages: unknown[]): Promise<unknown> {
  let handler: Handler | undefined;
  const api = {
    on: (name: string, fn: Handler) => {
      if (name === "session_before_compact") {
        handler = fn;
      }
    },
  };
  compactionEngramExtension()(api as never);
  return handler!(
    {
      preparation: {
        messagesToSummarize: messages,
        turnPrefixMessages: [],
        tokensBefore: 1000,
        firstKeptEntryId: "kept",
      },
    },
    { sessionManager: {} },
  );
}

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolOnly = () => ({
  role: "assistant",
  content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } }],
});
const toolResult = (text: string) => ({
  role: "toolResult",
  toolName: "bash",
  content: [{ type: "text", text }],
});

describe("compaction-engram archive", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "compaction-engram-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  function archive(): Array<{ id: string; kind: string; content: string }> {
    const file = join(home, ".openclaw", "engram", "events", "compaction.jsonl");
    if (!existsSync(file)) {
      return [];
    }
    return readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it("archives each distinct message once across overlapping compactions", async () => {
    await compactWith([user("fix the build"), assistant("on it"), toolResult("ok")]);
    expect(archive()).toHaveLength(3);
    // The next compaction re-sends the earlier messages plus new ones, as pi does.
    await compactWith([
      user("fix the build"),
      assistant("on it"),
      toolResult("ok"),
      user("thanks"),
      assistant("on it"),
    ]);
    const rows = archive();
    expect(rows.map((r) => r.content)).toEqual(["fix the build", "on it", "ok", "thanks"]);
  });

  it("does not archive the empty text of a tool-call-only turn", async () => {
    await compactWith([user("list files"), toolOnly(), toolResult("a.ts"), toolOnly()]);
    expect(archive().map((r) => r.content)).toEqual(["list files", "a.ts"]);
  });

  it("still returns a summary when every message is empty", async () => {
    const result = (await compactWith([toolOnly(), toolOnly()])) as {
      compaction: { summary: string };
    };
    expect(typeof result.compaction.summary).toBe("string");
    expect(archive()).toHaveLength(0);
  });
});
