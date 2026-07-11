import { createEntryLink, type EntryLink } from "./links.js";

declare const entryIdBrand: unique symbol;

export type EntryId = string & { readonly [entryIdBrand]: "EntryId" };

export const entryTypes = [
  "work",
  "reading_unit",
  "block",
  "note",
  "toc_entry",
  // `diary_entry` (#571): a personal diary artifact is a first-class addressable Entry, so a Memory note
  // created from it can point at it via a `derived_from` Entry link and it can join the typed link
  // graph via `entry_links`. Its ownership + chronology live in the shared `personal_entries` facet, and
  // the Timeline is a logical view over those personal entries — never a stored `timeline_entry` object.
  "diary_entry",
  // `recitation_plan` (#577): a learner's recitation routine adopted from a source Work is a first-class
  // owned Entry — it carries a `personal_entries` facet (so it appears on the logical Timeline and is
  // owner-scoped) and references the source Work, whose content stays canonical (never copied). Its
  // lightweight per-session routine state lives on the `recitation_plans` facet, NOT as Entries.
  "recitation_plan",
  // `memory_note` (#595): a Memory note is a first-class owned Entry — the durable retention target. It
  // carries a `personal_entries` facet (so it appears once on the logical Timeline and is owner-scoped),
  // a canonical rich document body, and a structured capture source. Provenance is a `derived_from`
  // Entry link to the source it came from.
  "memory_note",
  // `memory_prompt` (#595): a Memory prompt is a child Entry owning one independently scheduled retrieval
  // direction (rich cue + answer, lifecycle, and the FSRS card only when scheduled). It is linked from
  // its note with `contains`, inherits ownership transitively through that note, and NEVER carries a
  // `personal_entries` row — so it never surfaces a second Timeline row.
  "memory_prompt"
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
