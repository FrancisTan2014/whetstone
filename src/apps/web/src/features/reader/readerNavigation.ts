import type { ReaderStructure, ReaderTocEntry, ReaderUnitMeta } from "./readerModel";
import type { AnchorIndex } from "./referenceResolver";

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

// Where selecting a nav-derived TOC entry (#379) takes the reader, decided purely so the dispatch
// tests without React: `none` is a no-op (a label-only entry, or one whose target unit/anchor cannot
// be resolved); `unit` opens a reading unit at its top (a whole-file entry); `block` scrolls to a
// specific block within a unit (an entry with a `#fragment`, resolved through #366's anchor index).
export type TocEntryNavigation =
  | Readonly<{ kind: "none" }>
  | Readonly<{ blockEntryId: string; kind: "block" }>
  | Readonly<{ kind: "unit"; unitIndex: number }>;

// Resolve a TOC entry to its navigation intent. An entry with no target unit — or one naming a unit
// the structure no longer lists — no-ops. A whole-file entry (no `targetAnchor`) opens its unit's top.
// An entry with a `#fragment` resolves that anchor against its target unit's source file through the
// work-scoped anchor index (#366): a hit jumps to the owning block, a miss no-ops (rather than
// silently opening the wrong place). Iterating with the unit's index in hand keeps both the ordinal
// (for opening) and the source file (for resolving) on one matched unit without a second lookup.
export function resolveTocEntryNavigation(
  structure: ReaderStructure,
  anchorIndex: AnchorIndex,
  entry: ReaderTocEntry
): TocEntryNavigation {
  if (entry.targetUnitEntryId === undefined) {
    return { kind: "none" };
  }

  for (const [unitIndex, unit] of structure.units.entries()) {
    if (unit.entryId !== entry.targetUnitEntryId) {
      continue;
    }

    if (entry.targetAnchor === undefined) {
      return { kind: "unit", unitIndex };
    }

    const blockEntryId = anchorIndex.resolve({
      anchor: entry.targetAnchor,
      ...(unit.sourceFile === undefined ? {} : { sourceFile: unit.sourceFile })
    });

    return blockEntryId === undefined ? { kind: "none" } : { blockEntryId, kind: "block" };
  }

  return { kind: "none" };
}

// The TOC entry to mark as current: the first entry that opens the active reading unit, so the drawer
// highlights where the reader is even when several entries point into the same unit. Absent when no
// unit is active or no entry targets it.
export function activeTocEntryId(
  entries: ReadonlyArray<ReaderTocEntry>,
  activeUnitEntryId: string | undefined
): string | undefined {
  if (activeUnitEntryId === undefined) {
    return undefined;
  }

  return entries.find((entry) => entry.targetUnitEntryId === activeUnitEntryId)?.entryId;
}
