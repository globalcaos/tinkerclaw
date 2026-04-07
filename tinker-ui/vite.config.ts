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
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
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

export default defineConfig({
  root: ".",
  base: "/tinker/",
  define: {
    __BUNDLED_DEV__: "false", // Vite 8 requires this build-time constant
  },
  plugins: [tinkerDevConfig(), openFilePlugin()],
  server: {
    port: 18790,
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
