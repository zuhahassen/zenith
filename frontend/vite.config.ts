import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite dev server proxies /api/* to the FastAPI process on :8000 so the
// React app and Python backend can run side-by-side without CORS shenanigans.
// In production, /api/* is routed by the Cloudflare Worker (see _redirects).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
