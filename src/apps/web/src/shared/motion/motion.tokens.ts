import type { Transition } from "framer-motion";

// Spring presets for interactive/shared-element motion in the chrome and on annotation. Pure
// presentational tokens — no logic. Components animate only `transform`/`opacity` for WebView-safe
// 60fps.
export const motionSprings = {
  gentle: { type: "spring", stiffness: 170, damping: 26 },
  snappy: { type: "spring", stiffness: 320, damping: 30 }
} as const satisfies Record<string, Transition>;
