import { motion } from "framer-motion";
import { X } from "lucide-react";
import { useId } from "react";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion.js";

export type SelectionToolbarProps = Readonly<{
  anchorRect?: DOMRect | undefined;
  disabledHint?: string | undefined;
  onClose: () => void;
  onConfirm: () => void;
  onExplain: () => void;
  onLookup: () => void;
  onMark: () => void;
  prefersReducedMotion: boolean;
}>;

// A floating toolbar anchored to the current selection. It offers four primary actions — "Add
// note" (opens the focused rich note editor), "Mark" (a one-tap highlight with no note body, a "Gem"
// #255), "Look up" (dictionary only), and "Explain with AI" — plus a dismiss control. Positioned
// from a rect captured off the selection Range; springs in and honors reduced motion.
//
// When `disabledHint` is set the selection overlaps an existing annotation: annotations are disjoint
// (#163), so "Add note" and "Mark" are disabled and the hint explains why, while "Look up" stays
// available.
export function SelectionToolbar({
  anchorRect,
  disabledHint,
  onClose,
  onConfirm,
  onExplain,
  onLookup,
  onMark,
  prefersReducedMotion
}: SelectionToolbarProps): React.JSX.Element {
  const disclosureId = useId();
  const positioned =
    anchorRect === undefined
      ? {}
      : {
          style: {
            left: `clamp(12px, ${anchorRect.left}px, max(12px, calc(100vw - 34rem)))`,
            top: `min(${anchorRect.bottom}px, calc(100dvh - 12rem))`
          }
        };
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
        aria-describedby={disclosureId}
        className="selectionToolbarAction selectionToolbarAction--secondary"
        onClick={onExplain}
        type="button"
      >
        Explain with AI
      </button>
      <button
        aria-label="Dismiss"
        className="selectionToolbarDismiss"
        onClick={onClose}
        type="button"
      >
        <X aria-hidden size={18} strokeWidth={1.75} />
      </button>
      <p className="selectionToolbarHint" id={disclosureId}>
        Explain with AI sends the selection and a short surrounding passage to Copilot.
      </p>
      {overlapsAnnotation ? (
        <p className="selectionToolbarHint" role="note">
          {disabledHint}
        </p>
      ) : null}
    </motion.div>
  );
}
