import type { TargetAndTransition, Transition } from "framer-motion";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion.js";

export type ReadingEntrance = Readonly<{
  animate: TargetAndTransition;
  initial: TargetAndTransition;
  transition: Transition;
}>;

// The reading column's entrance, played when a unit mounts. It must NEVER gate the reading
// text's legibility on an opacity fade: fading dark Day text in from a low opacity over the
// cream paper renders it as pale, hard-to-read gray for the first ~half second of every load
// (#182 — the bug only looked "Day-specific" because dark-text-on-light at low opacity reads as
// washed out, while light-text-on-dark stays legible). So the content stays fully opaque
// (opacity 1) throughout and the entrance is a gentle vertical settle (transform only). Under
// reduced motion there is no movement at all — identical start and end with a zero-duration
// transition.
export function readingEntranceMotion(prefersReducedMotion: boolean): ReadingEntrance {
  const offset = prefersReducedMotion ? 0 : 8;

  return {
    animate: { opacity: 1, y: 0 },
    initial: { opacity: 1, y: offset },
    transition: withReducedMotion(motionSprings.gentle, prefersReducedMotion)
  };
}
