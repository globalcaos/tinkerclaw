import { describe, expect, it, vi } from "vitest";

// Drives whole turns through the real stream fn against a fake worker pool (the same harness
// as stream.compact-boundary.test.ts): every line goes out as a stream_line, then send()
// resolves with the result line.
const harness = vi.hoisted(() => {
  type StreamLineListener = (evt: { type: string; line: unknown }) => void;
  const state: { lines: unknown[] } = { lines: [] };
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
      kill: () => undefined,
      send: async () => {
        for (const line of state.lines) {
          for (const listener of [...listeners]) {
            listener({ type: "stream_line", line });
          }
        }
        return state.lines.find((line) => (line as { type?: unknown }).type === "result");
      },
    };
  };
  return { state, makeWorker };
});

vi.mock("./worker-pool.js", () => ({
  getPool: () => ({
    getOrCreate: () => harness.makeWorker(),
    takeThinkLevelPending: () => undefined,
  }),
}));

import { decideChannelReply } from "./channel-reply.js";
import type { CcStreamStdoutLine } from "./protocol.js";
import { createClaudeCodeStreamFn } from "./stream.js";

// FORK 2026-10-02 (channel-reply). The 15:46 turn in the WhatsApp group "I've got special
// powers" (session agent:main:whatsapp:group:120363050081077836@g.us, runId fd6fbe22): the
// narration the model wrote before each of its 12 tool calls, then `NO_REPLY` after the
// message tool had already sent the GIF. The whole 1004-char text went to the group.
const NARRATION = [
  "Reading the gifgrep skill instructions to find a mic-drop GIF the right way.",
  'Searching Tenor/Giphy for "mic drop" GIFs to pick one for the group.',
  "Tenor's demo key returned 403; trying Giphy as the source instead.",
  `No GIF API keys are set, so I'll pull candidate IDs from Giphy's public search page for "mic drop".`,
  "The page downloaded but my pattern missed; looking for any giphy media IDs in the HTML with a looser match.",
  "The Obama mic drop (id `3o7qDSOvfaCO9b3MlO`) is the classic. Checking how the WhatsApp channel ships a GIF, so it arrives animated and not as a still.",
  "Only type stubs matched; looking inside the WhatsApp extension for what it does with a `.gif` or `gifPlayback` on send.",
  "",
  "",
  "Looking at the extracted frame to confirm it really is the Obama mic drop before it goes to the group.",
  'Right clip: Obama, "Obama out", 2.9 s. Loading the message tool so I can send it as an auto-looping GIF.',
  `Sending the mic-drop clip to the "I've got special powers" group as an auto-looping GIF, with no caption.`,
];
const RECORDED_OFFSETS = [76, 144, 210, 309, 416, 566, 685, 685, 685, 787, 891, 996];
const SESSION = "00000000-0000-4000-8000-000000000003";
const MODEL = { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5-5" };

const asLine = (value: Record<string, unknown>): CcStreamStdoutLine => value as CcStreamStdoutLine;

/** One API call per step: its narration (if any) and the tool it fires, then the tool's result. */
function toolLoopTurn(steps: string[], answer: string): CcStreamStdoutLine[] {
  const lines: CcStreamStdoutLine[] = [
    asLine({ type: "system", subtype: "init", session_id: SESSION, model: MODEL.id }),
  ];
  steps.forEach((narration, i) => {
    const toolId = `toolu_${String(i).padStart(2, "0")}`;
    const content: Array<Record<string, unknown>> = [];
    if (narration) {
      content.push({ type: "text", text: narration });
    }
    content.push({ type: "tool_use", id: toolId, name: "Bash", input: { command: "true" } });
    lines.push(
      asLine({
        type: "assistant",
        session_id: SESSION,
        message: { id: `msg_${i}`, role: "assistant", content },
      }),
      asLine({
        type: "user",
        session_id: SESSION,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolId, content: "ok", is_error: false }],
        },
      }),
    );
  });
  lines.push(
    asLine({
      type: "assistant",
      session_id: SESSION,
      message: { id: "msg_answer", role: "assistant", content: [{ type: "text", text: answer }] },
    }),
    asLine({
      type: "result",
      subtype: "success",
      is_error: false,
      result: answer,
      num_turns: steps.length + 1,
      duration_ms: 73_532,
      session_id: SESSION,
      usage: { input_tokens: 10, output_tokens: 3_957 },
    }),
  );
  return lines;
}

async function runTurn(params: {
  lines: CcStreamStdoutLine[];
  channel: string | undefined;
  sessionKey: string;
}) {
  harness.state.lines = params.lines;
  const streamFn = createClaudeCodeStreamFn();
  const stream = await streamFn(
    MODEL as never,
    { systemPrompt: "channel-reply test", messages: [{ role: "user", content: "hi" }] } as never,
    {
      __openclawRunId: `run-${params.sessionKey}`,
      __openclawSessionKey: params.sessionKey,
      __openclawMessageChannel: params.channel,
    } as never,
  );
  return (await stream.result()) as unknown as {
    content: Array<{ type: string; text?: string }>;
    channelReply?: unknown;
  };
}

