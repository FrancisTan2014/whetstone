import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The screenshot harness (scripts/screenshots.mjs) runs `vite preview` against an ephemeral
// server on a chosen port and points the proxy at it via WHETSTONE_API_PROXY; the dev server
// keeps its fixed default. Both proxy /api so the web app's relative API calls reach Fastify.
const apiProxyTarget = process.env.WHETSTONE_API_PROXY ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  preview: {
    proxy: {
      "/api": apiProxyTarget
    }
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000"
    }
  }
});
