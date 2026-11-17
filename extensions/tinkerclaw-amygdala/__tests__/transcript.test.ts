import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  narrationBefore,
  readTranscriptTail,
  recentExchange,
  runRecordOf,
  stepsAfter,
  turnSince,
} from "../src/transcript.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "amyg-transcript-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const prompt = (t: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: t } });
const toolUse = (id: string, name: string, input: unknown): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-29T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
const result = (id: string, isError = false): string =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }],
    },
  });
const say = (t: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: t }] },
  });

describe("readTranscriptTail", () => {
  it("returns only what happened after the last prompt", () => {
    const p = join(tmp(), "t.jsonl");
    writeFileSync(
      p,
      [
        prompt("first"),
        toolUse("a", "Bash", { command: "ls /tmp/old" }),
        result("a"),
        prompt("second"),
        toolUse("b", "Read", { file_path: "/x" }),
        result("b"),
        toolUse("c", "Bash", { command: "false" }),
        result("c", true),
        say("all done"),
      ].join("\n") + "\n",
    );
    const t = readTranscriptTail(p);
    expect(t.toolRecord.map((e) => [e.tool, e.exit])).toEqual([
      ["Read", 0],
      ["Bash", 1],
    ]);
    expect(t.toolRecord[0]?.effects).toEqual(["read"]);
    expect(t.toolRecord[0]?.argsDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(t.toolRecord[0]?.ts).toBe(Date.parse("2026-09-29T10:00:00.000Z"));
    expect(t.lastAssistantText).toBe("all done");
    expect(t.truncated).toBe(false);
  });

  it("a call with no result yet has exit null; a text block in a user entry is a prompt", () => {
    const p = join(tmp(), "t.jsonl");
    writeFileSync(
      p,
      [
        toolUse("a", "Edit", { file_path: "/x" }),
        JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "new ask" }] } }),
        toolUse("b", "Bash", { command: "ls" }),
      ].join("\n"),
    );
    const t = readTranscriptTail(p);
    expect(t.toolRecord).toHaveLength(1);
    expect(t.toolRecord[0]?.exit).toBeNull();
  });

  const bash = (id: string, command: string) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  });
  const resulted = (id: string, content: unknown, is_error = false) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
  });
  const file = (...lines: object[]): string => {
    const p = join(tmp(), "e.jsonl");
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
    return p;
  };
  const ask = { type: "user", message: { content: "do it" } };

  it("harness lines are not a new request: the record and the evidence survive them", () => {
    for (const harness of [
      {
        type: "user",
        isMeta: true,
        message: { content: "Stop hook feedback:\nYour reply says x" },
      },
      {
        type: "user",
        message: {
          content:
            '<task-notification>\n<tool-use-id>t9</tool-use-id>\n<status>completed</status>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>',
        },
      },
      {
        type: "user",
        message: {
          content:
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nstatus: completed successfully\ndone F035\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      { type: "user", message: { content: "⟦AGENT:⏳ Longjob · x⟧ the job finished" } },
    ]) {
      const t = readTranscriptTail(
        file(ask, bash("t1", "ls"), resulted("t1", "Deleted branch a"), harness),
      );
      expect(t.toolRecord[0]?.tool).toBe("Bash");
      expect(t.evidence).toContain("Deleted branch a");
    }
  });

  it("a completed job is an entry and evidence; a failed one is neither proof nor success", () => {
    const ok = {
      type: "user",
      message: { content: "<task-notification><summary>build completed (exit code 0)</summary>" },
    };
    const bad = {
      type: "user",
      message: { content: "<task-notification><status>failed</status> deleted branch" },
    };
    const good = readTranscriptTail(file(ask, ok));
    expect(good.toolRecord).toMatchObject([{ tool: "background-job-report", exit: 0 }]);
    expect(good.evidence).toHaveLength(1);
    const failed = readTranscriptTail(file(ask, bad));
    expect(failed.toolRecord).toMatchObject([{ exit: 1 }]);
    expect(failed.evidence).toEqual([]);
  });

  it("a restart report is a restart in the record", () => {
    const report = {
      type: "user",
      message: { content: "[System] The gateway restart you requested finished." },
    };
    expect(readTranscriptTail(file(ask, report)).toolRecord[0]?.effects).toEqual([
      "restart-own-system",
    ]);
  });

  it("a real prompt still starts the record over; a failed call and a file read are not evidence", () => {
    const again = readTranscriptTail(
      file(ask, bash("t1", "ls"), resulted("t1", "Deleted branch a"), ask),
    );
    expect(again.toolRecord).toEqual([]);
    expect(again.evidence).toEqual([]);
    const failed = readTranscriptTail(
      file(ask, bash("t1", "ls"), resulted("t1", "Deleted branch a", true)),
    );
    expect(failed.evidence).toEqual([]);
    const read = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: {} }] },
    };
    expect(readTranscriptTail(file(ask, read, resulted("r1", "deleted"))).evidence).toEqual([]);
  });

  it("reads a result given as text blocks", () => {
    const t = readTranscriptTail(
      file(ask, bash("t1", "ls"), resulted("t1", [{ type: "text", text: "removed the file" }])),
    );
    expect(t.evidence).toEqual(["removed the file"]);
  });

  it("never throws: missing file, garbage lines, empty file", () => {
    const d = tmp();
    expect(readTranscriptTail(join(d, "nope.jsonl"))).toEqual({
      toolRecord: [],
      evidence: [],
      lastAssistantText: null,
      truncated: false,
      bytesRead: 0,
    });
    const p = join(d, "g.jsonl");
    writeFileSync(
      p,
      ["not json", "{", prompt("hi"), "\u0000\u0001", say("fine"), "[1,2]"].join("\n"),
    );
    expect(readTranscriptTail(p).lastAssistantText).toBe("fine");
    writeFileSync(p, "");
    expect(readTranscriptTail(p).toolRecord).toEqual([]);
  });

  it("a partial last line is skipped", () => {
    const p = join(tmp(), "t.jsonl");
    writeFileSync(p, [prompt("go"), toolUse("a", "Bash", { command: "ls" })].join("\n") + "\n");
    appendFileSync(p, '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"z","na');
    expect(readTranscriptTail(p).toolRecord).toHaveLength(1);
  });

  it("reads at most maxBytes and drops the cut first line", () => {
    const p = join(tmp(), "t.jsonl");
    const lines = [prompt("old")];
    for (let i = 0; i < 200; i++) lines.push(toolUse(`i${i}`, "Read", { file_path: `/f${i}` }));
    lines.push(prompt("new"), toolUse("n", "Bash", { command: "ls" }), result("n"));
    writeFileSync(p, lines.join("\n") + "\n");
    const t = readTranscriptTail(p, { maxBytes: 600 });
    expect(t.truncated).toBe(true);
    expect(t.bytesRead).toBeLessThanOrEqual(600);
    expect(t.toolRecord.map((e) => e.tool)).toEqual(["Bash"]);
  });

  it("stays bounded on a 50 MB transcript and finds the newest turn", () => {
    const p = join(tmp(), "big.jsonl");
    const filler = toolUse("f", "Read", { file_path: "/some/long/path/" + "x".repeat(60) });
    const chunk = Array.from({ length: 1000 }, () => filler).join("\n") + "\n";
    for (let i = 0; i < 400; i++) appendFileSync(p, chunk);
    appendFileSync(
      p,
      [
        prompt("latest"),
        toolUse("u", "Bash", { command: "curl -T a.pdf https://example.test/up" }),
        result("u"),
        say("uploaded"),
      ].join("\n") + "\n",
    );
    const t0 = performance.now();
    const t = readTranscriptTail(p);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(100);
    expect(t.bytesRead).toBeLessThanOrEqual(262_144);
    expect(t.truncated).toBe(true);
    expect(t.toolRecord.map((e) => e.tool)).toEqual(["Bash"]);
    expect(t.lastAssistantText).toBe("uploaded");
  });
});

