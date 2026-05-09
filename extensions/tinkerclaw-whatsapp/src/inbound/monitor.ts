import { DisconnectReason, isJidGroup } from "@whiskeysockets/baileys";
import type { AnyMessageContent, proto, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { createInboundDebouncer, formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/text-runtime";
// FORK 2026-05-02: pull the account resolver + runtime config so we can give
// createWebSendApi the per-account messagePrefix lookup it needs to enforce
// the persona icon on every outbound message.
import { resolveWhatsAppAccount } from "../accounts.js";
import { readWebSelfIdentityForDecision, WhatsAppAuthUnstableError } from "../auth-store.js";
// FORK 2026-05-01: setGroupMetadataFetcher is called below (4-tier agent-group
// detection) but its import was missing — produced ReferenceError on first
// connect under whatsmeow backend, silently masked under Baileys when earlier
// errors short-circuited. Add the import here.
import { setGroupMetadataFetcher } from "../group-name-cache.js";
import { getPrimaryIdentityId, resolveComparableIdentity } from "../identity.js";
import { DEFAULT_RECONNECT_POLICY, computeBackoff, sleepWithAbort } from "../reconnect.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { createWaSocket, formatError, getStatusCode, waitForWaConnection } from "../session.js";
import { resolveJidToE164 } from "../text-runtime.js";
import { checkInboundAccessControl } from "./access-control.js";
import {
  claimRecentInboundMessage,
  commitRecentInboundMessage,
  isRecentOutboundMessage,
  releaseRecentInboundMessage,
  rememberRecentOutboundMessage,
  WhatsAppRetryableInboundError,
} from "./dedupe.js";
import {
  describeReplyContext,
  extractLocationData,
  extractContactContext,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "./extract.js";
import { attachEmitterListener, closeInboundMonitorSocket } from "./lifecycle.js";
import { downloadInboundMedia } from "./media.js";
import { createWebSendApi } from "./send-api.js";
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const RECONNECT_IN_PROGRESS_ERROR = "no active socket - reconnection in progress";

function isGroupJid(jid: string): boolean {
  return (typeof isJidGroup === "function" ? isJidGroup(jid) : jid.endsWith("@g.us")) === true;
}

function isRetryableSendDisconnectError(err: unknown): boolean {
  return /closed|reset|timed\s*out|disconnect|no active socket/i.test(formatError(err));
}

function shouldClearSocketRefAfterSendFailure(err: unknown): boolean {
  return /closed|reset|disconnect|no active socket/i.test(formatError(err));
}

function isNonEmptyString(value: string | undefined): value is string {
  return Boolean(value);
}

export type MonitorWebInboxOptions = {
  cfg: OpenClawConfig;
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
  /** Optional shared socket reference so reply closures can follow reconnects. */
  socketRef?: { current: WASocket | null };
  /** Whether send retries should wait for a reconnect. */
  shouldRetryDisconnect?: () => boolean;
  /** Reconnect timing for waiting through transient socket replacement gaps. */
  disconnectRetryPolicy?: {
    initialMs: number;
    maxMs: number;
    factor: number;
    jitter: number;
    maxAttempts: number;
  };
  /** Abort in-flight reconnect waits when shutdown becomes terminal. */
  disconnectRetryAbortSignal?: AbortSignal;
};

export async function attachWebInboxToSocket(
  options: MonitorWebInboxOptions & {
    sock: WASocket;
  },
) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = options.sock;
  const connectedAtMs = Date.now();
  if (options.socketRef) {
    options.socketRef.current = sock;
  }
  const getCurrentSock = () => (options.socketRef ? options.socketRef.current : sock);
  const shouldRetryDisconnect = () => options.shouldRetryDisconnect?.() === true;
  const disconnectRetryPolicy = options.disconnectRetryPolicy ?? DEFAULT_RECONNECT_POLICY;
  const sendRetryMaxAttempts =
    disconnectRetryPolicy.maxAttempts > 0
      ? disconnectRetryPolicy.maxAttempts
      : DEFAULT_RECONNECT_POLICY.maxAttempts;

  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };

  try {
    await sock.sendPresenceUpdate("available");
    if (shouldLogVerbose()) {
      logVerbose("Sent global 'available' presence on connect");
    }
  } catch (err) {
    logVerbose(`Failed to send 'available' presence on connect: ${String(err)}`);
  }

  // FORK 2026-05-03: visible diagnostic — selfE164 keeps coming up null in
  // access-control even after the wm adapter captures selfJid. Probe both the
  // input (sock.user.id getter) and the output (resolved e164/jid/lid).
  const userInputId = (sock.user as { id?: string | null } | undefined)?.id ?? null;
  const userInputLid = (sock.user as { lid?: string | null } | undefined)?.lid ?? null;
  console.log(
    `[wa-debug] readWebSelfIdentityForDecision input authDir=${options.authDir} sock.user.id=${userInputId} sock.user.lid=${userInputLid}`,
  );
  const selfIdentity = await readWebSelfIdentityForDecision(
    options.authDir,
    sock.user as { id?: string | null; lid?: string | null } | undefined,
  );
  if (selfIdentity.outcome === "unstable") {
    throw new WhatsAppAuthUnstableError(
      "WhatsApp auth state is still stabilizing; retrying inbox attach.",
    );
  }
  const self = selfIdentity.identity;
  console.log(
    `[wa-debug] readWebSelfIdentityForDecision output e164=${self.e164 ?? null} jid=${self.jid ?? null} lid=${self.lid ?? null}`,
  );
  type QueuedInboundMessage = WebInboundMessage & {
    dedupeKey?: string;
  };

  const finalizeInboundDedupe = async (
    entries: QueuedInboundMessage[],
    error?: unknown,
  ): Promise<void> => {
    const dedupeKeys = [
      ...new Set(entries.map((entry) => entry.dedupeKey).filter(isNonEmptyString)),
    ];
    if (dedupeKeys.length === 0) {
      return;
    }
    if (error instanceof WhatsAppRetryableInboundError) {
      dedupeKeys.forEach((dedupeKey) => releaseRecentInboundMessage(dedupeKey, error));
      return;
    }
    await Promise.all(dedupeKeys.map((dedupeKey) => commitRecentInboundMessage(dedupeKey)));
  };

  const debouncer = createInboundDebouncer<QueuedInboundMessage>({
    debounceMs: options.debounceMs ?? 0,
    buildKey: (msg) => {
      const sender = msg.sender;
      const senderKey =
        msg.chatType === "group"
          ? (getPrimaryIdentityId(sender ?? null) ??
            msg.senderJid ??
            msg.senderE164 ??
            msg.senderName ??
            msg.from)
          : msg.from;
      if (!senderKey) {
        return null;
      }
      const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
      return `${msg.accountId}:${conversationKey}:${senderKey}`;
    },
    shouldDebounce: options.shouldDebounce,
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      try {
        if (entries.length === 1) {
          await options.onMessage(last);
          await finalizeInboundDedupe(entries);
          return;
        }
        const mentioned = new Set<string>();
        for (const entry of entries) {
          for (const jid of entry.mentions ?? entry.mentionedJids ?? []) {
            mentioned.add(jid);
          }
        }
        const combinedBody = entries
          .map((entry) => entry.body)
          .filter(Boolean)
          .join("\n");
        const combinedMessage: WebInboundMessage = {
          ...last,
          body: combinedBody,
          mentions: mentioned.size > 0 ? Array.from(mentioned) : undefined,
          mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
        };
        await options.onMessage(combinedMessage);
        await finalizeInboundDedupe(entries);
      } catch (error) {
        await finalizeInboundDedupe(entries, error);
        throw error;
      }
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  const groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lidLookup = sock.signalRepository?.lidMapping;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

  const rememberOutboundMessage = (remoteJid: string, result: unknown) => {
    const messageId =
      typeof result === "object" && result && "key" in result
        ? ((result as { key?: { id?: string } }).key?.id ?? "")
        : "";
    if (!messageId) {
      return;
    }
    rememberRecentOutboundMessage({
      accountId: options.accountId,
      remoteJid,
      messageId,
    });
  };

  const sendTrackedMessage = async (jid: string, content: AnyMessageContent) => {
    let lastErr: unknown = new Error(RECONNECT_IN_PROGRESS_ERROR);
    for (let attempt = 1; ; attempt++) {
      const currentSock = getCurrentSock();
      if (currentSock) {
        try {
          const result = await currentSock.sendMessage(jid, content);
          rememberOutboundMessage(jid, result);
          return result;
        } catch (err) {
          if (!shouldRetryDisconnect() || !isRetryableSendDisconnectError(err)) {
            throw err;
          }
          lastErr = err;
          if (
            shouldClearSocketRefAfterSendFailure(err) &&
            options.socketRef?.current === currentSock
          ) {
            options.socketRef.current = null;
          }
        }
      } else if (!shouldRetryDisconnect()) {
        throw lastErr;
      }

      if (attempt >= sendRetryMaxAttempts) {
        throw lastErr;
      }
      const delayMs = computeBackoff(disconnectRetryPolicy, attempt);
      logVerbose(
        `Waiting ${delayMs}ms for WhatsApp reconnect before retrying send to ${jid}: ${formatError(lastErr)}`,
      );
      try {
        await sleepWithAbort(delayMs, options.disconnectRetryAbortSignal);
      } catch {
        throw lastErr;
      }
    }
  };

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);
      const participants =
        (
          await Promise.all(
            meta.participants?.map(async (p) => {
              const mapped = await resolveInboundJid(p.id);
              return mapped ?? p.id;
            }) ?? [],
          )
        ).filter(Boolean) ?? [];
      const entry = {
        subject: meta.subject,
        participants,
        expires: Date.now() + GROUP_META_TTL_MS,
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (err) {
      logVerbose(`Failed to fetch group metadata for ${jid}: ${String(err)}`);
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  // FORK: register the group-name fetcher used by access-control's 4-tier
  // agent-group detection. Wraps sock.groupMetadata with a thin shim that
  // only returns {subject} — the cache layer handles TTL + stale fallback.
  setGroupMetadataFetcher(async (jid: string) => {
    const meta = await sock.groupMetadata(jid);
    return { subject: meta.subject ?? "" };
  });

  type NormalizedInboundMessage = {
    id?: string;
    remoteJid: string;
    group: boolean;
    participantJid?: string;
    from: string;
    senderE164: string | null;
    groupSubject?: string;
    groupParticipants?: string[];
    messageTimestampMs?: number;
    access: Awaited<ReturnType<typeof checkInboundAccessControl>>;
  };

  const normalizeInboundMessage = async (
    msg: WAMessage,
  ): Promise<NormalizedInboundMessage | null> => {
    const id = msg.key?.id ?? undefined;
    // FORK 2026-05-03: `let` (was const) so the self-DM via LID rescue below
    // can rebind it to the canonical phone JID after rewriting msg.key.remoteJid.
    let remoteJid = msg.key?.remoteJid;
    if (!remoteJid) {
      console.log(`[wa-debug] DROP: no remoteJid id=${id}`);
      return null;
    }
    if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      console.log(`[wa-debug] DROP: status/broadcast jid=${remoteJid} id=${id}`);
      return null;
    }

    const group = isGroupJid(remoteJid);
    // Drop echoes of messages the gateway itself sent (tracked by sendTrackedMessage).
    // Applies to both groups and DMs/self-chat — without this, self-chat mode
    // re-processes the bot's own replies as new inbound user messages.
    if (
      Boolean(msg.key?.fromMe) &&
      id &&
      isRecentOutboundMessage({
        accountId: options.accountId,
        remoteJid,
        messageId: id,
      })
    ) {
      console.log(`[wa-debug] DROP: recent outbound echo id=${id} jid=${remoteJid}`);
      return null;
    }
    const participantJid = msg.key?.participant ?? undefined;
    // FORK 2026-05-03: self-DM via LID rescue. When the owner messages
    // himself, whatsmeow can deliver the inbound with chat=<owner-lid>@lid
    // instead of chat=<owner-e164>@s.whatsapp.net. To keep the rest of the
    // pipeline consistent (which assumes the owner-self chat JID is the
    // standard `<phone>@s.whatsapp.net` form for routing/peer resolution),
    // rewrite both the local `remoteJid` and `msg.key.remoteJid` so
    // downstream code (normalize, dispatch, outbound chatId) sees the
    // canonical phone JID. Without this, the trigger gate fires but
    // downstream routing silently drops the msg.
    //
    // FORK 2026-05-04 (CRITICAL FIX — sister-DM trigger bug): The original
    // rescue only checked `fromMe + chat ends with @lid`. That is NOT
    // sufficient to identify a self-DM: when the owner DMs another contact
    // whose chat is delivered as `<their-lid>@lid` (sister, friend, etc),
    // `fromMe=true` because the message originated on the owner's phone, but
    // the chat is the OTHER person's LID — not the owner's. The old rescue
    // would rewrite that chat to the owner's self-DM, causing two cascading
    // bugs: (1) the trigger gate would fire (self-DM is in `noPrefixChats`),
    // making Jarvis reply to a non-Jarvis-addressed message; (2) the reply
    // routed back to the rewritten chat (owner self-DM) instead of the
    // original peer, leaking the reply into the owner's self-chat. The fix:
    // ONLY rescue when we have positive evidence the LID belongs to the
    // owner. Two signals (in priority order):
    //   (a) `self.lid` is populated and matches `remoteJid` — authoritative.
    //   (b) `remoteJid` is explicitly listed in `channels.whatsapp.noPrefixChats`
    //       AND `channels.whatsapp.allowFrom` — both lists declare this LID
    //       is the owner's self-chat alias (config truth, used as fallback
    //       because `self.lid` is currently null on whatsmeow auth state).
    // If neither matches, do NOT rescue — `from` stays null, and the
    // standard `if (!from)` guard drops the message. That is the correct
    // outcome for an unknown LID DM.
    let from = group ? remoteJid : await resolveInboundJid(remoteJid);
    const isOwnerLidCandidate =
      !from &&
      !group &&
      msg.key?.fromMe === true &&
      typeof remoteJid === "string" &&
      /(@lid|@hosted\.lid)$/i.test(remoteJid) &&
      self.e164;
    if (isOwnerLidCandidate) {
      const lidString = remoteJid as string;
      // (a) authoritative — owner's LID known and matches.
      const matchesSelfLid =
        typeof self.lid === "string" && self.lid.length > 0 && self.lid === lidString;
      // (b) config-truth fallback — LID configured as owner's self alias.
      const wa = (
        options.cfg.channels as
          | { whatsapp?: { noPrefixChats?: string[]; allowFrom?: string[] } }
          | undefined
      )?.whatsapp;
      const noPrefixChats = wa?.noPrefixChats ?? [];
      const allowFrom = wa?.allowFrom ?? [];
      const matchesConfiguredOwnerLid =
        noPrefixChats.includes(lidString) && allowFrom.includes(lidString);
      if (matchesSelfLid || matchesConfiguredOwnerLid) {
        const originalLid = lidString;
        from = self.e164;
        const selfPhoneJid = `${self.e164!.replace(/^\+/, "")}@s.whatsapp.net`;
        remoteJid = selfPhoneJid;
        if (msg.key) {
          (msg.key as { remoteJid?: string }).remoteJid = selfPhoneJid;
        }
        console.log(
          `[wa-debug] self-DM via LID rescue: chat=${originalLid} → owner e164=${self.e164} jid=${selfPhoneJid} id=${id} (matchesSelfLid=${matchesSelfLid} matchesConfig=${matchesConfiguredOwnerLid})`,
        );
      } else {
        // FORK 2026-05-04 (post-rescue-fix): still let owner's prefixed
        // messages through. The previous version of this branch left `from`
        // null, which dropped at the guard below — meaning the user literally
        // could not say "Jarvis …" in a non-self LID chat (e.g. a peer DM
        // delivered as <their-lid>@lid). Use the LID itself as the chat
        // identifier so the standard pipeline runs:
        //   - access-control: owner-fromMe fast-paths to allowed; the peer's
        //     own (fromMe=false) messages already dropped above because
        //     resolveInboundJid returned null, so they never reach this
        //     branch.
        //   - trigger gate: chat (LID) is NOT in `noPrefixChats`, so the
        //     body-prefix gate decides — silent without "Jarvis …", fires
        //     with it.
        //   - reply routing: `msg.from` is the LID, so the reply lands back
        //     in the same chat (the peer sees it). This honours the user's
        //     "always reply in the same chat that triggered him" rule.
        from = lidString;
        console.log(
          `[wa-debug] LID rescue SKIPPED: chat=${lidString} fromMe=true but LID not in self.lid (${self.lid ?? "null"}) and not in noPrefixChats∩allowFrom — using LID as chat identifier (owner-prefix path open) id=${id}`,
        );
      }
    }
    if (!from) {
      console.log(`[wa-debug] DROP: resolveInboundJid returned null jid=${remoteJid} id=${id}`);
      return null;
    }
    // FORK 2026-05-04: for fromMe DMs, the sender is the OWNER, not
    // the peer in `from`. Without this, downstream people-prefetch tries to
    // resolve the peer's profile when the body really came from the owner —
    // notably wrong on the new owner-prefix-via-LID-chat path where `from`
    // is the peer's LID. self.e164 is the canonical sender for any fromMe
    // message, group or DM.
    const senderE164 = group
      ? participantJid
        ? await resolveInboundJid(participantJid)
        : Boolean(msg.key?.fromMe) && self.e164
          ? self.e164 // FORK: fromMe group messages lack participant — use own E164
          : null
      : Boolean(msg.key?.fromMe) && self.e164
        ? self.e164
        : from;

    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (group) {
      const meta = await getGroupMeta(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampMs = msg.messageTimestamp
      ? Number(msg.messageTimestamp) * 1000
      : undefined;

    // FORK: Extract message body before access control for triggerPrefix evaluation
    const messageBody = extractText(msg.message ?? undefined) ?? "";
    const access = await checkInboundAccessControl({
      cfg: options.cfg,
      accountId: options.accountId,
      from,
      selfE164: self.e164 ?? null,
      senderE164,
      group,
      pushName: msg.pushName ?? undefined,
      isFromMe: Boolean(msg.key?.fromMe),
      messageTimestampMs,
      connectedAtMs,
      messageBody,
      sock: { sendMessage: (jid, content) => sendTrackedMessage(jid, content) },
      remoteJid,
    });
    console.log(
      `[wa-debug] access: allowed=${access.allowed} isSelfChat=${access.isSelfChat} from=${from} selfE164=${self.e164} fromMe=${msg.key?.fromMe} id=${id}`,
    );
    if (!access.allowed) {
      console.log(`[wa-debug] DROP: access denied from=${from} id=${id}`);
      return null;
    }

    return {
      id,
      remoteJid,
      group,
      participantJid,
      from,
      senderE164,
      groupSubject,
      groupParticipants,
      messageTimestampMs,
      access,
    };
  };

  const maybeMarkInboundAsRead = async (inbound: NormalizedInboundMessage) => {
    const { id, remoteJid, participantJid, access } = inbound;
    if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
      try {
        await sock.readMessages([{ remoteJid, id, participant: participantJid, fromMe: false }]);
        if (shouldLogVerbose()) {
          const suffix = participantJid ? ` (participant ${participantJid})` : "";
          logVerbose(`Marked message ${id} as read for ${remoteJid}${suffix}`);
        }
      } catch (err) {
        logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
      }
    } else if (id && access.isSelfChat && shouldLogVerbose()) {
      // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
      logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
    }
  };

  type EnrichedInboundMessage = {
    body: string;
    location?: ReturnType<typeof extractLocationData>;
    contactContext?: ReturnType<typeof extractContactContext>;
    replyContext?: ReturnType<typeof describeReplyContext>;
    mediaPath?: string;
    mediaType?: string;
    mediaFileName?: string;
  };

  const enrichInboundMessage = async (msg: WAMessage): Promise<EnrichedInboundMessage | null> => {
    const location = extractLocationData(msg.message ?? undefined);
    const locationText = location ? formatLocationText(location) : undefined;
    const contactContext = extractContactContext(msg.message ?? undefined);
    let body = extractText(msg.message ?? undefined);
    if (locationText) {
      body = [body, locationText].filter(Boolean).join("\n").trim();
    }
    if (!body) {
      body = extractMediaPlaceholder(msg.message ?? undefined);
      if (!body) {
        return null;
      }
    }
    const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let mediaFileName: string | undefined;
    try {
      const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock);
      if (inboundMedia) {
        const maxMb =
          typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0
            ? options.mediaMaxMb
            : 50;
        const maxBytes = maxMb * 1024 * 1024;
        const saved = await saveMediaBuffer(
          inboundMedia.buffer,
          inboundMedia.mimetype,
          "inbound",
          maxBytes,
          inboundMedia.fileName,
        );
        mediaPath = saved.path;
        mediaType = inboundMedia.mimetype;
        mediaFileName = inboundMedia.fileName;
      }
    } catch (err) {
      logVerbose(`Inbound media download failed: ${String(err)}`);
    }

    return {
      body,
      location: location ?? undefined,
      contactContext,
      replyContext,
      mediaPath,
      mediaType,
      mediaFileName,
    };
  };

  const enqueueInboundMessage = async (
    msg: WAMessage,
    inbound: NormalizedInboundMessage,
    enriched: EnrichedInboundMessage,
  ) => {
    const chatJid = inbound.remoteJid;
    const sendComposing = async () => {
      const currentSock = getCurrentSock();
      if (!currentSock) {
        return;
      }
      try {
        await currentSock.sendPresenceUpdate("composing", chatJid);
      } catch (err) {
        logVerbose(`Presence update failed: ${String(err)}`);
      }
    };
    const reply = async (text: string) => {
      await sendTrackedMessage(chatJid, { text });
    };
    const sendMedia = async (payload: AnyMessageContent) => {
      await sendTrackedMessage(chatJid, payload);
    };
    const timestamp = inbound.messageTimestampMs;
    const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
    const senderName = msg.pushName ?? undefined;

    inboundLogger.info(
      {
        from: inbound.from,
        to: self.e164 ?? "me",
        body: enriched.body,
        mediaPath: enriched.mediaPath,
        mediaType: enriched.mediaType,
        mediaFileName: enriched.mediaFileName,
        timestamp,
      },
      "inbound message",
    );
    const inboundMessage: QueuedInboundMessage = {
      id: inbound.id,
      from: inbound.from,
      conversationId: inbound.from,
      to: self.e164 ?? "me",
      accountId: inbound.access.resolvedAccountId,
      accessControlPassed: true,
      body: enriched.body,
      pushName: senderName,
      timestamp,
      chatType: inbound.group ? "group" : "direct",
      chatId: inbound.remoteJid,
      sender: resolveComparableIdentity({
        jid: inbound.participantJid,
        e164: inbound.senderE164 ?? undefined,
        name: senderName,
      }),
      senderJid: inbound.participantJid,
      senderE164: inbound.senderE164 ?? undefined,
      senderName,
      replyTo: enriched.replyContext ?? undefined,
      replyToId: enriched.replyContext?.id,
      replyToBody: enriched.replyContext?.body,
      replyToSender: enriched.replyContext?.sender?.label ?? undefined,
      replyToSenderJid: enriched.replyContext?.sender?.jid ?? undefined,
      replyToSenderE164: enriched.replyContext?.sender?.e164 ?? undefined,
      groupSubject: inbound.groupSubject,
      groupParticipants: inbound.groupParticipants,
      mentions: mentionedJids ?? undefined,
      mentionedJids: mentionedJids ?? undefined,
      self,
      selfJid: self.jid ?? undefined,
      selfLid: self.lid ?? undefined,
      selfE164: self.e164 ?? undefined,
      fromMe: Boolean(msg.key?.fromMe),
      location: enriched.location ?? undefined,
      untrustedStructuredContext: enriched.contactContext
        ? [
            {
              label: "WhatsApp contact",
              source: "whatsapp",
              type: enriched.contactContext.kind,
              payload: enriched.contactContext,
            },
          ]
        : undefined,
      sendComposing,
      reply,
      sendMedia,
      mediaPath: enriched.mediaPath,
      mediaType: enriched.mediaType,
      mediaFileName: enriched.mediaFileName,
      dedupeKey: inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : undefined,
    };
    try {
      const task = Promise.resolve(debouncer.enqueue(inboundMessage));
      void task.catch((err) => {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
      });
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    }
  };

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    console.log(
      `[wa-pipeline] handleMessagesUpsert type=${upsert.type} count=${upsert.messages?.length ?? 0}`,
    );
    if (upsert.type !== "notify" && upsert.type !== "append") {
      console.log(`[wa-pipeline] SKIP: type=${upsert.type} not notify/append`);
      return;
    }
    for (const msg of upsert.messages ?? []) {
      const msgJid = msg.key?.remoteJid;
      const msgId = msg.key?.id;
      const msgFromMe = msg.key?.fromMe;
      console.log(`[wa-pipeline] processing msg jid=${msgJid} id=${msgId} fromMe=${msgFromMe}`);
      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound",
      });
      const inbound = await normalizeInboundMessage(msg);
      if (!inbound) {
        console.log(`[wa-pipeline] DROPPED by normalizeInboundMessage: jid=${msgJid} id=${msgId}`);
        continue;
      }

      await maybeMarkInboundAsRead(inbound);

      // If this is history/offline catch-up, mark read above but skip auto-reply.
      if (upsert.type === "append") {
        const APPEND_RECENT_GRACE_MS = 60_000;
        const msgTsRaw = msg.messageTimestamp;
        const msgTsNum = msgTsRaw != null ? Number(msgTsRaw) : Number.NaN;
        const msgTsMs = Number.isFinite(msgTsNum) ? msgTsNum * 1000 : 0;
        if (msgTsMs < connectedAtMs - APPEND_RECENT_GRACE_MS) {
          continue;
        }
      }

      const enriched = await enrichInboundMessage(msg);
      if (!enriched) {
        continue;
      }

      const dedupeKey = inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : "";
      if (dedupeKey && !(await claimRecentInboundMessage(dedupeKey))) {
        continue;
      }

      await enqueueInboundMessage(msg, inbound, enriched);
    }
  };
  const handleConnectionUpdate = (
    update: Partial<import("@whiskeysockets/baileys").ConnectionState>,
  ) => {
    try {
      if (update.connection === "close") {
        if (options.socketRef?.current === sock) {
          options.socketRef.current = null;
        }
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          status,
          isLoggedOut: status === LOGGED_OUT_STATUS,
          error: update.lastDisconnect?.error,
        });
      }
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: err });
    }
  };
  const detachMessagesUpsert = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "messages.upsert",
    handleMessagesUpsert as unknown as (...args: unknown[]) => void,
  );
  console.log(
    `[wa-debug] EVENT SUBSCRIPTION ATTACHED: messages.upsert on sock.ev (type=${typeof sock.ev}, hasOn=${typeof sock.ev?.on})`,
  );
  const detachConnectionUpdate = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "connection.update",
    handleConnectionUpdate as unknown as (...args: unknown[]) => void,
  );

  void (async () => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      if (shouldLogVerbose()) {
        logVerbose(`Hydrated ${Object.keys(groups ?? {}).length} participating groups on connect`);
      }
    } catch (err) {
      const error = String(err);
      inboundLogger.warn({ error }, "failed hydrating participating groups on connect");
      inboundConsoleLog.warn(`Failed hydrating participating groups on connect: ${error}`);
      logVerbose(`Failed to hydrate participating groups on connect: ${error}`);
    }
  })();

  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (jid: string, content: AnyMessageContent) => sendTrackedMessage(jid, content),
      sendPresenceUpdate: async (presence, jid?: string) => {
        const currentSock = getCurrentSock();
        if (!currentSock) {
          throw new Error(RECONNECT_IN_PROGRESS_ERROR);
        }
        return currentSock.sendPresenceUpdate(presence, jid);
      },
      // biome-ignore lint/suspicious/noExplicitAny: presenceSubscribe is on the
      // Baileys socket but our wm-adapter declares a no-op; cast to keep types
      // permissive without the WASocket import here.
      presenceSubscribe: async (jid: string) => {
        const currentSock = getCurrentSock() as unknown as {
          presenceSubscribe?: (jid: string) => Promise<void>;
        } | null;
        await currentSock?.presenceSubscribe?.(jid);
      },
    },
    defaultAccountId: options.accountId,
    // FORK 2026-05-02: outbound persona-prefix resolver. Reads the live
    // openclaw.json snapshot every send so config edits are picked up
    // without a process restart (runtime-config-snapshot already handles
    // hot-reload). Per-account override > channel-level > global.
    resolveOutboundPrefix: (accountId: string) => {
      try {
        const cfg = getRuntimeConfig();
        const account = resolveWhatsAppAccount({ cfg, accountId });
        return account.messagePrefix?.trim() || undefined;
      } catch {
        return undefined;
      }
    },
  });

  return {
    close: async () => {
      try {
        detachMessagesUpsert();
        detachConnectionUpdate();
        closeInboundMonitorSocket(sock);
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
  } as const;
}

export async function monitorWebInbox(options: MonitorWebInboxOptions) {
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
  });
  await waitForWaConnection(sock);
  return attachWebInboxToSocket({
    ...options,
    sock,
  });
}
