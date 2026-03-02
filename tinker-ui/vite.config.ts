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

export default defineConfig({
  root: ".",
  base: "/tinker/",
  plugins: [tinkerDevConfig()],
  server: {
    port: 18790,
    proxy: {
      // Proxy API calls to the gateway (dev mode only)
      "/api": {
        target: "http://localhost:18789",
      },
    },
  },
  build: {
    outDir: "dist",
    emptyDirOnBuild: true,
  },
});