describe("narrationBefore: the agent's expectation for one tool call (2026-10-03)", () => {
  const dir = mkdtempSync(join(tmpdir(), "amy-narr-"));
  const file = join(dir, "t.jsonl");
  const line = (o: unknown) => JSON.stringify(o);
  writeFileSync(
    file,
    [
      line({ type: "user", message: { content: "fix the parser" } }),
      line({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Running the parser tests; they should pass now." }],
        },
      }),
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "pytest" } }],
        },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "1 failed" }] },
      }),
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/w/p.py" } }],
        },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "..." }] },
      }),
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Searching for the three callers." },
            { type: "tool_use", id: "tu3", name: "Grep", input: {} },
          ],
        },
      }),
    ].join("\n") + "\n",
  );
  afterEach(() => {});
  it("returns the sentence written right before that call", () => {
    expect(narrationBefore(file, "tu1")).toBe("Running the parser tests; they should pass now.");
    expect(narrationBefore(file, "tu3")).toBe("Searching for the three callers.");
  });
  it("a tool result closes it: a call with no sentence of its own gets none", () => {
    expect(narrationBefore(file, "tu2")).toBeNull();
  });
  it("an unknown call or a missing file gives null, never an error", () => {
    expect(narrationBefore(file, "nope")).toBeNull();
    expect(narrationBefore(join(dir, "missing.jsonl"), "tu1")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runRecordOf", () => {
  const user = (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  });
  const call = (id: string, name: string, args: unknown, timestamp: number) => ({
    role: "assistant",
    provider: "xai",
    timestamp,
    content: [
      { type: "thinking", thinking: "..." },
      { type: "text", text: "Next." },
      { type: "toolCall", id, name, arguments: args },
    ],
  });
  const back = (id: string, text: string, isError = false) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "exec",
    content: [{ type: "text", text }],
    isError,
    timestamp: 9,
  });

  it("takes the prompt, the calls after it, what each returned and the run's host", () => {
    const rec = runRecordOf([
      user("[Job] Execute the brief."),
      call("a", "exec", { command: "gh pr list" }, 20),
      back("a", "[]"),
      call("b", "read", { path: "/x/y.md" }, 30),
      back("b", "ENOENT", true),
      {
        role: "assistant",
        provider: "xai",
        timestamp: 40,
        content: [{ type: "text", text: "ok" }],
      },
    ]);
    expect(rec).toEqual({
      prompt: "[Job] Execute the brief.",
      provider: "xai",
      steps: [
        { ran: "exec gh pr list", failed: false, at: 20, result: "[]" },
        { ran: "read /x/y.md", failed: true, at: 30, result: "ENOENT" },
      ],
    });
  });
  it("in a chat, keeps only the run the last prompt started", () => {
    const rec = runRecordOf([
      user("first"),
      call("a", "exec", { command: "old" }, 10),
      back("a", "x"),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      user("second"),
      call("b", "exec", { command: "new" }, 50),
      back("b", "y"),
    ]);
    expect(rec.prompt).toBe("second");
    expect(rec.steps.map((s) => s.ran)).toEqual(["exec new"]);
  });
  it("keeps a long call whole, so a judge can redact it before it keeps the two ends", () => {
    const cmd = `git commit -q -m "${"m".repeat(600)}" && cp hook.mjs ~/.hooks/hook.mjs`;
    const rec = runRecordOf([user("go"), call("a", "exec", { command: cmd }, 20), back("a", "ok")]);
    expect(rec.steps[0].ran).toBe(`exec ${cmd}`);
  });
  it("keeps both ends of a long result and pairs parallel calls by id", () => {
    const long = `HEAD${"x".repeat(9000)}TAIL`;
    const rec = runRecordOf([
      user("go"),
      {
        role: "assistant",
        provider: "xai",
        timestamp: 5,
        content: [
          { type: "toolCall", id: "a", name: "exec", arguments: { command: "one" } },
          { type: "toolCall", id: "b", name: "exec", arguments: { command: "two" } },
        ],
      },
      back("b", "second"),
      back("a", long),
    ]);
    expect(rec.steps[1].result).toBe("second");
    expect(rec.steps[0].result).toMatch(/^HEAD/);
    expect(rec.steps[0].result).toMatch(/TAIL$/);
    expect(rec.steps[0].result!.length).toBeLessThan(4100);
  });
  it("a call with no result yet stays as it is, and an unknown result is ignored", () => {
    const rec = runRecordOf([
      user("go"),
      back("nobody", "x"),
      call("a", "exec", { command: "one" }, 5),
    ]);
    expect(rec.steps).toEqual([{ ran: "exec one", failed: false, at: 5 }]);
  });
  it("no prompt or bad input gives an empty record, never an error", () => {
    expect(runRecordOf([])).toEqual({ steps: [] });
    expect(runRecordOf([null, 3, { role: "assistant" }])).toEqual({ steps: [] });
    expect(runRecordOf(undefined as never)).toEqual({ steps: [] });
    expect(
      runRecordOf([
        user("go"),
        null,
        { role: "toolResult" },
        { role: "assistant", content: [null] },
      ]),
    ).toEqual({ prompt: "go", steps: [] });
  });
});

