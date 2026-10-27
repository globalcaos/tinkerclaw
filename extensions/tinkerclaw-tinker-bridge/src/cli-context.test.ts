import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CallCompositionKey,
  CALL_COMPOSITION_KEYS,
  estimateTokens,
} from "openclaw/plugin-sdk/fork-telemetry";
import { MORAL_CODE_MARKER } from "openclaw/plugin-sdk/state-paths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLI_CONTEXT_MAX_FIRST_READ_BYTES,
  cliContextFor,
  createCliContextReader,
  reconcileComposition,
  resetCliContextReadersForTest,
  splitMoralCode,
} from "./cli-context.js";

// FORK 2026-10-02 — the CLI transcript reader behind each cc-bridge call's `composition`
// (cli-context.ts). Every transcript here is SYNTHETIC: the record and field NAMES are the CLI's
// (claude CLI 2.1.287 transcripts), the text is made up. Lengths are multiples of 3.5 where a test
// reads a bucket's tokens, so the expected figures are easy to check by hand.

const CLOSE = "</moral_code>";
const FILLER = " The workspace notes describe the build, the tests and the release steps.";

/** Exactly `n` chars of prose-like text starting with `lead`. */
function sized(lead: string, n: number): string {
  let s = lead;
  while (s.length < n) {
    s += FILLER;
  }
  return s.slice(0, n);
}

/** A moral-code block of exactly `n` chars, tags included. */
function moral(n: number): string {
  return `${MORAL_CODE_MARKER}${sized("\nRule 1. Tell the truth.", n - MORAL_CODE_MARKER.length - CLOSE.length)}${CLOSE}`;
}

type Line = Record<string, unknown>;

const attachment = (type: string, fields: Record<string, unknown> = {}): Line => ({
  type: "attachment",
  attachment: { type, ...fields },
});
const userRecord = (content: unknown, extra: Record<string, unknown> = {}): Line => ({
  type: "user",
  isSidechain: false,
  message: { role: "user", content },
  ...extra,
});
const toolResult = (id: string, content: unknown): Line =>
  userRecord([{ type: "tool_result", tool_use_id: id, content }]);
/** One assistant message the way the CLI writes it: one record per content block, one message.id. */
const assistant = (
  id: string,
  blocks: Array<Record<string, unknown>>,
  usage?: Record<string, number>,
  model = "claude-opus-5-5",
): Line[] =>
  blocks.map((block) => ({
    type: "assistant",
    isSidechain: false,
    message: { id, role: "assistant", model, content: [block], ...(usage ? { usage } : {}) },
  }));
const usageOf = (input: number, cacheRead: number, cacheWrite: number) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: 1,
});

const jsonl = (lines: Line[]) => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-context-"));
  resetCliContextReadersForTest();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let fileCount = 0;
function writeTranscript(lines: Line[]): string {
  const file = path.join(dir, `session-${fileCount++}.jsonl`);
  fs.writeFileSync(file, jsonl(lines));
  return file;
}

/** A reader over `lines`, refreshed once; its itemised tokens. */
function itemise(lines: Line[]) {
  const reader = createCliContextReader(writeTranscript(lines));
  reader.refresh();
  const result = reader.itemised();
  if (!result) {
    throw new Error("nothing itemised");
  }
  return result;
}

const zeros = Object.fromEntries(CALL_COMPOSITION_KEYS.map((k) => [k, 0])) as Record<
  CallCompositionKey,
  number
>;

