import type { ReaderStructure, ReaderUnitMeta } from "./readerModel";

// The 目录-driven reader navigates a work by its reading units and renders one unit at a
// time. These pure helpers decide which unit is active, label units in the table of
// contents, and translate scroll position into work-level progress — kept out of React so
// the navigation logic tests without layout.

// The index of the reading unit with the given entry id, or undefined when no unit in the
// structure has it. Used to resolve a locator's unit (a deep link or a jump to a note) and a
// restored reading position's unit to a position in the 目录.
export function unitIndexForEntryId(
  structure: ReaderStructure,
  unitEntryId: string
): number | undefined {
  const index = structure.units.findIndex((unit) => unit.entryId === unitEntryId);

  return index === -1 ? undefined : index;
}

// Clamp an externally supplied unit index (a TOC selection) into the valid range; an empty
// work clamps to 0.
export function clampUnitIndex(structure: ReaderStructure, index: number): number {
  const last = structure.units.length - 1;

  if (last < 0) {
    return 0;
  }

  return Math.min(Math.max(index, 0), last);
}

// The label a unit shows in the 目录: its title, or an ordinal fallback for untitled units
// (front matter, unnamed sections) so every entry is selectable.
export function unitTocLabel(unit: ReaderUnitMeta, index: number): string {
  return unit.title ?? `Section ${index + 1}`;
}

// Work-level reading progress (0..1): how far the current unit sits in the work plus the
// scroll fraction within it, so the progress bar reflects place in the whole work rather
// than just the loaded chapter.
export function workProgress(
  activeUnitIndex: number,
  unitCount: number,
  withinUnitFraction: number
): number {
  if (unitCount <= 0) {
    return 0;
  }

  const within = Math.min(Math.max(withinUnitFraction, 0), 1);

  return Math.min(1, (activeUnitIndex + within) / unitCount);
}
