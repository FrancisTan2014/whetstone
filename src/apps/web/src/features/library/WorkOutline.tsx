import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { ManualWorkSectionDto } from "@whetstone/contracts";
import { buildHeadingOutline, type HeadingOutlineEntry } from "@whetstone/domain";

import { useMediaQuery } from "../../shared/ui/useMediaQuery.js";

// The manual-Work editor's live Outline (#697): the section navigator derived ONLY from the persisted
// heading blocks — never a stored or client-cached TOC copy. At 48rem+ it is a sticky sidebar always in
// view beside the editor canvas; below 48rem it collapses to a single 44px control that opens a
// full-height drawer with Escape/outside dismissal and focus restoration. Selecting an entry loads that
// section, and the parent focuses its heading. The outline itself owns no save/navigation logic; it
// reports selection and the add-section request and reflects the active section.

// The width at which the Outline is a persistent sidebar rather than a drawer (#697). Read in JS as well
// as CSS so the drawer's open state and dismissal only apply while it is actually a drawer.
const OUTLINE_SIDEBAR_QUERY = "(min-width: 48rem)";

// Project a Work's ordered sections into the shared hierarchical outline. Reuses the domain projection so
// the editor Outline and the Reader TOC derive the SAME hierarchy from the same heading data: source
// order preserved, skipped levels compressed, a root "Start" only when pre-heading content precedes a
// useful outline, and an empty outline for a single-section or headingless Work. Recomputed from the
// sections on every render; nothing is persisted here.
export function deriveWorkOutline(
  sections: ReadonlyArray<ManualWorkSectionDto>
): ReadonlyArray<HeadingOutlineEntry> {
  return buildHeadingOutline(
    sections.map((section) => ({
      entryId: section.unitEntryId,
      ...(section.headingLevel === undefined ? {} : { headingLevel: section.headingLevel }),
      ...(section.title === undefined ? {} : { title: section.title })
    }))
  );
}

export function WorkOutline({
  activeUnitEntryId,
  addPending,
  entries,
  onAddSection,
  onSelect
}: Readonly<{
  activeUnitEntryId: string;
  addPending: boolean;
  entries: ReadonlyArray<HeadingOutlineEntry>;
  onAddSection: () => void;
  onSelect: (unitEntryId: string) => void;
}>): React.JSX.Element {
  const isSidebar = useMediaQuery(OUTLINE_SIDEBAR_QUERY);
  const [openRequested, setOpenRequested] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // The drawer is only ever open below the sidebar breakpoint. Deriving the open state (rather than
  // resetting it in an effect) means growing to sidebar width simply hands navigation to the always-
  // visible sidebar — the transient request is ignored, with no focus to restore.
  const drawerOpen = openRequested && !isSidebar;

  // Dismiss (drawer only), optionally restoring focus to the control that opened it. A selection moves
  // focus into the editor's heading instead, so it closes WITHOUT restoring; Escape/backdrop dismissal
  // restores focus to the opener so keyboard focus is never stranded.
  const dismiss = useCallback((restoreFocus: boolean): void => {
    setOpenRequested(false);
    if (restoreFocus) {
      // The toggle is always mounted (it is rendered unconditionally, only hidden by CSS in sidebar
      // mode), so the opener ref is set whenever a focus-restoring dismissal runs.
      openerRef.current!.focus();
    }
  }, []);

  // Escape closes the drawer (matching its backdrop/selection dismissal), attached only while open so it
  // never competes with editor key handling when the drawer is closed or the Outline is a sidebar.
  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        dismiss(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, dismiss]);

  const select = (unitEntryId: string): void => {
    onSelect(unitEntryId);
    if (!isSidebar) {
      dismiss(false);
    }
  };

  return (
    <div className="workOutline">
      <button
        aria-controls={panelId}
        aria-expanded={drawerOpen}
        className="workOutlineToggle"
        onClick={() => setOpenRequested(true)}
        ref={openerRef}
        type="button"
      >
        Outline
      </button>
      {drawerOpen ? (
        <button
          aria-label="Close outline"
          className="workOutlineBackdrop"
          onClick={() => dismiss(true)}
          type="button"
        />
      ) : null}
      <nav
        aria-label="Outline"
        className={`workOutlinePanel${drawerOpen ? " workOutlinePanel--open" : ""}`}
        id={panelId}
      >
        <p className="workOutlineHeading">Outline</p>
        {entries.length > 0 ? (
          <ul className="workOutlineList">
            {entries.map((entry) => (
              <li
                className="workOutlineNode"
                data-depth={entry.depth}
                key={entry.entryId}
                style={{ "--outline-depth": entry.depth } as React.CSSProperties}
              >
                <button
                  aria-current={entry.targetUnitEntryId === activeUnitEntryId ? "true" : undefined}
                  className="workOutlineItem"
                  onClick={() => select(entry.targetUnitEntryId)}
                  title={entry.label}
                  type="button"
                >
                  <span className="workOutlineLabel">{entry.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="workOutlineEmpty">Add a section to build your outline.</p>
        )}
        <button
          className="workOutlineAdd"
          disabled={addPending}
          onClick={onAddSection}
          type="button"
        >
          {addPending ? "Adding…" : "Add section"}
        </button>
      </nav>
    </div>
  );
}
