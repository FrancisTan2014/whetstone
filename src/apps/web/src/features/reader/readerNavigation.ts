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

// The index of the first reading unit that carries substantive selectable text (#394), or undefined
// when every unit is front-matter-like (a cover/plate with no body text). A newly opened work with no
// saved position starts here so its cover does not dominate the first impression; the undefined case
// lets the caller fall back to the first unit, so the reader always opens something.
export function firstSubstantiveUnitIndex(structure: ReaderStructure): number | undefined {
  const index = structure.units.findIndex((unit) => unit.hasSubstantiveText);

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
// work-scoped anchor index (#366): a hit jumps to the owning block. A miss falls back to opening the
// target unit's top rather than doing nothing (#495) — a fragment commonly fails to resolve because the
// target unit's blocks are not loaded yet (a cross-chapter jump), and the entry still names a valid
// unit, so opening that chapter is the right move (its heading is at/near the top anyway). Iterating
// with the unit's index in hand keeps both the ordinal (for opening) and the source file (for resolving)
// on one matched unit without a second lookup.
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

    return blockEntryId === undefined
      ? { kind: "unit", unitIndex }
      : { blockEntryId, kind: "block" };
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

// The TOC entry to mark active for the reader's CURRENT position within the active unit (#542): the
// deepest authored section the current block falls within, so on a cold load (refresh / reopen) the
// drawer reopens revealed and highlighted around where the reader actually is — not just the chapter
// head. Among the entries that open the active unit, pick the one whose section-start block is the
// nearest at-or-before the current block in the unit's reading order; a tie resolves to the later
// (deeper) entry in the authored pre-order. Falls back to the chapter-level floor (`activeTocEntryId`)
// when there is no current block, the block is not in this unit, or no section starts at-or-before it —
// so behaviour is unchanged whenever the position cannot be resolved to a deeper section.
export function activeTocEntryIdForPosition(
  entries: ReadonlyArray<ReaderTocEntry>,
  activeUnitEntryId: string | undefined,
  unitBlocks: ReadonlyArray<{ anchorId?: string; entryId: string }>,
  currentBlockEntryId: string | undefined
): string | undefined {
  const floor = activeTocEntryId(entries, activeUnitEntryId);
  if (floor === undefined || currentBlockEntryId === undefined) {
    return floor;
  }

  const orderByBlockId = new Map<string, number>();
  const orderByAnchor = new Map<string, number>();
  unitBlocks.forEach((block, index) => {
    orderByBlockId.set(block.entryId, index);
    if (block.anchorId !== undefined) {
      orderByAnchor.set(block.anchorId, index);
    }
  });

  const currentIndex = orderByBlockId.get(currentBlockEntryId);
  if (currentIndex === undefined) {
    return floor;
  }

  let best: { entryId: string; rank: number; start: number } | undefined;
  entries.forEach((entry, rank) => {
    if (entry.targetUnitEntryId !== activeUnitEntryId) {
      return;
    }
    // A whole-unit entry starts at the unit top (index 0); a section entry starts at its anchor's block.
    const start = entry.targetAnchor === undefined ? 0 : orderByAnchor.get(entry.targetAnchor);
    if (start === undefined || start > currentIndex) {
      return;
    }
    if (best === undefined || start > best.start || (start === best.start && rank > best.rank)) {
      best = { entryId: entry.entryId, rank, start };
    }
  });

  return best?.entryId ?? floor;
}
