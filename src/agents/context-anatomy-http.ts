/**
 * Context Anatomy HTTP endpoints.
 *
 * Provides REST access to per-turn prompt decomposition data.
 * Registered as plugin HTTP routes on the gateway.
 *
 * Endpoints:
 *   GET /api/context-anatomy/:sessionKey         — last N events for a session
 *   GET /api/context-anatomy/:sessionKey/latest   — latest event only
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readAnatomyEvents, readLatestAnatomyEvent } from "./context-anatomy.js";

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function parseSessionKeyFromPath(pathname: string): {
  sessionKey: string | null;
  latest: boolean;
} {
  // /api/context-anatomy/:sessionKey/latest
  // /api/context-anatomy/:sessionKey
  const prefix = "/api/context-anatomy/";
  if (!pathname.startsWith(prefix)) {
    return { sessionKey: null, latest: false };
  }
  const rest = pathname.slice(prefix.length);
  if (!rest) {
    return { sessionKey: null, latest: false };
  }
  if (rest.endsWith("/latest")) {
    const key = decodeURIComponent(rest.slice(0, -"/latest".length));
    return { sessionKey: key || null, latest: true };
  }
  return { sessionKey: decodeURIComponent(rest), latest: false };
}

/**
 * Handle context-anatomy HTTP requests.
 * Returns true if the request was handled.
 */
export async function handleContextAnatomyRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/context-anatomy/")) {
    return false;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  const { sessionKey, latest } = parseSessionKeyFromPath(pathname);
  if (!sessionKey) {
    sendJson(res, 400, { error: "Missing session key" });
    return true;
  }

  if (latest) {
    const event = await readLatestAnatomyEvent(sessionKey);
    if (!event) {
      sendJson(res, 404, { error: "No anatomy events found", sessionKey });
      return true;
    }
    sendJson(res, 200, event);
    return true;
  }

  // Return last N events
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 500) : 50;
  const events = await readAnatomyEvents(sessionKey, limit);
  sendJson(res, 200, { sessionKey, count: events.length, events });
  return true;
}
