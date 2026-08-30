import { logRejectedLargePayload } from "../logging/diagnostic-payload.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
} from "./method-scopes.js";
import type {
  GatewayBroadcastCounts,
  GatewayBroadcastFn,
  GatewayBroadcastOpts,
  GatewayBroadcastStateVersion,
  GatewayBroadcastToConnIdsFn,
} from "./server-broadcast-types.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { logWs, shouldLogWs, summarizeAgentEventForWsLog } from "./ws-log.js";

// Pairing scope is for device-pairing handshakes only; chat transcript events
// require operator-level session access. Pairing-scoped and node-role clients
// must not passively receive chat-class broadcasts.
const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  agent: [READ_SCOPE],
  chat: [READ_SCOPE],
  "chat.side_result": [READ_SCOPE],
  cron: [READ_SCOPE],
  health: [],
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  heartbeat: [],
  "plugin.approval.requested": [APPROVALS_SCOPE],
  "plugin.approval.resolved": [APPROVALS_SCOPE],
  presence: [],
  shutdown: [],
  tick: [],
  "talk.mode": [WRITE_SCOPE],
  "update.available": [],
  "voicewake.changed": [READ_SCOPE],
  "voicewake.routing.changed": [READ_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
  "sessions.changed": [READ_SCOPE],
  "session.message": [READ_SCOPE],
  "session.tool": [READ_SCOPE],
};

// Events that node-role sessions must receive even when the event's operator
// scope would otherwise reject non-operator roles. Nodes act on these updates
// (e.g. reconfiguring wake-word triggers).
const NODE_ALLOWED_EVENTS = new Set<string>(["voicewake.changed", "voicewake.routing.changed"]);

export type {
  GatewayBroadcastCounts,
  GatewayBroadcastFn,
  GatewayBroadcastOpts,
  GatewayBroadcastStateVersion,
  GatewayBroadcastToConnIdsFn,
} from "./server-broadcast-types.js";

function hasEventScope(client: GatewayWsClient, event: string): boolean {
  const required = EVENT_SCOPE_GUARDS[event];
  // Plugin-defined gateway broadcast events (plugin.* namespace) are allowed
  // for operator.write and operator.admin scopes. Explicit plugin.* entries
  // in EVENT_SCOPE_GUARDS take precedence (e.g., plugin.approval.*).
  if (!required && event.startsWith("plugin.")) {
    const role = client.connect.role ?? "operator";
    if (role !== "operator") {
      return false;
    }
    const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
    return scopes.includes(WRITE_SCOPE) || scopes.includes(ADMIN_SCOPE);
  }
  if (!required) {
    return false;
  }
  if (required.length === 0) {
    return true;
  }
  const role = client.connect.role ?? "operator";
  if (role !== "operator") {
    return role === "node" && NODE_ALLOWED_EVENTS.has(event);
  }
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  if (required.includes(READ_SCOPE)) {
    return scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE);
  }
  return required.some((scope) => scopes.includes(scope));
}

function zeroBroadcastCounts(): GatewayBroadcastCounts {
  return { attempted: 0, sent: 0, scopeSkipped: 0, droppedSlow: 0, sendThrew: 0 };
}

type ChatDeliverPayload = {
  state?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  message?: { content?: unknown } | null;
};

function chatFinalTextLen(payload: ChatDeliverPayload): number {
  const content = payload.message?.content;
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let len = 0;
  for (const part of content) {
    const text = (part as { text?: unknown } | null)?.text;
    if (typeof text === "string") {
      len += text.length;
    }
  }
  return len;
}

