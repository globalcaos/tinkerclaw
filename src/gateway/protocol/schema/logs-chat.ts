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
    // FORK 2026-09-23 (chat.history rehaul, plan task 5): seq cursors. Local rows carry
    // `__openclaw.seq` (1-based along the served branch), numbered under `cursor.epoch` of an
    // earlier reply. `afterSeq` asks for the rows after that seq, `beforeSeq` for the `limit` rows
    // before it; at most one of the two (the handler rejects both). Neither = the legacy tail
    // window. A cursor is honoured only when `epoch` equals the server's current epoch; otherwise
    // the reply is the tail window with `cursor.reset: true`.
    afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    beforeSeq: Type.Optional(Type.Integer({ minimum: 1 })),
    epoch: Type.Optional(Type.String()),
    // FORK 2026-10-02: a RESET ARCHIVE of the session's transcript instead of the live one: the
    // newest archive whose reset happened strictly before this instant (epoch ms), its `limit` newest
    // rows, imports included. Paged by time, not by index, because a session reset every turn shifts
    // every index while a page is open. Exclusive with afterSeq/beforeSeq. The reply carries
    // `archive` and no cursor. chat-history-archive.ts.
    resetArchiveBefore: Type.Optional(Type.Number({ minimum: 0 })),
    // With resetArchiveBefore: how many rows of that archive (from its end) the page already holds;
    // the reply is the `limit` rows before them. A long archive is read in several pages.
    archiveOffset: Type.Optional(Type.Integer({ minimum: 0 })),
    // FORK 2026-10-03 — with resetArchiveBefore: the oldest row the page already holds (epoch ms).
    // Earlier COPIES of the tab's transcript (backups, checkpoints, a transcript it left) are served
    // only when it is given and only their rows strictly older; a copy left empty is passed over.
    // Reset archives are served whole: a page can lack them although it holds older rows.
    archiveFloor: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ChatHistoryArchiveSchema = Type.Object(
  {
    /** When the reset archived the transcript served (epoch ms); null when none is that old. */
    resetAt: Type.Union([Type.Number(), Type.Null()]),
    /** How many archives are older still: 0 = the transcript's start is reached. */
    olderCount: Type.Integer({ minimum: 0 }),
    /** Rows of THIS archive before the ones served: more pages of it are owed while > 0. */
    rowsBefore: Type.Integer({ minimum: 0 }),
    /**
     * What the transcript served is (FORK 2026-10-03): a reset archive, a transcript the tab left,
     * or an earlier copy of one (a repair backup or a compaction checkpoint). Absent with no archive.
     */
    kind: Type.Optional(
      Type.Union([Type.Literal("reset"), Type.Literal("earlier"), Type.Literal("copy")]),
    ),
  },
  { additionalProperties: false },
);

export const ChatHistoryCursorSchema = Type.Object(
  {
    // null = the transcript has no incremental identity (flat or legacy-loaded): a cursor request
    // against it always resets.
    epoch: Type.Union([Type.String(), Type.Null()]),
    // The beforeSeq that pages everything older than this reply. It can be lastSeq + 1 when a
    // limited tail cut imports newer than every local row it served (ruling R23).
    firstSeq: Type.Integer({ minimum: 0 }),
    lastSeq: Type.Integer({ minimum: 0 }),
    hasMoreBefore: Type.Boolean(),
    // true = the client's cursor was not honoured; `messages` is a fresh tail window that replaces
    // whatever the client holds.
    reset: Type.Boolean(),
    // FORK 2026-09-24 (ruling R36): how many user rows the display shows with a seq below
    // `firstSeq` on the current branch, so a client holding only part of the transcript numbers
    // turns from its start. Sent on tail windows, resets and older pages; a plain afterSeq delta
    // leaves it out (the client keeps its own).
    userRowsBefore: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ChatHistoryResultSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    sessionId: Type.Optional(Type.String()),
    messages: Type.Array(Type.Unknown()),
    thinkingLevel: Type.Optional(Type.String()),
    fastMode: Type.Optional(Type.Boolean()),
    verboseLevel: Type.Optional(Type.String()),
    // Optional (ruling R37): this gateway always sends it, but a client built from this schema
    // must still decode the reply of a gateway that predates cursors.
    cursor: Type.Optional(ChatHistoryCursorSchema),
    // FORK 2026-10-02: present exactly when the request asked for `resetArchiveBefore`.
    archive: Type.Optional(ChatHistoryArchiveSchema),
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
    // FORK 2026-09-06 (duprep III): present, and always literally `true`, ONLY when the
    // cumulative delta buffer was RE-BASED (src/gateway/server-chat.ts:838-855). The client
    // re-anchors its bubble offsets into the new coordinate space instead of slicing at stale
    // ones — which is how the answer used to render twice.
    //
    // Declared here because this object is additionalProperties:false. `validateChatEvent`
    // (protocol/index.ts:586) is compiled but currently has NO call site, so the field reached
    // the client regardless; the moment anyone wires that validator up, an undeclared `replace`
    // would be stripped or rejected and the fix would silently stop working with no error.
    // The server comment at server-chat.ts:849-853 asked for exactly this line.
    replace: Type.Optional(Type.Literal(true)),
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
    // FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.3 wire contract, plan step G2):
    // what the gateway did with an accepted prompt when a turn was already running. Set ONLY on the
    // early `final` that chat.send broadcasts from its `!agentRunStarted` branch
    // (src/gateway/server-methods/chat.ts) — no other final carries it.
    //
    // ADDITIVE and OPTIONAL on purpose. An old client ignores an unknown key, and an ABSENT key is
    // deliberately overloaded: it means "this prompt started its own run now" AND "this gateway
    // predates G2" AND "the report lost the race with the broadcast". All three collapse to the same
    // instruction for the client — keep today's behaviour. Distinguishing run-now from an old
    // gateway would need a fourth literal (PQ-8 names four dispositions, while the §6.3 contract and
    // the G2 acceptance row name three); this follows §6.3 and leaves that choice to the optic.
    //
    // A `final` carrying "steered" or "backlogged" is NEITHER a prompt terminal nor a session
    // terminal (contradiction C2 / principle PQ-7): the client must not stamp sessionEndedAt, settle
    // another prompt's state or close a timing block on it.
    //
    // PRODUCER MIRROR: the identical three literals are the `PromptDisposition` union in
    // src/auto-reply/get-reply-options.types.ts. This object is `additionalProperties: false`, so an
    // undeclared value would be stripped or rejected the day `validateChatEvent`
    // (protocol/index.ts) gets a call site — change both lists in the SAME commit.
    disposition: Type.Optional(
      Type.Union([Type.Literal("steered"), Type.Literal("backlogged"), Type.Literal("dropped")]),
    ),
  },
  { additionalProperties: false },
);
