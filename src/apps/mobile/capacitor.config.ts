/// <reference types="node" />
import type { CapacitorConfig } from "@capacitor/cli";

// The iOS shell runs the same web bundle from the local Capacitor origin, so it embeds the built web
// assets rather than loading a remote URL (AC #3). `webDir` points at the web app's Vite `dist`, which
// `pnpm --filter @whetstone/mobile sync` produces before `cap sync ios` copies it into the native app.
const config: CapacitorConfig = {
  appId: "com.whetstone.app",
  appName: "Whetstone",
  webDir: "../web/dist",
  ios: {
    // The web core owns its own scrolling/overscroll; let the native webview defer to it.
    contentInset: "always"
  },
  server: {
    // Keep external links out of the in-app webview so they open in Safari (AC #5). An empty
    // allow-list means only the local Capacitor origin loads in the webview; every other http(s)
    // navigation (e.g. the reader's dictionary lookup links) is handed to the system browser.
    allowNavigation: []
  }
};

export default config;
