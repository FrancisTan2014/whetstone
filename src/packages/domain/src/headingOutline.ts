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
  // Headings inside the unit that do NOT themselves start a new reading unit (#865): a chapter-scale
  // PDF unit's own in-unit sections, in source order. Each becomes a descendant TOC entry nested under
  // this unit (never a sibling reading unit), so a reader can jump WITHIN a long chapter instead of only
  // between chapters. Absent/empty for a work whose reading units are already heading-grained (EPUB,
  // Markdown, and a pre-#862 PDF), where every heading already starts its own unit and there is nothing
  // left to nest.
  sections?: ReadonlyArray<HeadingOutlineSection>;
  title?: string;
}>;

// One heading nested inside a reading unit rather than starting its own (#865): the deterministic,
// unique-per-work anchor it was given at ingestion (resolved through the work's anchor index, #366), the
// heading level it printed at, and its optional title (absent for an untitled heading, mirroring a
// unit's own optional title).
export type HeadingOutlineSection = Readonly<{
  anchor: string;
  level: number;
  title?: string;
}>;

// One node of the derived table of contents. Shaped to match the served TOC entry so both consumers
// map it the same way: `depth` and `parentEntryId` capture the compressed nesting, `orderIndex` is the
// source-order (pre-order) rank so entries render fully expanded and correctly indented, and
// `targetUnitEntryId` is the reading unit the entry opens. A unit-starting entry opens that unit's top
// (`targetAnchor` absent); an in-unit section entry (#865) opens the SAME unit but scrolls to its own
// anchor (`targetAnchor` present) rather than naming a sub-unit of its own.
export type HeadingOutlineEntry = Readonly<{
  depth: number;
  entryId: string;
  label: string;
  orderIndex: number;
  parentEntryId?: string;
  targetAnchor?: string;
  targetUnitEntryId: string;
}>;

// The label for the single root entry that gathers any content before the first heading, so a reader
// can jump back to the work's opening once later headings make a table of contents worthwhile.
export const HEADING_OUTLINE_PREFACE_LABEL = "Start";

// The label for a heading with no text (an empty `#`), so every derived entry stays selectable.
export const HEADING_OUTLINE_UNTITLED_LABEL = "Untitled section";

type OpenHeading = { depth: number; entryId: string; level: number };

export type WorkSectionPlacement = "next" | "child";

export type WorkSectionHeadingLevel = 1 | 2 | 3;

export type WorkSectionInsertionUnit = Readonly<{
  headingLevel?: number | undefined;
  unitEntryId: string;
}>;

export type WorkSectionInsertionPlan =
  | Readonly<{
      headingLevel: WorkSectionHeadingLevel;
      orderIndex: number;
      status: "planned";
    }>
  | Readonly<{ status: "target_not_found" }>
  | Readonly<{ status: "invalid_placement" }>;

// The editor exposes only the hierarchy Whetstone supports creating in v0. A leading headless section
// ("Start") can be followed by an H1; H1/H2 can create a sibling or child; H3 can create only a sibling.
// Deeper imported headings remain navigable but are not section-creation targets.
export function availableWorkSectionPlacements(
  headingLevel: number | undefined
): ReadonlyArray<WorkSectionPlacement> {
  if (headingLevel === undefined || headingLevel === 3) {
    return ["next"];
  }
  if (headingLevel === 1 || headingLevel === 2) {
    return ["next", "child"];
  }
  return [];
}

// Plan a contextual insertion from the canonical, source-ordered first-heading stream. Both "next" and
// "child" insert after the target's complete descendant branch: "next" keeps the target level, while
// "child" goes one level deeper and therefore becomes the branch's last child. A headless Start has no
// descendants and "next" creates H1 immediately after it.
export function planWorkSectionInsertion(
  units: ReadonlyArray<WorkSectionInsertionUnit>,
  targetUnitEntryId: string,
  placement: WorkSectionPlacement
): WorkSectionInsertionPlan {
  const targetIndex = units.findIndex((unit) => unit.unitEntryId === targetUnitEntryId);
  if (targetIndex === -1) {
    return { status: "target_not_found" };
  }

  const targetLevel = units[targetIndex]?.headingLevel;
  if (targetLevel !== undefined && targetLevel !== 1 && targetLevel !== 2 && targetLevel !== 3) {
    return { status: "invalid_placement" };
  }
  if (!availableWorkSectionPlacements(targetLevel).includes(placement)) {
    return { status: "invalid_placement" };
  }

  let orderIndex = targetIndex + 1;
  if (targetLevel !== undefined) {
    while (orderIndex < units.length) {
      const followingLevel = units[orderIndex]?.headingLevel;
      if (followingLevel === undefined || followingLevel <= targetLevel) {
        break;
      }
      orderIndex += 1;
    }
  }

  let headingLevel: WorkSectionHeadingLevel;
  if (targetLevel === undefined) {
    headingLevel = 1;
  } else if (placement === "child") {
    headingLevel = targetLevel === 1 ? 2 : 3;
  } else {
    headingLevel = targetLevel;
  }

  return { headingLevel, orderIndex, status: "planned" };
}

// Derive the hierarchical outline from a work's reading units, in source order.
//
// Rules (see issue #680): a single-unit work, or a work whose units carry no heading level, has no
// table of contents (the Reader reads it straight through) — both return an empty outline. Otherwise
// each heading's parent is the nearest preceding heading with a strictly lower level; a heading with no
// lower-level ancestor is a root. Skipped levels compress to one nesting step — depth is the parent's
// depth plus one, never the absolute level gap — so an H1 followed by an H3 nests one level, not two.
// An equal-or-shallower heading closes the deeper branch first. Content before the first heading is
// emitted once as a root "Start" entry (a sibling of the first chapter, never a parent of it).
//
// A unit's own in-unit `sections` (#865) are walked immediately after it, through this SAME nesting
// stack, so a section nests under its unit exactly as a deeper unit-level heading would, and a later
// unit's own heading still closes any section branch a preceding chapter left open. `orderIndex` is one
// counter shared across every unit and section, so a nested outline still renders fully expanded and
// correctly indented top to bottom.
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
  let orderIndex = 0;

  function placeHeading(
    level: number,
    entryId: string,
    label: string,
    targetUnitEntryId: string,
    targetAnchor?: string
  ): void {
    let parent = openHeadings.at(-1);
    while (parent !== undefined && parent.level >= level) {
      openHeadings.pop();
      parent = openHeadings.at(-1);
    }
    const depth = parent === undefined ? 0 : parent.depth + 1;
    entries.push({
      depth,
      entryId,
      label,
      orderIndex: orderIndex++,
      ...(parent === undefined ? {} : { parentEntryId: parent.entryId }),
      ...(targetAnchor === undefined ? {} : { targetAnchor }),
      targetUnitEntryId
    });
    openHeadings.push({ depth, entryId, level });
  }

  units.forEach((unit) => {
    const level = unit.headingLevel;
    if (level === undefined) {
      entries.push({
        depth: 0,
        entryId: unit.entryId,
        label: HEADING_OUTLINE_PREFACE_LABEL,
        orderIndex: orderIndex++,
        targetUnitEntryId: unit.entryId
      });
    } else {
      placeHeading(level, unit.entryId, unit.title ?? HEADING_OUTLINE_UNTITLED_LABEL, unit.entryId);
    }

    for (const section of unit.sections ?? []) {
      placeHeading(
        section.level,
        section.anchor,
        section.title ?? HEADING_OUTLINE_UNTITLED_LABEL,
        unit.entryId,
        section.anchor
      );
    }
  });

  return entries;
}
