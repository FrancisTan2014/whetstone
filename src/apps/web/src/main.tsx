import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";

import { App } from "./App";
import { ThemeToggle } from "./shared/theme/ThemeToggle";
import "./styles/theme.css";
import "./styles.css";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Root element #root was not found.");
}

// `reducedMotion="user"` makes every Framer Motion animation honor the OS preference
// globally; the JS guard in shared/motion/motion.ts covers manual transition configs.
createRoot(rootElement).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <ThemeToggle />
      <App />
    </MotionConfig>
  </StrictMode>
);
