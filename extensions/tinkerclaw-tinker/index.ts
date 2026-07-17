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
import { inflateSync } from "node:zlib";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const PREFIX = "/tinker";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Direct SQLite fallback for anatomy queries — used when the gateway's
// __anatomyDb global bridge isn't available yet (before first LLM call).
// ---------------------------------------------------------------------------
let directDb: any = null;

/** Decompress a column that may be zlib BLOB (new) or plain-text JSON (legacy). */
function decompressJson(val: Buffer | string | null) {
  if (val == null) {
    return undefined;
  }
  try {
    if (Buffer.isBuffer(val)) {
      return JSON.parse(inflateSync(val).toString("utf-8"));
    }
    return JSON.parse(val);
  } catch {
    return undefined;
  }
}

function parseRow(row: any) {
  return {
    turn: row.turn,
    roundNumber: row.round_number ?? undefined,
    compactionCycle: row.compaction_cycle ?? 0,
    timestamp: new Date(row.timestamp_ms).toISOString(),
    timestampMs: row.timestamp_ms,
    model: row.model ?? "",
    provider: row.provider ?? "",
    sessionKey: row.session_key || undefined,
    topics: decompressJson(row.topics) ?? [],
    topicTransition: decompressJson(row.topic_transition),
    contextSent: decompressJson(row.context_sent) ?? { totalTokens: 0 },
    contextWindow: decompressJson(row.context_window) ?? { maxTokens: 0, usedTokens: 0 },
    authProfileId: row.auth_profile_id ?? undefined,
    responseTokens: row.response_tokens ?? undefined,
    memoriesInjected: decompressJson(row.memories_injected) ?? { autoRecall: [], searched: [] },
    runId: row.run_id ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    toolsTriggered: decompressJson(row.tools_triggered),
    responseThinkingTokens: row.response_thinking_tokens ?? undefined,
    responseTextTokens: row.response_text_tokens ?? undefined,
    responseToolCallTokens: row.response_tool_call_tokens ?? undefined,
    cacheReadTokens: row.cache_read_tokens ?? undefined,
    cacheCreationTokens: row.cache_creation_tokens ?? undefined,
    responseContent: decompressJson(row.response_content) ?? undefined,
  };
}

