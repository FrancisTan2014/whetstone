import { createEntryLink, type EntryLink } from "./links.js";

declare const entryIdBrand: unique symbol;

export type EntryId = string & { readonly [entryIdBrand]: "EntryId" };

export const entryTypes = [
  "work",
  "reading_unit",
  "block",
  // `note` (#571, #620): the learner's one durable Note — a first-class owned Entry carrying a canonical
  // rich body and a structured capture source, owner-scoped and dated through the shared `personal_entries`
  // facet. It takes zero or one source anchor: an anchored Reader note keeps block/range/quote/context
  // provenance; an unanchored manual/Memory note keeps its capture source and any `derived_from` link.
  // Memory is behavior applied to a note through dependent `memory_prompt` children; a note NEVER stores
  // scheduler state. (A bodyless `mark` is the same `note` Entry type with `kind='mark'` and an anchor.)
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
  // `recitation_passage` (#578, #605): a contiguous, learner-editable source range of a recitation Work
  // that is practised and scheduled as one unit. It is a first-class addressable Entry (so a passage
  // range FKs its block ids and it can join the typed link graph), but it carries NO `personal_entries`
  // row — ownership is transitive through its plan, so passages and their reviews never surface a second
  // Timeline row. A passage is either queued (introduced, awaiting activation) or active (a scheduled
  // FSRS card); the lifecycle lives on the `recitation_passages` facet, not on the Entry.
  "recitation_passage",
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
