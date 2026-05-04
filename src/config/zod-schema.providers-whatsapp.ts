import { z } from "zod";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import {
  ChannelHealthMonitorSchema,
  ChannelHeartbeatVisibilitySchema,
} from "./zod-schema.channels.js";
import {
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "./zod-schema.core.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const WhatsAppGroupEntrySchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict()
  .optional();

const WhatsAppGroupsSchema = z.record(z.string(), WhatsAppGroupEntrySchema).optional();

const WhatsAppAckReactionSchema = z
  .object({
    emoji: z.string().optional(),
    direct: z.boolean().optional().default(true),
    group: z.enum(["always", "mentions", "never"]).optional().default("mentions"),
  })
  .strict()
  .optional();

const WhatsAppAckMessageSchema = z
  .object({
    text: z.string().optional(),
    direct: z.boolean().optional().default(true),
    group: z.enum(["always", "mentions", "never"]).optional().default("never"),
  })
  .strict()
  .optional();

const WhatsAppSharedSchema = z.object({
  enabled: z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
  markdown: MarkdownConfigSchema,
  configWrites: z.boolean().optional(),
  sendReadReceipts: z.boolean().optional(),
  messagePrefix: z.string().optional(),
  responsePrefix: z.string().optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  selfChatMode: z.boolean().optional(),
  allowFrom: z.array(z.string()).optional(),
  defaultTo: z.string().optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  triggerPrefix: z.string().optional(),
  triggerPrefixExempt: z.array(z.string()).optional(),
  // FORK 2026-05-03: chats (DM JIDs and/or group JIDs) where no body prefix
  // is required to trigger Jarvis. Outside this list, allowlisted senders
  // (including the owner) must start their message with `triggerPrefix`.
  noPrefixChats: z.array(z.string()).optional(),
  // FORK 2026-05-03: optional security guard prepended to inbound text from
  // third parties (non-owner senders). Two placeholders: {senderName} and
  // {senderId}. Owner messages are never prepended.
  thirdPartyGuardPrompt: z.string().optional(),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  groups: WhatsAppGroupsSchema,
  ackReaction: WhatsAppAckReactionSchema,
  ackMessage: WhatsAppAckMessageSchema,
  reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
  debounceMs: z.number().int().nonnegative().optional().default(0),
  heartbeat: ChannelHeartbeatVisibilitySchema,
  healthMonitor: ChannelHealthMonitorSchema,
});

function enforceOpenDmPolicyAllowFromStar(params: {
  dmPolicy: unknown;
  allowFrom: unknown;
  ctx: z.RefinementCtx;
  message: string;
  path?: Array<string | number>;
}) {
  if (params.dmPolicy !== "open") {
    return;
  }
  const allow = normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : []);
  if (allow.includes("*")) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path ?? ["allowFrom"],
    message: params.message,
  });
}

function enforceAllowlistDmPolicyAllowFrom(params: {
  dmPolicy: unknown;
  allowFrom: unknown;
  ctx: z.RefinementCtx;
  message: string;
  path?: Array<string | number>;
}) {
  if (params.dmPolicy !== "allowlist") {
    return;
  }
  const allow = normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : []);
  if (allow.length > 0) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path ?? ["allowFrom"],
    message: params.message,
  });
}

// FORK: passthrough instead of strict so fork-specific per-account fields
// (backend selector config, custom auth dir variants) don't bomb validation.
export const WhatsAppAccountSchema = WhatsAppSharedSchema.extend({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
  authDir: z.string().optional(),
  mediaMaxMb: z.number().int().positive().optional(),
  syncFullHistory: z.boolean().optional().default(false),
}).passthrough();

// FORK: WhatsAppConfigSchema uses .passthrough() instead of .strict() to
// accommodate fork-specific fields that upstream's schema doesn't know about
// (e.g. engram-related settings, custom backend selector config). The fork's
// runtime still only reads the fields it needs; unknown fields are ignored.
// Upstream's merge gap documentation (MEMORY.md "Config schema merge gap")
// has been flagging this as an open issue since March.
export const WhatsAppConfigSchema = WhatsAppSharedSchema.extend({
  accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
  mediaMaxMb: z.number().int().positive().optional().default(50),
  actions: z
    .object({
      reactions: z.boolean().optional(),
      sendMessage: z.boolean().optional(),
      polls: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  syncFullHistory: z.boolean().optional().default(false),
})
  .passthrough()
  .superRefine((value, ctx) => {
    enforceOpenDmPolicyAllowFromStar({
      dmPolicy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      message:
        'channels.whatsapp.dmPolicy="open" requires channels.whatsapp.allowFrom to include "*"',
    });
    enforceAllowlistDmPolicyAllowFrom({
      dmPolicy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      message:
        'channels.whatsapp.dmPolicy="allowlist" requires channels.whatsapp.allowFrom to contain at least one sender ID',
    });
    if (!value.accounts) {
      return;
    }
    for (const [accountId, account] of Object.entries(value.accounts)) {
      if (!account) {
        continue;
      }
      const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
      const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
      enforceOpenDmPolicyAllowFromStar({
        dmPolicy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.whatsapp.accounts.*.dmPolicy="open" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to include "*"',
      });
      enforceAllowlistDmPolicyAllowFrom({
        dmPolicy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.whatsapp.accounts.*.dmPolicy="allowlist" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to contain at least one sender ID',
      });
    }
  });
