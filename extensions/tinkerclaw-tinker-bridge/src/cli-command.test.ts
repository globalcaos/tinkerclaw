import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FORK 2026-09-25 (TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1 A6 (i)) — a turn whose user
// text IS `/compact` reaches the claude CLI as that command.
//
// CONTROL. Before this change `./cli-command.js` does not exist, so this file fails to import and
// every case is red. What each group pins, as the tree behaved before it:
//   - worker.send wrote the moral-code prefix + the wrapped text, so the CLI read prose, no command;
//   - worker.steer folded `/compact` into the live turn as prose;
//   - the stream fn appended the chat-row contract (it would have become the compaction's
//     instructions), and a text-less command turn ended with content [] — an EMPTY RESPONSE to the
//     embedded runner (a retry prompt, then "Agent couldn't generate a response");
//   - the watchdog SIGTERMed a silent `/compact` turn at the 90 s init window (fast-fail-init-stall).
//
// The stream fn runs end to end against a fake worker pool (the harness of
// stream.compact-boundary.test.ts); the worker tests drive the real ClaudeCodeWorker with a fake
// stdin (the idiom of worker.steer.test.ts: the constructor spawns nothing).
const harness = vi.hoisted(() => {
  type StreamLineListener = (evt: { type: string; line: unknown }) => void;
  const state: { lines: unknown[]; sent: string[]; gate: Promise<void> | null } = {
    lines: [],
    sent: [],
    gate: null,
  };
  const kill = vi.fn();
  const makeWorker = () => {
    const listeners = new Set<StreamLineListener>();
    return {
      thinkLevel: undefined as string | undefined,
      on: (_event: string, listener: StreamLineListener) => {
        listeners.add(listener);
      },
      off: (_event: string, listener: StreamLineListener) => {
        listeners.delete(listener);
      },
      kill,
      // Like worker.ts: record what would be written, then replay the CLI's lines (the `result`
      // line included) as stream_line events and resolve with that result line.
      send: async (params: { userText: string }) => {
        state.sent.push(params.userText);
        if (state.gate) {
          await state.gate;
        }
        for (const line of state.lines) {
          for (const listener of listeners) {
            listener({ type: "stream_line", line });
          }
        }
        return state.lines.find((line) => (line as { type?: unknown }).type === "result");
      },
    };
  };
  return { state, kill, makeWorker, emitCompactionTelemetry: vi.fn() };
});

vi.mock("./worker-pool.js", () => ({
  getPool: () => ({
    getOrCreate: () => harness.makeWorker(),
    takeThinkLevelPending: () => undefined,
  }),
}));

// The A1 owner's emitter is stubbed so no test writes a compaction ledger row.
vi.mock("openclaw/plugin-sdk/fork-telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fork-telemetry")>()),
  emitCompactionTelemetry: (...args: unknown[]) => harness.emitCompactionTelemetry(...args),
}));

import {
  CHAT_ROW_CONTRACT_MARKER,
  describeCliCommandOutcome,
  extractCliCommand,
} from "./cli-command.js";
import { FAST_FAIL_INIT_SILENT_MS } from "./defaults.js";
import type { CcStreamStdoutLine } from "./protocol.js";
import {
  createClaudeCodeStreamFn,
  createCompactionLineReader,
  shouldFastFailInitStall,
} from "./stream.js";
import { ClaudeCodeWorker } from "./worker.js";
import type { WorkerSpawnParams } from "./worker.js";

const SESSION = "00000000-0000-4000-8000-000000000025";
// The gateway's stamp, as injectTimestamp writes it on chat.send (measured on live Tinker rows).
const STAMP = "[Fri 2026-09-25 10:00 GMT+2] ";
// The Tinker UI's per-turn injection as buildInjectedPrompt writes it (tinker-ui/src/app.ts); the
// doctrine body is abridged, since only its opener and its one `---` rule decide anything here.
const UI_FRACTAL_SUFFIX =
  "\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** on its own line (blank line before it). This is the doctrine that governs it:\n\n" +
  "# 🌿 FRACTAL\n\nYou are the reflection layer.";
// The bridge's own chat-row contract, as stream.ts appends it (opening lines).
const CHAT_ROW_SUFFIX = [
  "",
  "",
  CHAT_ROW_CONTRACT_MARKER,
  "Before EVERY tool call in your response, emit one assistant text",
].join("\n");

