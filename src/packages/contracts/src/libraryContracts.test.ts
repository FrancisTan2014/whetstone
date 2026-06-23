import { describe, expect, it } from "vitest";

import {
  authorIdDtoSchema,
  parseCreateAuthorRequest,
  parseCreateReadingUnitRequest,
  parseCreateWorkRequest,
  parseWorkIdParams
} from "./libraryContracts.js";

describe("library contract schemas", () => {
  it("parses author creation requests and rejects blank or unexpected fields", () => {
    expect(parseCreateAuthorRequest({ name: "George Orwell" })).toEqual({ name: "George Orwell" });
    expect(() => parseCreateAuthorRequest({ name: "  " })).toThrow();
    expect(() => parseCreateAuthorRequest({ name: "ok", extra: true })).toThrow();
  });

  it("parses work creation for both existing and inline-new authors", () => {
    const existing = parseCreateWorkRequest({
      author: { authorId: "author-1", mode: "existing" },
      language: "en",
      title: "Politics and the English Language",
      workType: "essay"
    });
    const inline = parseCreateWorkRequest({
      author: { mode: "new", name: "Paul Graham" },
      language: "en",
      title: "How to Do Great Work",
      workType: "blog_post"
    });

    expect(existing.author).toEqual({ authorId: "author-1", mode: "existing" });
    expect(inline.author).toEqual({ mode: "new", name: "Paul Graham" });
    expect(existing.workType).toBe("essay");
  });

  it("rejects malformed work creation requests", () => {
    expect(() =>
      parseCreateWorkRequest({
        author: { authorId: " ", mode: "existing" },
        language: "en",
        title: "x",
        workType: "essay"
      })
    ).toThrow();
    expect(() =>
      parseCreateWorkRequest({
        author: { mode: "new", name: "ok" },
        language: " ",
        title: "x",
        workType: "essay"
      })
    ).toThrow();
    expect(() =>
      parseCreateWorkRequest({
        author: { mode: "new", name: "ok" },
        language: "en",
        title: "x",
        workType: "podcast"
      })
    ).toThrow();
  });

  it("parses reading unit creation requests and enforces non-empty content", () => {
    expect(
      parseCreateReadingUnitRequest({ markdown: "# Chapter 1\n\nText.", title: "Chapter 1" })
    ).toEqual({ markdown: "# Chapter 1\n\nText.", title: "Chapter 1" });
    expect(() => parseCreateReadingUnitRequest({ markdown: "  ", title: "Chapter 1" })).toThrow();
    expect(() => parseCreateReadingUnitRequest({ markdown: "body", title: " " })).toThrow();
  });

  it("parses and rejects work id params", () => {
    expect(parseWorkIdParams({ id: "work-1" })).toEqual({ id: "work-1" });
    expect(() => parseWorkIdParams({ id: " " })).toThrow();
  });

  it("brands author ids directly through the shared schema", () => {
    expect(authorIdDtoSchema.parse("author-9")).toBe("author-9");
    expect(() => authorIdDtoSchema.parse("")).toThrow();
  });
});
