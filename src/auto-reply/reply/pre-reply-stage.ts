/**
 * FORK 2026-10-15 (bug-log `pre-reply-stall-invisible`): the step a prompt is in between its dispatch and its reply
 * operation. A Pi-migration prompt sat over three minutes inside `getReplyFromConfig`; every stuck-session line read
 * `phase=none`, because no reply operation existed yet, and nothing else was logged, so the gateway restart that
 * followed erased the only evidence. The stuck-session probe (server.impl.ts createGatewayReplyPhaseProbe) reads this
 * when there is no reply operation, so the next stall names its step and how long it has been in it.
 */
const stages = new Map<string, { stage: string; since: number }>();

export function notePreReplyStage(
  sessionKey: string | undefined,
  stage: string,
  now = Date.now(),
): void {
  const key = sessionKey?.trim();
  if (key) {
    stages.set(key, { stage, since: now });
  }
}

export function clearPreReplyStage(sessionKey: string | undefined): void {
  const key = sessionKey?.trim();
  if (key) {
    stages.delete(key);
  }
}

/** `pre:<step>:<seconds in it>s`, or undefined when the session is not before a reply. */
export function preReplyStageFor(
  sessionKey: string | undefined,
  now = Date.now(),
): string | undefined {
  const key = sessionKey?.trim();
  const entry = key ? stages.get(key) : undefined;
  if (!entry) {
    return undefined;
  }
  return `pre:${entry.stage}:${Math.max(0, Math.round((now - entry.since) / 1000))}s`;
}