function getAnatomyDb() {
  // Prefer the gateway's bridge (shares DB handle + prepared statements)
  const bridge = (globalThis as any).__anatomyDb;
  if (bridge) {
    return bridge;
  }

  // Fallback: open DB directly via better-sqlite3 (already in the process)
  if (!directDb) {
    try {
      const Database = require("better-sqlite3");
      const dbPath = path.join(
        process.env.HOME ?? "/tmp",
        ".openclaw",
        "data",
        "anatomy-timeline.db",
      );
      if (!fs.existsSync(dbPath)) {
        return null;
      }
      const db = new Database(dbPath, { readonly: true });
      db.pragma("journal_mode = WAL");
      directDb = {
        queryRecentEvents(hours: number, limit = 500) {
          const cutoff = Date.now() - hours * 3600000;
          return db
            .prepare(
              `SELECT * FROM (
                SELECT * FROM anatomy_events WHERE timestamp_ms > ?
                ORDER BY timestamp_ms DESC LIMIT ?
              ) ORDER BY timestamp_ms ASC`,
            )
            .all(cutoff, limit)
            .map(parseRow);
        },
        querySessionEvents(key: string, limit: number) {
          return db
            .prepare(
              "SELECT * FROM anatomy_events WHERE session_key = ? ORDER BY timestamp_ms DESC LIMIT ?",
            )
            .all(key, limit)
            .map(parseRow);
        },
        // FORK 2026-07-16 (EEG fan-out visibility): viewed session + its subagent
        // family (flat `<root>:subagent:%` keys). Mirrors context-anatomy-db.ts.
        querySessionTree(key: string, limit: number) {
          const root =
            key && !key.includes(":subagent:") && key.startsWith("agent:")
              ? key.split(":").slice(0, 2).join(":")
              : null;
          if (!root || !root.includes(":")) {
            return this.querySessionEvents(key, limit);
          }
          return db
            .prepare(
              `SELECT * FROM (
                SELECT * FROM anatomy_events
                WHERE session_key = ? OR session_key LIKE ?
                ORDER BY timestamp_ms DESC LIMIT ?
              ) ORDER BY timestamp_ms ASC`,
            )
            .all(key, `${root}:subagent:%`, limit)
            .map(parseRow);
        },
        queryEventsBefore(beforeMs: number, limit: number) {
          return db
            .prepare(
              `SELECT * FROM (
                SELECT * FROM anatomy_events WHERE timestamp_ms < ?
                ORDER BY timestamp_ms DESC LIMIT ?
              ) ORDER BY timestamp_ms ASC`,
            )
            .all(beforeMs, limit)
            .map(parseRow);
        },
      };
    } catch {
      return null;
    }
  }
  return directDb;
}

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
  id: "tinkerclaw-tinker",
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

    // If dangerouslyDisableDeviceAuth is enabled, serve Tinker without gateway auth
    // (same security posture as the Control UI — safe for loopback-only setups)
    const disableAuth =
      (api.config as any).gateway?.controlUi?.dangerouslyDisableDeviceAuth === true;

    let indexHtmlCache: string | null = null;

    function getIndexHtml(): string {
      if (indexHtmlCache) {
        return indexHtmlCache;
      }
      const raw = fs.readFileSync(path.join(TINKER_DIST, "index.html"), "utf-8");
      // Inject runtime config before </head> so the client can read it
      const config = JSON.stringify({ token: authToken });
      const tag = `<script>window.__TINKER_CONFIG=${config}</script>`;
      indexHtmlCache = raw.replace("</head>", `${tag}\n</head>`);
      return indexHtmlCache;
    }

    // Use registerHttpRoute (the correct plugin API) with prefix matching
    api.registerHttpRoute({
      path: PREFIX,
      auth: "gateway",
      match: "prefix",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        let pathname = url.pathname;

        // --- Jarvis Voice Mute API ---
        const MUTE_FILE = path.join(
          process.env.HOME ?? "/home/user",
          ".openclaw/data/jarvis-muted.json",
        );
        if (pathname === `${PREFIX}/api/jarvis-mute`) {
          const jsonHeaders = {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          };
          if (req.method === "OPTIONS") {
            res.writeHead(204, jsonHeaders);
            res.end();
            return true;
          }
          if (req.method === "GET") {
            let muted = false;
            try {
              muted = JSON.parse(fs.readFileSync(MUTE_FILE, "utf-8")).muted === true;
            } catch {
              fs.mkdirSync(path.dirname(MUTE_FILE), { recursive: true });
              fs.writeFileSync(MUTE_FILE, JSON.stringify({ muted: false }));
            }
            res.writeHead(200, jsonHeaders);
            res.end(JSON.stringify({ muted }));
            return true;
          }
          if (req.method === "POST") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(chunk as Buffer);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const muted = body.muted === true;
            fs.mkdirSync(path.dirname(MUTE_FILE), { recursive: true });
            fs.writeFileSync(MUTE_FILE, JSON.stringify({ muted }));
            res.writeHead(200, jsonHeaders);
            res.end(JSON.stringify({ muted }));
            return true;
          }
        }

        // --- Context Anatomy API (proxied through /tinker/api/context-anatomy/) ---
        if (pathname.startsWith(`${PREFIX}/api/context-anatomy/`)) {
          // Handle CORS preflight
          if (req.method === "OPTIONS") {
            res.writeHead(204, {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
              "Access-Control-Max-Age": "86400",
            });
            res.end();
            return true;
          }
          const anatomyDb = getAnatomyDb();
          const jsonHeaders = {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          };
          if (!anatomyDb) {
            res.writeHead(200, jsonHeaders);
            res.end(JSON.stringify({ count: 0, events: [] }));
            return true;
          }
          try {
            const subPath = pathname.slice(`${PREFIX}/api/context-anatomy/`.length);
            api.logger.info(`context-anatomy request: subPath="${subPath}" query="${url.search}"`);
            // /tinker/api/context-anatomy/before?ts=<timestampMs>&limit=50
            if (subPath === "before") {
              const tsParam = url.searchParams.get("ts");
              const beforeMs = parseInt(tsParam ?? "0", 10);
              if (!beforeMs) {
                res.writeHead(400, jsonHeaders);
                res.end(JSON.stringify({ error: "ts parameter required" }));
                return true;
              }
              const limitParam = url.searchParams.get("limit");
              const limit = limitParam
                ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 500)
                : 50;
              const events = anatomyDb.queryEventsBefore
                ? anatomyDb.queryEventsBefore(beforeMs, limit)
                : [];
              res.writeHead(200, jsonHeaders);
              res.end(JSON.stringify({ count: events.length, events }));
              return true;
            }
            // /tinker/api/context-anatomy/recent?hours=24
            if (subPath === "recent") {
              const hoursParam = url.searchParams.get("hours");
              const hours = Math.min(Math.max(parseInt(hoursParam ?? "48", 10) || 48, 1), 8760);
              const limitParam = url.searchParams.get("limit");
              const limit = limitParam
                ? Math.min(Math.max(1, parseInt(limitParam, 10) || 500), 2000)
                : 500;
              const events = anatomyDb.queryRecentEvents(hours, limit);
              res.writeHead(200, jsonHeaders);
              res.end(JSON.stringify({ count: events.length, events }));
              return true;
            }
            // /tinker/api/context-anatomy/:sessionKey[/latest]
            const isLatest = subPath.endsWith("/latest");
            const sessionKey = decodeURIComponent(isLatest ? subPath.slice(0, -7) : subPath);
            const limitParam = url.searchParams.get("limit");
            const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 500);
            if (isLatest) {
              const events = anatomyDb.querySessionEvents(sessionKey, 1);
              res.writeHead(events.length > 0 ? 200 : 404, jsonHeaders);
              res.end(JSON.stringify(events[0] ?? { error: "No events" }));
              return true;
            }
            // FORK 2026-07-16 (EEG fan-out visibility): ?tree=1 pulls the viewed
            // session + every subagent under its agent root, so the seismograph can
            // paint fan-out branches reload-proof (single-session gap fix).
            const wantTree = url.searchParams.get("tree") === "1";
            const events =
              wantTree && anatomyDb.querySessionTree
                ? anatomyDb.querySessionTree(sessionKey, limit)
                : anatomyDb.querySessionEvents(sessionKey, limit);
            api.logger.info(
              `context-anatomy session="${sessionKey}" tree=${wantTree} limit=${limit} → ${events.length} events`,
            );
            res.writeHead(200, jsonHeaders);
            res.end(JSON.stringify({ sessionKey, count: events.length, events }));
            return true;
          } catch (err: any) {
            api.logger.warn(`context-anatomy HTTP error: ${err.message}`);
            res.writeHead(500, jsonHeaders);
            res.end(JSON.stringify({ error: "Internal error" }));
            return true;
          }
        }

        // Redirect /tinker to /tinker/ for consistent relative URLs
        if (pathname === PREFIX) {
          res.statusCode = 301;
          res.setHeader("Location", PREFIX + "/");
          res.end();
          return true;
        }

        // ── FORK 2026-05-14: Kit content read endpoint ──
        // GET /tinker/api/kit-content?path=<relative-or-absolute>
        // Returns { path: string, content: string, isDownloaded: boolean }
        if (pathname === `${PREFIX}/api/kit-content` && req.method === "GET") {
          const jsonHeaders = { "Content-Type": "application/json" };
          const HOME = process.env.HOME ?? "/home/user";
          const TINKERCLAW_ROOT = path.resolve(HOME, "src/tinkerclaw");
          const WORKSPACE_KITS = path.resolve(HOME, ".openclaw/workspace/kits");
          const rawPath = url.searchParams.get("path") ?? "";
          if (!rawPath) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "path param required" }));
            return true;
          }
          const resolved = path.isAbsolute(rawPath)
            ? rawPath
            : path.resolve(TINKERCLAW_ROOT, rawPath);
          const inTinkerclaw = resolved.startsWith(TINKERCLAW_ROOT + path.sep);
          const inWorkspaceKits = resolved.startsWith(WORKSPACE_KITS + path.sep);
          if (!inTinkerclaw && !inWorkspaceKits) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Path outside allowed kit directories" }));
            return true;
          }
          try {
            const stat = fs.statSync(resolved);
            if (!stat.isFile()) throw new Error("not a file");
            if (stat.size > 512 * 1024) {
              res.statusCode = 413;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "File too large" }));
              return true;
            }
            const content = fs.readFileSync(resolved, "utf-8");
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache");
            res.end(JSON.stringify({ path: resolved, content, isDownloaded: inWorkspaceKits }));
          } catch (err: any) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message ?? "File not found" }));
          }
          return true;
        }

        // ── FORK 2026-05-14: Kit file save endpoint ──
        // POST /tinker/api/save-file { path: string, content: string }
        // Returns { ok: true } or { error: string }
        if (pathname === `${PREFIX}/api/save-file` && req.method === "POST") {
          const HOME = process.env.HOME ?? "/home/user";
          const TINKERCLAW_ROOT = path.resolve(HOME, "src/tinkerclaw");
          const WORKSPACE_KITS = path.resolve(HOME, ".openclaw/workspace/kits");
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          let body: { path?: unknown; content?: unknown };
          try {
            body = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return true;
          }
          if (typeof body.path !== "string" || typeof body.content !== "string") {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "path and content required" }));
            return true;
          }
          const OVERLAY_DIR = path.resolve(HOME, ".openclaw/recipes");
          // Recipe overlay redirect: a save of recipe.md / kit.md whose parent
          // dir is a slug is rewritten to live under the overlay as recipe.md.
          let targetPath = body.path;
          const base = path.basename(body.path);
          if (base === "recipe.md" || base === "kit.md") {
            const slug = path.basename(path.dirname(body.path));
            if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
              targetPath = path.join(OVERLAY_DIR, slug, "recipe.md");
            }
          }
          const resolved = path.isAbsolute(targetPath)
            ? targetPath
            : path.resolve(TINKERCLAW_ROOT, targetPath);
          const inTinkerclaw = resolved.startsWith(TINKERCLAW_ROOT + path.sep);
          const inWorkspaceKits = resolved.startsWith(WORKSPACE_KITS + path.sep);
          const inOverlay = resolved.startsWith(OVERLAY_DIR + path.sep);
          if (!inTinkerclaw && !inWorkspaceKits && !inOverlay) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Path outside allowed kit directories" }));
            return true;
          }
          // Atomic write: write to .tmp then rename
          const tmpPath = resolved + ".tmp";
          try {
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(tmpPath, body.content, "utf-8");
            fs.renameSync(tmpPath, resolved);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err: any) {
            try {
              fs.unlinkSync(tmpPath);
            } catch {}
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message ?? "Write failed" }));
          }
          return true;
        }

        // API: read local file contents
        if (pathname.startsWith(`${PREFIX}/api/`)) {
          const rawPath = url.searchParams.get("path") ?? "";
          if (!rawPath || !path.isAbsolute(rawPath)) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Absolute path required" }));
            return true;
          }
          // Try the exact path first, then common workspace prefixes
          const HOME = process.env.HOME ?? "/home/user";
          const candidates = [
            rawPath,
            path.join(HOME, ".openclaw/workspace/memory", rawPath),
            path.join(HOME, ".openclaw/workspace", rawPath),
            path.join(HOME, rawPath),
          ];
          let resolved: string | null = null;
          for (const c of candidates) {
            try {
              if (fs.statSync(c).isFile()) {
                resolved = c;
                break;
              }
            } catch {}
          }
          if (!resolved) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: `File not found: ${rawPath}` }));
            return true;
          }
          try {
            const stat = fs.statSync(resolved);
            if (stat.size > 512 * 1024) {
              res.statusCode = 413;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "File too large (>512KB)" }));
              return true;
            }
            const content = fs.readFileSync(resolved, "utf-8");
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache");
            res.end(JSON.stringify({ path: resolved, content }));
          } catch (err: any) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message ?? "File not found" }));
          }
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
        if (!rel || rel === "/") {
          rel = "/index.html";
        }

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
      },
    });

    api.logger.info(`Tinker Command Center registered at ${PREFIX}/ (with context-anatomy API)`);
  },
};

export default plugin;
