import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

// Read gateway token from openclaw config for dev mode auth injection
function readGatewayToken(): string {
  try {
    const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return cfg?.gateway?.auth?.token ?? "";
  } catch {
    return "";
  }
}

// Inject __TINKER_CONFIG into the HTML in dev mode (mirrors what the plugin does in prod)
function tinkerDevConfig(): Plugin {
  return {
    name: "tinker-dev-config",
    apply: "serve",
    transformIndexHtml(html) {
      const cfg = JSON.stringify({ token: readGatewayToken() });
      return html.replace("</head>", `<script>window.__TINKER_CONFIG=${cfg}</script>\n</head>`);
    },
  };
}

// Dev-only endpoint: POST /api/open-file { path: "relative/path.md" }
// Opens the file in the native OS editor via xdg-open (Linux).
function openFilePlugin(): Plugin {
  const tinkerclaw = path.resolve(__dirname, "..");
  return {
    name: "tinker-open-file",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/open-file", (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end("Method not allowed");
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const { path: filePath } = JSON.parse(body);
            if (!filePath || typeof filePath !== "string") {
              res.writeHead(400);
              res.end("Missing path");
              return;
            }
            // Resolve relative to tinkerclaw root, prevent path traversal
            const resolved = path.resolve(tinkerclaw, filePath);
            if (!resolved.startsWith(tinkerclaw)) {
              res.writeHead(403);
              res.end("Path outside project");
              return;
            }
            if (!fs.existsSync(resolved)) {
              res.writeHead(404);
              res.end("File not found");
              return;
            }
            execFile("xdg-open", [resolved], (err) => {
              if (err) {
                console.error(`[open-file] xdg-open failed: ${err.message}`);
              }
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, path: resolved }));
          } catch {
            res.writeHead(400);
            res.end("Invalid JSON");
          }
        });
      });
    },
  };
}

// Dev-only endpoint: GET /api/kit-content?path=<relative-or-absolute>
// Returns { path, content, isDownloaded } — mirrors /tinker/api/kit-content in production.
// POST /api/save-file { path, content } — atomic write within kit directories.
function kitContentPlugin(): Plugin {
  const tinkerclaw = path.resolve(__dirname, "..");
  const workspaceKits = path.join(os.homedir(), ".openclaw/workspace/kits");
  return {
    name: "tinker-kit-content",
    apply: "serve",
    configureServer(server) {
      // GET /api/kit-content
      server.middlewares.use("/api/kit-content", (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end("Method not allowed");
          return;
        }
        const u = new URL(req.url ?? "/", "http://localhost");
        const rawPath = u.searchParams.get("path") ?? "";
        if (!rawPath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "path param required" }));
          return;
        }
        const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(tinkerclaw, rawPath);
        const inTinkerclaw =
          resolved.startsWith(tinkerclaw + path.sep) || resolved.startsWith(tinkerclaw + "/");
        const inWorkspaceKits =
          resolved.startsWith(workspaceKits + path.sep) || resolved.startsWith(workspaceKits + "/");
        if (!inTinkerclaw && !inWorkspaceKits) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Path outside allowed kit directories" }));
          return;
        }
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isFile()) throw new Error("not a file");
          if (stat.size > 512 * 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "File too large" }));
            return;
          }
          const content = fs.readFileSync(resolved, "utf-8");
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          res.end(JSON.stringify({ path: resolved, content, isDownloaded: inWorkspaceKits }));
        } catch (err: unknown) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message ?? "File not found" }));
        }
      });

      // POST /api/save-file
      server.middlewares.use("/api/save-file", (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end("Method not allowed");
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { path?: unknown; content?: unknown };
            if (typeof parsed.path !== "string" || typeof parsed.content !== "string") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "path and content required" }));
              return;
            }
            const resolved = path.isAbsolute(parsed.path)
              ? parsed.path
              : path.resolve(tinkerclaw, parsed.path);
            const inTinkerclaw =
              resolved.startsWith(tinkerclaw + path.sep) || resolved.startsWith(tinkerclaw + "/");
            const inWorkspaceKits =
              resolved.startsWith(workspaceKits + path.sep) ||
              resolved.startsWith(workspaceKits + "/");
            if (!inTinkerclaw && !inWorkspaceKits) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Path outside allowed kit directories" }));
              return;
            }
            // Atomic write: .tmp then rename
            const tmpPath = resolved + ".tmp";
            try {
              fs.mkdirSync(path.dirname(resolved), { recursive: true });
              fs.writeFileSync(tmpPath, parsed.content as string, "utf-8");
              fs.renameSync(tmpPath, resolved);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true }));
            } catch (writeErr: unknown) {
              try {
                fs.unlinkSync(tmpPath);
              } catch {}
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: (writeErr as Error).message ?? "Write failed" }));
            }
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  root: ".",
  base: "/tinker/",
  define: {
    __BUNDLED_DEV__: "false", // Vite 8 requires this build-time constant
  },
  plugins: [tinkerDevConfig(), openFilePlugin(), kitContentPlugin()],
  server: {
    port: 18790,
    // FORK 2026-05-24 (fourth pass) — bug task-mpjhzu3j-ma9ts: allow
    // imports from `../src/shared/` so client + gateway share the
    // FORTUNE_COOKIES JSON without duplication. Default fs.allow is
    // the tinker-ui root only; opening to `..` lets the client import
    // `../src/shared/fortune-cookies.json` (and any future shared
    // module). Path stays inside the tinkerclaw repo — no escape.
    fs: {
      allow: [".", ".."],
    },
    proxy: {
      // Proxy API calls to the gateway (dev mode only)
      "/api": {
        target: "http://localhost:18789",
        rewrite: (p: string) => `/tinker${p}`,
        headers: { Authorization: `Bearer ${readGatewayToken()}` },
      },
      // Proxy tinker API calls to gateway with auth (context-anatomy, mute, etc.)
      "/tinker/api": {
        target: "http://localhost:18789",
        headers: { Authorization: `Bearer ${readGatewayToken()}` },
      },
      // Proxy tinker file-read API — rewrite to gateway tinker route
      "/tinker-api": {
        target: "http://localhost:18789",
        rewrite: (p: string) => p.replace(/^\/tinker-api/, "/tinker/api"),
        headers: { Authorization: `Bearer ${readGatewayToken()}` },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyDirOnBuild: true,
  },
});