describe("cli-context: the buckets", () => {
  it("maps every attachment type the CLI sends to its bucket", () => {
    const filesWithout = { path: "/ws/NOTES.md", type: "Project" };
    const addedLines = ["mcp__jarvis__browser", "mcp__jarvis__tts"];
    const addedBlocks = ["## jarvis\nUse the jarvis tools for messages and voice."];
    const date = attachment("date", { date: "2026-10-02" });
    const { tokens, r0 } = itemise([
      attachment("prompt_snapshot", {
        systemPrompt: [
          sized("You are Jarvis.", 700),
          { type: "text", text: sized("## Tools", 350) },
        ],
      }),
      attachment("instructions", {
        files: [
          { path: "/ws/AGENTS.md", type: "Project", content: sized("# Agents", 700) },
          filesWithout,
        ],
      }),
      attachment("skill_listing", {
        content: sized("- review: review a diff", 350),
        skillCount: 1,
      }),
      attachment("deferred_tools_delta", { addedNames: addedLines, addedLines }),
      attachment("mcp_instructions_delta", { addedNames: ["jarvis"], addedBlocks }),
      attachment("hook_additional_context", {
        content: [sized("Workspace status: clean.", 350)],
        hookName: "SessionStart",
        hookEvent: "SessionStart",
      }),
      // The hook's raw stdout never reaches the model, and a PostToolUse hook_success sends nothing.
      attachment("hook_success", {
        hookName: "SessionStart:startup",
        hookEvent: "SessionStart",
        content: "",
        stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: moral(7_000) } }),
      }),
      attachment("hook_success", {
        hookName: "SessionStart:startup",
        hookEvent: "SessionStart",
        content: sized("Loaded 3 notes.", 70),
      }),
      attachment("hook_success", {
        hookName: "PostToolUse:Edit",
        hookEvent: "PostToolUse",
        content: sized("Formatted the file.", 70),
      }),
      attachment("queued_command", { prompt: sized("Also check the logs", 70) }),
      date,
    ]);
    expect(r0).toBeUndefined();
    expect(tokens).toEqual({
      moralCode: 0,
      systemPrompt: 300,
      injectedFiles: estimateTokens(700 + JSON.stringify(filesWithout).length + 350 + 70),
      skills: 100,
      toolSchemas: estimateTokens(
        JSON.stringify(addedLines).length + JSON.stringify(addedBlocks).length,
      ),
      conversation: estimateTokens(JSON.stringify(date.attachment).length),
      toolResults: 0,
      userMessage: 20,
    });
  });

  it("splits the moral code out wherever it sits: hook context, system prompt, user prompt", () => {
    const text = `${sized("a", 70)}${moral(350)}${sized("b", 35)}${moral(70)}${sized("c", 35)}`;
    expect(splitMoralCode(text)).toEqual({ moral: 420, other: 140 });
    // No closing tag (the CLI's preview of an oversized hook output): the block runs to the end.
    expect(
      splitMoralCode(
        `${sized("Preview (first 2KB):", 70)}${MORAL_CODE_MARKER}${sized(" Rule", 63)}`,
      ),
    ).toEqual({
      moral: MORAL_CODE_MARKER.length + 63,
      other: 70,
    });
    // The marker JSON-escaped inside text that is itself JSON (source=\"tinkerclaw\") counts too.
    const escaped = JSON.stringify(moral(350)).slice(1, -1);
    expect(splitMoralCode(`${sized('{"context": "', 35)}${escaped}`)).toEqual({
      moral: escaped.length,
      other: 35,
    });

    const { tokens } = itemise([
      attachment("prompt_snapshot", { systemPrompt: [`${sized("Persona.", 350)}${moral(700)}`] }),
      attachment("hook_additional_context", {
        content: [`${sized("Status.", 70)}${moral(1_400)}`],
        hookEvent: "SessionStart",
      }),
      userRecord(`${moral(350)}${sized("Please check the build.", 70)}`),
    ]);
    expect(tokens.systemPrompt).toBe(100);
    expect(tokens.injectedFiles).toBe(20);
    expect(tokens.userMessage).toBe(20);
    expect(tokens.moralCode).toBe(estimateTokens(700 + 1_400 + 350));
  });

  it("replaces the system prompt (and its moral code) with each new snapshot", () => {
    const { tokens } = itemise([
      attachment("prompt_snapshot", {
        systemPrompt: [`${sized("Old persona.", 700)}${moral(700)}`],
      }),
      attachment("prompt_snapshot", { systemPrompt: [sized("New persona.", 350)] }),
    ]);
    expect(tokens.systemPrompt).toBe(100);
    expect(tokens.moralCode).toBe(0);
  });

  it("starts a new prompt on a real user message and moves the previous one into conversation", () => {
    const start = [
      userRecord(sized("Fix the failing test.", 70)),
      ...assistant("msg_1", [{ type: "text", text: sized("Looking.", 70) }]),
    ];
    expect(itemise(start).tokens).toMatchObject({ userMessage: 20, conversation: 20 });

    const later = itemise([
      ...start,
      // Meta text and text beside a tool_result are not prompts: conversation.
      userRecord([{ type: "text", text: sized("Skill body.", 35) }], { isMeta: true }),
      userRecord([
        { type: "tool_result", tool_use_id: "toolu_1", content: sized("ok", 35) },
        { type: "text", text: sized("Note beside a result.", 35) },
      ]),
      userRecord([{ type: "text", text: sized("Now the second one.", 35) }]),
      attachment("queued_command", { prompt: sized("And push nothing.", 70) }),
    ]);
    // conversation = first prompt 70 + reply 70 + meta 35 + side text 35.
    expect(later.tokens).toMatchObject({ conversation: 60, toolResults: 10, userMessage: 30 });

    const third = itemise([
      ...start,
      userRecord([{ type: "text", text: sized("Now the second one.", 35) }]),
      attachment("queued_command", { prompt: sized("And push nothing.", 70) }),
      userRecord(sized("Third.", 35)),
      userRecord(sized("Summary of the session so far.", 70), { isCompactSummary: true }),
    ]);
    // The second prompt and the queued one moved; the compaction summary is never the prompt.
    expect(third.tokens).toMatchObject({
      conversation: estimateTokens(140 + 35 + 70 + 70),
      userMessage: 10,
    });
  });

  it("counts tool results, tool_use input and thinking; skips images", () => {
    const input = { command: "pnpm test", description: "Run the tests" };
    const { tokens } = itemise([
      ...assistant("msg_1", [
        { type: "thinking", thinking: sized("Run the suite first.", 70), signature: "sig" },
        { type: "tool_use", id: "toolu_1", name: "Bash", input },
      ]),
      toolResult("toolu_1", sized("Tests: 12 passed", 350)),
      toolResult("toolu_2", [
        { type: "text", text: sized("Screenshot taken.", 70) },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
      ]),
    ]);
    expect(tokens.toolResults).toBe(120);
    expect(tokens.conversation).toBe(estimateTokens(70 + JSON.stringify(input).length));
  });

  it("skips malformed lines and sidechain records", () => {
    const file = path.join(dir, "malformed.jsonl");
    fs.writeFileSync(
      file,
      [
        "{not json",
        "[1, 2, 3]",
        "",
        JSON.stringify(attachment("skill_listing", { content: sized("- a skill", 350) })),
        JSON.stringify(userRecord(sized("Subagent prompt.", 700), { isSidechain: true })),
      ].join("\n") + "\n",
    );
    const reader = createCliContextReader(file);
    reader.refresh();
    expect(reader.itemised()?.tokens).toEqual({ ...zeros, skills: 100 });
  });
});

