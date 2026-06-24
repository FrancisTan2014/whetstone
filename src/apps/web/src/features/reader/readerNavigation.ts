import type { ReaderUnit, ReaderView } from "./readerModel";

// The 目录-driven reader navigates a work by its reading units and renders one unit at a
// time. These pure helpers decide which unit is active, label units in the table of
// contents, and translate scroll position into work-level progress — kept out of React so
// the navigation logic tests without layout.

// The index of the reading unit that holds the given block, or undefined when no unit in
// the work contains it. The view carries every unit (only one is rendered at a time), so a
// valid note always resolves even when its block lives in another unit.
export function unitIndexOfBlock(view: ReaderView, blockEntryId: string): number | undefined {
  const index = view.units.findIndex((unit) =>
    unit.blocks.some((block) => block.entryId === blockEntryId)
  );

  return index === -1 ? undefined : index;
}

// The unit to open first: the unit holding the deep-linked block when one is supplied and
// found, otherwise the first unit. Callers guard on an empty work, so 0 is a safe default.
export function initialUnitIndex(view: ReaderView, deepLinkBlockEntryId?: string): number {
  if (deepLinkBlockEntryId === undefined) {
    return 0;
  }

  return unitIndexOfBlock(view, deepLinkBlockEntryId) ?? 0;
}

// The unit to switch to when jumping to a block: the unit that holds it, or the fallback
// (the current unit) when the block is not part of the work.
export function targetUnitForBlock(
  view: ReaderView,
  blockEntryId: string,
  fallbackIndex: number
): number {
  return unitIndexOfBlock(view, blockEntryId) ?? fallbackIndex;
}

// Clamp an externally supplied unit index (a TOC selection) into the valid range; an empty
// work clamps to 0.
export function clampUnitIndex(view: ReaderView, index: number): number {
  const last = view.units.length - 1;

  if (last < 0) {
    return 0;
  }

  return Math.min(Math.max(index, 0), last);
}

// The label a unit shows in the 目录: its title, or an ordinal fallback for untitled units
// (front matter, unnamed sections) so every entry is selectable.
export function unitTocLabel(unit: ReaderUnit, index: number): string {
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
