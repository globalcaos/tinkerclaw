#!/usr/bin/env node
/**
 * FORK 2026-10-29: tc-rpc, the lean gateway RPC client of a cc-bridge worker.
 *
 * prompts/plan-tools.md sent every prefrontal.plan.* call through `openclaw gateway call`, which
 * boots the whole CLI to send one RPC: 7.9-9.2 s wall, about 11 CPU-s and 500 MB per call on the
 * Pi (measured 2026-10-29), for an RPC the gateway answers in a median 0.2-0.7 s. This script sends
 * the same RPC with Node's built-in WebSocket and nothing else: it reads no openclaw.json,
 * validates no config, and imports neither the CLI nor the plugin graph.
 *
 *   node tc-rpc.mjs <method> ['<json params>'] [--timeout <ms>]
 *
 * `--params '<json>'` works in place of the positional params, as on the CLI line.
 *
 * It reads two environment variables and nothing else:
 *   OPENCLAW_GATEWAY_URL    the gateway endpoint: wss://, or ws:// to a loopback host
 *   OPENCLAW_GATEWAY_TOKEN  the gateway's shared token, sent once, inside the connect frame
 *
 * The handshake copies what core's callGateway() does for an in-process backend caller
 * (src/gateway/call.ts, callGatewayLeastPrivilege): wait for the `connect.challenge` event, send
 * `connect` as client `gateway-client` in mode `backend` with the shared token and no device
 * identity (shouldOmitDeviceIdentityForGatewayCall: shared auth on a loopback URL), then send the
 * request. A vanilla gateway keeps the requested scopes for exactly that client
 * (shouldSkipLocalBackendSelfPairing in src/gateway/server/ws-connection/handshake-auth-helpers.ts)
 * and clears them for any other client that brings no device identity.
 *
 * Scopes: exactly what resolveLeastPrivilegeOperatorScopesForMethod() in
 * src/gateway/method-scopes.ts returns for the method inside the gateway. That function answers
 * for plugin methods from the gateway's live plugin registry, which no outside process can read,
 * so the answer for each method this client sends is written in METHOD_SCOPES and pinned against
 * its source by src/tc-rpc.test.ts. Any other method is refused before connecting: send it with
 * `openclaw gateway call`.
 *
 * The exit code says whether the request can have reached the gateway, so the caller knows when
 * it may send the call again:
 *   0  OK               the result is on stdout as JSON.
 *   1  RPC_ERROR        the gateway answered with an error.
 *   2  USAGE            the command line is wrong; nothing was sent.
 *   3  NOT_SENT         the request never left tc-rpc: no URL or token, plaintext off loopback, no
 *                       built-in WebSocket, a method it has no scope for, or the connection failed,
 *                       was refused or timed out before the request frame was written. Sending the
 *                       call again, through `openclaw gateway call` for one, cannot apply it twice.
 *   5  OUTCOME_UNKNOWN  the request frame was written, then the call timed out or the connection
 *                       was lost before the answer came: the gateway may have applied it. Read the
 *                       state back before repeating a call that changes it.
 *   6  INTERNAL         an unexpected failure inside tc-rpc.
 * 4 is no longer used: it meant "the connection failed", which is now 3 or 5 depending on whether
 * the request had been written. Each error is one line on stderr, and nothing tc-rpc prints
 * carries the token.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** The gateway protocol version (src/gateway/protocol/schema/protocol-schemas.ts), pinned by the test. */
export const PROTOCOL_VERSION = 3;

/** The least-privilege operator scopes of each method this client sends, pinned by the test. */
export const METHOD_SCOPES = Object.freeze({
  // tinkerclaw-prefrontal registers the plan RPCs with ADMIN_METHOD = { scope: "operator.admin" }.
  "prefrontal.plan.set": Object.freeze(["operator.admin"]),
  "prefrontal.plan.step": Object.freeze(["operator.admin"]),
  "prefrontal.plan.get": Object.freeze(["operator.admin"]),
  "prefrontal.plan.close": Object.freeze(["operator.admin"]),
  // Core READ_SCOPE: the read-only method for checking this client against a live gateway.
  health: Object.freeze(["operator.read"]),
});

/**
 * The budget for the whole call (connect, handshake, answer). Objective: never give up on a call
 * the gateway will still answer. Giving up before the request is written sends the caller to the
 * CLI line, an 8 s boot; giving up after it leaves the outcome unknown (exit 5), and the caller
 * has to read the state back before it may repeat the call. Derived from the gateway's own log of
 * plan RPCs on 2026-10-28/29 (medians 0.2-0.7 s, worst 7.1 s) and from the CLI line this replaces,
 * which passes --timeout 60000 for the same calls. Break-even: waiting costs nothing while the
 * gateway is alive, and quitting early costs a CLI boot or a read-back. Revisit it if the logged
 * plan-RPC tail nears a minute or the CLI line's timeout changes. `--timeout <ms>` overrides it
 * for one call.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** The longest delay a Node timer takes; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** The exit codes; the header of this file says what each one means for the request. */