describe("cli-context: r0, the remainder the transcript never records", () => {
  const STATIC = [
    attachment("prompt_snapshot", { systemPrompt: [sized("You are Jarvis.", 700)] }),
    attachment("skill_listing", { content: sized("- review", 350) }),
    userRecord(sized("Hello.", 70)),
  ];

  it("is the first call's billed prompt minus everything itemised before its own blocks", () => {
    const { tokens, r0 } = itemise([
      ...STATIC,
      ...assistant(
        "msg_1",
        [
          { type: "thinking", thinking: sized("Hm.", 70) },
          { type: "text", text: sized("Hi.", 70) },
        ],
        usageOf(10, 1_000, 30),
      ),
      ...assistant("msg_2", [{ type: "text", text: sized("Later.", 35) }], usageOf(5, 90_000, 5)),
    ]);
    // 1,040 billed - (system 200 + skills 100 + prompt 20) = 720; the second call changes nothing.
    expect(r0).toBe(720);
    expect(tokens.toolSchemas).toBe(720);
    expect(tokens.conversation).toBe(estimateTokens(175));
  });

  it("is the composed call's own remainder on the session's first call, before the CLI wrote its record", () => {
    // Live, the first usage frame comes at message_start, before the CLI writes that call's
    // assistant record: the transcript holds no usage yet.
    const file = writeTranscript(STATIC);
    const reader = createCliContextReader(file);
    reader.refresh();
    expect(reader.itemised()?.r0).toBeUndefined();
    expect(reader.compose(1_040)).toEqual({
      ...zeros,
      systemPrompt: 200,
      skills: 100,
      toolSchemas: 720,
      userMessage: 20,
    });
    // Once the record is written, the file gives the same figure.
    fs.appendFileSync(
      file,
      jsonl(assistant("msg_1", [{ type: "text", text: sized("Hi.", 70) }], usageOf(10, 1_000, 30))),
    );
    reader.refresh();
    expect(reader.itemised()?.r0).toBe(720);
  });

  it("takes usage only from the first record of each message.id, and never from a synthetic one", () => {
    const { r0 } = itemise([
      ...STATIC,
      ...assistant(
        "msg_syn",
        [{ type: "text", text: "No response requested." }],
        usageOf(0, 0, 0),
        "<synthetic>",
      ),
      // The first record of msg_1 has no usage: the message is passed over even though the second does.
      ...assistant("msg_1", [{ type: "text", text: sized("Hi.", 70) }]),
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          usage: usageOf(1, 5_000, 0),
        },
      },
      ...assistant("msg_2", [{ type: "text", text: sized("Again.", 35) }], usageOf(1, 2_000, 0)),
    ]);
    // Before msg_2: 320 static + conversation ceil((22 + 70 + 1) / 3.5) = 27.
    expect(r0).toBe(2_001 - 320 - estimateTokens(22 + 70 + 1));
  });

  it("survives a compaction, which resets every bucket but the system prompt snapshot", () => {
    const { tokens, r0 } = itemise([
      attachment("prompt_snapshot", { systemPrompt: [`${sized("Persona.", 700)}${moral(350)}`] }),
      attachment("skill_listing", { content: sized("- review", 350) }),
      attachment("hook_additional_context", { content: [moral(700)], hookEvent: "SessionStart" }),
      userRecord(sized("Hello.", 70)),
      ...assistant("msg_1", [{ type: "text", text: sized("Hi.", 70) }], usageOf(0, 2_000, 0)),
      toolResult("toolu_1", sized("output", 350)),
      {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens: 2_100 },
      },
      userRecord(sized("Summary.", 70), { isCompactSummary: true }),
    ]);
    // r0 = 2,000 - (system 200 + moral 300 + skills 100 + prompt 20).
    expect(r0).toBe(1_380);
    expect(tokens).toEqual({
      ...zeros,
      systemPrompt: 200,
      moralCode: 100,
      toolSchemas: 1_380,
      conversation: 20,
    });
  });
});

