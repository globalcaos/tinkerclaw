import { Type } from "typebox";
import { ChatSendSessionKeyString, InputProvenanceSchema, NonEmptyString } from "./primitives.js";

export const LogsTailParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

export const LogsTailResultSchema = Type.Object(
  {
    file: NonEmptyString,
    cursor: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 0 }),
    lines: Type.Array(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    reset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// WebChat/WebSocket-native chat methods
export const ChatHistoryParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 500_000 })),
  },
  { additionalProperties: false },
);

export const ChatSendParamsSchema = Type.Object(
  {
    sessionKey: ChatSendSessionKeyString,
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    // Per-turn model force (bible §5.84 Drop 3). The webchat client (which cannot
    // patch session metadata) re-sends its model pin on every chat.send; the
    // gateway applies it by injecting a `/model <id>` directive. Absent = Auto
    // (router/allocator picks). Mirrors the per-turn `thinking` param above.
    model: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    // When false, chat.send acks with a runId synchronously and returns
    // WITHOUT dispatching to the agent — no transcript writes, no
    // chat-broadcast deltas/final, no claude-cli spawn. Used by bible
    // invariant probes (TINKER_UI_DESIGN_BIBLE/flows.md F1) so the
    // "dispatch path alive" check doesn't pollute the user's webchat
    // session. Default true preserves existing behavior.
    dispatchAgent: Type.Optional(Type.Boolean()),
    originatingChannel: Type.Optional(Type.String()),
    originatingTo: Type.Optional(Type.String()),
    originatingAccountId: Type.Optional(Type.String()),
    originatingThreadId: Type.Optional(Type.String()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    systemInputProvenance: Type.Optional(InputProvenanceSchema),
    systemProvenanceReceipt: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
    execSecurityLevel: Type.Optional(
      Type.Union([
        Type.Literal("safe"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("critical"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const ChatAbortParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    runId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ChatInjectParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: NonEmptyString,
    label: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);

export const ChatEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    state: Type.Union([
      Type.Literal("delta"),
      Type.Literal("final"),
      Type.Literal("aborted"),
      Type.Literal("error"),
    ]),
    message: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    errorKind: Type.Optional(
      Type.Union([
        Type.Literal("refusal"),
        Type.Literal("timeout"),
        Type.Literal("rate_limit"),
        Type.Literal("context_length"),
        Type.Literal("unknown"),
      ]),
    ),
    // FORK 2026-06-24 (recoverable-error retry, spec Component 1): machine-readable
    // signal for the Tinker client-side auto-retry controller. `reason` is the
    // recoverability class derived at the failover layer (rate_limit / quota /
    // overloaded / unavailable); `retryAfter` is the provider-supplied backoff in
    // SECONDS (Retry-After header / 429 body) when derivable. Both optional and
    // additive — the human `errorMessage` text remains the frontend fallback.
    // NOTE: additionalProperties:false here means error-event producers (the emit
    // sites in src/gateway/server-chat.ts emitChatFinal + src/gateway/server-methods/chat.ts
    // broadcastChatError) MUST populate these for them to reach the UI; this schema
    // change is the enabler, the producer wiring lands in a separate edit-unit.
    reason: Type.Optional(Type.String()),
    retryAfter: Type.Optional(Type.Number({ minimum: 0 })),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