function chatDeliverField(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/**
 * FORK 2026-08-26 (chat-deliver): deliberately NOT behind `shouldLogWs()`.
 *
 * `sent=0` for a chat final on a session whose tab is open is the real "the
 * answer was routed to zero sockets" condition, and until now it left no trace
 * anywhere. The only nearby number, `routedFinalCount` in
 * auto-reply/reply/dispatch-from-config.ts, counts cross-channel re-routes and
 * reads 0 on every webchat turn by construction — four bug-log entries read it
 * as "the router found no live sink" and chased the wrong layer. A diagnostic you
 * have to enable in advance cannot catch an incident you only notice afterwards,
 * so this line always prints. It fires on chat FINALS only — at most one line per
 * completed turn — so it cannot flood the log.
 */
function logChatDelivery(event: string, payload: unknown, counts: GatewayBroadcastCounts): void {
  if (event !== "chat" || !payload || typeof payload !== "object") {
    return;
  }
  const chat = payload as ChatDeliverPayload;
  if (chat.state !== "final") {
    return;
  }
  console.log(
    `[chat-deliver] sessionKey=${chatDeliverField(chat.sessionKey)} runId=${chatDeliverField(chat.runId)} attempted=${counts.attempted} sent=${counts.sent} scopeSkipped=${counts.scopeSkipped} droppedSlow=${counts.droppedSlow} sendThrew=${counts.sendThrew} textLen=${chatFinalTextLen(chat)}`,
  );
}

export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  const clientSeq = new WeakMap<GatewayWsClient, number>();
  const reportedSlowPayloadClients = new WeakSet<GatewayWsClient>();

  const broadcastInternal = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
    targetConnIds?: ReadonlySet<string>,
  ): GatewayBroadcastCounts => {
    const counts = zeroBroadcastCounts();
    if (params.clients.size === 0) {
      // Zeroed counters, never `undefined`: "nobody was connected" is the single
      // most interesting delivery outcome there is, so it has to be reportable.
      logChatDelivery(event, payload, counts);
      return counts;
    }
    const isTargeted = Boolean(targetConnIds);
    if (shouldLogWs()) {
      const logMeta: Record<string, unknown> = {
        event,
        seq: isTargeted ? "targeted" : "per-client",
        clients: params.clients.size,
        targets: targetConnIds ? targetConnIds.size : undefined,
        dropIfSlow: opts?.dropIfSlow,
        presenceVersion: opts?.stateVersion?.presence,
        healthVersion: opts?.stateVersion?.health,
      };
      if (event === "agent") {
        Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
      }
      logWs("out", "event", logMeta);
    }
    for (const c of params.clients) {
      if (targetConnIds && !targetConnIds.has(c.connId)) {
        continue;
      }
      counts.attempted += 1;
      if (!hasEventScope(c, event)) {
        counts.scopeSkipped += 1;
        continue;
      }
      const nextSeq = (clientSeq.get(c) ?? 0) + 1;
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (!slow) {
        reportedSlowPayloadClients.delete(c);
      } else if (!reportedSlowPayloadClients.has(c)) {
        reportedSlowPayloadClients.add(c);
        logRejectedLargePayload({
          surface: "gateway.ws.outbound_buffer",
          bytes: c.socket.bufferedAmount,
          limitBytes: MAX_BUFFERED_BYTES,
          reason: opts?.dropIfSlow ? "ws_send_buffer_drop" : "ws_send_buffer_close",
        });
      }
      if (slow && opts?.dropIfSlow) {
        // Behaviour unchanged: the dropped frame still consumes this client's
        // sequence number. It is now RECORDED instead of vanishing.
        if (!isTargeted) {
          clientSeq.set(c, nextSeq);
        }
        counts.droppedSlow += 1;
        continue;
      }
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        const eventSeq = isTargeted ? undefined : nextSeq;
        if (!isTargeted) {
          clientSeq.set(c, nextSeq);
        }
        const frame = JSON.stringify({
          type: "event",
          event,
          payload,
          seq: eventSeq,
          stateVersion: opts?.stateVersion,
        });
        c.socket.send(frame);
        counts.sent += 1;
      } catch {
        // FORK 2026-08-26 (chat-deliver): this was a bare ignore-catch. A send
        // that throws is precisely the failure the delivery investigation could
        // not see; count it instead of discarding it.
        counts.sendThrew += 1;
      }
    }
    logChatDelivery(event, payload, counts);
    return counts;
  };

  // Deliberately NOT annotated `GatewayBroadcastFn`: that alias returns
  // `GatewayBroadcastCounts | void` so it can still accept the void-returning
  // relays elsewhere in the gateway, and annotating with it would erase the
  // counters right where they are produced. This stays exactly
  // `=> GatewayBroadcastCounts`, and remains assignable to `GatewayBroadcastFn`
  // for every consumer that takes one.
  const broadcast = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
  ): GatewayBroadcastCounts => broadcastInternal(event, payload, opts);

  const broadcastToConnIds: GatewayBroadcastToConnIdsFn = (event, payload, connIds, opts) => {
    if (connIds.size === 0) {
      return;
    }
    broadcastInternal(event, payload, opts, connIds);
  };

  return { broadcast, broadcastToConnIds };
}
