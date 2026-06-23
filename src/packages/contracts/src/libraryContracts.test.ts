import { describe, expect, it } from "vitest";

import {
  authorIdDtoSchema,
  createWorkRequestSchema,
  parseCreateAuthorRequest,
  parseCreateWorkRequest,
  workAuthorSelectionSchema
} from "./libraryContracts.js";

describe("authorIdDtoSchema", () => {
  it("brands non-empty ids", () => {
    expect(authorIdDtoSchema.parse("author-1")).toBe("author-1");
  });

  it("rejects blank ids", () => {
    const result = authorIdDtoSchema.safeParse("   ");

    expect(result.success).toBe(false);
  });
});

describe("parseCreateAuthorRequest", () => {
  it("accepts a non-empty name", () => {
    expect(parseCreateAuthorRequest({ name: "Octavia Butler" })).toEqual({
      name: "Octavia Butler"
    });
  });

  it("rejects a blank name", () => {
    expect(() => parseCreateAuthorRequest({ name: " " })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => parseCreateAuthorRequest({ name: "x", extra: 1 })).toThrow();
  });
});

describe("workAuthorSelectionSchema", () => {
  it("accepts an existing-author selection", () => {
    expect(workAuthorSelectionSchema.parse({ authorId: "author-1", mode: "existing" })).toEqual({
      authorId: "author-1",
      mode: "existing"
    });
  });

  it("accepts a new-author selection", () => {
    expect(workAuthorSelectionSchema.parse({ mode: "new", name: "Anon" })).toEqual({
      mode: "new",
      name: "Anon"
    });
  });

  it("rejects an unknown mode", () => {
    expect(workAuthorSelectionSchema.safeParse({ mode: "other" }).success).toBe(false);
  });

  it("rejects a new selection with a blank name", () => {
    expect(workAuthorSelectionSchema.safeParse({ mode: "new", name: "  " }).success).toBe(false);
  });
});

describe("parseCreateWorkRequest", () => {
  it("accepts a valid new-author work request", () => {
    expect(
      parseCreateWorkRequest({
        author: { mode: "new", name: "George Orwell" },
        language: "en",
        title: "Politics and the English Language",
        workType: "essay"
      })
    ).toEqual({
      author: { mode: "new", name: "George Orwell" },
      language: "en",
      title: "Politics and the English Language",
      workType: "essay"
    });
  });

  it("accepts a valid existing-author work request", () => {
    expect(
      parseCreateWorkRequest({
        author: { authorId: "author-1", mode: "existing" },
        language: "zh",
        title: "史记",
        workType: "classical_text"
      })
    ).toEqual({
      author: { authorId: "author-1", mode: "existing" },
      language: "zh",
      title: "史记",
      workType: "classical_text"
    });
  });

  it("rejects an invalid work type", () => {
    expect(
      createWorkRequestSchema.safeParse({
        author: { mode: "new", name: "x" },
        language: "en",
        title: "t",
        workType: "magazine"
      }).success
    ).toBe(false);
  });

  it("rejects a blank title", () => {
    expect(
      createWorkRequestSchema.safeParse({
        author: { mode: "new", name: "x" },
        language: "en",
        title: " ",
        workType: "book"
      }).success
    ).toBe(false);
  });

  it("rejects a blank language", () => {
    expect(
      createWorkRequestSchema.safeParse({
        author: { mode: "new", name: "x" },
        language: " ",
        title: "t",
        workType: "book"
      }).success
    ).toBe(false);
  });
});
