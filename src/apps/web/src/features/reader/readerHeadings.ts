import type { ReaderUnit } from "./readerModel";

function normalizeHeading(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

// A unit's title is rendered as an eyebrow above the unit. It is redundant when the unit's
// first block is itself a heading with the same text — showing both makes the title appear
// twice (the duplicated giant front-matter headings on technical books). When redundant, the
// reader suppresses the eyebrow and lets the first heading stand alone. Pure so the
// suppression rule tests without the component.
export function isUnitTitleRedundant(unit: ReaderUnit): boolean {
  if (unit.title === undefined) {
    return false;
  }

  const first = unit.blocks[0];

  if (first === undefined || !first.isHeading) {
    return false;
  }

  return normalizeHeading(first.plaintext) === normalizeHeading(unit.title);
}
