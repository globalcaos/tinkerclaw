/**
 * FORK 2026-05-23: WhatsApp inbound `[input-mode]` prelude block.
 *
 * Signals to the agent that the message it's reading originated as a voice
 * note (the audio-preflight STT cascade replaced the `<media:audio>` body
 * with a transcript). Pairs with the `voice-in-voice-out` feedback rule:
 * when the input arrives by voice, the reply should be a voice note unless
 * the prompt explicitly asks for a written artifact.
 *
 * Emitted only for voice-origin messages. For ordinary text input, the
 * block is omitted entirely (no `mode: text` chatter — the absence of the
 * block IS the text default).
 */
export function buildInputModeBlock(params: { mode: "voice" }): string {
  const lines: string[] = ["[input-mode]"];
  lines.push(`mode: ${params.mode}`);
  if (params.mode === "voice") {
    lines.push(`The body you are reading was originally a voice note — the audio-preflight`);
    lines.push(`STT cascade transcribed it. Default response modality: REPLY BY VOICE.`);
    lines.push(`Render your reply text to an OGG/Opus voice note (jarvis-wa or sherpa-onnx-tts)`);
    lines.push(`and send via WhatsApp PTT. Keep it short, punchy, conversational — voice notes`);
    lines.push(`over ~60s feel long.`);
    lines.push(``);
    lines.push(`Exceptions — reply in TEXT instead when the owner explicitly asked for:`);
    lines.push(`  - a written artifact ("write me", "draft", "give me the list", "make a table")`);
    lines.push(`  - code, file paths, links, JSON, diffs, or anything else not naturally spoken`);
    lines.push(`  - structured information that requires markdown rendering`);
  }
  lines.push("[/input-mode]");
  return lines.join("\n");
}
