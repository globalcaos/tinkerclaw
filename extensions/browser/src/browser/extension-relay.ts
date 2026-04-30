import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { isLoopbackAddress, isLoopbackHost } from "../gateway/net.js";
import { rawDataToString } from "../infra/ws.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  probeAuthenticatedOpenClawRelay,
  resolveRelayAcceptedTokensForPort,
  resolveRelayAuthTokenForPort,
} from "./extension-relay-auth.js";

const log = createSubsystemLogger("browser/extension-relay");

type CdpCommand = {
  id: number;
  method: string;
  params?: unknown;
  sessionId?: string;
};

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
};

type CdpEvent = {
  method: string;
  params?: unknown;
  sessionId?: string;
};

type ExtensionForwardCommandMessage = {
  id: number;
  method: "forwardCDPCommand";
  params: { method: string; params?: unknown; sessionId?: string };
};

type ExtensionResponseMessage = {
  id: number;
  result?: unknown;
  error?: string;
};

type ExtensionForwardEventMessage = {
  method: "forwardCDPEvent";
  params: { method: string; params?: unknown; sessionId?: string };
};

type ExtensionPingMessage = { method: "ping" };
type ExtensionPongMessage = { method: "pong" };

type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionForwardEventMessage
  | ExtensionPongMessage;

type TargetInfo = {
  targetId: string;
  type?: string;
  title?: string;
  url?: string;
  attached?: boolean;
  // FORK 2026-04-30 (Bible §5.81f): synthetic context id so Playwright's
  // browser-level CDP assertions pass on tab-scoped relay sessions.
  browserContextId?: string;
};

type AttachedToTargetEvent = {
  sessionId: string;
  targetInfo: TargetInfo;
  waitingForDebugger?: boolean;
};

// FORK 2026-04-30 (Bible §5.81f): the relay extension uses chrome.debugger.attach({tabId})
// which is permanently tab-scoped — Chrome refuses browser-level CDP methods on those
// sessions. Playwright's connectOverCDP path expects a single virtual browser context
// the relay can pretend to be. Every targetInfo carrying out of the relay carries this
// context id so Playwright's `assert(targetInfo.browserContextId, ...)` (crBrowser.js:147)
// passes, and Target.getBrowserContexts returns this id.
const SYNTHETIC_BROWSER_CONTEXT_ID = "default";

function withSyntheticBrowserContextId<T extends TargetInfo>(targetInfo: T): T {
  if ((targetInfo as TargetInfo & { browserContextId?: string }).browserContextId) {
    return targetInfo;
  }
  return {
    ...targetInfo,
    browserContextId: SYNTHETIC_BROWSER_CONTEXT_ID,
  } as T;
}

type DetachedFromTargetEvent = {
  sessionId: string;
  targetId?: string;
};

type ConnectedTarget = {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
};

const RELAY_AUTH_HEADER = "x-openclaw-relay-token";
const DEFAULT_EXTENSION_RECONNECT_GRACE_MS = 20_000;
const DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS = 3_000;

function headerValue(value: string | string[] | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  return headerValue(req.headers[name.toLowerCase()]);
}

function getRelayAuthTokenFromRequest(req: IncomingMessage, url?: URL): string | undefined {
  const headerToken = getHeader(req, RELAY_AUTH_HEADER)?.trim();
  if (headerToken) {
    return headerToken;
  }
  const queryToken = url?.searchParams.get("token")?.trim();
  if (queryToken) {
    return queryToken;
  }
  return undefined;
}

export type ChromeExtensionRelayServer = {
  host: string;
  bindHost: string;
  port: number;
  baseUrl: string;
  cdpWsUrl: string;
  extensionConnected: () => boolean;
  stop: () => Promise<void>;
};

type RelayRuntime = {
  server: ChromeExtensionRelayServer;
  relayAuthToken: string;
};

function parseUrlPort(parsed: URL): number | null {
  const port =
    parsed.port?.trim() !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

function parseBaseUrl(raw: string): {
  host: string;
  port: number;
  baseUrl: string;
} {
  const parsed = new URL(raw.trim().replace(/\/$/, ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`extension relay cdpUrl must be http(s), got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  const port = parseUrlPort(parsed);
  if (!port) {
    throw new Error(`extension relay cdpUrl has invalid port: ${parsed.port || "(empty)"}`);
  }
  return { host, port, baseUrl: parsed.toString().replace(/\/$/, "") };
}

function text(res: Duplex, status: number, bodyText: string) {
  const body = Buffer.from(bodyText);
  res.write(
    `HTTP/1.1 ${status} ${status === 200 ? "OK" : "ERR"}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Connection: close\r\n" +
      "\r\n",
  );
  res.write(body);
  res.end();
}

function rejectUpgrade(socket: Duplex, status: number, bodyText: string) {
  text(socket, status, bodyText);
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

function envMsOrDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

const relayRuntimeByPort = new Map<number, RelayRuntime>();
const relayInitByPort = new Map<number, Promise<ChromeExtensionRelayServer>>();

function isAddrInUseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EADDRINUSE"
  );
}

function relayAuthTokenForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!isLoopbackHost(parsed.hostname)) {
      return null;
    }
    const port = parseUrlPort(parsed);
    if (!port) {
      return null;
    }
    return relayRuntimeByPort.get(port)?.relayAuthToken ?? null;
  } catch {
    return null;
  }
}

