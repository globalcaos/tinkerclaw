import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { isLoopbackAddress, isLoopbackHost } from "../gateway/net.js";
import { declareInstrument, noteInstrumentFired } from "../infra/instrument-liveness.js";
import { rawDataToString } from "../infra/ws.js";
import {
  probeAuthenticatedOpenClawRelay,
  resolveRelayAcceptedTokensForPort,
  resolveRelayAuthTokenForPort,
} from "./extension-relay-auth.js";

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
};

type AttachedToTargetEvent = {
  sessionId: string;
  targetInfo: TargetInfo;
  waitingForDebugger?: boolean;
};

type DetachedFromTargetEvent = {
  sessionId: string;
  targetId?: string;
};

// sessionId/targetId are relay-side ids: namespaced with the owner's prefix (see ExtensionBrowser).
type ConnectedTarget = {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
  owner: number;
};

type PendingExtensionRequest = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

// One connected browser (one extension). Several can be connected at once, e.g. the local
// Chromium and a Chrome on another machine. Tab session ids are small per-browser counters
// (`tc-tab-1`), so ids from browsers in slot >= 1 get a `b<key>:` prefix on the way in and lose
// it on the way out; slot 0 keeps raw ids, so a single-browser setup sees exactly what it did
// before multi-browser support.
type ExtensionBrowser = {
  key: number;
  prefix: string;
  // Stable id the extension sends (`?browserId=`), so an MV3 worker reconnect lands in the
  // same slot. Without one, a reconnecting socket inherits a slot whose socket is gone.
  browserId?: string;
  ws: WebSocket | null;
  upgrading: boolean;
  pending: Map<number, PendingExtensionRequest>;
  cleanupTimer: NodeJS.Timeout | null;
};

