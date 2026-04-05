import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  QaBusCreateThreadInput,
  QaBusDeleteMessageInput,
  QaBusEditMessageInput,
  QaBusInboundMessageInput,
  QaBusOutboundMessageInput,
  QaBusPollInput,
  QaBusReactToMessageInput,
  QaBusReadMessageInput,
  QaBusSearchMessagesInput,
  QaBusWaitForInput,
} from "../../extensions/qa-channel/test-api.js";
import type { QaBusState } from "./bus-state.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as unknown) : {};
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeError(res: ServerResponse, statusCode: number, error: unknown) {
  writeJson(res, statusCode, {
    error: error instanceof Error ? error.message : String(error),
  });
}

async function handleRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  state: QaBusState;
}) {
  const method = params.req.method ?? "GET";
  const url = new URL(params.req.url ?? "/", "http://127.0.0.1");

  if (method === "GET" && url.pathname === "/health") {
    writeJson(params.res, 200, { ok: true });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/state") {
    writeJson(params.res, 200, params.state.getSnapshot());
    return;
  }

  if (method !== "POST") {
    writeError(params.res, 405, "method not allowed");
    return;
  }

  const body = (await readJson(params.req)) as Record<string, unknown>;

  try {
    switch (url.pathname) {
      case "/v1/reset":
        params.state.reset();
        writeJson(params.res, 200, { ok: true });
        return;
      case "/v1/inbound/message":
        writeJson(params.res, 200, {
          message: params.state.addInboundMessage(body as unknown as QaBusInboundMessageInput),
        });
        return;
      case "/v1/outbound/message":
        writeJson(params.res, 200, {
          message: params.state.addOutboundMessage(body as unknown as QaBusOutboundMessageInput),
        });
        return;
      case "/v1/actions/thread-create":
        writeJson(params.res, 200, {
          thread: params.state.createThread(body as unknown as QaBusCreateThreadInput),
        });
        return;
      case "/v1/actions/react":
        writeJson(params.res, 200, {
          message: params.state.reactToMessage(body as unknown as QaBusReactToMessageInput),
        });
        return;
      case "/v1/actions/edit":
        writeJson(params.res, 200, {
          message: params.state.editMessage(body as unknown as QaBusEditMessageInput),
        });
        return;
      case "/v1/actions/delete":
        writeJson(params.res, 200, {
          message: params.state.deleteMessage(body as unknown as QaBusDeleteMessageInput),
        });
        return;
      case "/v1/actions/read":
        writeJson(params.res, 200, {
          message: params.state.readMessage(body as unknown as QaBusReadMessageInput),
        });
        return;
      case "/v1/actions/search":
        writeJson(params.res, 200, {
          messages: params.state.searchMessages(body as unknown as QaBusSearchMessagesInput),
        });
        return;
      case "/v1/poll": {
        const input = body as unknown as QaBusPollInput;
        const timeoutMs = Math.max(0, Math.min(input.timeoutMs ?? 0, 30_000));
        const initial = params.state.poll(input);
        if (initial.events.length > 0 || timeoutMs === 0) {
          writeJson(params.res, 200, initial);
          return;
        }
        try {
          await params.state.waitFor({
            kind: "event-kind",
            eventKind: "inbound-message",
            timeoutMs,
          });
        } catch {
          // timeout is fine for long-poll.
        }
        writeJson(params.res, 200, params.state.poll(input));
        return;
      }
      case "/v1/wait":
        writeJson(params.res, 200, {
          match: await params.state.waitFor(body as unknown as QaBusWaitForInput),
        });
        return;
      default:
        writeError(params.res, 404, "not found");
    }
  } catch (error) {
    writeError(params.res, 400, error);
  }
}

export function createQaBusServer(state: QaBusState): Server {
  return createServer(async (req, res) => {
    await handleRequest({ req, res, state });
  });
}

export async function startQaBusServer(params: { state: QaBusState; port?: number }) {
  const server = createQaBusServer(params.state);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("qa-bus failed to bind");
  }
  return {
    server,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
