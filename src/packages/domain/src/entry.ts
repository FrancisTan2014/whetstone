import { createEntryLink, type EntryLink } from "./links.js";

declare const entryIdBrand: unique symbol;

export type EntryId = string & { readonly [entryIdBrand]: "EntryId" };

export const entryTypes = [
  "work",
  "reading_unit",
  "block",
  "note",
  "toc_entry",
  // `diary_entry` (#571): a personal diary artifact is a first-class addressable Entry, so a Recall item
  // created from it can point at it via `recall_items.provenance_entry_id` and it can join the typed link
  // graph via `entry_links`. Its ownership + chronology live in the shared `personal_entries` facet, and
  // the Timeline is a logical view over those personal entries — never a stored `timeline_entry` object.
  "diary_entry"
] as const;

export type EntryType = (typeof entryTypes)[number];

export type Entry = Readonly<{
  id: EntryId;
  links: ReadonlyArray<EntryLink>;
  type: EntryType;
}>;

export type CreateEntryInput = Readonly<{
  id: EntryId;
  links?: ReadonlyArray<EntryLink>;
  type: EntryType;
}>;

const entryTypeSet: ReadonlySet<unknown> = new Set(entryTypes);

export function toEntryId(value: string): EntryId {
  if (value.trim().length === 0) {
    throw new Error("EntryId must be a non-empty string.");
  }

  return value as EntryId;
}

export function isEntryType(value: unknown): value is EntryType {
  return entryTypeSet.has(value);
}

export function createEntry(input: CreateEntryInput): Entry {
  return freezeEntry({
    id: input.id,
    links: input.links ?? [],
    type: input.type
  });
}

export function addEntryLink(entry: Entry, link: EntryLink): Entry {
  return freezeEntry({
    ...entry,
    links: [...entry.links, link]
  });
}

export function replaceEntryLinks(entry: Entry, links: ReadonlyArray<EntryLink>): Entry {
  return freezeEntry({
    ...entry,
    links
  });
}

function freezeEntry(entry: Entry): Entry {
  return Object.freeze({
    id: entry.id,
    links: Object.freeze(entry.links.map((link) => createEntryLink(link))),
    type: entry.type
  });
}
