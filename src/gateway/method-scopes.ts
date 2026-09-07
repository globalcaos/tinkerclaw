import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { resolveReservedGatewayMethodScope } from "../shared/gateway-method-policy.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  READ_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
  type OperatorScope,
} from "./operator-scopes.js";

export {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  READ_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
  type OperatorScope,
};

export const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  TALK_SECRETS_SCOPE,
];

const NODE_ROLE_METHODS = new Set([
  "node.invoke.result",
  "node.event",
  "node.pending.drain",
  "node.canvas.capability.refresh",
  "node.pending.pull",
  "node.pending.ack",
  "skills.bins",
]);

const METHOD_SCOPE_GROUPS: Record<OperatorScope, readonly string[]> = {
  [APPROVALS_SCOPE]: [
    "exec.approval.get",
    "exec.approval.list",
    "exec.approval.request",
    "exec.approval.waitDecision",
    "exec.approval.resolve",
    "plugin.approval.list",
    "plugin.approval.request",
    "plugin.approval.waitDecision",
    "plugin.approval.resolve",
  ],
  [PAIRING_SCOPE]: [
    "node.pair.request",
    "node.pair.list",
    "node.pair.reject",
    "node.pair.remove",
    "node.pair.verify",
    "node.pair.approve",
    "device.pair.list",
    "device.pair.approve",
    "device.pair.reject",
    "device.pair.remove",
    "device.token.rotate",
    "device.token.revoke",
    "node.rename",
  ],
  [READ_SCOPE]: [
    "assistant.media.get",
    "health",
    "diagnostics.stability",
    "doctor.memory.status",
    "doctor.memory.dreamDiary",
    "logs.tail",
    "channels.status",
    "status",
    "usage.status",
    "usage.cost",
    "tts.status",
    "tts.providers",
    "tts.personas",
    "commands.list",
    "models.list",
    "models.authStatus",
    "tools.catalog",
    "tools.effective",
    "plugins.uiDescriptors",
    "agents.list",
    "agent.identity.get",
    "skills.status",
    "skills.search",
    "skills.detail",
    "voicewake.get",
    "voicewake.routing.get",
    "briefing.resolve",
    // FORK 2026-05-10: bare-filename → absolute-path resolver, used by
    // Tinker UI's `.fs-link` click handler when the link only carries the
    // basename (e.g. "BRIEFING.md") rather than a full path.
    "files.resolveBareName",
    // FORK 2026-05-11: J15 RSC probes (see bible/probes.md). All READ_SCOPE:
    // returns inspection-only state, never credentials or write capability.
    "debug.session.config",
    "debug.session.state",
    "debug.tail.lastN",
    "cron.lastRun",
    "cron.listJobs",
    "wa.lastOutbound",
    "wa.recentOutbound",
    "gateway.stuckSessions",
    "gateway.diagnosticSessionCount",
    "plugin.boot.status",
    "gateway.flow.replay",
    "gateway.observability.snapshot",
    "gateway.slo.burnRate",
    // FORK 2026-08-18: the READ half of the session-attachments surface. Pure inspection —
    // it lists in-flight runs, queued turns and child processes and signals nothing. The
    // MUTATING half (sessions.attachmentStop) is classified WRITE_SCOPE below; leaving
    // either UNCLASSIFIED silently falls back to ADMIN on the server and to [] on the
    // least-privilege client, which is the two-sided trap documented in the fork.* note.
    "sessions.attachments",
    "sessions.list",
    "sessions.get",
    "sessions.preview",
    "sessions.resolve",
    "sessions.compaction.list",
    "sessions.compaction.get",
    "sessions.subscribe",
    "sessions.unsubscribe",
    "sessions.messages.subscribe",
    "sessions.messages.unsubscribe",
    "sessions.usage",
    "sessions.usage.timeseries",
    "sessions.usage.logs",
    "sessions.suggestTitle", // FORK 2026-06-25
    "cron.list",
    "cron.status",
    "cron.runs",
    "gateway.identity.get",
    "system-presence",
    "last-heartbeat",
    "node.list",
    "node.describe",
    "chat.history",
    "config.get",
    "config.schema.lookup",
    "talk.config",
    "agents.files.list",
    "agents.files.get",
    // FORK 2026-08-04: fork.* least-privilege classification (READ half).
    //
    // These methods were UNCLASSIFIED, and unclassified is a two-sided trap: the CLIENT
    // (resolveLeastPrivilegeOperatorScopesForMethod) asks for [] while the SERVER
    // (authorizeOperatorScopesForMethod) falls back to `?? ADMIN_SCOPE`. So every
    // least-privilege BACKEND caller (callGateway -> callGatewayLeastPrivilege, see
    // gateway/call.ts) was refused `missing scope: operator.admin` ~1ms in, at warn level
    // only. That killed the Overseer loop and the idle curiosity chips for months, while
    // callers passing EXPLICIT admin scopes kept working -- so the surface looked half-alive
    // and nobody chased it. Classifying here fixes BOTH ends at once, because the client
    // derives its ask from this same table.
    //
    // READ = inspection only: returns state, mutates nothing, spawns nothing.
    "fork.curiosity.topGaps",
    "fork.memory.search",
    "fork.skill.search",
    "fork.strategy.switch.list",
    "fork.strategy.switch.review",
    "fork.overseer.status",
    // Pure derive: bounded (128 inputs / 64KB), no persistence, fails safe to []. READ is
    // also the most reachable tier -- READ methods are granted to WRITE holders too (see
    // authorizeOperatorScopesForMethod below) -- which matters because this is the J13
    // recipe matcher's embedding lane and it must degrade to lexical, never to refused.
    "fork.prefrontal.embed",
  ],
  [WRITE_SCOPE]: [
    "message.action",
    "send",
    "poll",
    "agent",
    "agent.wait",
    "wake",
    "talk.mode",
    "talk.realtime.session",
    "talk.realtime.relayAudio",
    "talk.realtime.relayMark",
    "talk.realtime.relayStop",
    "talk.realtime.relayToolResult",
    "talk.speak",
    "tts.enable",
    "tts.disable",
    "tts.convert",
    "tts.setProvider",
    "tts.setPersona",
    "voicewake.set",
    "voicewake.routing.set",
    "node.invoke",
    "chat.send",
    "chat.abort",
    "sessions.create",
    "sessions.send",
    "sessions.steer",
    "sessions.abort",
    // FORK 2026-08-18: sessions.attachmentStop MUTATES — it aborts a live run or signals a
    // child process (SIGTERM, then SIGKILL only on explicit escalation). Scoped exactly like
    // `chat.abort` / `sessions.abort` above. It must NEVER be classified READ: READ is also
    // granted to WRITE holders (authorizeOperatorScopesForMethod), so a READ classification
    // would hand a kill switch to every read-only operator token.
    "sessions.attachmentStop",
    "sessions.compaction.branch",
    "doctor.memory.backfillDreamDiary",
    "doctor.memory.resetDreamDiary",
    "doctor.memory.resetGroundedShortTerm",
    "doctor.memory.repairDreamingArtifacts",
    "doctor.memory.dedupeDreamDiary",
    "push.test",
    "push.web.vapidPublicKey",
    "push.web.subscribe",
    "push.web.unsubscribe",
    "push.web.test",
    "node.pending.enqueue",
    // FORK 2026-08-04: fork.* least-privilege classification (WRITE half). See the READ
    // block above for why UNCLASSIFIED == dead. WRITE = mutates durable state, emits a
    // broadcast, or spawns/burns compute -- the same tier this table already assigns to
    // `agent` / `sessions.create` / `sessions.send` / `doctor.memory.*`.
    "fork.subagents.spawn", // spawns a child run: same tier as `agent` + `sessions.create`
    "fork.overseer.activate",
    "fork.overseer.deactivate",
    "fork.curiosity.logGap",
    "fork.curiosity.resolveGap",
    "fork.prefrontal.setRecipe",
    "fork.prefrontal.trailEvent",
    "fork.skill.put",
    "fork.skill.recordOutcome",
    "fork.strategy.switch.apply",
    "fork.reasoning.search", // bounded tree-of-thoughts: real model calls, not a lookup
    // Heavy ENGRAM sleep-consolidation run. WRITE, not ADMIN: every sibling memory-
    // maintenance mutation already in this table (doctor.memory.backfillDreamDiary /
    // resetDreamDiary / resetGroundedShortTerm / repairDreamingArtifacts /
    // dedupeDreamDiary) is WRITE. `cron.run` is ADMIN because it runs an ARBITRARY named
    // job; this runs one fixed, known job.
    "fork.engram.consolidate.run",
  ],
  [ADMIN_SCOPE]: [
    "channels.start",
    "channels.logout",
    "config.openExternalFile",
    "debug.dumpUiSnapshot",
    "agents.create",
    "agents.update",
    "agents.delete",
    "skills.install",
    "skills.update",
    "secrets.reload",
    "secrets.resolve",
    "cron.add",
    "cron.update",
    "cron.remove",
    "cron.run",
    "sessions.patch",
    "sessions.pluginPatch",
    "sessions.reset",
    "sessions.delete",
    "sessions.compact",
    "sessions.compaction.restore",
    "connect",
    "chat.inject",
    "nativeHook.invoke",
    "web.login.start",
    "web.login.wait",
    "set-heartbeats",
    "system-event",
    "agents.files.set",
    "update.status",
  ],
  [TALK_SECRETS_SCOPE]: [],
};

