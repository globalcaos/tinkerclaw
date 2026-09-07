/**
 * FORK 2026-05-01: WhatsApp web channel monitor — whatsmeow-node variant.
 *
 * Parallel to ./monitor.ts (Baileys), invoked by `gateway.startAccount`
 * in `../channel.ts` when `OPENCLAW_WHATSAPP_BACKEND=whatsmeow|wm`.
 *
 * Why this exists: Baileys' monitor.ts opens a WebSocket against the cached
 * `creds.json`. The whatsmeow backend has no such file (it owns its session
 * state in `whatsmeow.db` and runs a Go subprocess), so attempting to drive
 * it via the Baileys monitor either no-ops or trips terminal auth errors,
 * leaving `connected:false` forever. This file boots the whatsmeow socket
 * via `createWmMonitorSocket` (which spawns the Go process, connects, and
 * binds history live-capture), wraps it in the Baileys-shaped adapter, and
 * delegates inbound handling to the existing `attachWebInboxToSocket` so
 * we share all message-processing logic (debouncer, dedupe, access-control,
 * group-history, echo tracker, auto-reply) with the Baileys path.
 *
 * What this file deliberately drops vs. monitor.ts:
 *   - SIGINT trap, `WhatsAppConnectionController`, watchdog, heartbeat,
 *     `drainPendingDeliveries`, unhandled-rejection guard, MaxListeners bump.
 *   The whatsmeow client owns its own keep-alive/heartbeat in the Go subprocess;
 *   the Node side just consumes events. The reconnect loop here is the
 *   minimum needed to surface `connected:true` and recover from transient
 *   subprocess restarts.
 *
 * Wired in: `../channel.ts:gateway.startAccount` selects this via
 *           `isWhatsmeowBackend()` from `../backend-selector.ts`.
 */

import { resolveInboundDebounceMs } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  defaultRuntime,
  formatDurationPrecise,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount, resolveWhatsAppMediaMaxBytes } from "../accounts.js";
import {
  registerWhatsAppConnectionController,
  unregisterWhatsAppConnectionController,
  type WhatsAppConnectionControllerHandle,
} from "../connection-controller-registry.js";
import { createWmMonitorSocket } from "../inbound/monitor-wm.js";
import { attachWebInboxToSocket } from "../inbound/monitor.js";
import type { ActiveWebListener } from "../inbound/types.js";
import {
  computeBackoff,
  newConnectionId,
  resolveReconnectPolicy,
  sleepWithAbort,
} from "../reconnect.js";
import { disconnectWmClient } from "../session-wm.js";
import { formatError, getStatusCode } from "../session.js";
import { getRuntimeConfig } from "./config.runtime.js";
import { whatsappLog } from "./loggers.js";
import { buildMentionConfig } from "./mentions.js";
import { createWebChannelStatusController } from "./monitor-state.js";
import { createEchoTracker } from "./monitor/echo.js";
import { createWebOnMessageHandler } from "./monitor/on-message.js";
import type { WebInboundMsg, WebMonitorTuning } from "./types.js";

type ReplyResolver = typeof import("./reply-resolver.runtime.js").getReplyFromConfig;

let replyResolverRuntimePromise: Promise<typeof import("./reply-resolver.runtime.js")> | null =
  null;

function loadReplyResolverRuntime() {
  replyResolverRuntimePromise ??= import("./reply-resolver.runtime.js");
  return replyResolverRuntimePromise;
}

const LOGGED_OUT_STATUS = 401;

