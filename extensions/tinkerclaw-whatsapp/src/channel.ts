import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { chunkText } from "openclaw/plugin-sdk/reply-runtime";
// WhatsApp-specific imports from local extension code (moved from src/web/ and src/channels/plugins/)
import {
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
  type ResolvedWhatsAppAccount,
} from "./accounts.js";
// FORK: whatsmeow login — side-effect import forces bundler inclusion
import "./login-qr-wm.js";
import { handleWhatsAppAction } from "./action-runtime.js";
import { createWhatsAppLoginTool } from "./agent-tools-login.js";
import type { WebChannelStatus } from "./auto-reply/types.js";
// FORK 2026-05-01: backend selector decides Baileys vs. whatsmeow at startAccount.
import { isWhatsmeowBackend } from "./backend-selector.js";
import {
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./directory-config.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import { startWebLoginWithQr as startWebLoginWithQrWm, waitForWebLoginWm } from "./login-qr-wm.js";
import { looksLikeWhatsAppTargetId, normalizeWhatsAppMessagingTarget } from "./normalize.js";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";
import {
  createActionGate,
  createWhatsAppOutboundBase,
  DEFAULT_ACCOUNT_ID,
  formatWhatsAppConfigAllowFromEntries,
  readStringParam,
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppOutboundTarget,
  resolveWhatsAppHeartbeatRecipients,
  resolveWhatsAppMentionStripRegexes,
  type ChannelMessageActionName,
  type ChannelPlugin,
  type OpenClawConfig,
  isWhatsAppGroupJid,
  normalizeWhatsAppTarget,
} from "./runtime-api.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { sendMessageWhatsApp, sendPollWhatsApp } from "./send.js";
import { resolveWhatsAppOutboundSessionRoute } from "./session-route.js";
import { whatsappSetupAdapter } from "./setup-core.js";
import {
  createWhatsAppPluginBase,
  loadWhatsAppChannelRuntime,
  whatsappSetupWizardProxy,
} from "./shared.js";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

function normalizeWhatsAppPayloadText(text: string | undefined): string {
  return (text ?? "").replace(/^(?:[ \t]*\r?\n)+/, "");
}

function parseWhatsAppExplicitTarget(raw: string) {
  const normalized = normalizeWhatsAppTarget(raw);
  if (!normalized) {
    return null;
  }
  return {
    to: normalized,
    chatType: isWhatsAppGroupJid(normalized) ? ("group" as const) : ("direct" as const),
  };
}

function areWhatsAppAgentReactionsEnabled(params: { cfg: OpenClawConfig; accountId?: string }) {
  if (!params.cfg.channels?.whatsapp) {
    return false;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return false;
  }
  return resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  }).agentReactionsEnabled;
}

function hasAnyWhatsAppAccountWithAgentReactionsEnabled(cfg: OpenClawConfig) {
  if (!cfg.channels?.whatsapp) {
    return false;
  }
  return listWhatsAppAccountIds(cfg).some((accountId) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    if (!account.enabled) {
      return false;
    }
    return areWhatsAppAgentReactionsEnabled({
      cfg,
      accountId,
    });
  });
}

function resolveWhatsAppAgentReactionGuidance(params: { cfg: OpenClawConfig; accountId?: string }) {
  if (!params.cfg.channels?.whatsapp) {
    return undefined;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return undefined;
  }
  const resolved = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!resolved.agentReactionsEnabled) {
    return undefined;
  }
  return resolved.agentReactionGuidance;
}

