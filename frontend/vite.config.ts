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
    rollupOptions: {
      output: {
        // Function form (not the object form) so that react/react-dom are
        // pinned to react-vendor and never absorbed into the recharts chunk.
        // The object form let rollup fold react-dom into recharts (a 527KB
        // chunk), which got eagerly preloaded. Splitting them keeps the
        // largest chunk ~107KB gzipped. Note recharts is still eagerly loaded
        // because SeeingForecast (in the plan header) uses it; only
        // SessionTimeline and ChatPane are lazy.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("/react-dom/") ||
            id.includes("/react/") ||
            id.includes("/scheduler/")
          ) {
            return "react-vendor";
          }
          if (id.includes("@tanstack")) return "query";
          if (
            id.includes("/recharts/") ||
            id.includes("/d3-") ||
            id.includes("/victory-") ||
            id.includes("/lodash")
          ) {
            return "recharts";
          }
          return undefined;
        },
      },
    },
  },
});
