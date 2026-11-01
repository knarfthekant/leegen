import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ports: 13370 = backend (UI + API + MCP), 13371 = this dev server. `leetclaude dev` sets both.
const apiPort = process.env.LEETCLAUDE_PORT ?? "13370";
const api = process.env.LEETCLAUDE_API ?? `http://127.0.0.1:${apiPort}`;
const webPort = Number(process.env.LEETCLAUDE_WEB_PORT ?? 13371);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true, // fail loudly instead of drifting to another port
    proxy: {
      "/api/ws": { target: api.replace(/^http/, "ws"), ws: true },
      "/api": { target: api, changeOrigin: true },
      "/mcp": { target: api, changeOrigin: true },
    },
  },
  preview: { port: webPort, strictPort: true },
  build: { chunkSizeWarningLimit: 4000 },
});
