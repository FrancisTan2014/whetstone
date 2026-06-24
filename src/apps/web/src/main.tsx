import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { HashRouter } from "react-router-dom";

import { App } from "./App";
import "./styles/theme.css";
import "./styles.css";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Root element #root was not found.");
}

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