const METHOD_SCOPE_BY_NAME = new Map<string, OperatorScope>(
  Object.entries(METHOD_SCOPE_GROUPS).flatMap(([scope, methods]) =>
    methods.map((method) => [method, scope as OperatorScope]),
  ),
);

function resolveScopedMethod(method: string): OperatorScope | undefined {
  const explicitScope = METHOD_SCOPE_BY_NAME.get(method);
  if (explicitScope) {
    return explicitScope;
  }
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (reservedScope) {
    return reservedScope;
  }
  const pluginScope = getPluginRegistryState()?.activeRegistry?.gatewayMethodScopes?.[method];
  if (pluginScope) {
    return pluginScope;
  }
  return undefined;
}

export function isApprovalMethod(method: string): boolean {
  return resolveScopedMethod(method) === APPROVALS_SCOPE;
}

export function isPairingMethod(method: string): boolean {
  return resolveScopedMethod(method) === PAIRING_SCOPE;
}

export function isReadMethod(method: string): boolean {
  return resolveScopedMethod(method) === READ_SCOPE;
}

export function isWriteMethod(method: string): boolean {
  return resolveScopedMethod(method) === WRITE_SCOPE;
}

export function isNodeRoleMethod(method: string): boolean {
  return NODE_ROLE_METHODS.has(method);
}