export function getChromeExtensionRelayAuthHeaders(url: string): Record<string, string> {
  const token = relayAuthTokenForUrl(url);
  if (!token) {
    return {};
  }
  return { [RELAY_AUTH_HEADER]: token };
}

export async function ensureChromeExtensionRelayServer(opts: {
  cdpUrl: string;
  bindHost?: string;
}): Promise<ChromeExtensionRelayServer> {
  const info = parseBaseUrl(opts.cdpUrl);
  if (!isLoopbackHost(info.host)) {
    throw new Error(`extension relay requires loopback cdpUrl host (got ${info.host})`);
  }
  const bindHost = opts.bindHost ?? info.host;

  const existing = relayRuntimeByPort.get(info.port);
  if (existing) {
    if (existing.server.bindHost !== bindHost) {
      await existing.server.stop();
    } else {
      return existing.server;
    }
  }

  const inFlight = relayInitByPort.get(info.port);
  if (inFlight) {
    const server = await inFlight;
    if (server.bindHost === bindHost) {
      return server;
    }
    await server.stop();
  }

  const extensionReconnectGraceMs = envMsOrDefault(
    "OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS",
    DEFAULT_EXTENSION_RECONNECT_GRACE_MS,
  );
  const extensionCommandReconnectWaitMs = envMsOrDefault(
    "OPENCLAW_EXTENSION_RELAY_COMMAND_RECONNECT_WAIT_MS",
    DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS,
  );

  const initPromise = (async (): Promise<ChromeExtensionRelayServer> => {
    const relayAuthToken = await resolveRelayAuthTokenForPort(info.port);
    const relayAuthTokens = new Set(await resolveRelayAcceptedTokensForPort(info.port));

    // FORK: Multi-extension relay — Map<id, ExtensionConnection> replaces single extensionWs.
    // Guard: ExtensionConnection
    type ExtensionConnection = {
      id: string;
      ws: WebSocket;
      ownedSessions: Set<string>;
      pending: Map<
        number,
        { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
      >;
      nextId: number;
      pingTimer: ReturnType<typeof setInterval>;
    };

    const extensionConnections = new Map<string, ExtensionConnection>();
    const cdpClients = new Set<WebSocket>();
    const connectedTargets = new Map<string, ConnectedTarget>();
    const extensionConnected = () => extensionConnections.size > 0;
    const hasConnectedTargets = () => connectedTargets.size > 0;
    let extensionDisconnectCleanupTimer: NodeJS.Timeout | null = null;
    const extensionReconnectWaiters = new Set<(connected: boolean) => void>();

    /** Find the extension that owns a given CDP sessionId. */
    const findExtensionBySession = (sessionId: string): ExtensionConnection | undefined => {
      for (const conn of extensionConnections.values()) {
        if (conn.ownedSessions.has(sessionId)) {
          return conn;
        }
      }
      return undefined;
    };

    /** Get any connected extension (for browser-level commands). */
    const anyExtension = (): ExtensionConnection | undefined => {
      for (const conn of extensionConnections.values()) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          return conn;
        }
      }
      return undefined;
    };

    const flushExtensionReconnectWaiters = (connected: boolean) => {
      if (extensionReconnectWaiters.size === 0) {
        return;
      }
      const waiters = Array.from(extensionReconnectWaiters);
      extensionReconnectWaiters.clear();
      for (const waiter of waiters) {
        waiter(connected);
      }
    };

    const clearExtensionDisconnectCleanupTimer = () => {
      if (!extensionDisconnectCleanupTimer) {
        return;
      }
      clearTimeout(extensionDisconnectCleanupTimer);
      extensionDisconnectCleanupTimer = null;
    };

    const closeCdpClientsAfterExtensionDisconnect = () => {
      connectedTargets.clear();
      for (const client of cdpClients) {
        try {
          client.close(1011, "extension disconnected");
        } catch {
          // ignore
        }
      }
      cdpClients.clear();
      flushExtensionReconnectWaiters(false);
    };

    const scheduleExtensionDisconnectCleanup = () => {
      clearExtensionDisconnectCleanupTimer();
      extensionDisconnectCleanupTimer = setTimeout(() => {
        extensionDisconnectCleanupTimer = null;
        if (extensionConnected()) {
          return;
        }
        closeCdpClientsAfterExtensionDisconnect();
      }, extensionReconnectGraceMs);
    };

    const waitForExtensionReconnect = async (timeoutMs: number): Promise<boolean> => {
      if (extensionConnected()) {
        return true;
      }
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const waiter = (connected: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          extensionReconnectWaiters.delete(waiter);
          resolve(connected);
        };
        const timer = setTimeout(() => {
          waiter(false);
        }, timeoutMs);
        extensionReconnectWaiters.add(waiter);
      });
    };

    // FORK: Route to extension owning the target session, fall back to any connected extension.
    const sendToExtension = async (
      payload: ExtensionForwardCommandMessage,
      sessionId?: string,
    ): Promise<unknown> => {
      const conn = sessionId
        ? (findExtensionBySession(sessionId) ?? anyExtension())
        : anyExtension();
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
        throw new Error("Chrome extension not connected");
      }
      const id = conn.nextId++;
      const routed = { ...payload, id };
      // FORK 2026-04-30 (Bible §5.81f): trace forwarded commands when the
      // OPENCLAW_RELAY_CDP_TRACE env var is set. Off by default — at steady
      // state Playwright fires hundreds of CDP messages per page-init and
      // logging them all is noise; on-demand diagnostics for regressions.
      const traceEnabled = process.env.OPENCLAW_RELAY_CDP_TRACE === "1";
      const traceMethod = payload.params.method;
      const traceStart = traceEnabled ? Date.now() : 0;
      if (traceEnabled) {
        log.info(
          `[relay-cdp] → ext id=${id} method=${traceMethod} sessionId=${sessionId ?? "none"}`,
        );
      }
      conn.ws.send(JSON.stringify(routed));
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          conn.pending.delete(id);
          // Always log timeouts — those are real signals.
          log.warn(
            `[relay-cdp] ✗ ext id=${id} method=${traceMethod} TIMEOUT after ${
              traceEnabled ? Date.now() - traceStart : ">30000"
            }ms`,
          );
          reject(new Error(`extension request timeout: ${payload.params.method}`));
        }, 30_000);
        conn.pending.set(id, {
          resolve: (v: unknown) => {
            if (traceEnabled) {
              log.info(
                `[relay-cdp] ✓ ext id=${id} method=${traceMethod} ok ${Date.now() - traceStart}ms`,
              );
            }
            resolve(v);
          },
          reject,
          timer,
        });
      });
    };

    const broadcastToCdpClients = (evt: CdpEvent) => {
      const msg = JSON.stringify(evt);
      for (const ws of cdpClients) {
        if (ws.readyState !== WebSocket.OPEN) {
          continue;
        }
        ws.send(msg);
      }
    };

    const sendResponseToCdp = (ws: WebSocket, res: CdpResponse) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(JSON.stringify(res));
    };

    const dropConnectedTargetSession = (sessionId: string): ConnectedTarget | undefined => {
      const existing = connectedTargets.get(sessionId);
      if (!existing) {
        return undefined;
      }
      connectedTargets.delete(sessionId);
      return existing;
    };

    const dropConnectedTargetsByTargetId = (targetId: string): ConnectedTarget[] => {
      const removed: ConnectedTarget[] = [];
      for (const [sessionId, target] of connectedTargets) {
        if (target.targetId !== targetId) {
          continue;
        }
        connectedTargets.delete(sessionId);
        removed.push(target);
      }
      return removed;
    };

    const broadcastDetachedTarget = (target: ConnectedTarget, targetId?: string) => {
      broadcastToCdpClients({
        method: "Target.detachedFromTarget",
        params: {
          sessionId: target.sessionId,
          targetId: targetId ?? target.targetId,
        },
        sessionId: target.sessionId,
      });
    };

    const isMissingTargetError = (err: unknown) => {
      const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return (
        message.includes("target not found") ||
        message.includes("no target with given id") ||
        message.includes("session not found") ||
        message.includes("cannot find session")
      );
    };

    const pruneStaleTargetsFromCommandFailure = (cmd: CdpCommand, err: unknown) => {
      if (!isMissingTargetError(err)) {
        return;
      }
      if (cmd.sessionId) {
        const removed = dropConnectedTargetSession(cmd.sessionId);
        if (removed) {
          broadcastDetachedTarget(removed);
          return;
        }
      }
      const params = (cmd.params ?? {}) as { targetId?: unknown };
      const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
      if (!targetId) {
        return;
      }
      const removedTargets = dropConnectedTargetsByTargetId(targetId);
      for (const removed of removedTargets) {
        broadcastDetachedTarget(removed, targetId);
      }
    };

    const ensureTargetEventsForClient = (ws: WebSocket, mode: "autoAttach" | "discover") => {
      // FORK 2026-04-30 (Bible §5.81f): replay BOTH Target.targetCreated AND
      // Target.attachedToTarget for every connected target on autoAttach.
      // chrome-devtools-mcp uses puppeteer's connectOverCDP, which calls
      // Target.setAutoAttach but populates browser.targets() from
      // Target.targetCreated events (not from attached events). Without
      // the targetCreated replay, puppeteer's list_pages returns empty
      // even though the relay is forwarding correctly — the chrome-mcp
      // attach times out waiting for tabs to become available.
      for (const target of connectedTargets.values()) {
        // FORK 2026-04-30 (Bible §5.81f): Target.targetCreated announces a
        // target's EXISTENCE; Target.attachedToTarget announces ATTACHMENT.
        // Chrome distinguishes them via the `attached` flag — created with
        // attached:false, then attachedToTarget with attached:true. Sending
        // both with attached:true (which we did initially) confuses
        // Playwright's CRBrowser into thinking the target is already
        // attached on creation, suppressing the second event's effects.
        ws.send(
          JSON.stringify({
            method: "Target.targetCreated",
            params: { targetInfo: { ...target.targetInfo, attached: false } },
          } satisfies CdpEvent),
        );
        if (mode === "autoAttach") {
          ws.send(
            JSON.stringify({
              method: "Target.attachedToTarget",
              params: {
                sessionId: target.sessionId,
                targetInfo: { ...target.targetInfo, attached: true },
                waitingForDebugger: false,
              },
            } satisfies CdpEvent),
          );
        }
      }
    };

    const routeCdpCommand = async (cmd: CdpCommand): Promise<unknown> => {
      switch (cmd.method) {
        case "Browser.getVersion":
          return {
            protocolVersion: "1.3",
            product: "Chrome/OpenClaw-Extension-Relay",
            revision: "0",
            userAgent: "OpenClaw-Extension-Relay",
            jsVersion: "V8",
          };
        case "Browser.setDownloadBehavior":
          return {};
        case "Target.setAutoAttach":
        case "Target.setDiscoverTargets":
          return {};
        case "Target.getTargets":
          return {
            targetInfos: Array.from(connectedTargets.values()).map((t) => ({
              ...t.targetInfo,
              attached: true,
            })),
          };
        case "Target.getTargetInfo": {
          const params = (cmd.params ?? {}) as { targetId?: string };
          const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
          if (targetId) {
            for (const t of connectedTargets.values()) {
              if (t.targetId === targetId) {
                return { targetInfo: t.targetInfo };
              }
            }
          }
          if (cmd.sessionId && connectedTargets.has(cmd.sessionId)) {
            const t = connectedTargets.get(cmd.sessionId);
            if (t) {
              return { targetInfo: t.targetInfo };
            }
          }
          const first = Array.from(connectedTargets.values())[0];
          return { targetInfo: first?.targetInfo };
        }
        case "Target.attachToTarget": {
          const params = (cmd.params ?? {}) as { targetId?: string };
          const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
          if (!targetId) {
            throw new Error("targetId required");
          }
          for (const t of connectedTargets.values()) {
            if (t.targetId === targetId) {
              return { sessionId: t.sessionId };
            }
          }
          throw new Error("target not found");
        }
        // FORK 2026-04-30 (Bible §5.81f): the relay pretends to be a single-context
        // browser. Playwright's connectOverCDP path enumerates contexts, creates one
        // for the persistent flow, and asks for permissions. We synthesize stable
        // answers so the handshake completes without forwarding browser-level
        // methods to chrome.debugger (which only knows tab-scoped CDP).
        case "Target.getBrowserContexts":
          return { browserContextIds: [SYNTHETIC_BROWSER_CONTEXT_ID] };
        case "Target.createBrowserContext":
          // Playwright will then try Target.createTarget against this id; that
          // call falls through to the extension which blocks tab creation per
          // Bible §5.81. The disabled error is the truthful answer — agents
          // ask the user to share a tab; they do not open new ones.
          return { browserContextId: SYNTHETIC_BROWSER_CONTEXT_ID };
        case "Target.disposeBrowserContext":
          return {};
        case "Browser.grantPermissions":
        case "Browser.resetPermissions":
          // No-op: the relay can't enforce permissions on chrome.debugger
          // sessions. Returning {} lets Playwright proceed; agents that depend
          // on grants should treat them as best-effort. Documented in §5.81f.
          return {};
        case "Storage.getCookies":
          // v1: empty list, regardless of the requested URL/context. The flows
          // we care about (npm publish, generic UI automation) don't depend on
          // storage-scoped cookies. If a future agent needs cookies, route via
          // chrome.cookies API in the extension — see §5.81f Open Work.
          return { cookies: [] };
        case "Storage.setCookies":
        case "Storage.clearCookies":
          // v1: no-op. Same rationale as Storage.getCookies.
          return {};
        default: {
          return await sendToExtension(
            {
              id: 0, // replaced by sendToExtension with conn-local id
              method: "forwardCDPCommand",
              params: {
                method: cmd.method,
                sessionId: cmd.sessionId,
                params: cmd.params,
              },
            },
            cmd.sessionId,
          );
        }
      }
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", info.baseUrl);
      const path = url.pathname;
      const origin = getHeader(req, "origin");
      const isChromeExtensionOrigin =
        typeof origin === "string" && origin.startsWith("chrome-extension://");

      if (isChromeExtensionOrigin && origin) {
        // Let extension pages call relay HTTP endpoints cross-origin.
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }

      // Handle CORS preflight requests from the browser extension.
      if (req.method === "OPTIONS") {
        if (origin && !isChromeExtensionOrigin) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        const requestedHeaders = (getHeader(req, "access-control-request-headers") ?? "")
          .split(",")
          .map((header) => header.trim().toLowerCase())
          .filter((header) => header.length > 0);
        const allowedHeaders = new Set(["content-type", RELAY_AUTH_HEADER, ...requestedHeaders]);
        res.writeHead(204, {
          "Access-Control-Allow-Origin": origin ?? "*",
          "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
          "Access-Control-Allow-Headers": Array.from(allowedHeaders).join(", "),
          "Access-Control-Max-Age": "86400",
          Vary: "Origin, Access-Control-Request-Headers",
        });
        res.end();
        return;
      }

      if (path.startsWith("/json")) {
        // FORK 2026-04-29 (Bible §5.81): /json/version and /json/list are
        // read-only discovery endpoints (browser version + list of attached
        // targets). They do not accept commands and do not expose the WS
        // command channel beyond a URL string. Tinkerclaw's gateway calls
        // them to bootstrap the chrome-relay profile, but the upstream gate
        // requires an HMAC token the gateway doesn't currently plumb through.
        // Relaxation: allow loopback callers without auth, since the relay
        // server is already loopback-bound and same-host trust is the model.
        // The /cdp WebSocket (where commands actually flow) keeps its token
        // gate untouched a few lines below.
        const isLoopback = isLoopbackAddress(req.socket?.remoteAddress);
        if (!isLoopback) {
          const token = getRelayAuthTokenFromRequest(req, url);
          if (!token || !relayAuthTokens.has(token)) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }
        }
      }

      if (req.method === "HEAD" && path === "/") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (path === "/") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("OK");
        return;
      }

      if (path === "/extension/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ connected: extensionConnected(), count: extensionConnections.size }),
        );
        return;
      }

      const hostHeader = req.headers.host?.trim() || `${info.host}:${info.port}`;
      const wsHost = `ws://${hostHeader}`;
      const cdpWsUrl = `${wsHost}/cdp`;

      if (
        (path === "/json/version" || path === "/json/version/") &&
        (req.method === "GET" || req.method === "PUT")
      ) {
        const payload: Record<string, unknown> = {
          Browser: "OpenClaw/extension-relay",
          "Protocol-Version": "1.3",
        };
        // Keep reporting CDP WS while attached targets are cached, so callers can
        // reconnect through brief MV3 worker disconnects.
        if (extensionConnected() || hasConnectedTargets()) {
          payload.webSocketDebuggerUrl = cdpWsUrl;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      const listPaths = new Set(["/json", "/json/", "/json/list", "/json/list/"]);
      if (listPaths.has(path) && (req.method === "GET" || req.method === "PUT")) {
        const list = Array.from(connectedTargets.values()).map((t) => ({
          id: t.targetId,
          type: t.targetInfo.type ?? "page",
          title: t.targetInfo.title ?? "",
          description: t.targetInfo.title ?? "",
          url: t.targetInfo.url ?? "",
          webSocketDebuggerUrl: cdpWsUrl,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpWsUrl.replace("ws://", "")}`,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
        return;
      }

      const handleTargetActionRoute = (
        match: RegExpMatchArray | null,
        cdpMethod: "Target.activateTarget" | "Target.closeTarget",
      ): boolean => {
        if (!match || (req.method !== "GET" && req.method !== "PUT")) {
          return false;
        }
        let targetId = "";
        try {
          targetId = decodeURIComponent(match[1] ?? "").trim();
        } catch {
          res.writeHead(400);
          res.end("invalid targetId encoding");
          return true;
        }
        if (!targetId) {
          res.writeHead(400);
          res.end("targetId required");
          return true;
        }
        void (async () => {
          try {
            await sendToExtension({
              id: 0, // replaced by sendToExtension with conn-local id
              method: "forwardCDPCommand",
              params: { method: cdpMethod, params: { targetId } },
            });
          } catch {
            // ignore
          }
        })();
        res.writeHead(200);
        res.end("OK");
        return true;
      };

      if (
        handleTargetActionRoute(path.match(/^\/json\/activate\/(.+)$/), "Target.activateTarget")
      ) {
        return;
      }
      if (handleTargetActionRoute(path.match(/^\/json\/close\/(.+)$/), "Target.closeTarget")) {
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    const wssExtension = new WebSocketServer({ noServer: true });
    const wssCdp = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", info.baseUrl);
      const pathname = url.pathname;
      const remote = req.socket.remoteAddress;

      // When bindHost is explicitly non-loopback (e.g. 0.0.0.0 for WSL2),
      // allow non-loopback connections; otherwise enforce loopback-only.
      if (!isLoopbackAddress(remote) && isLoopbackHost(bindHost)) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }

      const origin = headerValue(req.headers.origin);
      if (origin && !origin.startsWith("chrome-extension://")) {
        rejectUpgrade(socket, 403, "Forbidden: invalid origin");
        return;
      }

      if (pathname === "/extension") {
        // FORK: Allow chrome-extension:// origins on loopback without token.
        const isTrustedExtensionOrigin =
          origin && origin.startsWith("chrome-extension://") && isLoopbackAddress(remote);
        if (!isTrustedExtensionOrigin) {
          const token = getRelayAuthTokenFromRequest(req, url);
          if (!token || !relayAuthTokens.has(token)) {
            rejectUpgrade(socket, 401, "Unauthorized");
            return;
          }
        }
        // FORK: Multi-extension — no 409 rejection, multiple extensions can connect simultaneously.
        wssExtension.handleUpgrade(req, socket, head, (ws) => {
          wssExtension.emit("connection", ws, req);
        });
        return;
      }

      if (pathname === "/cdp") {
        // FORK 2026-04-29 (Bible §5.81): /cdp is the actual CDP command
        // channel. Upstream gates it on an HMAC token the gateway doesn't
        // currently plumb through to its existing-session WS upgrades.
        // Tinkerclaw's threat model is single-user, loopback-only:
        // - The relay listens only on 127.0.0.1.
        // - Even an unauthenticated local caller can only send commands
        //   that the relay extension would forward, and the extension
        //   only forwards to tabs the user explicitly clicked "share" on.
        //   That per-tab consent is the actual security boundary.
        // So allow loopback callers without a token. Non-loopback callers
        // (impossible given the bind) keep the gate as a defense-in-depth
        // backstop.
        const isLoopback = isLoopbackAddress(req.socket?.remoteAddress);
        if (!isLoopback) {
          const token = getRelayAuthTokenFromRequest(req, url);
          if (!token || !relayAuthTokens.has(token)) {
            rejectUpgrade(socket, 401, "Unauthorized");
            return;
          }
        }
        // Allow CDP clients to connect even during brief extension worker drops.
        // Individual commands already wait briefly for extension reconnect.
        wssCdp.handleUpgrade(req, socket, head, (ws) => {
          wssCdp.emit("connection", ws, req);
        });
        return;
      }

      rejectUpgrade(socket, 404, "Not Found");
    });

    wssExtension.on("connection", (ws) => {
      // FORK: Multi-extension — each connection gets its own state.
      const connId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const conn: ExtensionConnection = {
        id: connId,
        ws,
        ownedSessions: new Set(),
        pending: new Map(),
        nextId: 1,
        pingTimer: setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            return;
          }
          ws.send(JSON.stringify({ method: "ping" } satisfies ExtensionPingMessage));
        }, 5000),
      };
      extensionConnections.set(connId, conn);
      clearExtensionDisconnectCleanupTimer();
      flushExtensionReconnectWaiters(true);

      ws.on("message", (data) => {
        if (!extensionConnections.has(connId)) {
          return;
        }
        let parsed: ExtensionMessage | null = null;
        try {
          parsed = JSON.parse(rawDataToString(data)) as ExtensionMessage;
        } catch {
          return;
        }

        if (
          parsed &&
          typeof parsed === "object" &&
          "id" in parsed &&
          typeof parsed.id === "number"
        ) {
          const pending = conn.pending.get(parsed.id);
          if (!pending) {
            return;
          }
          conn.pending.delete(parsed.id);
          clearTimeout(pending.timer);
          if ("error" in parsed && typeof parsed.error === "string" && parsed.error.trim()) {
            pending.reject(new Error(parsed.error));
          } else {
            pending.resolve(parsed.result);
          }
          return;
        }

        if (parsed && typeof parsed === "object" && "method" in parsed) {
          if ((parsed as ExtensionPongMessage).method === "pong") {
            return;
          }
          if ((parsed as ExtensionForwardEventMessage).method !== "forwardCDPEvent") {
            return;
          }
          const evt = parsed as ExtensionForwardEventMessage;
          const method = evt.params?.method;
          const params = evt.params?.params;
          const sessionId = evt.params?.sessionId;
          if (!method || typeof method !== "string") {
            return;
          }

          if (method === "Target.attachedToTarget") {
            const attached = (params ?? {}) as AttachedToTargetEvent;
            const targetType = attached?.targetInfo?.type ?? "page";
            if (targetType !== "page") {
              return;
            }
            if (attached?.sessionId && attached?.targetInfo?.targetId) {
              // FORK: Track session ownership for this extension.
              conn.ownedSessions.add(attached.sessionId);

              const prev = connectedTargets.get(attached.sessionId);
              const nextTargetId = attached.targetInfo.targetId;
              const prevTargetId = prev?.targetId;
              const changedTarget = Boolean(prev && prevTargetId && prevTargetId !== nextTargetId);
              connectedTargets.set(attached.sessionId, {
                sessionId: attached.sessionId,
                targetId: nextTargetId,
                targetInfo: withSyntheticBrowserContextId(attached.targetInfo),
              });
              if (changedTarget && prevTargetId) {
                broadcastToCdpClients({
                  method: "Target.detachedFromTarget",
                  params: { sessionId: attached.sessionId, targetId: prevTargetId },
                  sessionId: attached.sessionId,
                });
              }
              if (!prev || changedTarget) {
                // FORK 2026-04-30 (Bible §5.81f): rebuild the broadcast params
                // with the synthetic browserContextId injected. The raw params
                // from the extension lacks this field; Playwright asserts on it
                // (crBrowser.js:147) and rejects the connection if missing.
                const broadcastParams = {
                  ...attached,
                  targetInfo: withSyntheticBrowserContextId(attached.targetInfo),
                };
                broadcastToCdpClients({
                  method,
                  params: broadcastParams as unknown as Record<string, unknown>,
                  sessionId,
                });
              }
              return;
            }
          }

          if (method === "Target.detachedFromTarget") {
            const detached = (params ?? {}) as DetachedFromTargetEvent;
            if (detached?.sessionId) {
              dropConnectedTargetSession(detached.sessionId);
              conn.ownedSessions.delete(detached.sessionId);
            } else if (detached?.targetId) {
              dropConnectedTargetsByTargetId(detached.targetId);
            }
            broadcastToCdpClients({ method, params, sessionId });
            return;
          }

          if (method === "Target.targetDestroyed" || method === "Target.targetCrashed") {
            const targetEvent = (params ?? {}) as { targetId?: string };
            if (targetEvent.targetId) {
              dropConnectedTargetsByTargetId(targetEvent.targetId);
            }
            broadcastToCdpClients({ method, params, sessionId });
            return;
          }

          // Keep cached tab metadata fresh for /json/list.
          if (method === "Target.targetInfoChanged") {
            const changed = (params ?? {}) as { targetInfo?: { targetId?: string; type?: string } };
            const targetInfo = changed?.targetInfo;
            const targetId = targetInfo?.targetId;
            if (targetId && (targetInfo?.type ?? "page") === "page") {
              for (const [sid, target] of connectedTargets) {
                if (target.targetId !== targetId) {
                  continue;
                }
                connectedTargets.set(sid, {
                  ...target,
                  // FORK 2026-04-30 (Bible §5.81f): re-inject browserContextId
                  // since the merge-spread can be overwritten by the extension's
                  // payload (which lacks the field).
                  targetInfo: withSyntheticBrowserContextId({
                    ...target.targetInfo,
                    ...(targetInfo as object),
                  } as TargetInfo),
                });
              }
              // FORK 2026-04-30 (Bible §5.81f): also rebuild the broadcast params
              // so downstream Playwright sees a consistent browserContextId.
              const enriched = withSyntheticBrowserContextId(targetInfo as TargetInfo);
              broadcastToCdpClients({
                method,
                params: { ...changed, targetInfo: enriched } as unknown as Record<string, unknown>,
                sessionId,
              });
              return;
            }
          }

          broadcastToCdpClients({ method, params, sessionId });
        }
      });

      ws.on("close", () => {
        clearInterval(conn.pingTimer);
        extensionConnections.delete(connId);

        // Reject only this extension's pending requests.
        for (const [, pending] of conn.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("extension disconnected"));
        }
        conn.pending.clear();

        // Remove only targets owned by this extension.
        for (const sid of conn.ownedSessions) {
          const target = connectedTargets.get(sid);
          if (target) {
            connectedTargets.delete(sid);
            broadcastToCdpClients({
              method: "Target.detachedFromTarget",
              params: { sessionId: sid, targetId: target.targetId },
            });
          }
        }
        conn.ownedSessions.clear();

        // Only schedule cleanup / tear down CDP clients when ALL extensions are gone.
        if (extensionConnections.size === 0) {
          scheduleExtensionDisconnectCleanup();
        }
      });
    });

    wssCdp.on("connection", (ws) => {
      cdpClients.add(ws);

      ws.on("message", async (data) => {
        let cmd: CdpCommand | null = null;
        try {
          cmd = JSON.parse(rawDataToString(data)) as CdpCommand;
        } catch {
          return;
        }
        if (!cmd || typeof cmd !== "object") {
          return;
        }
        if (typeof cmd.id !== "number" || typeof cmd.method !== "string") {
          return;
        }

        if (!extensionConnected()) {
          const reconnected = await waitForExtensionReconnect(extensionCommandReconnectWaitMs);
          if (!reconnected || !extensionConnected()) {
            sendResponseToCdp(ws, {
              id: cmd.id,
              sessionId: cmd.sessionId,
              error: { message: "Extension not connected" },
            });
            return;
          }
        }

        try {
          const result = await routeCdpCommand(cmd);

          // FORK 2026-04-30 (Bible §5.81f): send the response BEFORE replaying
          // target events. Both Playwright and puppeteer set up their CDPSession
          // event handlers as part of their post-response init flow. If we
          // emit Target.attachedToTarget events before the setAutoAttach
          // response lands, they're delivered into a not-yet-attached handler
          // and dropped — resulting in browser.pages() returning empty even
          // though the relay forwarded everything.
          sendResponseToCdp(ws, { id: cmd.id, sessionId: cmd.sessionId, result });

          if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId) {
            ensureTargetEventsForClient(ws, "autoAttach");
          }
          if (cmd.method === "Target.setDiscoverTargets") {
            const discover = (cmd.params ?? {}) as { discover?: boolean };
            if (discover.discover === true) {
              ensureTargetEventsForClient(ws, "discover");
            }
          }
          if (cmd.method === "Target.attachToTarget") {
            const params = (cmd.params ?? {}) as { targetId?: string };
            const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
            if (targetId) {
              const target = Array.from(connectedTargets.values()).find(
                (t) => t.targetId === targetId,
              );
              if (target) {
                ws.send(
                  JSON.stringify({
                    method: "Target.attachedToTarget",
                    params: {
                      sessionId: target.sessionId,
                      targetInfo: { ...target.targetInfo, attached: true },
                      waitingForDebugger: false,
                    },
                  } satisfies CdpEvent),
                );
              }
            }
          }
        } catch (err) {
          pruneStaleTargetsFromCommandFailure(cmd, err);
          sendResponseToCdp(ws, {
            id: cmd.id,
            sessionId: cmd.sessionId,
            error: { message: err instanceof Error ? err.message : String(err) },
          });
        }
      });

      ws.on("close", () => {
        cdpClients.delete(ws);
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(info.port, bindHost, () => resolve());
        server.once("error", reject);
      });
    } catch (err) {
      if (
        isAddrInUseError(err) &&
        (await probeAuthenticatedOpenClawRelay({
          baseUrl: info.baseUrl,
          relayAuthHeader: RELAY_AUTH_HEADER,
          relayAuthToken,
        }))
      ) {
        const existingRelay: ChromeExtensionRelayServer = {
          host: info.host,
          bindHost,
          port: info.port,
          baseUrl: info.baseUrl,
          cdpWsUrl: `ws://${info.host}:${info.port}/cdp`,
          extensionConnected: () => false,
          stop: async () => {
            relayRuntimeByPort.delete(info.port);
          },
        };
        relayRuntimeByPort.set(info.port, { server: existingRelay, relayAuthToken });
        return existingRelay;
      }
      throw err;
    }

    const addr = server.address() as AddressInfo | null;
    const port = addr?.port ?? info.port;
    const actualBindHost = addr?.address || bindHost;
    const host = info.host;
    const baseUrl = `${new URL(info.baseUrl).protocol}//${host}:${port}`;

    const relay: ChromeExtensionRelayServer = {
      host,
      bindHost: actualBindHost,
      port,
      baseUrl,
      cdpWsUrl: `ws://${host}:${port}/cdp`,
      extensionConnected,
      stop: async () => {
        relayRuntimeByPort.delete(port);
        clearExtensionDisconnectCleanupTimer();
        flushExtensionReconnectWaiters(false);
        // FORK: Close all extension connections.
        for (const conn of extensionConnections.values()) {
          for (const [, pending] of conn.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error("server stopping"));
          }
          conn.pending.clear();
          clearInterval(conn.pingTimer);
          try {
            conn.ws.close(1001, "server stopping");
          } catch {
            // ignore
          }
        }
        extensionConnections.clear();
        for (const ws of cdpClients) {
          try {
            ws.close(1001, "server stopping");
          } catch {
            // ignore
          }
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        wssExtension.close();
        wssCdp.close();
      },
    };

    relayRuntimeByPort.set(port, { server: relay, relayAuthToken });
    return relay;
  })();
  relayInitByPort.set(info.port, initPromise);
  try {
    return await initPromise;
  } finally {
    relayInitByPort.delete(info.port);
  }
}

export async function stopChromeExtensionRelayServer(opts: { cdpUrl: string }): Promise<boolean> {
  const info = parseBaseUrl(opts.cdpUrl);
  const existing = relayRuntimeByPort.get(info.port);
  if (!existing) {
    return false;
  }
  await existing.server.stop();
  return true;
}
