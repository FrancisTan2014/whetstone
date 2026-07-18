import { ArrowLeft, X } from "lucide-react";

import { returnPillAriaLabel, returnPillLabel } from "./returnPoint";
import type { ReaderReturnPoint } from "./returnPoint";

export type ReaderBackPillProps = Readonly<{
  onDismiss: () => void;
  onReturn: () => void;
  returnPoint: ReaderReturnPoint;
}>;

// The reader's quiet, persistent "Back" pill (#549). Anchored at the bottom of the reader, it shows
// only while a return point exists and lets the reader jump back to the exact position they left
// after an internal jump (footnote/endnote, cross-reference, or a location-changing TOC entry). It
// carries NO timeout — it clears only when the reader taps it (returns), makes another jump (the
// point is replaced), or dismisses it here. The main control names its destination; a small close
// control dismisses without navigating. Motion and Day/Night styling come from design tokens in
// theme.css, respecting reduced-motion.
export function ReaderBackPill({
  onDismiss,
  onReturn,
  returnPoint
}: ReaderBackPillProps): React.JSX.Element {
  const label = returnPillLabel(returnPoint.unitTitle);
  const ariaLabel = returnPillAriaLabel(returnPoint.unitTitle);

  return (
    <div className="readerBackPill">
      <button
        aria-label={ariaLabel}
        className="readerBackPillReturn"
        onClick={onReturn}
        type="button"
      >
        <span aria-hidden="true" className="readerBackPillArrow">
          <ArrowLeft size={18} strokeWidth={1.75} />
        </span>
        <span className="readerBackPillLabel">{label}</span>
      </button>
      <button
        aria-label="Dismiss back"
        className="readerBackPillDismiss"
        onClick={onDismiss}
        type="button"
      >
        <X aria-hidden="true" size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}
