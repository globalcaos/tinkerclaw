import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/config-runtime";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import { isSelfChatMode, normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
import { resolveWhatsAppAccount } from "../accounts.js";

export type InboundAccessControlResult = {
  allowed: boolean;
  shouldMarkRead: boolean;
  isSelfChat: boolean;
  resolvedAccountId: string;
};

const PAIRING_REPLY_HISTORY_GRACE_MS = 30_000;

function resolveWhatsAppRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: "open" | "allowlist" | "disabled";
  defaultGroupPolicy?: "open" | "allowlist" | "disabled";
}): {
  groupPolicy: "open" | "allowlist" | "disabled";
  providerMissingFallbackApplied: boolean;
} {
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
  });
}

export async function checkInboundAccessControl(params: {
  accountId: string;
  from: string;
  selfE164: string | null;
  senderE164: string | null;
  group: boolean;
  pushName?: string;
  isFromMe: boolean;
  messageTimestampMs?: number;
  connectedAtMs?: number;
  pairingGraceMs?: number;
  sock: {
    sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
  };
  remoteJid: string;
  /** Message body - used to check triggerPrefix for outbound DM allowance */
  messageBody?: string;
}): Promise<InboundAccessControlResult> {
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({
    cfg,
    accountId: params.accountId,
  });
  const dmPolicy = account.dmPolicy ?? "pairing";
  const configuredAllowFrom = account.allowFrom ?? [];
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "whatsapp",
    accountId: account.accountId,
    dmPolicy,
  });
  // Without user config, default to self-only DM access so the owner can talk to themselves.
  const defaultAllowFrom =
    configuredAllowFrom.length === 0 && params.selfE164 ? [params.selfE164] : [];
  const dmAllowFrom = configuredAllowFrom.length > 0 ? configuredAllowFrom : defaultAllowFrom;
  const groupAllowFrom =
    account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);
  const isSamePhone = params.from === params.selfE164;
  const isSelfChat = account.selfChatMode ?? isSelfChatMode(params.selfE164, configuredAllowFrom);
  const pairingGraceMs =
    typeof params.pairingGraceMs === "number" && params.pairingGraceMs > 0
      ? params.pairingGraceMs
      : PAIRING_REPLY_HISTORY_GRACE_MS;
  const suppressPairingReply =
    typeof params.connectedAtMs === "number" &&
    typeof params.messageTimestampMs === "number" &&
    params.messageTimestampMs < params.connectedAtMs - pairingGraceMs;

  // Group policy filtering:
  // - "open": groups bypass allowFrom, only mention-gating applies
  // - "disabled": block all group messages entirely
  // - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } = resolveWhatsAppRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.whatsapp !== undefined,
    groupPolicy: account.groupPolicy,
    defaultGroupPolicy,
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "whatsapp",
    accountId: account.accountId,
    log: (message) => logVerbose(message),
  });
  const normalizedDmSender = normalizeE164(params.from);
  const normalizedGroupSender =
    typeof params.senderE164 === "string" ? normalizeE164(params.senderE164) : null;
  const access = resolveDmGroupAccessWithLists({
    isGroup: params.group,
    dmPolicy,
    groupPolicy,
    // Groups intentionally fall back to configured allowFrom only (not DM self-chat fallback).
    allowFrom: params.group ? configuredAllowFrom : dmAllowFrom,
    groupAllowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowEntries) => {
      const hasWildcard = allowEntries.includes("*");
      if (hasWildcard) {
        return true;
      }
      const normalizedEntrySet = new Set(
        allowEntries
          .map((entry) => normalizeE164(String(entry)))
          .filter((entry): entry is string => Boolean(entry)),
      );
      if (!params.group && isSamePhone) {
        return true;
      }
      return params.group
        ? Boolean(normalizedGroupSender && normalizedEntrySet.has(normalizedGroupSender))
        : normalizedEntrySet.has(normalizedDmSender);
    },
  });
  // ─── FORK: Unified trigger logic ───
  // Self-chat (same phone): always allow, no prefix needed.
  if (!params.group && isSamePhone) {
    logVerbose("Allowing self-chat DM (same phone, no prefix required)");
    return {
      allowed: true,
      shouldMarkRead: true,
      isSelfChat,
      resolvedAccountId: account.accountId,
    };
  }

  // Resolve triggerPrefix once — used for all non-self-chat paths.
  const triggerPrefix =
    cfg.channels?.whatsapp?.triggerPrefix ?? cfg.channels?.defaults?.triggerPrefix;
  const bodyTrimmed = (params.messageBody ?? "").trim().toLowerCase();
  const prefixMatches = triggerPrefix ? bodyTrimmed.startsWith(triggerPrefix.toLowerCase()) : false;

  // Exempt groups: agent-to-agent chats where prefix is not required.
  // These are dedicated conversation groups where agents talk freely.
  const exemptGroups: string[] = cfg.channels?.whatsapp?.triggerPrefixExempt ?? [];
  const isExemptGroup = params.group && exemptGroups.includes(params.remoteJid);

  // Owner (isFromMe) in any chat (DM or group): require prefix, unless exempt group.
  if (params.isFromMe) {
    if (isExemptGroup) {
      logVerbose(`Allowing owner message (fromMe) in exempt group ${params.remoteJid}`);
      return {
        allowed: true,
        shouldMarkRead: true,
        isSelfChat,
        resolvedAccountId: account.accountId,
      };
    }
    if (!triggerPrefix) {
      logVerbose("Blocked owner message (fromMe) — no triggerPrefix configured");
      return {
        allowed: false,
        shouldMarkRead: false,
        isSelfChat,
        resolvedAccountId: account.accountId,
      };
    }
    if (!prefixMatches) {
      logVerbose(`Blocked owner message (fromMe) — prefix "${triggerPrefix}" not matched`);
      return {
        allowed: false,
        shouldMarkRead: false,
        isSelfChat,
        resolvedAccountId: account.accountId,
      };
    }
    logVerbose(
      `Allowing owner message (fromMe) — prefix "${triggerPrefix}" matched in ${params.group ? "group" : "DM"}`,
    );
    return {
      allowed: true,
      shouldMarkRead: true,
      isSelfChat,
      resolvedAccountId: account.accountId,
    };
  }

  // Other senders: must be in allowlist. Prefix required unless exempt group.
  // Groups: check groupAllowFrom. DMs: check allowFrom/dmPolicy.
  if (params.group) {
    if (access.decision !== "allow") {
      logVerbose(
        `Blocked group message from ${params.senderE164 ?? "unknown"} (not in groupAllowFrom)`,
      );
      return {
        allowed: false,
        shouldMarkRead: false,
        isSelfChat,
        resolvedAccountId: account.accountId,
      };
    }
    // Sender is allowed — exempt groups skip prefix, others require it.
    if (isExemptGroup) {
      logVerbose(`Allowing message from ${params.senderE164 ?? "unknown"} in exempt group`);
      return {
        allowed: true,
        shouldMarkRead: true,
        isSelfChat,
        resolvedAccountId: account.accountId,
      };
    }
    if (!prefixMatches) {
      logVerbose(
        `Blocked group message from ${params.senderE164 ?? "unknown"} — prefix not matched`,
      );
      return {
        allowed: false,
        shouldMarkRead: false,
        isSelfChat,
        resolvedAccountId: account.accountId,
      };
    }
    logVerbose(`Allowing group message from ${params.senderE164 ?? "unknown"} — prefix matched`);
    return {
      allowed: true,
      shouldMarkRead: true,
      isSelfChat,
      resolvedAccountId: account.accountId,
    };
  }

  // DMs from others: check dmPolicy + allowlist, then prefix.
  if (access.decision === "block" && access.reason === "dmPolicy=disabled") {
    logVerbose("Blocked DM (dmPolicy: disabled)");
    return {
      allowed: false,
      shouldMarkRead: false,
      isSelfChat,
      resolvedAccountId: account.accountId,
    };
  }
  if (access.decision === "pairing" && !isSamePhone) {
    const candidate = params.from;
    if (suppressPairingReply) {
      logVerbose(`Skipping pairing reply for historical DM from ${candidate}.`);
    } else {
      await createChannelPairingChallengeIssuer({
        channel: "whatsapp",
        upsertPairingRequest: async ({ id, meta }) =>
          await upsertChannelPairingRequest({
            channel: "whatsapp",
            id,
            accountId: account.accountId,
            meta,
          }),
      })({
        senderId: candidate,
        senderIdLine: `Your WhatsApp phone number: ${candidate}`,
        meta: { name: (params.pushName ?? "").trim() || undefined },
        onCreated: () => {
          logVerbose(
            `whatsapp pairing request sender=${candidate} name=${params.pushName ?? "unknown"}`,
          );
        },
        sendPairingReply: async (text) => {
          await params.sock.sendMessage(params.remoteJid, { text });
        },
        onReplyError: (err) => {
          logVerbose(`whatsapp pairing reply failed for ${candidate}: ${String(err)}`);
        },
      });
    }
    return {
      allowed: false,
      shouldMarkRead: false,
      isSelfChat,
      resolvedAccountId: account.accountId,
    };
  }
  if (access.decision !== "allow") {
    logVerbose(`Blocked unauthorized DM sender ${params.from} (dmPolicy=${dmPolicy})`);
    return {
      allowed: false,
      shouldMarkRead: false,
      isSelfChat,
      resolvedAccountId: account.accountId,
    };
  }
  // Sender is in DM allowlist — check prefix.
  if (!prefixMatches) {
    logVerbose(`Blocked DM from ${params.from} — prefix not matched`);
    return {
      allowed: false,
      shouldMarkRead: false,
      isSelfChat,
      resolvedAccountId: account.accountId,
    };
  }
  logVerbose(`Allowing DM from ${params.from} — prefix matched`);
  return { allowed: true, shouldMarkRead: true, isSelfChat, resolvedAccountId: account.accountId };
}

export const __testing = {
  resolveWhatsAppRuntimeGroupPolicy,
};
