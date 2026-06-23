import { describe, expect, it } from "vitest";

import {
  addEntryLink,
  createEntry,
  createEntryLink,
  entryTypes,
  isEntryType,
  isLinkType,
  isWorkType,
  linkTypes,
  replaceEntryLinks,
  toEntryId,
  workTypes,
  type EntryLink
} from "./index.js";

describe("entry/link vocabulary", () => {
  it("recognizes the v0 entry, link, and work types", () => {
    expect(entryTypes).toEqual(["work", "reading_unit", "block", "note"]);
    expect(linkTypes).toEqual(["contains", "annotates", "references", "related_to"]);
    expect(workTypes).toEqual(["book", "essay", "blog_post", "classical_text"]);
    expect(isEntryType("reading_unit")).toBe(true);
    expect(isEntryType("template")).toBe(false);
    expect(isLinkType("annotates")).toBe(true);
    expect(isLinkType("invalid")).toBe(false);
    expect(isWorkType("classical_text")).toBe(true);
    expect(isWorkType("video")).toBe(false);
  });

  it("brands non-empty entry ids", () => {
    expect(toEntryId("entry-1")).toBe("entry-1");
    expect(() => toEntryId("  ")).toThrow("EntryId must be a non-empty string.");
  });
});

describe("entry immutable update helpers", () => {
  const workId = toEntryId("work-1");
  const readingUnitId = toEntryId("reading-unit-1");
  const noteId = toEntryId("note-1");

  const containsLink: EntryLink = createEntryLink({
    fromEntryId: workId,
    toEntryId: readingUnitId,
    type: "contains"
  });

  const annotatesLink: EntryLink = createEntryLink({
    fromEntryId: noteId,
    toEntryId: readingUnitId,
    type: "annotates"
  });

  it("creates immutable entries with copied links", () => {
    const entryWithoutLinks = createEntry({ id: workId, type: "work" });
    const entryWithLinks = createEntry({ id: workId, links: [containsLink], type: "work" });

    expect(entryWithoutLinks.links).toEqual([]);
    expect(entryWithLinks.links).toEqual([containsLink]);
    expect(Object.isFrozen(entryWithoutLinks)).toBe(true);
    expect(Object.isFrozen(entryWithLinks.links)).toBe(true);
    expect(Object.isFrozen(entryWithLinks.links[0])).toBe(true);
  });

  it("adds and replaces links without mutating the source entry", () => {
    const entry = createEntry({ id: workId, links: [containsLink], type: "work" });
    const withAnnotation = addEntryLink(entry, annotatesLink);
    const withReferencesOnly = replaceEntryLinks(withAnnotation, [
      createEntryLink({ fromEntryId: workId, toEntryId: noteId, type: "references" })
    ]);

    expect(entry.links).toEqual([containsLink]);
    expect(withAnnotation.links).toEqual([containsLink, annotatesLink]);
    expect(withAnnotation).not.toBe(entry);
    expect(withAnnotation.links).not.toBe(entry.links);
    expect(withReferencesOnly.links).toEqual([
      { fromEntryId: workId, toEntryId: noteId, type: "references" }
    ]);
  });
});