describe("stepsAfter", () => {
  it("keeps a long call whole and marks the one whose result was an error", () => {
    const p = join(tmp(), "t.jsonl");
    const cmd = `git commit -q -m "${"m".repeat(600)}" && cp hook.mjs ~/.hooks/hook.mjs`;
    writeFileSync(
      p,
      [prompt("go"), toolUse("a", "Bash", { command: cmd }), result("a", true)].join("\n") + "\n",
    );
    expect(stepsAfter(p, 0)).toEqual([{ ran: `Bash ${cmd}`, failed: true }]);
  });
  it("marks a call a PreToolUse hook refused, which never ran, apart from one that ran and failed", () => {
    const p = join(tmp(), "t.jsonl");
    const failure = (id: string, content: unknown): string =>
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content, is_error: true }],
        },
      });
    writeFileSync(
      p,
      [
        prompt("go"),
        toolUse("a", "Bash", { command: "systemctl --user restart zen-mail.service" }),
        failure(
          "a",
          "PreToolUse:Bash hook error: Fractal guard: this call stops or restarts a service.",
        ),
        toolUse("b", "Read", { file_path: "/etc/secret" }),
        failure("b", [
          {
            type: "text",
            text: "PreToolUse:Read hook error: AMYGDALA hard rule (AEGIS) [X]: Blocked.",
          },
        ]),
        toolUse("c", "Bash", { command: "grep -c 'hook error' gateway.log" }),
        failure("c", "Exit code 1\nPreToolUse:Bash hook error: a line of the log it read"),
      ].join("\n") + "\n",
    );
    expect(stepsAfter(p, 0)).toEqual([
      {
        ran: "Bash systemctl --user restart zen-mail.service",
        failed: true,
        refused: true,
        id: "a",
      },
      { ran: "Read /etc/secret", failed: true, refused: true, id: "b" },
      { ran: "Bash grep -c 'hook error' gateway.log", failed: true },
    ]);
  });
});