const BROWSER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAMESPACED_ID_PATTERN = /^b(\d+):/;

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

  // Liveness enrollment (see infra/instrument-liveness.ts). Declared HERE — where a relay is
  // actually wired up — not at module load, so a deployment that never starts the relay does
  // not report a false "never fired". Fires only when a CDP frame genuinely crosses the relay
  // (either direction); browsing is bursty, so tolerate a full day of silence before calling
  // it broken.
  declareInstrument({
    id: "browser:relay-forward",
    kind: "integration",
    description: "CDP frames forwarded between the extension socket and a CDP client",
    expectFireWithinMs: 24 * 60 * 60 * 1000,
  });

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

    const browsers = new Map<number, ExtensionBrowser>();
    const cdpClients = new Set<WebSocket>();
    const connectedTargets = new Map<string, ConnectedTarget>();
    const isBrowserOpen = (browser: ExtensionBrowser | undefined) =>
      browser?.ws?.readyState === WebSocket.OPEN;
    const extensionConnected = () => {
      for (const browser of browsers.values()) {
        if (isBrowserOpen(browser)) {
          return true;
        }
      }
      return false;
    };
    const hasConnectedTargets = () => connectedTargets.size > 0;
    const firstOpenBrowser = (): ExtensionBrowser | undefined => {
      const keys = Array.from(browsers.keys()).toSorted((a, b) => a - b);
      for (const key of keys) {
        const browser = browsers.get(key);
        if (isBrowserOpen(browser)) {
          return browser;
        }
      }
      return undefined;
    };

    // Waiters re-check their condition on every extension connection; `giveUp` settles them
    // all (server stop, or the last browser gone).
    const extensionReconnectWaiters = new Set<(giveUp: boolean) => void>();

    const notifyExtensionWaiters = (giveUp: boolean) => {
      for (const waiter of Array.from(extensionReconnectWaiters)) {
        waiter(giveUp);
      }
    };

    const waitForExtension = async (ready: () => boolean, timeoutMs: number): Promise<boolean> => {
      if (ready()) {
        return true;
      }
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const waiter = (giveUp: boolean) => {
          if (settled || (!giveUp && !ready())) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          extensionReconnectWaiters.delete(waiter);
          resolve(ready());
        };
        const timer = setTimeout(() => {
          waiter(true);
        }, timeoutMs);
        extensionReconnectWaiters.add(waiter);
      });
    };

    const rejectBrowserPending = (browser: ExtensionBrowser, reason: string) => {
      for (const [, pending] of browser.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      browser.pending.clear();
    };

    const clearBrowserCleanupTimer = (browser: ExtensionBrowser) => {
      if (!browser.cleanupTimer) {
        return;
      }
      clearTimeout(browser.cleanupTimer);
      browser.cleanupTimer = null;
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
      notifyExtensionWaiters(true);
    };

    // The browser did not come back within the grace period: forget it and its tabs. CDP
    // clients stay open while another browser is connected or still has tabs.
    const dropBrowser = (browser: ExtensionBrowser) => {
      if (browsers.get(browser.key) !== browser) {
        return;
      }
      browsers.delete(browser.key);
      rejectBrowserPending(browser, "extension disconnected");
      const removed: ConnectedTarget[] = [];
      for (const [sessionId, target] of connectedTargets) {
        if (target.owner === browser.key) {
          connectedTargets.delete(sessionId);
          removed.push(target);
        }
      }
      if (!extensionConnected() && !hasConnectedTargets()) {
        closeCdpClientsAfterExtensionDisconnect();
        return;
      }
      for (const target of removed) {
        broadcastDetachedTarget(target);
      }
    };

    const scheduleBrowserCleanup = (browser: ExtensionBrowser) => {
      clearBrowserCleanupTimer(browser);
      browser.cleanupTimer = setTimeout(() => {
        browser.cleanupTimer = null;
        if (isBrowserOpen(browser)) {
          return;
        }
        dropBrowser(browser);
      }, extensionReconnectGraceMs);
    };

    // Same browser reconnecting (by browserId, or for id-less sockets any slot whose socket is
    // gone) keeps its slot, so its tab ids stay the same; otherwise a new slot.
    const claimBrowserSlot = (browserId: string | undefined): ExtensionBrowser | "busy" => {
      const keys = Array.from(browsers.keys()).toSorted((a, b) => a - b);
      for (const key of keys) {
        const browser = browsers.get(key);
        if (!browser) {
          continue;
        }
        if (browserId) {
          if (browser.browserId !== browserId) {
            continue;
          }
        } else if (browser.browserId || browser.upgrading || isBrowserOpen(browser)) {
          continue;
        }
        if (browser.upgrading || isBrowserOpen(browser)) {
          return "busy";
        }
        return browser;
      }
      let key = 0;
      while (browsers.has(key)) {
        key++;
      }
      const browser: ExtensionBrowser = {
        key,
        prefix: key === 0 ? "" : `b${key}:`,
        browserId,
        ws: null,
        upgrading: false,
        pending: new Map(),
        cleanupTimer: null,
      };
      browsers.set(key, browser);
      return browser;
    };

    const namespaceId = (browser: ExtensionBrowser, id: unknown) =>
      typeof id === "string" ? browser.prefix + id : id;

    const stripId = (browser: ExtensionBrowser, id: unknown) =>
      typeof id === "string" && browser.prefix && id.startsWith(browser.prefix)
        ? id.slice(browser.prefix.length)
        : id;

    // Prefix the id fields of an event's params (sessionId, targetId, openerId, targetInfo.*).
    const namespaceEventParams = (browser: ExtensionBrowser, value: unknown): unknown => {
      if (!browser.prefix || !value || typeof value !== "object" || Array.isArray(value)) {
        return value;
      }
      const out = { ...(value as Record<string, unknown>) };
      for (const key of ["sessionId", "targetId", "openerId"]) {
        if (typeof out[key] === "string") {
          out[key] = namespaceId(browser, out[key]);
        }
      }
      if (out.targetInfo && typeof out.targetInfo === "object") {
        out.targetInfo = namespaceEventParams(browser, out.targetInfo);
      }
      return out;
    };

    const stripCommandParams = (browser: ExtensionBrowser, value: unknown): unknown => {
      if (!browser.prefix || !value || typeof value !== "object" || Array.isArray(value)) {
        return value;
      }
      const out = { ...(value as Record<string, unknown>) };
      for (const key of ["sessionId", "targetId"]) {
        if (typeof out[key] === "string") {
          out[key] = stripId(browser, out[key]);
        }
      }
      return out;
    };

    const browserForNamespacedId = (id: unknown): ExtensionBrowser | undefined => {
      if (typeof id !== "string") {
        return undefined;
      }
      const match = id.match(NAMESPACED_ID_PATTERN);
      const key = match ? Number(match[1]) : 0;
      return key >= 1 ? browsers.get(key) : undefined;
    };

    // Which browser owns the tab a command is about: by session, then by target, then by an
    // id prefix (e.g. a child session), else the first connected browser.
    const resolveCommandOwner = (
      sessionId: string | undefined,
      params: unknown,
    ): ExtensionBrowser | undefined => {
      const p = (params ?? {}) as { targetId?: unknown; sessionId?: unknown };
      for (const sid of [sessionId, p.sessionId]) {
        const target = typeof sid === "string" ? connectedTargets.get(sid) : undefined;
        if (target) {
          return browsers.get(target.owner);
        }
      }
      if (typeof p.targetId === "string") {
        for (const target of connectedTargets.values()) {
          if (target.targetId === p.targetId) {
            return browsers.get(target.owner);
          }
        }
      }
      for (const id of [sessionId, p.targetId, p.sessionId]) {
        const browser = browserForNamespacedId(id);
        if (browser) {
          return browser;
        }
      }
      return firstOpenBrowser();
    };

    let nextExtensionId = 1;

    const sendToExtension = async (
      browser: ExtensionBrowser | undefined,
      command: { method: string; params?: unknown; sessionId?: string },
    ): Promise<unknown> => {
      const ws = browser?.ws;
      if (!browser || !ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("Chrome extension not connected");
      }
      // Relay-side ids are unique across browsers; each browser only resolves its own.
      const payload: ExtensionForwardCommandMessage = {
        id: nextExtensionId++,
        method: "forwardCDPCommand",
        params: {
          method: command.method,
          sessionId: stripId(browser, command.sessionId) as string | undefined,
          params: stripCommandParams(browser, command.params),
        },
      };
      ws.send(JSON.stringify(payload));
      // Liveness: a forwardCDPCommand frame genuinely left for the extension. One site covers
      // both dispatch paths (the /cdp client socket and the /json/activate|close HTTP routes).
      // In-memory counter only — this path must never write a metrics row per frame.
      noteInstrumentFired("browser:relay-forward", "client->ext");
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          browser.pending.delete(payload.id);
          reject(new Error(`extension request timeout: ${payload.params.method}`));
        }, 30_000);
        browser.pending.set(payload.id, { resolve, reject, timer });
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
      for (const target of connectedTargets.values()) {
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
        } else {
          ws.send(
            JSON.stringify({
              method: "Target.targetCreated",
              params: { targetInfo: { ...target.targetInfo, attached: true } },
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
        default: {
          const owner = resolveCommandOwner(cmd.sessionId, cmd.params);
          if (owner && !isBrowserOpen(owner)) {
            await waitForExtension(() => isBrowserOpen(owner), extensionCommandReconnectWaitMs);
          }
          return await sendToExtension(owner, {
            method: cmd.method,
            sessionId: cmd.sessionId,
            params: cmd.params,
          });
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
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
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
        res.end(JSON.stringify({ connected: extensionConnected() }));
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
            await sendToExtension(resolveCommandOwner(undefined, { targetId }), {
              method: cdpMethod,
              params: { targetId },
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
      // FORK: Only enforce origin check on /extension path — authenticated /cdp
      // connections from Node.js (ws library) send a non-chrome-extension origin.
      if (pathname === "/extension" && origin && !origin.startsWith("chrome-extension://")) {
        rejectUpgrade(socket, 403, "Forbidden: invalid origin");
        return;
      }

      if (pathname === "/extension") {
        // FORK: Allow chrome-extension:// origins on loopback without token.
        // The origin check above + loopback check is sufficient for local security.
        const isTrustedExtensionOrigin =
          origin && origin.startsWith("chrome-extension://") && isLoopbackAddress(remote);
        if (!isTrustedExtensionOrigin) {
          const token = getRelayAuthTokenFromRequest(req, url);
          if (!token || !relayAuthTokens.has(token)) {
            rejectUpgrade(socket, 401, "Unauthorized");
            return;
          }
        }
        const rawBrowserId = url.searchParams.get("browserId")?.trim();
        const browserId =
          rawBrowserId && BROWSER_ID_PATTERN.test(rawBrowserId) ? rawBrowserId : undefined;
        const browser = claimBrowserSlot(browserId);
        if (browser === "busy") {
          // The same browser already holds an open socket.
          rejectUpgrade(socket, 409, "Extension already connected");
          return;
        }
        // MV3 worker reconnect races can leave a stale non-OPEN socket reference.
        if (browser.ws && browser.ws.readyState !== WebSocket.OPEN) {
          const stale = browser.ws;
          browser.ws = null;
          rejectBrowserPending(browser, "extension disconnected");
          try {
            stale.terminate();
          } catch {
            // ignore
          }
        }
        browser.upgrading = true;
        if (!browser.cleanupTimer) {
          // Cleared once the socket attaches; drops the slot if the upgrade never completes.
          scheduleBrowserCleanup(browser);
        }
        wssExtension.handleUpgrade(req, socket, head, (ws) => {
          browser.upgrading = false;
          attachExtensionSocket(browser, ws);
        });
        return;
      }

      if (pathname === "/cdp") {
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
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

    const attachExtensionSocket = (browser: ExtensionBrowser, ws: WebSocket) => {
      browser.ws = ws;
      clearBrowserCleanupTimer(browser);
      notifyExtensionWaiters(false);

      const ping = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        ws.send(JSON.stringify({ method: "ping" } satisfies ExtensionPingMessage));
      }, 5000);

      ws.on("message", (data) => {
        if (browser.ws !== ws) {
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
          const pending = browser.pending.get(parsed.id);
          if (!pending) {
            return;
          }
          browser.pending.delete(parsed.id);
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
          // Relay-side ids from here on (prefixed for browsers in slot >= 1).
          const params = namespaceEventParams(browser, evt.params?.params);
          const sessionId = namespaceId(browser, evt.params?.sessionId) as string | undefined;
          if (!method || typeof method !== "string") {
            return;
          }
          // Liveness: a CDP event frame from the extension is on the forward path (the
          // branches below broadcast it to CDP clients). HIGH-FREQUENCY path: in-memory
          // counter only — never write a metrics row per frame.
          noteInstrumentFired("browser:relay-forward", "ext->client");

          if (method === "Target.attachedToTarget") {
            const attached = (params ?? {}) as AttachedToTargetEvent;
            const targetType = attached?.targetInfo?.type ?? "page";
            if (targetType !== "page") {
              return;
            }
            if (attached?.sessionId && attached?.targetInfo?.targetId) {
              const prev = connectedTargets.get(attached.sessionId);
              const nextTargetId = attached.targetInfo.targetId;
              const prevTargetId = prev?.targetId;
              const changedTarget = Boolean(prev && prevTargetId && prevTargetId !== nextTargetId);
              connectedTargets.set(attached.sessionId, {
                sessionId: attached.sessionId,
                targetId: nextTargetId,
                targetInfo: attached.targetInfo,
                owner: browser.key,
              });
              if (changedTarget && prevTargetId) {
                broadcastToCdpClients({
                  method: "Target.detachedFromTarget",
                  params: { sessionId: attached.sessionId, targetId: prevTargetId },
                  sessionId: attached.sessionId,
                });
              }
              if (!prev || changedTarget) {
                broadcastToCdpClients({ method, params, sessionId });
              }
              return;
            }
          }

          if (method === "Target.detachedFromTarget") {
            const detached = (params ?? {}) as DetachedFromTargetEvent;
            if (detached?.sessionId) {
              dropConnectedTargetSession(detached.sessionId);
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
          // After navigation, Chrome updates URL/title via Target.targetInfoChanged.
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
                  targetInfo: { ...target.targetInfo, ...(targetInfo as object) },
                });
              }
            }
          }

          broadcastToCdpClients({ method, params, sessionId });
        }
      });

      ws.on("close", () => {
        clearInterval(ping);
        if (browser.ws !== ws) {
          return;
        }
        browser.ws = null;
        rejectBrowserPending(browser, "extension disconnected");
        scheduleBrowserCleanup(browser);
      });
    };

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
          const reconnected = await waitForExtension(
            extensionConnected,
            extensionCommandReconnectWaitMs,
          );
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

          sendResponseToCdp(ws, { id: cmd.id, sessionId: cmd.sessionId, result });
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
        const stopping = Array.from(browsers.values());
        browsers.clear();
        notifyExtensionWaiters(true);
        for (const browser of stopping) {
          clearBrowserCleanupTimer(browser);
          rejectBrowserPending(browser, "server stopping");
          const ws = browser.ws;
          browser.ws = null;
          try {
            ws?.close(1001, "server stopping");
          } catch {
            // ignore
          }
        }
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
