/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import pkg from "./package.json";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": r("./src"),
      "@deeplab/shared": r("../../packages/shared/src/index.ts"),
      "@deeplab/sdk/mock-server": r("../../packages/sdk/src/mockServer.ts"),
      // Every ACP entry must precede the bare "@deeplab/sdk" prefix, which would
      // otherwise swallow them. `acp/stdio` (spawns an agent) and
      // `acp/serve-stdio` (IS the agent an editor spawns) are node-only;
      // nothing in the webview bundle may import either.
      "@deeplab/sdk/acp/serve-stdio": r("../../packages/sdk/src/acp/serve-stdio.ts"),
      "@deeplab/sdk/acp/stdio": r("../../packages/sdk/src/acp/stdio.ts"),
      "@deeplab/sdk/acp": r("../../packages/sdk/src/acp/index.ts"),
      "@deeplab/sdk": r("../../packages/sdk/src/index.ts"),
    },
  },
  // Browser dev: dsh's /api gateway serves its own SPA same-origin and refuses
  // cross-origin requests (browser-trust fence + no CORS headers). Proxy the
  // same-origin /api prefix (HTTP and the WebSocket event downlinks) to the
  // sidecar so the React app runs unmodified in `pnpm dev`. dsh's trust fence
  // requires Origin === Host, so the forwarded Origin is rewritten to the dsh
  // authority (changeOrigin: true already rewrites Host).
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3080",
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Origin", "http://127.0.0.1:3080");
          });
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("Origin", "http://127.0.0.1:3080");
          });
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
