import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { HashRouter } from "react-router-dom";

import { App } from "./App";
import { bootstrapApiRuntime } from "./shared/runtime";
import "./styles/theme.css";
import "./styles.css";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Root element #root was not found.");
}

// Boundary: resolve the host runtime contract once before anything renders. A native shell
// (desktop/iOS) injects `window.__WHETSTONE_HOST_CONFIG__`; browser web injects nothing and falls
// back to same-origin `/api`. An invalid injection fails loud with a blocking startup screen instead
// of silently starting with a wrong API base.
const resolution = bootstrapApiRuntime(window as unknown as Record<string, unknown>);

if (!resolution.ok) {
  const screen = document.createElement("main");
  screen.setAttribute("role", "alert");
  screen.style.cssText =
    "font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5;";
  const heading = document.createElement("h1");
  heading.textContent = "Whetstone could not start";
  const detail = document.createElement("p");
  detail.textContent = resolution.message;
  screen.append(heading, detail);
  rootElement.replaceChildren(screen);
} else {
  // `reducedMotion="user"` makes every Framer Motion animation honor the OS preference
  // globally. HashRouter keeps routing origin-independent (file / capacitor:// / tauri://).
  createRoot(rootElement).render(
    <StrictMode>
      <MotionConfig reducedMotion="user">
        <HashRouter>
          <App />
        </HashRouter>
      </MotionConfig>
    </StrictMode>
  );
}
