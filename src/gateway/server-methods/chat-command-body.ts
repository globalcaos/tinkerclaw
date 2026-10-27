/**
 * Builds the command-parsing body for a chat.send turn, injecting per-turn
 * `/model` and `/think` directives when the webchat client pins a model and/or
 * thinking level (bible §5.84 Drop 3).
 *
 * The webchat client cannot patch session metadata, so it re-sends its pins on
 * every chat.send; the gateway applies them by prepending the matching inline
 * directives, which the auto-reply pipeline extracts (extractModelDirective /
 * the /think parser) and strips before the message runs. Both extractors scan
 * the whole body independently, so chaining `/model` and `/think` is safe.
 *
 * Injection is skipped when the user's own message is already a slash command
 * (so we never clobber an explicit `/model`, `/clear`, etc.) or is empty.
 *
 * FORK 2026-09-08 — EXCEPT a message that leads with the user's own `/think`. "/think xhigh keep
 * going" is how the architect types half his turns, and under the blanket rule neither a picker
 * pin nor the picker's Auto reset (`model: "auto"`, see auto-reply/reply/model-directive-auto.ts)
 * ever reached those turns: the exhausted, still-pinned model kept running while the picker read
 * Auto. A leading `/think` is an inline directive the sliders themselves inject in this very
 * position, not a command that owns the turn, so the model directive is prepended in front of it.
 * The per-turn `thinking` param is NOT added then — the user's typed level is the explicit one and
 * two `/think`s in one body would leave the parser to pick.
 *
 * FORK 2026-10-09 (effort slider) — chat.send no longer passes `thinking` here. Every path that
 * applies an inline `/think` stores it in `sessionEntry.thinkingLevel`, so the slider's per-send
 * pin outlived the pin and later Auto turns skipped Thalamus. chat.send now hands the level to the
 * reply pipeline as a this-turn pin (`resolveChatSendTurnThinking` below, read by
 * get-reply-directives as `ctx.TurnThinkLevel`). The `thinking` option has no production caller
 * left; it stays only while chat-command-body.test.ts still covers it, and both should go together.
 */
export function buildChatSendCommandBody(params: {
  message: string;
  thinking?: string;
  model?: string;
}): string {
  const trimmed = params.message.trim();
  if (!trimmed) {
    return params.message;
  }
  const leadsWithThink = /^\/think(?:\s|$)/i.test(trimmed);
  const isUserCommand = trimmed.startsWith("/") && !leadsWithThink;
  if (isUserCommand) {
    return params.message;
  }
  const directives: string[] = [];
  if (params.model) {
    directives.push(`/model ${params.model}`);
  }
  if (params.thinking && !leadsWithThink) {
    directives.push(`/think ${params.thinking}`);
  }
  return directives.length > 0 ? `${directives.join(" ")} ${params.message}` : params.message;
}

/**
 * FORK 2026-10-09 (effort slider) — the chat.send `thinking` param as a pin for THIS TURN ONLY.
 *
 * Returns the level chat.send hands the reply pipeline as `ctx.TurnThinkLevel`, under the same
 * rules that used to decide whether `/think <lvl>` was injected: nothing for an empty message, and
 * nothing when the message leads with a slash. A user command owns its turn, and a `/think` the
 * user typed is the explicit level: it stays a directive and keeps persisting as it always has.
 * The level is returned raw; get-reply-directives normalizes it ("auto" normalizes to no pin).
 */
export function resolveChatSendTurnThinking(params: {
  message: string;
  thinking?: string;
}): string | undefined {
  const thinking = params.thinking?.trim();
  const trimmed = params.message.trim();
  if (!thinking || !trimmed || trimmed.startsWith("/")) {
    return undefined;
  }
  return thinking;
}
