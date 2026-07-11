import type { EntryId } from "./entry.js";

// `derived_from` (#595): a Memory note points at the source Entry (block, note, diary entry, …) it was
// derived from, preserving provenance without copying content. Detached (the link is removed) rather than
// cascaded when the source is deleted, so the owned Memory survives.
export const linkTypes = [
  "contains",
  "annotates",
  "references",
  "related_to",
  "derived_from"
] as const;

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