const asLine = (value: Record<string, unknown>): CcStreamStdoutLine => value as CcStreamStdoutLine;
const INIT = asLine({
  type: "system",
  subtype: "init",
  session_id: SESSION,
  model: "claude-opus-5",
});
const COMPACTING = asLine({
  type: "system",
  subtype: "status",
  status: "compacting",
  session_id: SESSION,
});
// Field NAMES from §6.0 (b); the numbers are synthetic.
const BOUNDARY = asLine({
  type: "system",
  subtype: "compact_boundary",
  session_id: SESSION,
  compact_metadata: {
    trigger: "manual",
    pre_tokens: 167_500,
    post_tokens: 21_300,
    duration_ms: 142_000,
  },
});
// A command turn's `result` with no text: a shape a local command may end on (UNVERIFIED live, U3).
const EMPTY_RESULT = asLine({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  num_turns: 0,
  duration_ms: 142_500,
  session_id: SESSION,
  usage: { input_tokens: 0, output_tokens: 0 },
});
const COMPACTED_LINE = "⚙️ Compacted the Claude CLI's context (167.5k → 21.3k tokens, 2m 22s).";

const MODEL = { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5" };

/** Starts one turn through the real stream fn against the fake worker above. */
function startTurn(userContent: string, lines: CcStreamStdoutLine[]) {
  harness.state.lines = lines;
  return createClaudeCodeStreamFn()(
    MODEL as never,
    {
      systemPrompt: "cli-command test",
      messages: [{ role: "user", content: userContent }],
    } as never,
    { __openclawRunId: "run-cli-command", __openclawSessionKey: "agent:main:main" } as never,
  );
}

beforeEach(() => {
  harness.state.lines = [];
  harness.state.sent = [];
  harness.state.gate = null;
  harness.kill.mockClear();
  harness.emitCompactionTelemetry.mockClear();
});

describe("extractCliCommand (A6 (i), pure)", () => {
  it.each([
    ["bare", "/compact", "/compact"],
    ["owner instructions kept", "/compact keep the ORCA plan", "/compact keep the ORCA plan"],
    ["the gateway's stamp", `${STAMP}/compact`, "/compact"],
    ["the UI's fractal injection", `/compact${UI_FRACTAL_SUFFIX}`, "/compact"],
    ["the bridge's chat-row contract", `/compact${CHAT_ROW_SUFFIX}`, "/compact"],
    [
      "all three wrappers: instructions kept, doctrine dropped",
      `${STAMP}/compact keep the ORCA plan${UI_FRACTAL_SUFFIX}${CHAT_ROW_SUFFIX}`,
      "/compact keep the ORCA plan",
    ],
    [
      "multi-line owner instructions",
      `${STAMP}/compact keep the plan\nand the open bugs${UI_FRACTAL_SUFFIX}`,
      "/compact keep the plan\nand the open bugs",
    ],
    [
      "dashes inside the instructions",
      `/compact use --- markers${UI_FRACTAL_SUFFIX}`,
      "/compact use --- markers",
    ],
    [
      "a stacked recipe block",
      `/compact${UI_FRACTAL_SUFFIX}\n\n---\n\n<active_recipe title="x" path="/r.md">`,
      "/compact",
    ],
    ["the gateway's colon form", "/compact: keep the plan", "/compact keep the plan"],
    ["any case in, the canonical name out", "/COMPACT", "/compact"],
  ])("%s", (_label, input, expected) => {
    expect(extractCliCommand(input)).toBe(expected);
    // Idempotent: worker.send asks again on the bare line the stream fn already unwrapped.
    expect(extractCliCommand(expected)).toBe(expected);
  });

  it.each([
    ["prose", "how do I compact this?"],
    ["prose that mentions the command", "please /compact"],
    ["a longer word", "/compacting the logs was a mistake"],
    ["another slash command (closed allowlist)", "/new"],
    ["another slash command with arguments", "/model opus"],
    ["a bracket that is not the stamp", "[draft] /compact"],
    ["a channel envelope", "[WhatsApp Fri 2026-09-25 10:00 GMT+2] /compact"],
    ["another agent's message", `${STAMP}⟦AGENT⟧ /compact`],
    [
      "an appended block it does not recognise",
      `/compact\n\n---\n\nalso remember the auth work${UI_FRACTAL_SUFFIX}`,
    ],
    ["empty", ""],
    ["not a string", undefined],
  ])("%s → null", (_label, input) => {
    expect(extractCliCommand(input)).toBeNull();
  });
});

describe("describeCliCommandOutcome (A6 (i), pure)", () => {
  it("quotes the CLI's own figures when the boundary arrived, and drops its status text", () => {
    expect(
      describeCliCommandOutcome({
        command: "/compact keep the plan",
        compaction: {
          completed: true,
          tokensBefore: 167_500,
          tokensAfter: 21_300,
          durationMs: 142_000,
        },
        resultText: "Compacted (ctrl+o to see full summary)",
        isError: false,
      }),
    ).toBe(COMPACTED_LINE);
  });

  it("claims no figure the boundary did not carry", () => {
    expect(
      describeCliCommandOutcome({
        command: "/compact",
        compaction: { completed: true, tokensBefore: 1_010_000 },
        resultText: "",
        isError: false,
      }),
    ).toBe("⚙️ Compacted the Claude CLI's context (1.01M tokens before).");
    expect(
      describeCliCommandOutcome({
        command: "/compact",
        compaction: { completed: true },
        resultText: "",
        isError: false,
      }),
    ).toBe("⚙️ Compacted the Claude CLI's context.");
  });

  it("says a failed compaction failed, in the CLI's words when it gave any", () => {
    expect(
      describeCliCommandOutcome({
        command: "/compact",
        compaction: { completed: false },
        resultText: "",
        isError: true,
      }),
    ).toBe("⚙️ The Claude CLI's compaction failed.");
    expect(
      describeCliCommandOutcome({
        command: "/compact",
        compaction: { completed: false },
        resultText: "synthetic",
        isError: true,
      }),
    ).toBe("⚙️ The Claude CLI's compaction failed: synthetic");
  });

  it("passes the CLI's own words through when no compaction ran, and never answers with nothing", () => {
    expect(
      describeCliCommandOutcome({
        command: "/compact",
        compaction: null,
        resultText: " Not enough messages to compact.\n",
        isError: false,
      }),
    ).toBe("⚙️ /compact: Not enough messages to compact.");
    expect(
      describeCliCommandOutcome({
        command: "/compact",
        compaction: null,
        resultText: "",
        isError: false,
      }),
    ).toBe("⚙️ /compact finished, but the Claude CLI reported no compaction.");
    expect(
      describeCliCommandOutcome({
        command: "/compact",
        compaction: null,
        resultText: "",
        isError: true,
      }),
    ).toBe("⚙️ /compact failed in the Claude CLI, which returned no detail.");
  });
});

describe("the fast-fail spares a compaction (A6 (i), pure)", () => {
  it("never fast-fails while compacting; the init-wedge rule is otherwise unchanged", () => {
    const wedge = {
      elapsedMs: FAST_FAIL_INIT_SILENT_MS + 30_000,
      textLen: 0,
      thinkingLen: 0,
      linesSeen: 3,
    };
    expect(shouldFastFailInitStall(wedge)).toBe(true);
    expect(shouldFastFailInitStall({ ...wedge, compacting: false })).toBe(true);
    expect(shouldFastFailInitStall({ ...wedge, compacting: true })).toBe(false);
  });

  it("the compaction reader holds its latch from `compacting` to the boundary", () => {
    const reader = createCompactionLineReader();
    expect(reader.isCompacting()).toBe(false);
    reader.read(COMPACTING);
    expect(reader.isCompacting()).toBe(true);
    reader.read(BOUNDARY);
    expect(reader.isCompacting()).toBe(false);
  });
});

describe("the stream fn sends a /compact turn bare and answers it (A6 (i))", () => {
  it("writes only the command: no stamp, no doctrine, no chat-row contract", async () => {
    const stream = await startTurn(`${STAMP}/compact${UI_FRACTAL_SUFFIX}`, [
      INIT,
      COMPACTING,
      BOUNDARY,
      EMPTY_RESULT,
    ]);
    await stream.result();
    expect(harness.state.sent).toEqual(["/compact"]);
  });

  it("completes an empty-result compaction turn with the CLI's own figures, not an error or an empty reply", async () => {
    const stream = await startTurn(`${STAMP}/compact`, [INIT, COMPACTING, BOUNDARY, EMPTY_RESULT]);
    const message = await stream.result();
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: COMPACTED_LINE }]);
  });

  it("still answers when the CLI reported no compaction at all", async () => {
    const stream = await startTurn("/compact", [INIT, EMPTY_RESULT]);
    const message = await stream.result();
    expect(message.content).toEqual([
      { type: "text", text: "⚙️ /compact finished, but the Claude CLI reported no compaction." },
    ]);
  });

  it("leaves a prose turn as it was: the chat-row contract rides along (control)", async () => {
    const stream = await startTurn(`${STAMP}hi`, [INIT, EMPTY_RESULT]);
    await stream.result();
    expect(harness.state.sent).toHaveLength(1);
    expect(harness.state.sent[0].startsWith(`${STAMP}hi`)).toBe(true);
    expect(harness.state.sent[0]).toContain(CHAT_ROW_CONTRACT_MARKER);
  });
});

