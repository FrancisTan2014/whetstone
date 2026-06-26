import type { Transition } from "framer-motion";

// The named motion token tables (durations, easings, springs) live in the coverage-excluded
// `motion.tokens.ts`; re-exported here so consumers keep importing motion from one place.
export { motionDurations, motionEasings, motionSprings } from "./motion.tokens.js";

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
