// extensions/prefrontal/prefrontal-http.ts
// FORK: HTTP handler for Prefrontal tree API — serves call tree state to Tinker UI.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrefrontalTreeResponse } from "./prefrontal-types.js";

type TreeStateGetter = (sessionFilter?: string) => PrefrontalTreeResponse;

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

export function createPrefrontalHttpHandler(getTreeState: TreeStateGetter) {
  return function handlePrefrontalRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (!pathname.startsWith("/api/prefrontal/")) {return false;}

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return true;
    }

    if (pathname === "/api/prefrontal/tree" && req.method === "GET") {
      const session = url.searchParams.get("session") ?? undefined;
      const tree = getTreeState(session);
      sendJson(res, 200, tree);
      return true;
    }

    sendJson(res, 404, { error: "Not found" });
    return true;
  };
}