describe("the watchdog does not SIGTERM a /compact turn (A6 (i))", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** One turn whose CLI stays silent past the init window, then ends. Returns the kill calls. */
  async function silentTurn(userContent: string): Promise<unknown[][]> {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    harness.state.gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const stream = await startTurn(userContent, [INIT, EMPTY_RESULT]);
    await vi.advanceTimersByTimeAsync(FAST_FAIL_INIT_SILENT_MS + 30_000);
    const kills = [...harness.kill.mock.calls];
    release();
    await stream.result();
    return kills;
  }

  it("lets a silent /compact turn run past the 90 s init window", async () => {
    expect(await silentTurn(`${STAMP}/compact${UI_FRACTAL_SUFFIX}`)).toEqual([]);
  });

  it("still fast-fails a silent prose turn (control)", async () => {
    expect(await silentTurn(`${STAMP}hi`)).toEqual([["SIGTERM", "fast-fail-init-stall"]]);
  });
});

function liveWorker(pendingMoralCode: string | null) {
  const worker = new ClaudeCodeWorker({ sessionKey: "k", cwd: "/tmp" } as WorkerSpawnParams);
  const writes: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
  const w = worker as any;
  w.proc = { stdin: { write: (s: string) => writes.push(s) } };
  w.running = true;
  w.sessionId = SESSION;
  w.pendingMoralCodePrefix = pendingMoralCode;
  return { worker, w, writes };
}