export function isAdminOnlyMethod(method: string): boolean {
  return resolveScopedMethod(method) === ADMIN_SCOPE;
}

export function resolveRequiredOperatorScopeForMethod(method: string): OperatorScope | undefined {
  return resolveScopedMethod(method);
}

export function resolveLeastPrivilegeOperatorScopesForMethod(method: string): OperatorScope[] {
  const requiredScope = resolveRequiredOperatorScopeForMethod(method);
  if (requiredScope) {
    return [requiredScope];
  }
  // Default-deny for unclassified methods.
  return [];
}

export function authorizeOperatorScopesForMethod(
  method: string,
  scopes: readonly string[],
): { allowed: true } | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
  if (requiredScope === READ_SCOPE) {
    if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) {
      return { allowed: true };
    }
    return { allowed: false, missingScope: READ_SCOPE };
  }
  if (scopes.includes(requiredScope)) {
    return { allowed: true };
  }
  return { allowed: false, missingScope: requiredScope };
}

export function isGatewayMethodClassified(method: string): boolean {
  if (isNodeRoleMethod(method)) {
    return true;
  }
  return resolveRequiredOperatorScopeForMethod(method) !== undefined;
}

/**
 * FORK 2026-08-04: true when an error is the gateway's operator-scope REFUSAL -- the
 * `missing scope: operator.x` shape minted in server-methods.ts and the HTTP helpers.
 *
 * WHY THIS EXISTS: a refusal arrives at a backend caller as an ordinary rejected promise,
 * so it gets folded into whatever generic "the call failed" branch is nearest, and that
 * branch is usually indistinguishable from "ran fine, nothing to report". That is exactly
 * how the unclassified-`fork.*` outage above stayed invisible for months at warn level.
 * Callers use this to report a refusal as its OWN outcome, loudly, because a refusal is a
 * wiring bug that will never self-heal -- unlike a transient transport error.
 *
 * Pattern mirrors MISSING_SCOPE_PATTERN in src/commands/gateway-status/helpers.ts.
 */
export function isOperatorScopeDenial(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /\bmissing scope:\s*[a-z0-9._-]+/i.test(message);
}
