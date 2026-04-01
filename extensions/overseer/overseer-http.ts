// extensions/overseer/overseer-http.ts
// FORK: HTTP handler for Overseer tree API — serves call tree state to Tinker UI.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OverseerTreeResponse } from "./overseer-types.js";

type TreeStateGetter = (sessionFilter?: string) => OverseerTreeResponse;

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

export function createOverseerHttpHandler(getTreeState: TreeStateGetter) {
  return function handleOverseerRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (!pathname.startsWith("/api/overseer/")) return false;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return true;
    }

    if (pathname === "/api/overseer/tree" && req.method === "GET") {
      const session = url.searchParams.get("session") ?? undefined;
      const tree = getTreeState(session);
      sendJson(res, 200, tree);
      return true;
    }

    sendJson(res, 404, { error: "Not found" });
    return true;
  };
}