const textOf = (message: { content: Array<{ type: string; text?: string }> }) =>
  message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");

describe("channel reply: the 15:46 mic-drop turn", () => {
  it("stamps a WhatsApp run whose text after the last tool is NO_REPLY as silent, text intact", async () => {
    const message = await runTurn({
      lines: toolLoopTurn(NARRATION, "NO_REPLY"),
      channel: "whatsapp",
      sessionKey: "agent:main:whatsapp:group:120363050081077836@g.us",
    });
    // The transcript keeps exactly what the stream produced: 1004 chars, narration included.
    expect(textOf(message)).toBe(`${NARRATION.join("")}NO_REPLY`);
    expect(textOf(message)).toHaveLength(1004);
    expect(message.channelReply).toStrictEqual({ kind: "silent", textLength: 1004 });
  });

  it("records the same offsets the live turn persisted", () => {
    const text = `${NARRATION.join("")}NO_REPLY`;
    expect(decideChannelReply({ text, toolTextOffsets: RECORDED_OFFSETS })).toStrictEqual({
      verdict: "silent",
      source: "silent-final-segment",
      stamp: { kind: "silent", textLength: 1004 },
      narrationChars: 996,
      finalChars: 8,
    });
  });

  it("stamps the final segment when the turn ends in a real answer", async () => {
    // The 16:36 reply in the same group: one narration sentence, one tool, then the joke.
    const narration =
      "Running the draft reply to Luís through the `human-voice` checker and noting what this group is like in its chat-profile notes file.";
    const answer = "Imposible, güey, no tengo boca, lo mío es soltar micrófonos 🎤";
    const message = await runTurn({
      lines: toolLoopTurn([narration], answer),
      channel: "whatsapp",
      sessionKey: "agent:main:whatsapp:group:120363050081077836@g.us",
    });
    expect(textOf(message)).toBe(`${narration}${answer}`);
    expect(message.channelReply).toStrictEqual({
      kind: "final",
      from: narration.length,
      textLength: narration.length + answer.length,
    });
  });

  it("leaves a webchat (Tinker) run unstamped", async () => {
    const message = await runTurn({
      lines: toolLoopTurn(NARRATION, "NO_REPLY"),
      channel: "webchat",
      sessionKey: "agent:main:tinker:channel-reply",
    });
    expect(textOf(message)).toHaveLength(1004);
    expect(message).not.toHaveProperty("channelReply");
  });

  it("leaves a run with no channel unstamped", async () => {
    const message = await runTurn({
      lines: toolLoopTurn(NARRATION, "NO_REPLY"),
      channel: undefined,
      sessionKey: "agent:main:main",
    });
    expect(message).not.toHaveProperty("channelReply");
  });
});

describe("decideChannelReply", () => {
  it("keeps the whole text when no tool ran", () => {
    expect(decideChannelReply({ text: "Just an answer.", toolTextOffsets: [] })).toMatchObject({
      verdict: "whole",
      source: "no-tool-calls",
    });
  });

  it("keeps the whole text when nothing was said before the tools", () => {
    const decision = decideChannelReply({ text: "Answer after tools.", toolTextOffsets: [0, 0] });
    expect(decision).toMatchObject({ verdict: "whole", source: "no-narration" });
    expect(decision.stamp).toBeUndefined();
  });

  it("keeps the whole text, tagged, when nothing follows the last tool", () => {
    const text = "Here is the answer. Logging it in the notes file.";
    const decision = decideChannelReply({ text, toolTextOffsets: [20, text.length] });
    expect(decision).toMatchObject({
      verdict: "whole",
      source: "empty-final-segment",
      narrationChars: text.length,
      finalChars: 0,
    });
    expect(decision.stamp).toBeUndefined();
  });

  it("treats only the exact silent token as silent, never an answer that ends with it", () => {
    expect(
      decideChannelReply({ text: "Checking.  NO_REPLY \n", toolTextOffsets: [9] }).verdict,
    ).toBe("silent");
    expect(
      decideChannelReply({ text: "Checking.Done, nothing to add. NO_REPLY", toolTextOffsets: [9] }),
    ).toMatchObject({ verdict: "final", stamp: { kind: "final", from: 9 } });
  });

  it("ignores offsets outside the text", () => {
    expect(
      decideChannelReply({ text: "Checking.Answer.", toolTextOffsets: [9, 99, -1] }),
    ).toMatchObject({ verdict: "final", stamp: { kind: "final", from: 9, textLength: 16 } });
  });
});