export const EXIT = Object.freeze({
  OK: 0,
  RPC_ERROR: 1,
  USAGE: 2,
  NOT_SENT: 3,
  OUTCOME_UNKNOWN: 5,
  INTERNAL: 6,
});

/** The end of the stderr line for the two codes a caller decides a retry on. */
const OUTCOME_NOTE = Object.freeze({
  [EXIT.NOT_SENT]: "nothing was sent",
  [EXIT.OUTCOME_UNKNOWN]: "the request was sent, so the gateway may have applied it",
});

const CLIENT_VERSION = "tc-rpc/1";
const USAGE = "usage: node tc-rpc.mjs <method> ['<json params>'] [--timeout <ms>]";

class UsageError extends Error {}

/** Read `<method> [<json params>] [--timeout <ms>] [--params <json>] [--json]`. */
export function parseArgs(argv) {
  let method;
  let paramsText;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  // `--name value` or `--name=value`; returns the value and the index of the last argument read.
  const valueOf = (name, index) => {
    const arg = argv[index];
    if (arg !== name) {
      return [arg.slice(name.length + 1), index];
    }
    if (index + 1 >= argv.length) {
      throw new UsageError(`${name} needs a value`);
    }
    return [argv[index + 1], index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const [raw, last] = valueOf("--timeout", i);
      i = last;
      const ms = Number(raw);
      if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_TIMER_MS) {
        throw new UsageError("--timeout takes a whole number of milliseconds above 0");
      }
      timeoutMs = ms;
    } else if (arg === "--params" || arg.startsWith("--params=")) {
      if (paramsText !== undefined) {
        throw new UsageError("the params were given twice");
      }
      const [raw, last] = valueOf("--params", i);
      i = last;
      paramsText = raw;
    } else if (arg === "--json") {
      // Accepted as on `openclaw gateway call --json`: the output is always JSON.
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown option ${arg.split("=")[0]}`);
    } else if (method === undefined) {
      method = arg;
    } else if (paramsText === undefined) {
      paramsText = arg;
    } else {
      throw new UsageError("too many arguments");
    }
  }
  if (!method) {
    throw new UsageError("the method is missing");
  }
  let params = {};
  if (paramsText !== undefined) {
    try {
      params = JSON.parse(paramsText);
    } catch {
      throw new UsageError("the params are not valid JSON");
    }
  }
  return { method, params, timeoutMs };
}

function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") {
    return true;
  }
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => part !== "" && Number.isInteger(Number(part)) && Number(part) <= 255)
  );
}

/** The endpoint and token from the environment, or why there is none. */
export function resolveEndpoint(env) {
  const rawUrl = (env.OPENCLAW_GATEWAY_URL ?? "").trim();
  const token = (env.OPENCLAW_GATEWAY_TOKEN ?? "").trim();
  if (!rawUrl || !token) {
    return { error: "OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN must both be set" };
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: "OPENCLAW_GATEWAY_URL is not a URL" };
  }
  // The other helper scripts take an http(s) gateway URL and switch the scheme; so does this one.
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { error: `OPENCLAW_GATEWAY_URL must be a ws:// or wss:// URL, not ${url.protocol}` };
  }
  if (url.protocol === "ws:" && !isLoopbackHostname(url.hostname)) {
    return {
      error: `refusing plaintext ws:// to ${url.hostname}: the token would cross the network unencrypted, so use wss://`,
    };
  }
  return { url: url.href, origin: url.origin, token };
}

/** The connect params core's GatewayClient sends for a backend caller with a shared token. */
export function buildConnectParams({ method, scopes, token }) {
  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: `tc-rpc:${method}`,
      version: CLIENT_VERSION,
      platform: process.platform,
      mode: "backend",
      instanceId: randomUUID(),
    },
    caps: [],
    role: "operator",
    scopes: [...scopes],
    auth: { token },
  };
}

function describeError(error) {
  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.trim()
      : "unknown error";
  const code =
    typeof error?.details?.code === "string"
      ? error.details.code
      : typeof error?.code === "string"
        ? error.code
        : "";
  return code ? `${message} [${code}]` : message;
}

function redact(text, secret) {
  return secret ? String(text).split(secret).join("<redacted>") : String(text);
}

function oneLine(text) {
  return String(text)
    .split(/\s*\n\s*/)
    .join(" ");
}

