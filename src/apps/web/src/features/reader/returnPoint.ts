// The reader's single-level "Back" return point (#549). After any internal jump that moves the
// reader — a footnote/endnote marker, a same-work cross-reference, or a TOC entry that changes
// location — the origin the reader jumped from is captured here so a quiet, persistent Back pill
// can return them to the exact spot. It is a single return point (not a history stack): each new
// jump replaces it, matching Kindle / Apple Books "Back to …". Kept pure (no React, DOM, or
// layout) so the capture, no-op, and labelling rules test in isolation.

// Where the reader jumped from: the origin reading unit, the top-of-viewport block within it, and
// the origin unit's title when known (for the pill's label).
export type ReaderReturnPoint = Readonly<{
  blockEntryId: string;
  unitEntryId: string;
  unitTitle?: string | undefined;
}>;

// The origin the reader is about to leave, read at capture time (before the jump): the active unit
// and the top-of-viewport block. Either may be unknown (nothing measurable yet), in which case no
// return point can be recorded.
export type ReturnOrigin = Readonly<{
  blockEntryId?: string | undefined;
  unitEntryId?: string | undefined;
  unitTitle?: string | undefined;
}>;

// Decide the return point to record before an internal jump moves the reader, or undefined when
// nothing should be captured: the origin is not measurable (no active unit or no visible block),
// or the jump is a no-op because the target block is the one the reader is already at. A caller
// that navigates to another unit without a specific block target passes `targetBlockEntryId`
// undefined and guards its own unit-level no-op (selecting the current unit).
export function captureReturnPoint(params: {
  origin: ReturnOrigin;
  targetBlockEntryId?: string | undefined;
}): ReaderReturnPoint | undefined {
  const { origin, targetBlockEntryId } = params;

  if (origin.unitEntryId === undefined || origin.blockEntryId === undefined) {
    return undefined;
  }

  if (targetBlockEntryId !== undefined && targetBlockEntryId === origin.blockEntryId) {
    return undefined;
  }

  return {
    blockEntryId: origin.blockEntryId,
    unitEntryId: origin.unitEntryId,
    ...(origin.unitTitle === undefined ? {} : { unitTitle: origin.unitTitle })
  };
}

// The longest unit title the pill shows before truncating with an ellipsis, so a long chapter name
// never blows out the quiet pill.
const maxLabelTitleLength = 24;

// Shorten a unit title for the pill: collapse surrounding whitespace and truncate an over-long
// title with an ellipsis. An all-whitespace title collapses to empty, so the label falls back to
// plain "Back".
export function shortenUnitTitle(title: string): string {
  const trimmed = title.trim();

  if (trimmed.length <= maxLabelTitleLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLabelTitleLength).trimEnd()}…`;
}

// The visible label on the Back pill: "Back to <short unit title>" when the origin unit title is
// resolvable, otherwise plain "Back".
export function returnPillLabel(unitTitle: string | undefined): string {
  const short = unitTitle === undefined ? "" : shortenUnitTitle(unitTitle);

  return short === "" ? "Back" : `Back to ${short}`;
}

// The pill's accessible name, always spelling out the destination in full (never truncated): the
// origin unit title when known, or a generic phrase so the control still names where it returns to.
export function returnPillAriaLabel(unitTitle: string | undefined): string {
  const trimmed = unitTitle === undefined ? "" : unitTitle.trim();

  return trimmed === "" ? "Back to your previous position" : `Back to ${trimmed}`;
}
