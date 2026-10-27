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

// Advertised whenever WhatsApp is configured; react and poll have their own gates.
const ALWAYS_ADVERTISED_ACTIONS = [
  "edit",
  "unsend",
  "reply",
  "renameGroup",
  "setGroupIcon",
  "leaveGroup",
] as const satisfies readonly ChannelMessageActionName[];

// Everything handleAction implements. poll is not here: core sends it through outbound.sendPoll.
const PLUGIN_HANDLED_ACTIONS: ReadonlySet<string> = new Set([
  "react",
  "delete",
  ...ALWAYS_ADVERTISED_ACTIONS,
]);

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
      // FORK 2026-10-03: only actions that reach the live listener (contract:
      // channel.actions-contract.test.ts). Not advertised: sticker (whatsmeow-node uploads no
      // stickers), add/removeParticipant (the Go bridge drops per-participant results, so a
      // refused add would read as success), and group-create, setGroupDescription,
      // promote/demoteParticipant, get/revokeInviteCode, getGroupInfo (not in core's action
      // names, so the runner fails them with "requires a target" before the plugin sees them).
      for (const action of ALWAYS_ADVERTISED_ACTIONS) {
        actions.add(action);
      }
      return { actions: Array.from(actions) };
    },
    supportsAction: ({ action }) => PLUGIN_HANDLED_ACTIONS.has(action),
    // The live WhatsApp socket exists only in the gateway; a CLI `openclaw message edit|delete`
    // runs in its own process, so these route through the gateway's message.action.
    resolveExecutionMode: ({ action }) =>
      PLUGIN_HANDLED_ACTIONS.has(action) ? "gateway" : "local",
    handleAction: async ({ action, params, cfg, accountId }) => {
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
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Delete/unsend message (`delete` is the CLI's name for it)
      if (action === "unsend" || action === "delete") {
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
        const replyToId =
          readStringParam(params, "replyTo") ??
          readStringParam(params, "messageId", { required: true });
        return await handleWhatsAppAction(
          {
            action: "reply",
            to,
            text,
            replyToId,
            quotedFromMe:
              typeof params.quotedFromMe === "boolean" ? params.quotedFromMe : undefined,
            quotedParticipant: readStringParam(params, "quotedParticipant"),
            mediaUrl: readStringParam(params, "mediaUrl"),
            accountId: accountId ?? undefined,
          },
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

      // Leave group
      if (action === "leaveGroup") {
        const groupJid =
          readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        return await handleWhatsAppAction(
          { action: "leaveGroup", groupJid, accountId: accountId ?? undefined },
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
