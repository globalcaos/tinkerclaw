import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: {
    port: 18790,
    proxy: {
      // Proxy WebSocket to the gateway
      "/ws": {
        target: "ws://localhost:18789",
        ws: true,
      },
      // Proxy API calls to the gateway
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
