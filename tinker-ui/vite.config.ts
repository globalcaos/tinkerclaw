import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "/tinker/",
  server: {
    port: 18790,
    proxy: {
      // Proxy WebSocket to the gateway (dev mode only)
      "/ws": {
        target: "ws://localhost:18789",
        ws: true,
      },
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
