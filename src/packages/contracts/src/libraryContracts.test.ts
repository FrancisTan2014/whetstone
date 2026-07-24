import { describe, expect, it } from "vitest";

import {
  authorIdDtoSchema,
  beginManualWorkRequestSchema,
  createWorkRequestSchema,
  parseBeginManualWorkRequest,
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
        origin: "manual",
        title: "Politics and the English Language",
        workType: "essay"
      })
    ).toEqual({
      author: { mode: "new", name: "George Orwell" },
      language: "en",
      origin: "manual",
      title: "Politics and the English Language",
      workType: "essay"
    });
  });

  it("accepts a valid existing-author work request", () => {
    expect(
      parseCreateWorkRequest({
        author: { authorId: "author-1", mode: "existing" },
        language: "zh-CN",
        origin: "imported",
        title: "史记",
        workType: "classical_text"
      })
    ).toEqual({
      author: { authorId: "author-1", mode: "existing" },
      language: "zh-CN",
      origin: "imported",
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

  it("rejects an unsupported language code", () => {
    expect(
      createWorkRequestSchema.safeParse({
        author: { mode: "new", name: "x" },
        language: "zh",
        title: "t",
        workType: "book"
      }).success
    ).toBe(false);
  });
});

describe("parseBeginManualWorkRequest", () => {
  it("accepts a valid new-author manual request (origin implicit, not carried)", () => {
    expect(
      parseBeginManualWorkRequest({
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

  it("accepts an existing-author manual request", () => {
    expect(
      parseBeginManualWorkRequest({
        author: { authorId: "author-1", mode: "existing" },
        language: "zh-CN",
        title: "史记",
        workType: "classical_text"
      })
    ).toEqual({
      author: { authorId: "author-1", mode: "existing" },
      language: "zh-CN",
      title: "史记",
      workType: "classical_text"
    });
  });

  it("rejects a client-supplied origin (never accepted at the manual front door)", () => {
    expect(
      beginManualWorkRequestSchema.safeParse({
        author: { mode: "new", name: "x" },
        language: "en",
        origin: "imported",
        title: "t",
        workType: "book"
      }).success
    ).toBe(false);
  });

  it("rejects a blank title", () => {
    expect(() =>
      parseBeginManualWorkRequest({
        author: { mode: "new", name: "x" },
        language: "en",
        title: " ",
        workType: "book"
      })
    ).toThrow();
  });

  it("rejects an invalid work type", () => {
    expect(
      beginManualWorkRequestSchema.safeParse({
        author: { mode: "new", name: "x" },
        language: "en",
        title: "t",
        workType: "magazine"
      }).success
    ).toBe(false);
  });
});