describe("cli-context: incremental reads", () => {
  const LINES = [
    attachment("prompt_snapshot", { systemPrompt: [sized("You are Jarvis.", 700)] }),
    userRecord(`${sized("Café check", 69)}✓`),
    ...assistant("msg_1", [{ type: "text", text: sized("Done.", 70) }], usageOf(3, 900, 0)),
    toolResult("toolu_1", sized("result", 350)),
  ];

  it("reads only what was appended, keeping a line split mid-character for the next refresh", () => {
    const whole = Buffer.from(jsonl(LINES));
    const file = path.join(dir, "growing.jsonl");
    // Cut inside the 3-byte "✓" of the second line.
    const cut = whole.indexOf(Buffer.from("✓")) + 1;
    fs.writeFileSync(file, whole.subarray(0, cut));
    const reader = createCliContextReader(file);
    reader.refresh();
    expect(reader.itemised()?.tokens).toEqual({ ...zeros, systemPrompt: 200 });

    fs.appendFileSync(file, whole.subarray(cut));
    reader.refresh();
    reader.refresh(); // nothing new: nothing counted twice

    const oneShot = createCliContextReader(writeTranscript(LINES));
    oneShot.refresh();
    expect(reader.itemised()).toEqual(oneShot.itemised());
    expect(reader.itemised()?.tokens).toMatchObject({ userMessage: 20, toolResults: 100 });
  });

  it("reads a file that shrank again from the start", () => {
    const file = writeTranscript(LINES);
    const reader = createCliContextReader(file);
    reader.refresh();
    const shorter = [attachment("skill_listing", { content: sized("- review", 350) })];
    fs.writeFileSync(file, jsonl(shorter));
    reader.refresh();
    expect(reader.itemised()).toEqual({ tokens: { ...zeros, skills: 100 }, r0: undefined });
  });

  it("throws nothing and composes nothing for a missing file, then reads it once it appears", () => {
    const file = path.join(dir, "not-yet.jsonl");
    const reader = createCliContextReader(file);
    expect(() => reader.refresh()).not.toThrow();
    expect(reader.compose(1_000)).toBeUndefined();
    fs.writeFileSync(file, jsonl(LINES));
    reader.refresh();
    expect(reader.compose(1_000)).toBeDefined();
  });

  it("skips a transcript over 64 MB on the first read", () => {
    const file = writeTranscript(LINES);
    fs.truncateSync(file, CLI_CONTEXT_MAX_FIRST_READ_BYTES + 1); // sparse: cheap to make
    const reader = createCliContextReader(file);
    reader.refresh();
    expect(reader.itemised()).toBeUndefined();
    expect(reader.compose(5_000)).toBeUndefined();
  });

  it("keeps one reader per transcript path, at most 32", () => {
    const first = cliContextFor(path.join(dir, "a.jsonl"));
    expect(cliContextFor(path.join(dir, "a.jsonl"))).toBe(first);
    for (let i = 0; i < 32; i++) {
      cliContextFor(path.join(dir, `other-${i}.jsonl`));
    }
    expect(cliContextFor(path.join(dir, "a.jsonl"))).not.toBe(first);
  });
});

