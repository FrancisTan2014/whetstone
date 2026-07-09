import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The screenshot harness (scripts/screenshots.mjs) runs `vite preview` against an ephemeral
// server on a chosen port, and the E2E smoke suite (e2e/) runs the dev server against one;
// both point the proxy at it via WHETSTONE_API_PROXY. When unset it falls back to the dev
// default port, so a normal `pnpm dev` is unaffected. Both proxy /api so the web app's
// relative API calls reach Fastify.
const apiProxyTarget = process.env.WHETSTONE_API_PROXY ?? "http://127.0.0.1:3000";

// The service worker must never serve stale assets to the deterministic harnesses: the E2E smoke runs
// the dev server (SW off via `devOptions.enabled: false`), and the screenshot harness serves the built
// dist, so it sets WHETSTONE_DISABLE_PWA=true to build with no SW/manifest at all (#438).
const disablePwa = process.env.WHETSTONE_DISABLE_PWA === "true";

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    // The React Compiler (target React 19) auto-memoizes components/hooks so unnecessary
    // re-renders are prevented at build time; the rules-of-React ESLint gate keeps code eligible.
    // plugin-react v6 transforms JSX with oxc, so the compiler runs as a separate Babel pass via
    // @rolldown/plugin-babel using the plugin's reactCompilerPreset.
    babel({ presets: [reactCompilerPreset({ target: "19" })] }),
    // Installable PWA (#438): a generated manifest + Workbox service worker that precaches the built
    // app shell so the installed app opens in its own window. autoUpdate (skipWaiting + clientsClaim)
    // so a redeploy never strips users on a stale SW. Scope is the site root ("/") so the SW controls
    // the whole hash-routed SPA. No custom API/runtime caching in this slice (shell precache only).
    VitePWA({
      disable: disablePwa,
      registerType: "autoUpdate",
      injectRegister: "auto",
      // The SW is a browser-only concern; keep it out of dev and the E2E/screenshot harnesses.
      devOptions: { enabled: false },
      includeAssets: ["favicon.svg", "icon.svg", "icon-180.png"],
      manifest: {
        name: "whetstone",
        short_name: "whetstone",
        description: "Read, annotate, and practise a new language.",
        display: "standalone",
        start_url: "/",
        scope: "/",
        // Day theme tokens (src/apps/web/src/styles/theme.css): accent brand + app background.
        theme_color: "#4f46e5",
        background_color: "#f5f4ef",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        // Precache the built shell (JS/CSS/HTML + fonts + icons); no runtime/API caching here.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"]
      }
    })
  ],
  preview: {
    proxy: {
      "/api": apiProxyTarget
    }
  },
  server: {
    // A non-default dev port so `pnpm dev` never collides with other Vite projects (their default is
    // 5173). `strictPort` makes a clash fail loudly instead of silently drifting to another port and
    // desyncing the values that mirror this one: the desktop devUrl (tauri.conf.json) and QUICK_START.
    // The E2E / screenshot harnesses pass their own `--port` on the CLI, which overrides this.
    port: 5273,
    strictPort: true,
    proxy: {
      "/api": apiProxyTarget
    }
  }
});
