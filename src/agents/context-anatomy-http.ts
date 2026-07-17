/**
 * Context Anatomy HTTP endpoints.
 *
 * Provides REST access to per-turn prompt decomposition data.
 * Registered as plugin HTTP routes on the gateway.
 *
 * Endpoints:
 *   GET /api/context-anatomy/recent              — events across all sessions (last N hours)
 *   GET /api/context-anatomy/:sessionKey         — last N events for a session
 *   GET /api/context-anatomy/:sessionKey/latest   — latest event only
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { queryRecentEvents, querySessionEvents, querySessionTree } from "./context-anatomy-db.js";

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

  // FORK: Handle CORS preflight for Vite dev server (localhost:18790 → localhost:18789)
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return true;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  // Check for /api/context-anatomy/recent before session key parsing
  const recentMatch = url.pathname.match(/\/api\/context-anatomy\/recent$/);
  if (recentMatch) {
    const hoursParam = url.searchParams.get("hours");
    const hours = Math.min(Math.max(parseInt(hoursParam ?? "48", 10) || 48, 1), 8760);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 500), 2000) : 500;
    const events = queryRecentEvents(hours, limit);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ count: events.length, events }));
    return true;
  }

  const { sessionKey, latest } = parseSessionKeyFromPath(pathname);
  if (!sessionKey) {
    sendJson(res, 400, { error: "Missing session key" });
    return true;
  }

  if (latest) {
    const events = querySessionEvents(sessionKey, 1);
    const event = events[0] ?? null;
    if (!event) {
      sendJson(res, 404, { error: "No anatomy events found", sessionKey });
      return true;
    }
    sendJson(res, 200, event);
    return true;
  }

  // Return last N events. ?tree=1 also pulls the subagent family (EEG fan-out
  // visibility, FORK 2026-07-16) so the seismograph paints branches reload-proof.
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 500) : 50;
  const wantTree = url.searchParams.get("tree") === "1";
  const events = wantTree
    ? querySessionTree(sessionKey, limit)
    : querySessionEvents(sessionKey, limit);
  sendJson(res, 200, { sessionKey, count: events.length, events });
  return true;
}
