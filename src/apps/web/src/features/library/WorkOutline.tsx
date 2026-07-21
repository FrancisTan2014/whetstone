import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import type { ManualWorkSectionDto } from "@whetstone/contracts";
import { buildHeadingOutline, type HeadingOutlineEntry, type HeadingOutlineUnit } from "@whetstone/domain";
import type { DocumentNodeJSON } from "@whetstone/document";

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
  return buildHeadingOutline(sections.map(sectionToOutlineUnit));
}

function sectionToOutlineUnit(section: ManualWorkSectionDto): HeadingOutlineUnit {
  return {
    entryId: section.unitEntryId,
    ...(section.headingLevel === undefined ? {} : { headingLevel: section.headingLevel }),
    ...(section.title === undefined ? {} : { title: section.title })
  };
}

// The plaintext of a heading node's inline content, used only to preview a draft heading's label live
// (the server derives the canonical title on save). Empty for an untitled heading.
function headingText(node: DocumentNodeJSON): string {
  return (node.content ?? []).map((child) => child.text ?? "").join("");
}

// Split the active section's DRAFT document into outline units at every heading node — the same boundary
// the server repartitions on — so a preview entry appears per heading. The first partition keeps the
// active unit's real id (so it stays navigable and highlighted); later partitions are preview-only.
function partitionDraftIntoUnits(
  activeUnitEntryId: string,
  draft: DocumentNodeJSON
): HeadingOutlineUnit[] {
  const units: HeadingOutlineUnit[] = [];
  let partitionIndex = -1;
  (draft.content ?? []).forEach((block, index) => {
    const isHeading = block.type === "heading";
    if (index !== 0 && !isHeading) {
      return;
    }
    partitionIndex += 1;
    const entryId =
      partitionIndex === 0 ? activeUnitEntryId : `${activeUnitEntryId}\u0000draft-${partitionIndex}`;
    if (!isHeading) {
      units.push({ entryId });
      return;
    }
    const level = (block.attrs as { level?: unknown } | undefined)?.level;
    const title = headingText(block);
    units.push({
      entryId,
      ...(typeof level === "number" ? { headingLevel: level } : {}),
      ...(title.length === 0 ? {} : { title })
    });
  });
  return units;
}

// Project the active section's live DRAFT into the persisted section list so the Outline reflects heading
// edits immediately (#698), before a save reconciles canonical units. The active section is replaced by
// one entry per draft partition: the first keeps the active unit's id; later partitions are preview-only
// synthetic ids whose target stays the active unit, so a click merely keeps the open section rather than
// navigating to a not-yet-saved unit. On save the server-reconciled Outline replaces this projection.
export function projectDraftOutline(
  sections: ReadonlyArray<ManualWorkSectionDto>,
  activeUnitEntryId: string,
  draft: DocumentNodeJSON
): ReadonlyArray<HeadingOutlineEntry> {
  const draftUnits = partitionDraftIntoUnits(activeUnitEntryId, draft);
  const projected: HeadingOutlineUnit[] = [];
  for (const section of sections) {
    if (section.unitEntryId === activeUnitEntryId) {
      projected.push(...draftUnits);
    } else {
      projected.push(sectionToOutlineUnit(section));
    }
  }

  const previewEntryIds = new Set(draftUnits.slice(1).map((unit) => unit.entryId));
  return buildHeadingOutline(projected).map((entry) =>
    previewEntryIds.has(entry.entryId)
      ? { ...entry, targetUnitEntryId: activeUnitEntryId }
      : entry
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

  // The active *path*, not just the active section: issue #697 requires selecting a nested item to
  // highlight the whole ancestry (Part One > Chapter One > Section One), so a reader always sees where the
  // open section sits in the hierarchy. Walk up the derived `parentEntryId` chain from the active entry —
  // every entry's `entryId` is its own `targetUnitEntryId`, so the active entry is found by id directly.
  const activePathEntryIds = useMemo(() => {
    const path = new Set<string>();
    const byEntryId = new Map(entries.map((entry) => [entry.entryId, entry] as const));
    let current = byEntryId.get(activeUnitEntryId);
    while (current !== undefined) {
      path.add(current.entryId);
      current =
        current.parentEntryId === undefined ? undefined : byEntryId.get(current.parentEntryId);
    }
    return path;
  }, [entries, activeUnitEntryId]);

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
                  data-active-path={activePathEntryIds.has(entry.entryId) ? "true" : undefined}
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
