import { buildErrorEnvelope } from "../../fork/error-envelope.js";
import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";
import type { ActiveRunQueueAction } from "./queue-policy.js";
import type { QueueSettings } from "./queue.js";

export type ReplyRunQueueBusyState = {
  activeSessionId: string | undefined;
  isActive: boolean;
  isStreaming: boolean;
};

export async function resolvePreparedReplyQueueState(params: {
  activeRunQueueAction: ActiveRunQueueAction;
  activeSessionId: string | undefined;
  queueMode: QueueSettings["mode"];
  sessionKey: string | undefined;
  sessionId: string;
  abortActiveRun: (sessionId: string) => boolean;
  waitForActiveRunEnd: (sessionId: string) => Promise<unknown>;
  refreshPreparedState: () => Promise<void>;
  resolveBusyState: () => ReplyRunQueueBusyState;
}): Promise<
  { kind: "continue"; busyState: ReplyRunQueueBusyState } | { kind: "reply"; reply: ReplyPayload }
> {
  if (params.activeRunQueueAction !== "run-now" || !params.activeSessionId) {
    return { kind: "continue", busyState: params.resolveBusyState() };
  }

  if (params.queueMode === "interrupt") {
    const aborted = params.abortActiveRun(params.activeSessionId);
    logVerbose(
      `Interrupting active run for ${params.sessionKey ?? params.sessionId} (aborted=${aborted})`,
    );
  }

  const waitStart = Date.now();
  await params.waitForActiveRunEnd(params.activeSessionId);
  const waitedMs = Date.now() - waitStart;
  await params.refreshPreparedState();
  const refreshedBusyState = params.resolveBusyState();
  if (refreshedBusyState.isActive) {
    const stuckSessionId =
      refreshedBusyState.activeSessionId ?? params.activeSessionId ?? "<unknown>";
    const streaming = refreshedBusyState.isStreaming ? "streaming" : "not streaming";
    // FORK: deliver the busy banner as a structured ErrorEnvelope so the UI
    // can render it rich (icon + fatal=false → orange) instead of as plain red.
    const envelope = buildErrorEnvelope({
      code: "lane_busy",
      sessionKey: params.sessionKey ?? params.sessionId,
      details: {
        activeSessionId: stuckSessionId,
        streaming: refreshedBusyState.isStreaming,
        waitedMs,
        state: streaming,
      },
    });
    return {
      kind: "reply",
      reply: {
        text: `__ERR_ENV__:${JSON.stringify(envelope)}`,
        isError: true,
      },
    };
  }
  return { kind: "continue", busyState: refreshedBusyState };
}
