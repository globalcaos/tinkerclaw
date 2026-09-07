// Headless requester session key — the sink for subagent spawns whose caller
// has no UI tab identity (CLI / ORCA / Claude Code sessions).
//
// WHY THIS MODULE EXISTS: subagent completion announcements are delivered to
// `requesterSessionKey`. When a caller has no tab, two independent layers used
// to default it to `agent:main:main` — which is a LIVE human-facing Tinker UI
// webchat tab (sessions.json origin.label "Tinker UI"), not a headless lane.
// Result: announcements were injected into the human Main tab as user turns
// (64 of them in one 6-day session), each minting a model turn on a single
// serialized lane. Headless callers must land on `agent:<agentId>:orchestrator`
// instead — a lane that can never collide with the protected "🏠 Main" tab
// (tinker-ui/src/app.ts identifies that tab with `key.endsWith(":main")`).
import { normalizeAgentId } from "../routing/session-key.js";

export const HEADLESS_REQUESTER_SUFFIX = "orchestrator";

/**
 * Resolve the session key headless (tab-less) subagent spawns use as their
 * `requesterSessionKey`. The agent id falls back to the default agent id via
 * `normalizeAgentId` — never hardcode "main" here.
 */
export function resolveHeadlessRequesterSessionKey(agentId?: string): string {
  return `agent:${normalizeAgentId(agentId)}:${HEADLESS_REQUESTER_SUFFIX}`;
}
