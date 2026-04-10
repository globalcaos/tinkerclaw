/**
 * FORK: 4-tier inbound access control for WhatsApp messages.
 *
 * Replaces the upstream access-control.ts with a cleaner model that
 * eliminates hardcoded group JID exemptions and static triggerPrefixExempt
 * lists. Instead, group names are dynamically checked via group-name-cache.ts.
 *
 * 4-tier decision model (first match wins):
 *   Self-chat  — same phone as linked account → always allowed, no prefix
 *   Tier 1     — owner DM (isFromMe && !isGroup) → always allowed, no prefix
 *   Tier 2     — agent group (name contains triggerPrefix) → no prefix,
 *                allowlisted senders only
 *   Tier 3     — authorized DM (sender in allowFrom) → prefix required
 *   Tier 4     — everything else → owner with prefix only
 *
 * Wired into the inbound pipeline by the channel registration code (Task 6/8).
 */

import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import { isAgentGroup } from "./group-name-cache.js";

export type InboundAccessControlResult = {
  allowed: boolean;
  shouldMarkRead: boolean;
  isSelfChat: boolean;
  resolvedAccountId: string;
};

export async function checkInboundAccessControl(params: {
  accountId: string;
  from: string;
  selfE164: string | null;
  senderE164: string | null;
  group: boolean;
  pushName?: string;
  isFromMe: boolean;
  messageBody?: string;
  remoteJid: string;
  /** Dependency injection to avoid import coupling */
  resolveAccount: (cfg: ReturnType<typeof loadConfig>) => {
    accountId: string;
    dmPolicy?: string;
    allowFrom?: string[];
    groupAllowFrom?: string[];
    groupPolicy?: string;
    selfChatMode?: boolean;
  };
  normalizeE164: (input: string) => string | null;
  isSelfChatMode: (selfE164: string | null, allowFrom: string[]) => boolean;
}): Promise<InboundAccessControlResult> {
  const cfg = loadConfig();
  const account = params.resolveAccount(cfg);
  const configuredAllowFrom = account.allowFrom ?? [];
  const dmPolicy = account.dmPolicy ?? "pairing";
  const isSamePhone = params.from === params.selfE164;
  const isSelfChat =
    account.selfChatMode ?? params.isSelfChatMode(params.selfE164, configuredAllowFrom);

  // Resolve triggerPrefix from config — needed for all non-self-chat tiers.
  const triggerPrefix =
    cfg.channels?.whatsapp?.triggerPrefix ?? cfg.channels?.defaults?.triggerPrefix;
  const bodyTrimmed = (params.messageBody ?? "").trim().toLowerCase();
  const prefixMatches = triggerPrefix ? bodyTrimmed.startsWith(triggerPrefix.toLowerCase()) : false;

  // Helper: build a result object.
  const result = (allowed: boolean, shouldMarkRead: boolean): InboundAccessControlResult => ({
    allowed,
    shouldMarkRead,
    isSelfChat,
    resolvedAccountId: account.accountId,
  });

  // ─── Self-chat: same phone number ─────────────────────────────────
  if (!params.group && isSamePhone) {
    logVerbose("AC: self-chat DM (same phone) — allowed, no prefix");
    return result(true, true);
  }

  // ─── Tier 1: Owner DM (isFromMe && !isGroup) ─────────────────────
  if (params.isFromMe && !params.group) {
    logVerbose("AC: owner DM (isFromMe) — allowed, no prefix");
    return result(true, true);
  }

  // ─── Tier 2: Agent group (name contains triggerPrefix) ────────────
  if (params.group && triggerPrefix) {
    const agentGroup = await isAgentGroup(params.remoteJid, triggerPrefix);
    if (agentGroup) {
      // Agent group: check sender against allowlists (owner always passes).
      if (params.isFromMe) {
        logVerbose(`AC: owner in agent group ${params.remoteJid} — allowed, no prefix`);
        return result(true, true);
      }
      // Check if sender is in groupAllowFrom / allowFrom.
      const senderAllowed = await isSenderInAllowList(params, account, cfg, dmPolicy);
      if (senderAllowed) {
        logVerbose(
          `AC: allowlisted sender ${params.senderE164 ?? "?"} in agent group — allowed, no prefix`,
        );
        return result(true, true);
      }
      logVerbose(`AC: non-allowlisted sender ${params.senderE164 ?? "?"} in agent group — blocked`);
      return result(false, false);
    }
  }

  // ─── Tier 3: Authorized DM (sender in allowFrom, not isFromMe) ───
  if (!params.group && !params.isFromMe) {
    const senderAllowed = await isSenderInAllowList(params, account, cfg, dmPolicy);
    if (senderAllowed) {
      if (!prefixMatches) {
        logVerbose(
          `AC: authorized DM from ${params.from} — prefix "${triggerPrefix ?? "(none)"}" not matched, silently ignored`,
        );
        return result(false, false);
      }
      logVerbose(`AC: authorized DM from ${params.from} — prefix matched, allowed`);
      return result(true, true);
    }
    logVerbose(`AC: unauthorized DM from ${params.from} — blocked`);
    return result(false, false);
  }

  // ─── Tier 4: Everything else (non-agent groups, owner with prefix) ─
  if (params.isFromMe) {
    if (!triggerPrefix) {
      logVerbose("AC: owner in non-agent context — no triggerPrefix configured, blocked");
      return result(false, false);
    }
    if (!prefixMatches) {
      logVerbose(`AC: owner in non-agent context — prefix "${triggerPrefix}" not matched, blocked`);
      return result(false, false);
    }
    logVerbose(`AC: owner in non-agent context — prefix "${triggerPrefix}" matched, allowed`);
    return result(true, true);
  }

  // Non-owner in a non-agent group or any other case: blocked.
  logVerbose(`AC: non-owner ${params.senderE164 ?? params.from} in unrecognized context — blocked`);
  return result(false, false);
}

// ─── Internal helper: check sender against upstream allowlists ──────

async function isSenderInAllowList(
  params: {
    from: string;
    senderE164: string | null;
    group: boolean;
    normalizeE164: (input: string) => string | null;
  },
  account: {
    accountId: string;
    dmPolicy?: string;
    allowFrom?: string[];
    groupAllowFrom?: string[];
    groupPolicy?: string;
  },
  cfg: ReturnType<typeof loadConfig>,
  dmPolicy: string,
): Promise<boolean> {
  const configuredAllowFrom = account.allowFrom ?? [];
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "whatsapp",
    accountId: account.accountId,
    dmPolicy,
  });
  const groupAllowFrom =
    account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);
  const allowFrom = params.group ? configuredAllowFrom : configuredAllowFrom;

  const normalizedDmSender = params.normalizeE164(params.from);
  const normalizedGroupSender =
    typeof params.senderE164 === "string" ? params.normalizeE164(params.senderE164) : null;

  const access = resolveDmGroupAccessWithLists({
    isGroup: params.group,
    dmPolicy,
    groupPolicy: account.groupPolicy ?? "allowlist",
    allowFrom,
    groupAllowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowEntries) => {
      if (allowEntries.includes("*")) {
        return true;
      }
      const normalizedEntrySet = new Set(
        allowEntries
          .map((entry) => params.normalizeE164(String(entry)))
          .filter((entry): entry is string => Boolean(entry)),
      );
      return params.group
        ? Boolean(normalizedGroupSender && normalizedEntrySet.has(normalizedGroupSender))
        : Boolean(normalizedDmSender && normalizedEntrySet.has(normalizedDmSender));
    },
  });
  return access.decision === "allow";
}