/** Connect, send one request, and settle with { code, out } or { code, err }; never rejects. */
export function callGateway({ url, origin, token, method, params, scopes, timeoutMs }) {
  return new Promise((resolve) => {
    const connectId = randomUUID();
    const requestId = randomUUID();
    // challenge → hello → answer
    let phase = "challenge";
    let opened = false;
    // Set once the request frame is handed to the socket: from then on, a failure cannot tell
    // whether the gateway applied the request.
    let sent = false;
    let settled = false;
    let socket;
    let timer;
    const waitingFor = () =>
      phase === "challenge"
        ? "the gateway's connect challenge"
        : phase === "hello"
          ? "the gateway to accept the connection"
          : `the answer to ${method}`;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Close a socket that is still connecting as well as an open one: a gateway that completes
      // the upgrade after tc-rpc gave up must never get the connect frame or the request. Closing a
      // socket that is still connecting makes Node 22's built-in client fire its error event again,
      // from inside close(); `settled` is already set, so that call returns here at once.
      const state = socket?.readyState;
      if (state === WebSocket.CONNECTING || state === WebSocket.OPEN) {
        socket.close(1000);
      }
      resolve(result);
    };
    // A failure with no answer from the gateway: NOT_SENT until the request frame is written,
    // OUTCOME_UNKNOWN after it.
    const failed = (err) => finish({ code: sent ? EXIT.OUTCOME_UNKNOWN : EXIT.NOT_SENT, err });
    timer = setTimeout(() => {
      failed(`timed out after ${timeoutMs} ms waiting for ${waitingFor()}`);
    }, timeoutMs);
    try {
      socket = new WebSocket(url);
    } catch (err) {
      failed(`cannot open a WebSocket to ${origin}: ${err?.message ?? err}`);
      return;
    }
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      opened = true;
    });
    socket.addEventListener("error", () => {
      // A refused connect fires only this event: Node 22's built-in client sends no close after it
      // and leaves the socket CONNECTING, so the error ends the call itself.
      failed(
        opened
          ? `the connection to the gateway failed while tc-rpc waited for ${waitingFor()}`
          : `could not open a WebSocket to the gateway at ${origin}`,
      );
    });
    socket.addEventListener("close", (event) => {
      const why = event.reason ? `${event.code} ${event.reason}` : String(event.code);
      failed(`the gateway closed the connection (${why}) while tc-rpc waited for ${waitingFor()}`);
    });
    socket.addEventListener("message", (event) => {
      // A settled call sends nothing more, whatever arrives: a late challenge must not put the
      // connect frame and then the request on the wire after tc-rpc has reported its exit code.
      if (settled) {
        return;
      }
      let frame;
      try {
        frame = JSON.parse(
          typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"),
        );
      } catch {
        return;
      }
      if (frame?.type === "event") {
        if (frame.event === "connect.challenge" && phase === "challenge") {
          phase = "hello";
          const connect = buildConnectParams({ method, scopes, token });
          socket.send(
            JSON.stringify({ type: "req", id: connectId, method: "connect", params: connect }),
          );
        }
        return;
      }
      if (frame?.type !== "res") {
        return;
      }
      if (frame.id === connectId && phase === "hello") {
        if (frame.ok !== true) {
          failed(`the gateway refused the connection: ${describeError(frame.error)}`);
          return;
        }
        phase = "answer";
        sent = true;
        socket.send(JSON.stringify({ type: "req", id: requestId, method, params }));
        return;
      }
      if (frame.id === requestId && phase === "answer") {
        finish(
          frame.ok === true
            ? { code: EXIT.OK, out: JSON.stringify(frame.payload ?? null, null, 2) }
            : { code: EXIT.RPC_ERROR, err: `${method} failed: ${describeError(frame.error)}` },
        );
      }
    });
  });
}

/** Run one call and return the exit code; `io` defaults to the process streams. */
export async function main(argv, env, io = process) {
  const secret = (env.OPENCLAW_GATEWAY_TOKEN ?? "").trim();
  const print = (stream, text) => stream.write(`${redact(text, secret)}\n`);
  const fail = (code, message) => {
    const note = OUTCOME_NOTE[code];
    print(io.stderr, `tc-rpc: ${oneLine(message)}${note ? `; ${note}` : ""}`);
    return code;
  };
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      return fail(EXIT.USAGE, `${err.message}; ${USAGE}`);
    }
    throw err;
  }
  if (!Object.hasOwn(METHOD_SCOPES, args.method)) {
    return fail(
      EXIT.NOT_SENT,
      `tc-rpc knows no least-privilege scope for ${args.method}; send it with \`openclaw gateway call\``,
    );
  }
  const endpoint = resolveEndpoint(env);
  if (endpoint.error) {
    return fail(EXIT.NOT_SENT, endpoint.error);
  }
  if (typeof globalThis.WebSocket !== "function") {
    return fail(
      EXIT.NOT_SENT,
      `Node ${process.version} has no built-in WebSocket (Node 22 has one)`,
    );
  }
  const result = await callGateway({
    url: endpoint.url,
    origin: endpoint.origin,
    token: endpoint.token,
    method: args.method,
    params: args.params,
    scopes: METHOD_SCOPES[args.method],
    timeoutMs: args.timeoutMs,
  });
  if (result.code !== EXIT.OK) {
    return fail(result.code, result.err);
  }
  print(io.stdout, result.out);
  return EXIT.OK;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const secret = (process.env.OPENCLAW_GATEWAY_TOKEN ?? "").trim();
  main(process.argv.slice(2), process.env)
    .catch((err) => {
      process.stderr.write(
        `tc-rpc: unexpected failure: ${redact(oneLine(err?.message ?? err), secret)}\n`,
      );
      return EXIT.INTERNAL;
    })
    .then((code) => {
      process.exitCode = code;
      // The socket is closed by now; this only bounds a gateway that never acknowledges the close.
      setTimeout(() => process.exit(code), 2_000).unref();
    });
}
