import { motion } from "framer-motion";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion.js";

export type SelectionToolbarProps = Readonly<{
  anchorRect?: DOMRect | undefined;
  disabledHint?: string | undefined;
  onClose: () => void;
  onConfirm: () => void;
  onLookup: () => void;
  onMark: () => void;
  prefersReducedMotion: boolean;
}>;

// A floating toolbar anchored to the current selection. It offers three primary actions — "Add
// note" (opens the editor, where the size-preselected template is chosen or confirmed), "Mark" (a
// one-tap highlight with no note body, a "Gem" #255), and "Look up" (opens the view-only definition
// panel) — plus a dismiss control; the template choice lives in the note editor, not here.
// Positioned from a rect captured off the selection Range; springs in and honors reduced motion.
//
// When `disabledHint` is set the selection overlaps an existing annotation: annotations are disjoint
// (#163), so "Add note" and "Mark" are disabled and the hint explains why, while "Look up" stays
// available.
export function SelectionToolbar({
  anchorRect,
  disabledHint,
  onClose,
  onConfirm,
  onLookup,
  onMark,
  prefersReducedMotion
}: SelectionToolbarProps): React.JSX.Element {
  const positioned =
    anchorRect === undefined ? {} : { style: { left: anchorRect.left, top: anchorRect.bottom } };
  const overlapsAnnotation = disabledHint !== undefined;

  return (
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      aria-label="Annotate selection"
      className="selectionToolbar"
      initial={{ opacity: 0, scale: 0.96 }}
      role="toolbar"
      transition={withReducedMotion(motionSprings.snappy, prefersReducedMotion)}
      {...positioned}
    >
      <button
        className="selectionToolbarAction"
        disabled={overlapsAnnotation}
        onClick={onConfirm}
        type="button"
      >
        Add note
      </button>
      <button
        className="selectionToolbarAction selectionToolbarAction--mark"
        disabled={overlapsAnnotation}
        onClick={onMark}
        type="button"
      >
        Mark
      </button>
      <button
        className="selectionToolbarAction selectionToolbarAction--secondary"
        onClick={onLookup}
        type="button"
      >
        Look up
      </button>
      <button
        aria-label="Dismiss"
        className="selectionToolbarDismiss"
        onClick={onClose}
        type="button"
      >
        ✕
      </button>
      {overlapsAnnotation ? (
        <p className="selectionToolbarHint" role="note">
          {disabledHint}
        </p>
      ) : null}
    </motion.div>
  );
}