export const whatsappPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  ...createWhatsAppPluginBase({
    groups: {
      resolveRequireMention: resolveWhatsAppGroupRequireMention,
      resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
      resolveGroupIntroHint: resolveWhatsAppGroupIntroHint,
    },
    setupWizard: whatsappSetupWizardProxy,
    setup: whatsappSetupAdapter,
    isConfigured: async (account) =>
      await (await loadWhatsAppChannelRuntime()).webAuthExists(account.authDir),
  }),
  agentTools: () => [createWhatsAppLoginTool()],
  pairing: {
    idLabel: "whatsappSenderId",
  },
  allowlist: buildDmGroupAccountAllowlistAdapter({
    channelId: "whatsapp",
    resolveAccount: ({ cfg, accountId }) => resolveWhatsAppAccount({ cfg, accountId }),
    normalize: ({ values }) => formatWhatsAppConfigAllowFromEntries(values),
    resolveDmAllowFrom: (account) => account.allowFrom,
    resolveGroupAllowFrom: (account) => account.groupAllowFrom,
    resolveDmPolicy: (account) => account.dmPolicy,
    resolveGroupPolicy: (account) => account.groupPolicy,
  }),
  mentions: {
    stripRegexes: ({ ctx }) => resolveWhatsAppMentionStripRegexes(ctx),
  },
  commands: {
    enforceOwnerForCommands: true,
    skipWhenConfigEmpty: true,
  },
  messaging: {
    normalizeTarget: normalizeWhatsAppMessagingTarget,
    resolveOutboundSessionRoute: (params) => resolveWhatsAppOutboundSessionRoute(params),
    parseExplicitTarget: ({ raw }) => parseWhatsAppExplicitTarget(raw),
    inferTargetChatType: ({ to }) => parseWhatsAppExplicitTarget(to)?.chatType,
    targetResolver: {
      looksLikeId: looksLikeWhatsAppTargetId,
      hint: "<E.164|group JID>",
    },
  },
  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveWhatsAppAccount({ cfg, accountId });
      const { e164, jid } = (await loadWhatsAppChannelRuntime()).readWebSelfId(account.authDir);
      const id = e164 ?? jid;
      if (!id) {
        return null;
      }
      return {
        kind: "user",
        id,
        name: account.name,
        raw: { e164, jid },
      };
    },
    listPeers: async (params) => listWhatsAppDirectoryPeersFromConfig(params),
    listGroups: async (params) => listWhatsAppDirectoryGroupsFromConfig(params),
  },
  agentPrompt: {
    reactionGuidance: ({ cfg, accountId }) => {
      const level = resolveWhatsAppAgentReactionGuidance({
        cfg,
        accountId: accountId ?? undefined,
      });
      return level ? { level, channelLabel: "WhatsApp" } : undefined;
    },
  },
  actions: {
    describeMessageTool: ({ cfg, accountId }) => {
      if (!cfg.channels?.whatsapp) {
        return null;
      }
      const gate = createActionGate(cfg.channels.whatsapp.actions);
      const actions = new Set<ChannelMessageActionName>();
      const canReact =
        accountId != null
          ? areWhatsAppAgentReactionsEnabled({
              cfg,
              accountId: accountId ?? undefined,
            })
          : hasAnyWhatsAppAccountWithAgentReactionsEnabled(cfg);
      if (canReact) {
        actions.add("react");
      }
      if (gate("polls")) {
        actions.add("poll");
      }
      // Always available when WhatsApp is configured
      actions.add("group-create");
      actions.add("edit");
      actions.add("unsend");
      actions.add("reply");
      actions.add("sticker");
      actions.add("renameGroup");
      actions.add("setGroupIcon");
      actions.add("setGroupDescription");
      actions.add("addParticipant");
      actions.add("removeParticipant");
      actions.add("promoteParticipant");
      actions.add("demoteParticipant");
      actions.add("leaveGroup");
      actions.add("getInviteCode");
      actions.add("revokeInviteCode");
      actions.add("getGroupInfo");
      return { actions: Array.from(actions) };
    },
    supportsAction: ({ action }) => {
      const supported = [
        "react",
        "group-create",
        "edit",
        "unsend",
        "reply",
        "sticker",
        "renameGroup",
        "setGroupIcon",
        "setGroupDescription",
        "addParticipant",
        "removeParticipant",
        "promoteParticipant",
        "demoteParticipant",
        "leaveGroup",
        "getInviteCode",
        "revokeInviteCode",
        "getGroupInfo",
      ];
      return supported.includes(action);
    },
    handleAction: async ({ action, params, cfg, accountId }) => {
      // Group creation
      if (action === "group-create") {
        const name = readStringParam(params, "name", { required: true });
        const participantsRaw = params.participants;
        let participants: string[] = [];
        if (Array.isArray(participantsRaw)) {
          participants = participantsRaw.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof participantsRaw === "string") {
          try {
            const parsed = JSON.parse(participantsRaw);
            if (Array.isArray(parsed)) {
              participants = parsed.map((p) => String(p).trim()).filter(Boolean);
            }
          } catch {
            // Not JSON, try comma-separated
            participants = participantsRaw
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
          }
        }

        if (participants.length === 0) {
          return {
            content: [
              { type: "text", text: "Error: participants array is required (E.164 format)" },
            ],
          };
        }

        return await handleWhatsAppAction(
          { action: "group-create", name, participants, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Edit message
      if (action === "edit") {
        const chatJid =
          readStringParam(params, "chatJid") ?? readStringParam(params, "to", { required: true });
        const messageId = readStringParam(params, "messageId", { required: true });
        const newText =
          readStringParam(params, "message") ?? readStringParam(params, "text", { required: true });
        return await handleWhatsAppAction(
          {
            action: "edit",
            chatJid,
            messageId,
            newText,
            fromMe: typeof params.fromMe === "boolean" ? params.fromMe : true,
            participant: readStringParam(params, "participant"),
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Delete/unsend message
      if (action === "unsend") {
        const chatJid =
          readStringParam(params, "chatJid") ?? readStringParam(params, "to", { required: true });
        const messageId = readStringParam(params, "messageId", { required: true });
        return await handleWhatsAppAction(
          {
            action: "unsend",
            chatJid,
            messageId,
            fromMe: typeof params.fromMe === "boolean" ? params.fromMe : true,
            participant: readStringParam(params, "participant"),
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Reply to message (quote)
      if (action === "reply") {
        const to = readStringParam(params, "to", { required: true });
        const text =
          readStringParam(params, "message") ?? readStringParam(params, "text", { required: true });
        const quotedMessageId =
          readStringParam(params, "replyTo") ??
          readStringParam(params, "messageId", { required: true });
        const quotedFromMe = typeof params.quotedFromMe === "boolean" ? params.quotedFromMe : false;
        const quotedParticipant = readStringParam(params, "quotedParticipant");
        return await handleWhatsAppAction(
          {
            action: "reply",
            to,
            text,
            quotedKey: {
              remoteJid: to,
              id: quotedMessageId,
              fromMe: quotedFromMe,
              participant: quotedParticipant,
            },
            mediaUrl: readStringParam(params, "mediaUrl"),
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Send sticker
      if (action === "sticker") {
        const to = readStringParam(params, "to", { required: true });
        const stickerPath =
          readStringParam(params, "filePath") ??
          readStringParam(params, "path", { required: true });
        return await handleWhatsAppAction(
          { action: "sticker", to, stickerPath, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Rename group
      if (action === "renameGroup") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const newName = readStringParam(params, "name", { required: true });
        return await handleWhatsAppAction(
          { action: "renameGroup", groupJid, newName, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Set group icon
      if (action === "setGroupIcon") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const imagePath =
          readStringParam(params, "filePath") ??
          readStringParam(params, "path", { required: true });
        return await handleWhatsAppAction(
          { action: "setGroupIcon", groupJid, imagePath, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Add participants
      if (action === "addParticipant") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const participantsRaw = params.participants;
        let participants: string[] = [];
        if (Array.isArray(participantsRaw)) {
          participants = participantsRaw.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof participantsRaw === "string") {
          try {
            const parsed = JSON.parse(participantsRaw);
            if (Array.isArray(parsed)) {
              participants = parsed.map((p) => String(p).trim()).filter(Boolean);
            }
          } catch {
            participants = participantsRaw
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
          }
        }
        if (participants.length === 0) {
          return { content: [{ type: "text", text: "Error: participants array required" }] };
        }
        return await handleWhatsAppAction(
          { action: "addParticipant", groupJid, participants, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Remove participants
      if (action === "removeParticipant") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const participantsRaw = params.participants;
        let participants: string[] = [];
        if (Array.isArray(participantsRaw)) {
          participants = participantsRaw.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof participantsRaw === "string") {
          try {
            const parsed = JSON.parse(participantsRaw);
            if (Array.isArray(parsed)) {
              participants = parsed.map((p) => String(p).trim()).filter(Boolean);
            }
          } catch {
            participants = participantsRaw
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
          }
        }
        if (participants.length === 0) {
          return { content: [{ type: "text", text: "Error: participants array required" }] };
        }
        return await handleWhatsAppAction(
          {
            action: "removeParticipant",
            groupJid,
            participants,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Leave group
      if (action === "leaveGroup") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        return await handleWhatsAppAction(
          { action: "leaveGroup", groupJid, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Set group description
      if (action === "setGroupDescription") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const description = readStringParam(params, "description", { required: true });
        return await handleWhatsAppAction(
          {
            action: "setGroupDescription",
            groupJid,
            description,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Promote participants to admin
      if (action === "promoteParticipant") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const participantsRaw = params.participants;
        let participants: string[] = [];
        if (Array.isArray(participantsRaw)) {
          participants = participantsRaw.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof participantsRaw === "string") {
          try {
            const parsed = JSON.parse(participantsRaw);
            if (Array.isArray(parsed)) {
              participants = parsed.map((p) => String(p).trim()).filter(Boolean);
            }
          } catch {
            participants = participantsRaw
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
          }
        }
        if (participants.length === 0) {
          return { content: [{ type: "text", text: "Error: participants array required" }] };
        }
        return await handleWhatsAppAction(
          {
            action: "promoteParticipant",
            groupJid,
            participants,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Demote participants from admin
      if (action === "demoteParticipant") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const participantsRaw = params.participants;
        let participants: string[] = [];
        if (Array.isArray(participantsRaw)) {
          participants = participantsRaw.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof participantsRaw === "string") {
          try {
            const parsed = JSON.parse(participantsRaw);
            if (Array.isArray(parsed)) {
              participants = parsed.map((p) => String(p).trim()).filter(Boolean);
            }
          } catch {
            participants = participantsRaw
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
          }
        }
        if (participants.length === 0) {
          return { content: [{ type: "text", text: "Error: participants array required" }] };
        }
        return await handleWhatsAppAction(
          {
            action: "demoteParticipant",
            groupJid,
            participants,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Get invite code
      if (action === "getInviteCode") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        return await handleWhatsAppAction(
          { action: "getInviteCode", groupJid, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Revoke invite code
      if (action === "revokeInviteCode") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        return await handleWhatsAppAction(
          { action: "revokeInviteCode", groupJid, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Get group info/metadata
      if (action === "getGroupInfo") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        return await handleWhatsAppAction(
          { action: "getGroupInfo", groupJid, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // React (existing)
      if (action === "react") {
        const messageId = readStringParam(params, "messageId", { required: true });
        const emoji = readStringParam(params, "emoji", { allowEmpty: true });
        const remove = typeof params.remove === "boolean" ? params.remove : undefined;
        return await handleWhatsAppAction(
          {
            action: "react",
            chatJid:
              readStringParam(params, "chatJid") ??
              readStringParam(params, "to", { required: true }),
            messageId,
            emoji,
            remove,
            participant: readStringParam(params, "participant"),
            accountId: accountId ?? undefined,
            fromMe: typeof params.fromMe === "boolean" ? params.fromMe : undefined,
          },
          cfg,
        );
      }

      throw new Error(`Action ${action} is not supported for provider ${meta.id}.`);
    },
  },
  outbound: {
    ...createWhatsAppOutboundBase({
      chunker: (text, limit) => chunkText(text, limit),
      sendMessageWhatsApp: async (...args) => await sendMessageWhatsApp(...args),
      sendPollWhatsApp: async (...args) => await sendPollWhatsApp(...args),
      shouldLogVerbose: () => getWhatsAppRuntime().logging.shouldLogVerbose(),
      resolveTarget: ({ to, allowFrom, mode }) =>
        resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
    }),
    normalizePayload: ({ payload }) => ({
      ...payload,
      text: normalizeWhatsAppPayloadText(payload.text),
    }),
  },
  auth: {
    login: async ({ cfg, accountId, runtime, verbose }) => {
      const resolvedAccountId =
        accountId?.trim() || whatsappPlugin.config.defaultAccountId?.(cfg) || DEFAULT_ACCOUNT_ID;
      await (
        await loadWhatsAppChannelRuntime()
      ).loginWeb(Boolean(verbose), undefined, runtime, resolvedAccountId);
    },
  },
  heartbeat: {
    checkReady: async ({ cfg, accountId, deps }) => {
      if (cfg.web?.enabled === false) {
        return { ok: false, reason: "whatsapp-disabled" };
      }
      const account = resolveWhatsAppAccount({ cfg, accountId });
      const authExists = await (
        deps?.webAuthExists ?? (await loadWhatsAppChannelRuntime()).webAuthExists
      )(account.authDir);
      if (!authExists) {
        return { ok: false, reason: "whatsapp-not-linked" };
      }
      const listenerActive = deps?.hasActiveWebListener
        ? deps.hasActiveWebListener()
        : Boolean((await loadWhatsAppChannelRuntime()).getActiveWebListener());
      if (!listenerActive) {
        return { ok: false, reason: "whatsapp-not-running" };
      }
      return { ok: true, reason: "ok" };
    },
    resolveRecipients: ({ cfg, opts }) => resolveWhatsAppHeartbeatRecipients(cfg, opts),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastMessageAt: null,
      lastEventAt: null,
      lastError: null,
    },
    collectStatusIssues: collectWhatsAppStatusIssues,
    buildChannelSummary: async ({ account, snapshot }) => {
      const authDir = account.authDir;
      const linked =
        typeof snapshot.linked === "boolean"
          ? snapshot.linked
          : authDir
            ? await (await loadWhatsAppChannelRuntime()).webAuthExists(authDir)
            : false;
      const authAgeMs =
        linked && authDir ? (await loadWhatsAppChannelRuntime()).getWebAuthAgeMs(authDir) : null;
      const self =
        linked && authDir
          ? (await loadWhatsAppChannelRuntime()).readWebSelfId(authDir)
          : { e164: null, jid: null };
      return {
        configured: linked,
        linked,
        authAgeMs,
        self,
        running: snapshot.running ?? false,
        connected: snapshot.connected ?? false,
        lastConnectedAt: snapshot.lastConnectedAt ?? null,
        lastDisconnect: snapshot.lastDisconnect ?? null,
        reconnectAttempts: snapshot.reconnectAttempts,
        lastMessageAt: snapshot.lastMessageAt ?? null,
        lastEventAt: snapshot.lastEventAt ?? null,
        lastError: snapshot.lastError ?? null,
      };
    },
    buildAccountSnapshot: async ({ account, runtime }) => {
      const linked = await (await loadWhatsAppChannelRuntime()).webAuthExists(account.authDir);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: true,
        linked,
        running: runtime?.running ?? false,
        connected: runtime?.connected ?? false,
        reconnectAttempts: runtime?.reconnectAttempts,
        lastConnectedAt: runtime?.lastConnectedAt ?? null,
        lastDisconnect: runtime?.lastDisconnect ?? null,
        lastMessageAt: runtime?.lastMessageAt ?? null,
        lastEventAt: runtime?.lastEventAt ?? null,
        lastError: runtime?.lastError ?? null,
        dmPolicy: account.dmPolicy,
        allowFrom: account.allowFrom,
      };
    },
    resolveAccountState: ({ configured }) => (configured ? "linked" : "not linked"),
    logSelfId: ({ account, runtime, includeChannelPrefix }) => {
      void loadWhatsAppChannelRuntime().then((runtimeExports) =>
        runtimeExports.logWebSelfId(account.authDir, runtime, includeChannelPrefix),
      );
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      // FORK 2026-05-01: route to whatsmeow monitor when the backend env flag
      // is set; the Baileys monitor would no-op against the missing creds.json
      // and leave connected:false forever after a successful QR pair.
      if (isWhatsmeowBackend()) {
        ctx.log?.info(`[${account.accountId}] starting provider (whatsmeow)`);
        const { monitorWebChannelWm } = await import("./auto-reply/monitor-wm.js");
        return monitorWebChannelWm(
          getWhatsAppRuntime().logging.shouldLogVerbose(),
          undefined,
          true,
          undefined,
          ctx.runtime,
          ctx.abortSignal,
          {
            statusSink: (next: WebChannelStatus) =>
              ctx.setStatus({ accountId: ctx.accountId, ...next }),
            accountId: account.accountId,
          },
        );
      }
      const { e164, jid } = (await loadWhatsAppChannelRuntime()).readWebSelfId(account.authDir);
      const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
      ctx.log?.info(`[${account.accountId}] starting provider (${identity})`);
      return (await loadWhatsAppChannelRuntime()).monitorWebChannel(
        getWhatsAppRuntime().logging.shouldLogVerbose(),
        undefined,
        true,
        undefined,
        ctx.runtime,
        ctx.abortSignal,
        {
          statusSink: (next: WebChannelStatus) =>
            ctx.setStatus({ accountId: ctx.accountId, ...next }),
          accountId: account.accountId,
        },
      );
    },
    loginWithQrStart: async ({ accountId, force, timeoutMs, verbose }) => {
      // FORK: whatsmeow backend support
      if (
        process.env.OPENCLAW_WHATSAPP_BACKEND?.toLowerCase().trim() === "whatsmeow" ||
        process.env.OPENCLAW_WHATSAPP_BACKEND?.toLowerCase().trim() === "wm"
      ) {
        return startWebLoginWithQrWm({
          accountId,
          force,
          timeoutMs,
          verbose,
        });
      }
      return (await loadWhatsAppChannelRuntime()).startWebLoginWithQr({
        accountId,
        force,
        timeoutMs,
        verbose,
      });
    },
    loginWithQrWait: async ({ accountId, timeoutMs }) => {
      if (
        process.env.OPENCLAW_WHATSAPP_BACKEND?.toLowerCase().trim() === "whatsmeow" ||
        process.env.OPENCLAW_WHATSAPP_BACKEND?.toLowerCase().trim() === "wm"
      ) {
        return waitForWebLoginWm({ accountId, timeoutMs });
      }
      return (await loadWhatsAppChannelRuntime()).waitForWebLogin({ accountId, timeoutMs });
    },
    logoutAccount: async ({ account, runtime }) => {
      const cleared = await (
        await loadWhatsAppChannelRuntime()
      ).logoutWeb({
        authDir: account.authDir,
        isLegacyAuthDir: account.isLegacyAuthDir,
        runtime,
      });
      return { cleared, loggedOut: cleared };
    },
  },
};
