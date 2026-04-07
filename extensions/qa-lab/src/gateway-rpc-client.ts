import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { callGatewayFromCli } from "./runtime-api.js";

type QaGatewayRpcRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number;
};

export type QaGatewayRpcClient = {
  request(method: string, rpcParams?: unknown, opts?: QaGatewayRpcRequestOptions): Promise<unknown>;
  stop(): Promise<void>;
};

function formatQaGatewayRpcError(error: unknown, logs: () => string) {
  const details = formatErrorMessage(error);
  return new Error(`${details}\nGateway logs:\n${logs()}`);
}

let qaGatewayRpcQueue = Promise.resolve();

async function withScopedProcessEnv<T>(env: NodeJS.ProcessEnv, task: () => Promise<T>): Promise<T> {
  const original = new Map<string, string | undefined>();
  const keys = new Set([...Object.keys(process.env), ...Object.keys(env)]);

  for (const key of keys) {
    original.set(key, process.env[key]);
    const nextValue = env[key];
    if (nextValue === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = nextValue;
  }

  try {
    return await task();
  } finally {
    for (const key of keys) {
      const previousValue = original.get(key);
      if (previousValue === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = previousValue;
    }
  }
}

async function runQueuedQaGatewayRpc<T>(task: () => Promise<T>): Promise<T> {
  const run = qaGatewayRpcQueue.then(task, task);
  qaGatewayRpcQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return await run;
}

export async function startQaGatewayRpcClient(params: {
  wsUrl: string;
  token: string;
  env: NodeJS.ProcessEnv;
  logs: () => string;
}): Promise<QaGatewayRpcClient> {
  const wrapError = (error: unknown) => formatQaGatewayRpcError(error, params.logs);
  let stopped = false;

  return {
    async request(method, rpcParams, opts) {
      if (stopped) {
        throw wrapError(new Error("gateway rpc client already stopped"));
      }
      try {
        return await runQueuedQaGatewayRpc(
          async () =>
            await withScopedProcessEnv(
              params.env,
              async () =>
                await callGatewayFromCli(
                  method,
                  {
                    url: params.wsUrl,
                    token: params.token,
                    timeout: String(opts?.timeoutMs ?? 20_000),
                    expectFinal: opts?.expectFinal,
                    json: true,
                  },
                  rpcParams ?? {},
                  {
                    expectFinal: opts?.expectFinal,
                    progress: false,
                  },
                ),
            ),
        );
      } catch (error) {
        throw wrapError(error);
      }
    },
    async stop() {
      stopped = true;
    },
  };
}
