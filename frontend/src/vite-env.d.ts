/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Base URL for the Zenith API. Empty in dev (Vite proxies /api -> :8000);
  // set to the Cloudflare Worker URL in production builds so the frontend
  // calls the Worker directly (Cloudflare Pages _redirects cannot proxy POST).
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
