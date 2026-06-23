import type { Transition } from "framer-motion";

// Named motion tokens shared across the app. Durations are in seconds (Framer Motion's
// unit); easings mirror the CSS `--ease-*` tokens in styles/theme.css. Components animate
// only `transform`/`opacity` for WebView-safe 60fps.
export const motionDurations = {
  fast: 0.12,
  base: 0.2,
  slow: 0.32
} as const;

export const motionEasings = {
  standard: [0.2, 0, 0, 1],
  emphasized: [0.3, 0, 0, 1],
  exit: [0.4, 0, 1, 1]
} as const;

// Spring presets for interactive/shared-element motion in the chrome and on annotation.
export const motionSprings = {
  gentle: { type: "spring", stiffness: 170, damping: 26 },
  snappy: { type: "spring", stiffness: 320, damping: 30 }
} as const satisfies Record<string, Transition>;

// The non-animated transition used when motion is suppressed.
const instantTransition: Transition = { duration: 0 };

// Reduced-motion guard: returns the instant (non-animated) transition when the user
// prefers reduced motion, otherwise the requested transition unchanged. Pair this with
// `<MotionConfig reducedMotion="user">` at the app root for a single global policy.
export function withReducedMotion(
  transition: Transition,
  prefersReducedMotion: boolean
): Transition {
  return prefersReducedMotion ? instantTransition : transition;
}
