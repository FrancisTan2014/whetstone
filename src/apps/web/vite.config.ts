import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The screenshot harness (scripts/screenshots.mjs) runs `vite preview` against an ephemeral
// server on a chosen port and points the proxy at it via WHETSTONE_API_PROXY; the dev server
// keeps its fixed default. Both proxy /api so the web app's relative API calls reach Fastify.
const apiProxyTarget = process.env.WHETSTONE_API_PROXY ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    // The React Compiler (target React 19) auto-memoizes components/hooks so unnecessary
    // re-renders are prevented at build time; the rules-of-React ESLint gate keeps code eligible.
    // plugin-react v6 transforms JSX with oxc, so the compiler runs as a separate Babel pass via
    // @rolldown/plugin-babel using the plugin's reactCompilerPreset.
    babel({ presets: [reactCompilerPreset({ target: "19" })] })
  ],
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
