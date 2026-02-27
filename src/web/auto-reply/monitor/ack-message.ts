import type { WhatsAppAckMessageConfig } from "../../../config/types.whatsapp.js";
import type { loadConfig } from "../../../config/config.js";
import { logVerbose } from "../../../globals.js";
import { sendMessageWhatsApp } from "../../outbound.js";
import { formatError } from "../../session.js";
import type { WebInboundMsg } from "../types.js";
import { resolveGroupActivationFor } from "./group-activation.js";

function shouldSendAckMessage(params: {
  text: string;
  isDirect: boolean;
  isGroup: boolean;
  directEnabled: boolean;
  groupMode: NonNullable<WhatsAppAckMessageConfig["group"]>;
  wasMentioned: boolean;
  groupActivated: boolean;
}): boolean {
  if (!params.text) {
    return false;
  }
  if (params.isDirect) {
    return params.directEnabled;
  }
  if (!params.isGroup) {
    return false;
  }
  if (params.groupMode === "never") {
    return false;
  }
  if (params.groupMode === "always") {
    return true;
  }
  // "mentions" mode
  return params.wasMentioned || params.groupActivated;
}

export function maybeSendAckMessage(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  verbose: boolean;
  accountId?: string;
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}) {
  const ackConfig = params.cfg.channels?.whatsapp?.ackMessage;
  const text = (ackConfig?.text ?? "").trim();
  if (!text) {
    return;
  }

  const directEnabled = ackConfig?.direct ?? true;
  const groupMode = ackConfig?.group ?? "never";
  const conversationIdForCheck = params.msg.conversationId ?? params.msg.from;

  const activation =
    params.msg.chatType === "group"
      ? resolveGroupActivationFor({
          cfg: params.cfg,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          conversationId: conversationIdForCheck,
        })
      : null;

  if (
    !shouldSendAckMessage({
      text,
      isDirect: params.msg.chatType === "direct",
      isGroup: params.msg.chatType === "group",
      directEnabled,
      groupMode,
      wasMentioned: params.msg.wasMentioned === true,
      groupActivated: activation === "always",
    })
  ) {
    return;
  }

  params.info(
    { chatId: params.msg.chatId, text },
    "sending ack message",
  );

  sendMessageWhatsApp(params.msg.chatId, text, {
    verbose: params.verbose,
    accountId: params.accountId,
  }).catch((err) => {
    params.warn(
      {
        error: formatError(err),
        chatId: params.msg.chatId,
      },
      "failed to send ack message",
    );
    logVerbose(`WhatsApp ack message failed for chat ${params.msg.chatId}: ${formatError(err)}`);
  });
}
