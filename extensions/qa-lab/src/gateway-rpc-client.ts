import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { GatewayClient } from "./runtime-api.js";

type QaGatewayRpcRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number;
};

const QA_GATEWAY_RPC_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
  "operator.talk.secrets",
] as const;

export type QaGatewayRpcClient = {
  request(method: string, rpcParams?: unknown, opts?: QaGatewayRpcRequestOptions): Promise<unknown>;
  stop(): Promise<void>;
};

function formatQaGatewayRpcError(error: unknown, logs: () => string) {
  const details = formatErrorMessage(error);
  return new Error(`${details}\nGateway logs:\n${logs()}`);
}

export async function startQaGatewayRpcClient(params: {
  wsUrl: string;
  token: string;
  logs: () => string;
}): Promise<QaGatewayRpcClient> {
  let readySettled = false;
  let stopping = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const settleReady = (error?: unknown) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    if (error) {
      rejectReady(error);
      return;
    }
    resolveReady();
  };

  const wrapError = (error: unknown) => formatQaGatewayRpcError(error, params.logs);

  const client = new GatewayClient({
    url: params.wsUrl,
    token: params.token,
    deviceIdentity: null,
    // Mirror the old gateway CLI caller scopes so the faster path stays behavior-identical.
    scopes: [...QA_GATEWAY_RPC_SCOPES],
    onHelloOk: () => {
      settleReady();
    },
    onConnectError: (error) => {
      settleReady(wrapError(error));
    },
    onClose: (code, reason) => {
      if (stopping) {
        return;
      }
      const reasonText = reason.trim() || "no close reason";
      settleReady(wrapError(new Error(`gateway closed (${code}): ${reasonText}`)));
    },
  });

  client.start();
  await ready;

  return {
    async request(method, rpcParams, opts) {
      try {
        return await client.request(method, rpcParams, {
          expectFinal: opts?.expectFinal,
          timeoutMs: opts?.timeoutMs ?? 20_000,
        });
      } catch (error) {
        throw wrapError(error);
      }
    },
    async stop() {
      stopping = true;
      try {
        await client.stopAndWait();
      } catch {
        client.stop();
      }
    },
  };
}
