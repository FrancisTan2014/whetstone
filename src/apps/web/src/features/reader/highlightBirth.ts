import type { TargetAndTransition, Transition } from "framer-motion";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion.js";

export type HighlightBirth = Readonly<{
  animate: TargetAndTransition;
  initial: TargetAndTransition;
  transition: Transition;
}>;

// The "highlight birth" motion played when a saved note's block highlight first appears:
// the wash flushes in (opacity) and settles with a soft spring (scale). Under reduced
// motion the highlight appears instantly — identical start and end with a zero-duration
// transition — so the hue still shows without any animation.
export function highlightBirthMotion(prefersReducedMotion: boolean): HighlightBirth {
  if (prefersReducedMotion) {
    return {
      animate: { opacity: 1, scale: 1 },
      initial: { opacity: 1, scale: 1 },
      transition: withReducedMotion(motionSprings.gentle, true)
    };
  }

  return {
    animate: { opacity: 1, scale: 1 },
    initial: { opacity: 0.35, scale: 0.985 },
    transition: motionSprings.gentle
  };
}