export async function monitorWebChannelWm(
  verbose: boolean,
  listenerFactory: typeof attachWebInboxToSocket | undefined = attachWebInboxToSocket,
  keepAlive = true,
  replyResolver?: ReplyResolver,
  runtime: RuntimeEnv = defaultRuntime,
  abortSignal?: AbortSignal,
  tuning: WebMonitorTuning = {},
) {
  const activeReplyResolver =
    replyResolver ?? (await loadReplyResolverRuntime()).getReplyFromConfig;
  const runId = newConnectionId();
  const replyLogger = getChildLogger({ module: "web-auto-reply", runId });
  const reconnectLogger = getChildLogger({ module: "wm-web-reconnect", runId });
  const statusController = createWebChannelStatusController(tuning.statusSink);
  statusController.emit();

  const baseCfg = getRuntimeConfig();
  const account = resolveWhatsAppAccount({
    cfg: baseCfg,
    accountId: tuning.accountId,
  });
  // FORK 2026-05-01: same overlay shape as monitor.ts so downstream handlers
  // observe per-account ackReaction/messagePrefix/allowFrom/etc.
  const cfg = {
    ...baseCfg,
    channels: {
      ...baseCfg.channels,
      whatsapp: {
        ...baseCfg.channels?.whatsapp,
        ackReaction: account.ackReaction,
        messagePrefix: account.messagePrefix,
        allowFrom: account.allowFrom,
        groupAllowFrom: account.groupAllowFrom,
        groupPolicy: account.groupPolicy,
        textChunkLimit: account.textChunkLimit,
        chunkMode: account.chunkMode,
        mediaMaxMb: account.mediaMaxMb,
        blockStreaming: account.blockStreaming,
        groups: account.groups,
      },
    },
  } satisfies ReturnType<typeof getRuntimeConfig>;

  const maxMediaBytes = resolveWhatsAppMediaMaxBytes(account);
  const reconnectPolicy = resolveReconnectPolicy(cfg, tuning.reconnect);
  const baseMentionConfig = buildMentionConfig(cfg);
  const groupHistoryLimit =
    account.historyLimit ??
    cfg.channels?.whatsapp?.historyLimit ??
    cfg.messages?.groupChat?.historyLimit ??
    DEFAULT_GROUP_HISTORY_LIMIT;
  const groupHistories = new Map<
    string,
    Array<{
      sender: string;
      body: string;
      timestamp?: number;
      id?: string;
      senderJid?: string;
    }>
  >();
  const groupMemberNames = new Map<string, Map<string, string>>();
  const echoTracker = createEchoTracker({ maxItems: 100, logVerbose });

  const sleep =
    tuning.sleep ??
    ((ms: number, signal?: AbortSignal) => sleepWithAbort(ms, signal ?? abortSignal));
  const stopRequested = () => abortSignal?.aborted === true;

  let reconnectAttempts = 0;
  let terminal = false;

  try {
    while (!stopRequested() && !terminal) {
      const connectionId = newConnectionId();
      const inboundDebounceMs = resolveInboundDebounceMs({
        cfg,
        channel: "whatsapp",
      });
      const shouldDebounce = (msg: WebInboundMsg) => {
        if (msg.mediaPath || msg.mediaType) {
          return false;
        }
        if (msg.location) {
          return false;
        }
        if (msg.replyToId || msg.replyToBody) {
          return false;
        }
        return !hasControlCommand(msg.body, cfg);
      };

      // FORK 2026-05-01: spawn the whatsmeow Go subprocess + adapter; failure
      // here (no stored session, addon missing, etc.) is terminal — don't loop
      // until the user re-pairs via the QR flow.
      let session: { adapter: ReturnType<typeof Object> } & Awaited<
        ReturnType<typeof createWmMonitorSocket>
      >;
      let socket: Awaited<ReturnType<typeof createWmMonitorSocket>>;
      try {
        socket = await createWmMonitorSocket({
          verbose,
          authDir: account.authDir,
        });
        session = socket as typeof session;
      } catch (error) {
        const errText = formatError(error);
        // FORK 2026-08-29: reap the Go subprocess before bailing out.
        //
        // createWmMonitorSocket spawns whatsmeow-node and only THEN connects, so
        // a connect failure lands here with the child already running. This path
        // used to `break` without terminating it, orphaning one Go process per
        // attempt — each holding the store's SQLite file open. With the channel
        // failing every ~40s that reached 25 live processes in a single session.
        // disconnectWmClient() falls back to the module-level active client,
        // which is what we need since `socket` was never assigned.
        await disconnectWmClient().catch(() => {});
        reconnectLogger.error(
          { connectionId, accountId: account.accountId, error: errText },
          "wm monitor: failed to create whatsmeow socket; treating as terminal",
        );
        statusController.noteClose({
          loggedOut: false,
          error: errText,
          reconnectAttempts,
          healthState: "stopped",
        });
        // Only suggest relinking when a QR would actually help. WhatsApp refuses
        // to issue one to an outdated client, so telling the architect to scan
        // was a month of misdirection.
        const relinkHint = errText.includes("err-client-outdated")
          ? "Relinking will NOT help: WhatsApp is rejecting this client build as outdated."
          : "Use the Relink button to scan a new QR code.";
        runtime.error(`WhatsApp (whatsmeow) failed to start: ${errText}. ${relinkHint}`);
        terminal = true;
        break;
      }

      const adapter = session.adapter as Parameters<typeof attachWebInboxToSocket>[0]["sock"];
      const wmClient = session.client;

      // FORK 2026-05-01: capture the close reason from the adapter's bridged
      // connection.update events. The adapter already maps whatsmeow
      // disconnected/logged_out -> connection:"close" + lastDisconnect.error,
      // so we just observe and forward.
      let closeReason: { isLoggedOut: boolean; status?: number; error?: unknown } | null = null;
      let resolveCloseSignal: (() => void) | null = null;
      const closeSignal = new Promise<void>((resolve) => {
        resolveCloseSignal = resolve;
      });
      const finalizeClose = (reason: typeof closeReason) => {
        if (closeReason) {
          return;
        }
        closeReason = reason;
        if (resolveCloseSignal) {
          const r = resolveCloseSignal;
          resolveCloseSignal = null;
          r();
        }
      };

      // biome-ignore lint/suspicious/noExplicitAny: bridged event payload
      adapter.ev.on("connection.update", (update: any) => {
        try {
          if (update?.connection === "open") {
            statusController.noteReconnectAttempts(reconnectAttempts);
            statusController.noteConnected();
            whatsappLog.info(`WhatsApp (whatsmeow) connected (account=${account.accountId}).`);
            reconnectAttempts = 0;
          } else if (update?.connection === "close") {
            const status = getStatusCode(update.lastDisconnect?.error);
            finalizeClose({
              isLoggedOut: status === LOGGED_OUT_STATUS,
              status,
              error: update.lastDisconnect?.error,
            });
          }
        } catch (err) {
          reconnectLogger.error({ error: String(err) }, "wm connection.update handler error");
          finalizeClose({ isLoggedOut: false, error: err });
        }
      });

      // FORK 2026-05-01: seed connected:true. createWmMonitorSocket awaits
      // connectWmClient before returning, so by the time we reach this line
      // the whatsmeow client has already fired its "connected" event — which
      // the adapter bridged into connection.update("open"), but our listener
      // wasn't attached yet (the adapter is constructed and event-wired
      // synchronously inside createBaileysAdapter, which runs *after* connect).
      // Without this seed the channels.status probe stays at connected:false
      // forever. Subsequent reconnects DO see the bridged event because the
      // listener is attached before createWmMonitorSocket runs again.
      statusController.noteReconnectAttempts(reconnectAttempts);
      statusController.noteConnected();
      whatsappLog.info(`WhatsApp (whatsmeow) connected (account=${account.accountId}, seeded).`);
      reconnectAttempts = 0;

      // FORK 2026-05-01: build the same on-message pipeline the Baileys monitor
      // uses; everything below the adapter is backend-agnostic.
      const backgroundTasks = new Set<Promise<unknown>>();
      const onMessage = createWebOnMessageHandler({
        cfg,
        verbose,
        connectionId,
        maxMediaBytes,
        groupHistoryLimit,
        groupHistories,
        groupMemberNames,
        echoTracker,
        backgroundTasks,
        replyResolver: activeReplyResolver,
        replyLogger,
        baseMentionConfig,
        account,
      });

      let listener: Awaited<ReturnType<typeof attachWebInboxToSocket>>;
      // FORK 2026-05-01: register an ActiveWebListener handle so `send.ts`
      // (the outbound path) can find us. Without this, `send.ts:50` throws
      // "No active WhatsApp Web listener (account: default)" even though
      // inbound + history-sync are wired and flowing.
      let activeListenerForOutbound: ActiveWebListener | null = null;
      const controllerHandle: WhatsAppConnectionControllerHandle = {
        getActiveListener: () => activeListenerForOutbound,
      };
      try {
        listener = await (listenerFactory ?? attachWebInboxToSocket)({
          cfg,
          verbose,
          accountId: account.accountId,
          authDir: account.authDir,
          mediaMaxMb: account.mediaMaxMb,
          sendReadReceipts: account.sendReadReceipts,
          debounceMs: inboundDebounceMs,
          shouldDebounce,
          disconnectRetryPolicy: reconnectPolicy,
          onMessage: async (msg: WebInboundMsg) => {
            statusController.noteInbound(Date.now());
            await onMessage(msg);
          },
          sock: adapter,
        });
      } catch (error) {
        const errText = formatError(error);
        reconnectLogger.error(
          { connectionId, accountId: account.accountId, error: errText },
          "wm monitor: attachWebInboxToSocket failed",
        );
        await disconnectWmClient(wmClient).catch(() => {});
        statusController.noteClose({
          loggedOut: false,
          error: errText,
          reconnectAttempts,
          healthState: "reconnecting",
        });
        if (!keepAlive) {
          terminal = true;
          break;
        }
        reconnectAttempts += 1;
        if (reconnectPolicy.maxAttempts && reconnectAttempts >= reconnectPolicy.maxAttempts) {
          runtime.error(
            `WhatsApp (whatsmeow) inbox attach: max attempts reached (${reconnectAttempts}/${reconnectPolicy.maxAttempts}). Stopping.`,
          );
          terminal = true;
          break;
        }
        const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
        try {
          await sleep(delayMs);
        } catch {
          terminal = true;
          break;
        }
        continue;
      }

      // FORK 2026-05-01: expose the listener to the outbound path. The
      // attachWebInboxToSocket return value satisfies ActiveWebListener
      // (sendMessage/sendPoll/sendReaction/sendComposingTo all present, see
      // inbound/monitor.ts:736-752).
      activeListenerForOutbound = listener as unknown as ActiveWebListener;
      registerWhatsAppConnectionController(account.accountId, controllerHandle);

      whatsappLog.info("Listening for personal WhatsApp inbound messages (whatsmeow backend).");

      if (!keepAlive) {
        try {
          await listener.close();
        } catch {
          // best-effort
        }
        activeListenerForOutbound = null;
        unregisterWhatsAppConnectionController(account.accountId, controllerHandle);
        await disconnectWmClient(wmClient).catch(() => {});
        return;
      }

      // FORK 2026-05-01: race adapter close vs. listener close vs. abort.
      // listener.onClose resolves when the inbound side observes connection.update
      // close; closeSignal is the same thing one layer up so we win either way.
      const abortPromise = abortSignal
        ? new Promise<"aborted">((resolve) => {
            const onAbort = () => resolve("aborted");
            if (abortSignal.aborted) {
              resolve("aborted");
              return;
            }
            abortSignal.addEventListener("abort", onAbort, { once: true });
          })
        : new Promise<never>(() => {});

      const winner = await Promise.race([
        closeSignal.then(() => "closed" as const),
        listener.onClose.then(() => "listener-closed" as const),
        abortPromise,
      ]);

      try {
        await listener.close();
      } catch {
        // best-effort
      }
      activeListenerForOutbound = null;
      unregisterWhatsAppConnectionController(account.accountId, controllerHandle);
      await disconnectWmClient(wmClient).catch(() => {});

      if (winner === "aborted" || stopRequested()) {
        statusController.noteClose({
          loggedOut: false,
          error: "aborted",
          reconnectAttempts,
          healthState: "stopped",
        });
        terminal = true;
        break;
      }

      const reason = closeReason ?? { isLoggedOut: false };
      const errText = reason.error ? formatError(reason.error) : undefined;

      if (reason.isLoggedOut) {
        statusController.noteClose({
          loggedOut: true,
          statusCode: reason.status,
          error: errText,
          reconnectAttempts,
          healthState: "logged-out",
        });
        runtime.error(
          "WhatsApp (whatsmeow) session logged out. Use the Relink button to scan a new QR code.",
        );
        terminal = true;
        break;
      }

      reconnectAttempts += 1;
      if (reconnectPolicy.maxAttempts && reconnectAttempts >= reconnectPolicy.maxAttempts) {
        statusController.noteClose({
          loggedOut: false,
          statusCode: reason.status,
          error: errText,
          reconnectAttempts,
          healthState: "reconnecting",
        });
        runtime.error(
          `WhatsApp (whatsmeow) reconnect: max attempts reached (${reconnectAttempts}/${reconnectPolicy.maxAttempts}). Stopping.`,
        );
        terminal = true;
        break;
      }

      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      statusController.noteClose({
        loggedOut: false,
        statusCode: reason.status,
        error: errText,
        reconnectAttempts,
        healthState: "reconnecting",
      });
      reconnectLogger.info(
        {
          connectionId,
          status: reason.status,
          reconnectAttempts,
          maxAttempts: reconnectPolicy.maxAttempts || "unlimited",
          delayMs,
        },
        "wm reconnect: scheduling retry",
      );
      runtime.error(
        `WhatsApp (whatsmeow) connection closed. Retry ${reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDurationPrecise(delayMs)}…${errText ? ` (${errText})` : ""}`,
      );

      if (backgroundTasks.size > 0) {
        await Promise.allSettled(backgroundTasks);
        backgroundTasks.clear();
      }

      try {
        await sleep(delayMs);
      } catch {
        terminal = true;
        break;
      }
    }
  } finally {
    statusController.markStopped();
  }
}