describe("cli-context: compose", () => {
  const SESSION = [
    attachment("prompt_snapshot", {
      systemPrompt: [`${sized("You are Jarvis.", 700)}${moral(350)}`],
    }),
    attachment("skill_listing", { content: sized("- review", 350) }),
    userRecord(sized("Fix the build.", 70)),
    ...assistant("msg_1", [{ type: "text", text: sized("On it.", 140) }], usageOf(0, 1_000, 0)),
    toolResult("toolu_1", sized("error: missing semicolon", 210)),
  ];
  // Itemised: system 200, moral 100, skills 100, r0 = 1,000 - 420 = 580,
  // conversation 40, toolResults 60, userMessage 20 → 1,100.
  const reader = () => {
    const r = createCliContextReader(writeTranscript(SESSION));
    r.refresh();
    return r;
  };

  it("returns all 8 keys, summing to the billed prompt exactly", () => {
    const r = reader();
    for (const billed of [1_100, 1_101, 1_337, 25_013, 999, 400, 1]) {
      const composition = r.compose(billed);
      expect(Object.keys(composition ?? {}).toSorted()).toEqual(
        [...CALL_COMPOSITION_KEYS].toSorted(),
      );
      expect(Object.values(composition ?? {}).reduce((a, b) => a + b, 0)).toBe(billed);
    }
    expect(r.compose(1_100)).toEqual({
      moralCode: 100,
      systemPrompt: 200,
      injectedFiles: 0,
      skills: 100,
      toolSchemas: 580,
      conversation: 40,
      toolResults: 60,
      userMessage: 20,
    });
  });

  it("puts a positive residual only on conversation, toolResults and userMessage, in proportion", () => {
    // Residual 1,200 over 40 / 60 / 20.
    expect(reader().compose(2_300)).toEqual({
      moralCode: 100,
      systemPrompt: 200,
      injectedFiles: 0,
      skills: 100,
      toolSchemas: 580,
      conversation: 440,
      toolResults: 660,
      userMessage: 220,
    });
    const allStatic = { ...zeros, systemPrompt: 300, toolSchemas: 200 };
    expect(reconcileComposition(allStatic, 650)).toEqual({ ...allStatic, conversation: 150 });
  });

  it("takes a negative residual off the dynamic buckets first, then scales every bucket", () => {
    // Deficit 60 off 40 / 60 / 20.
    expect(reader().compose(1_040)).toMatchObject({
      moralCode: 100,
      systemPrompt: 200,
      skills: 100,
      toolSchemas: 580,
      conversation: 20,
      toolResults: 30,
      userMessage: 10,
    });
    // Deficit 650 > 120: every bucket × 450 / 1,100.
    const scaled = reader().compose(450);
    expect(scaled).toEqual({
      moralCode: 41,
      systemPrompt: 82,
      injectedFiles: 0,
      skills: 41,
      toolSchemas: 237,
      conversation: 16,
      toolResults: 25,
      userMessage: 8,
    });
  });

  it("reports a moral code that is absent as a measured 0", () => {
    const r = createCliContextReader(
      writeTranscript([attachment("prompt_snapshot", { systemPrompt: [sized("Persona.", 700)] })]),
    );
    r.refresh();
    // A first call: what the transcript does not itemise is r0, in toolSchemas.
    expect(r.compose(500)).toEqual({ ...zeros, systemPrompt: 200, toolSchemas: 300 });
  });

  it("composes nothing for a billed prompt that is not > 0, or a transcript with no records", () => {
    const r = reader();
    expect(r.compose(0)).toBeUndefined();
    expect(r.compose(-5)).toBeUndefined();
    expect(r.compose(Number.NaN)).toBeUndefined();
    const empty = createCliContextReader(writeTranscript([]));
    empty.refresh();
    expect(empty.compose(1_000)).toBeUndefined();
  });
});