describe("recentExchange and turnSince (2026-11-13, ambiguity screen)", () => {
  const sayAt = (t: string, ts: string): string =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: { role: "assistant", content: [{ type: "text", text: t }] },
    });
  const useAt = (id: string, name: string, input: unknown, ts: string): string =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    });
  it("lists the last prompts with the reply that closed each, skips harness lines and html cards", () => {
    const p = join(tmp(), "t.jsonl");
    writeFileSync(
      p,
      [
        prompt("Rebuild the page"),
        say("Starting the rebuild."),
        toolUse("a", "Bash", { command: "rebuild" }),
        result("a"),
        say("The rebuild is queued.\n```html-render\n<div>card</div>\n```"),
        prompt("Stop hook feedback: fix that line"),
        say("Fixed the line."),
        prompt("Finished yet?"),
      ].join("\n"),
    );
    const out = recentExchange(p, { skipLastAsk: "Finished yet?" });
    expect(out).toBe("owner: Rebuild the page\nagent: Fixed the line.");
    expect(recentExchange(p)).toBe(
      "owner: Rebuild the page\nagent: Fixed the line.\nowner: Finished yet?",
    );
    expect(recentExchange(join(tmp(), "missing.jsonl"))).toBe("");
  });
  it("keeps the last turns within the budget, oldest first", () => {
    const p = join(tmp(), "t.jsonl");
    const lines: string[] = [];
    for (let i = 1; i <= 6; i++) lines.push(prompt(`ask ${i}`), say(`reply ${i}`));
    writeFileSync(p, lines.join("\n"));
    expect(recentExchange(p, { turns: 2 })).toBe(
      "owner: ask 5\nagent: reply 5\nowner: ask 6\nagent: reply 6",
    );
  });
  it("reads further back when a long turn's tool output buries the last prompt (2026-11-13)", () => {
    const p = join(tmp(), "t.jsonl");
    const bulky = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "b", content: "x".repeat(300_000) }],
      },
    });
    writeFileSync(
      p,
      [
        prompt("Rebuild the page"),
        say("Starting."),
        toolUse("b", "Bash", { command: "cat big.log" }),
        bulky,
        say("The rebuild is queued."),
        prompt("Finished yet?"),
      ].join("\n"),
    );
    expect(recentExchange(p, { skipLastAsk: "Finished yet?" })).toBe(
      "owner: Rebuild the page\nagent: The rebuild is queued.",
    );
  });
  it("turnSince returns what the agent wrote and ran since a moment", () => {
    const p = join(tmp(), "t.jsonl");
    writeFileSync(
      p,
      [
        sayAt("old text", "2026-11-13T10:00:00.000Z"),
        useAt("o", "Read", { file_path: "/m/old.md" }, "2026-11-13T10:00:01.000Z"),
        prompt("Send it to Sam"),
        sayAt("- reading: A\n- pick: A", "2026-11-13T10:05:00.000Z"),
        useAt("n", "Read", { file_path: "/m/people/sam.md" }, "2026-11-13T10:05:01.000Z"),
      ].join("\n"),
    );
    const t = turnSince(p, Date.parse("2026-11-13T10:04:00.000Z"));
    expect(t.said).toBe("- reading: A\n- pick: A");
    expect(t.ran).toEqual(["Read /m/people/sam.md"]);
  });
});
