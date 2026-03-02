/**
 * Tinker Command Center — OpenClaw plugin.
 *
 * Serves the Tinker UI (built Vite app) from /tinker/ on the gateway port.
 * Injects the gateway auth token into index.html so the client can connect
 * to the WebSocket without a hardcoded token.
 */
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const PREFIX = "/tinker";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// tinker-ui/dist is at the repo root, two levels up from extensions/tinker/
const TINKER_DIST = path.resolve(__dirname, "../../tinker-ui/dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function contentType(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

const plugin = {
  id: "tinker",
  name: "Tinker Command Center",
  description: "Operator command center with context/response treemaps and chat",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },

  register(api: OpenClawPluginApi) {
    // Read gateway auth token from config (same one used by control-ui and WebSocket)
    const authToken =
      (api.config as any).gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

    let indexHtmlCache: string | null = null;

    function getIndexHtml(): string {
      if (indexHtmlCache) return indexHtmlCache;
      const raw = fs.readFileSync(path.join(TINKER_DIST, "index.html"), "utf-8");
      // Inject runtime config before </head> so the client can read it
      const config = JSON.stringify({ token: authToken });
      const tag = `<script>window.__TINKER_CONFIG=${config}</script>`;
      indexHtmlCache = raw.replace("</head>", `${tag}\n</head>`);
      return indexHtmlCache;
    }

    api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      let pathname = url.pathname;

      // Only handle /tinker and /tinker/*
      if (pathname !== PREFIX && !pathname.startsWith(PREFIX + "/")) return false;

      // Redirect /tinker to /tinker/ for consistent relative URLs
      if (pathname === PREFIX) {
        res.statusCode = 301;
        res.setHeader("Location", PREFIX + "/");
        res.end();
        return true;
      }

      // Check if the dist directory exists
      if (!fs.existsSync(TINKER_DIST)) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Tinker UI not built. Run: cd tinker-ui && npx vite build");
        return true;
      }

      // Strip prefix to get relative path
      let rel = pathname.slice(PREFIX.length);
      if (!rel || rel === "/") rel = "/index.html";

      // Security: resolve and check path stays within dist
      const filePath = path.resolve(TINKER_DIST, "." + rel);
      if (!filePath.startsWith(TINKER_DIST + path.sep) && filePath !== TINKER_DIST) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "text/plain");
        res.end("Forbidden");
        return true;
      }

      // Serve index.html with injected config
      if (rel === "/index.html") {
        try {
          const html = getIndexHtml();
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(html);
        } catch {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain");
          res.end("Failed to read index.html");
        }
        return true;
      }

      // Serve static files
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          const data = fs.readFileSync(filePath);
          res.statusCode = 200;
          res.setHeader("Content-Type", contentType(filePath));
          // Hashed assets get long cache; everything else no-cache
          if (rel.startsWith("/assets/")) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else {
            res.setHeader("Cache-Control", "no-cache");
          }
          res.end(data);
          return true;
        }
      } catch {
        // File not found — fall through
      }

      // SPA fallback: serve index.html for non-asset routes
      const ext = path.extname(rel);
      if (!ext || ext === ".html") {
        try {
          const html = getIndexHtml();
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(html);
        } catch {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain");
          res.end("Failed to read index.html");
        }
        return true;
      }

      // Unknown static asset → 404
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("Not found");
      return true;
    });

    api.logger.info(`Tinker Command Center registered at ${PREFIX}/`);
  },
};

export default plugin;
