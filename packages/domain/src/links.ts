import type { EntryId } from "./entry.js";

export const linkTypes = ["contains", "annotates", "references", "related_to"] as const;

export type LinkType = (typeof linkTypes)[number];

export type EntryLink = Readonly<{
  fromEntryId: EntryId;
  toEntryId: EntryId;
  type: LinkType;
}>;

const linkTypeSet: ReadonlySet<unknown> = new Set(linkTypes);

export function isLinkType(value: unknown): value is LinkType {
  return linkTypeSet.has(value);
}

export function createEntryLink(link: EntryLink): EntryLink {
  return Object.freeze({
    fromEntryId: link.fromEntryId,
    toEntryId: link.toEntryId,
    type: link.type
  });
}
