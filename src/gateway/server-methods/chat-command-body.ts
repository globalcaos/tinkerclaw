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
 */
export function buildChatSendCommandBody(params: {
  message: string;
  thinking?: string;
  model?: string;
}): string {
  const trimmed = params.message.trim();
  const isUserCommand = !trimmed || trimmed.startsWith("/");
  if (isUserCommand) {
    return params.message;
  }
  const directives: string[] = [];
  if (params.model) {
    directives.push(`/model ${params.model}`);
  }
  if (params.thinking) {
    directives.push(`/think ${params.thinking}`);
  }
  return directives.length > 0 ? `${directives.join(" ")} ${params.message}` : params.message;
}