const resultChunk = (result: string): string =>
  `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: SESSION })}\n`;

describe("ClaudeCodeWorker writes a CLI command as that command (A6 (i))", () => {
  it("sends the bare /compact line and leaves the moral code owed to the next real turn", async () => {
    const { worker, w, writes } = liveWorker("MORAL CODE");
    const compact = worker.send({
      userText: `${STAMP}/compact keep the plan${UI_FRACTAL_SUFFIX}${CHAT_ROW_SUFFIX}`,
    });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual({
      type: "user",
      message: { role: "user", content: "/compact keep the plan" },
      session_id: SESSION,
    });
    expect(w.pendingMoralCodePrefix).toBe("MORAL CODE");
    // An empty `result` ends the command turn like any other.
    w.onStdoutChunk(resultChunk(""));
    await expect(compact).resolves.toMatchObject({ type: "result", result: "" });

    // The next conversation turn pays the owed moral code, once.
    const next = worker.send({ userText: "hola" });
    expect(JSON.parse(writes[1]).message.content).toBe("MORAL CODE\n\nhola");
    expect(w.pendingMoralCodePrefix).toBeNull();
    w.onStdoutChunk(resultChunk("hola"));
    await next;
  });

  it("steer refuses a command into a live turn, writes nothing, and still steers prose", () => {
    const { worker, w, writes } = liveWorker(null);
    w.currentTurn = { resolve() {}, reject() {}, aborted: false };
    expect(worker.steer(`${STAMP}/compact`)).toBe(false);
    expect(writes).toHaveLength(0);
    expect(worker.steer("also check the logs")).toBe(true);
    expect(writes).toHaveLength(1);
  });
});
