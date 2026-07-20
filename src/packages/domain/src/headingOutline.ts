// A manually-added Markdown work has no authored table of contents (only an EPUB carries one). Its
// hierarchy lives implicitly in the heading levels that start each reading unit. This pure projection
// derives a hierarchical outline from that heading structure so Manage content and the Reader present
// the same table of contents — without persisting a second, editable copy. The outline is recomputed
// from the units on every read; nothing here is stored.

// A reading unit as the outline projection sees it: its stable id, its optional title (the heading's
// text — absent for an untitled heading or the leading run of content before the first heading), and
// the Markdown heading level (mdast heading depth, 1-6) that starts it. `headingLevel` is absent for a
// unit that does not start at a heading (only ever the leading preface unit).
export type HeadingOutlineUnit = Readonly<{
  entryId: string;
  headingLevel?: number;
  title?: string;
}>;

// One node of the derived table of contents. Shaped to match the served TOC entry so both consumers
// map it the same way: `depth` and `parentEntryId` capture the compressed nesting, `orderIndex` is the
// source-order (pre-order) rank so entries render fully expanded and correctly indented, and
// `targetUnitEntryId` is the reading unit the entry opens (always its own unit — a heading entry opens
// the unit's top, so there is never a sub-unit anchor).
export type HeadingOutlineEntry = Readonly<{
  depth: number;
  entryId: string;
  label: string;
  orderIndex: number;
  parentEntryId?: string;
  targetUnitEntryId: string;
}>;

// The label for the single root entry that gathers any content before the first heading, so a reader
// can jump back to the work's opening once later headings make a table of contents worthwhile.
export const HEADING_OUTLINE_PREFACE_LABEL = "Start";

// The label for a heading with no text (an empty `#`), so every derived entry stays selectable.
export const HEADING_OUTLINE_UNTITLED_LABEL = "Untitled section";

type OpenHeading = { depth: number; entryId: string; level: number };

// Derive the hierarchical outline from a work's reading units, in source order.
//
// Rules (see issue #680): a single-unit work, or a work whose units carry no heading level, has no
// table of contents (the Reader reads it straight through) — both return an empty outline. Otherwise
// each heading's parent is the nearest preceding heading with a strictly lower level; a heading with no
// lower-level ancestor is a root. Skipped levels compress to one nesting step — depth is the parent's
// depth plus one, never the absolute level gap — so an H1 followed by an H3 nests one level, not two.
// An equal-or-shallower heading closes the deeper branch first. Content before the first heading is
// emitted once as a root "Start" entry (a sibling of the first chapter, never a parent of it).
export function buildHeadingOutline(
  units: ReadonlyArray<HeadingOutlineUnit>
): ReadonlyArray<HeadingOutlineEntry> {
  if (units.length <= 1) {
    return [];
  }
  if (!units.some((unit) => unit.headingLevel !== undefined)) {
    return [];
  }

  const entries: HeadingOutlineEntry[] = [];
  const openHeadings: OpenHeading[] = [];

  units.forEach((unit, orderIndex) => {
    const level = unit.headingLevel;
    if (level === undefined) {
      entries.push({
        depth: 0,
        entryId: unit.entryId,
        label: HEADING_OUTLINE_PREFACE_LABEL,
        orderIndex,
        targetUnitEntryId: unit.entryId
      });
      return;
    }

    let parent = openHeadings.at(-1);
    while (parent !== undefined && parent.level >= level) {
      openHeadings.pop();
      parent = openHeadings.at(-1);
    }
    const depth = parent === undefined ? 0 : parent.depth + 1;
    entries.push({
      depth,
      entryId: unit.entryId,
      label: unit.title ?? HEADING_OUTLINE_UNTITLED_LABEL,
      orderIndex,
      ...(parent === undefined ? {} : { parentEntryId: parent.entryId }),
      targetUnitEntryId: unit.entryId
    });
    openHeadings.push({ depth, entryId: unit.entryId, level });
  });

  return entries;
}
