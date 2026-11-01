import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.LEETCLAUDE_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api/ws": { target: api.replace(/^http/, "ws"), ws: true },
      "/api": { target: api, changeOrigin: true },
    },
  },
  build: { chunkSizeWarningLimit: 4000 },
});
