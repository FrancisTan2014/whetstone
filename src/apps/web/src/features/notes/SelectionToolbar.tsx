import { motion } from "framer-motion";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion.js";

export type SelectionToolbarProps = Readonly<{
  anchorRect?: DOMRect | undefined;
  onClose: () => void;
  onConfirm: () => void;
  onLookup: () => void;
  prefersReducedMotion: boolean;
}>;

// A floating toolbar anchored to the current selection. It offers exactly two primary
// actions — "Add note" (opens the editor, where the size-preselected template is chosen
// or confirmed) and "Look up" (opens the view-only definition panel) — plus a dismiss
// control; the template choice lives in the note editor, not here. Positioned from a rect
// captured off the selection Range; springs in and honors reduced motion.
export function SelectionToolbar({
  anchorRect,
  onClose,
  onConfirm,
  onLookup,
  prefersReducedMotion
}: SelectionToolbarProps): React.JSX.Element {
  const positioned =
    anchorRect === undefined ? {} : { style: { left: anchorRect.left, top: anchorRect.bottom } };

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
      <button className="selectionToolbarAction" onClick={onConfirm} type="button">
        Add note
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
    </motion.div>
  );
}
