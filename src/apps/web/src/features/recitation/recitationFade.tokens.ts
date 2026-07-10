import type { Transition } from "framer-motion";

// Presentational motion tokens for the passage support fade (#579): a pure boolean → motion map, kept in
// a coverage-excluded *.tokens module like the other presentational token files. Changing the support
// level cross-fades the projection briefly; when the learner prefers reduced motion the change is
// instant (no opacity travel and zero-duration), so the fade never animates against their setting.
export function supportFadeInitialOpacity(prefersReducedMotion: boolean): number {
  return prefersReducedMotion ? 1 : 0;
}

export function supportFadeTransition(prefersReducedMotion: boolean): Transition {
  return { duration: prefersReducedMotion ? 0 : 0.25 };
}
