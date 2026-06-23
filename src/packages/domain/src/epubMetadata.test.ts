import { describe, expect, it } from "vitest";

import { normalizeEpubMetadata } from "./epubMetadata.js";

describe("normalizeEpubMetadata", () => {
  it("reads title, language, and the first named creator from the OPF", () => {
    const metadata = normalizeEpubMetadata({
      creator: [{ contributor: "司马迁" }],
      language: "zh",
      title: "史记选读"
    });

    expect(metadata).toEqual({ author: "司马迁", language: "zh", title: "史记选读" });
  });

  it("skips blank or missing creators until a named one is found", () => {
    const metadata = normalizeEpubMetadata({
      creator: [{}, { contributor: "  " }, { contributor: "George Orwell" }],
      language: "en",
      title: "Essays"
    });

    expect(metadata.author).toBe("George Orwell");
  });

  it("falls back when title, language, and creator are missing", () => {
    const metadata = normalizeEpubMetadata({});

    expect(metadata).toEqual({
      author: "Unknown author",
      language: "und",
      title: "Untitled work"
    });
  });

  it("falls back when fields are present but blank", () => {
    const metadata = normalizeEpubMetadata({
      creator: [{ contributor: "" }],
      language: "   ",
      title: "  "
    });

    expect(metadata).toEqual({
      author: "Unknown author",
      language: "und",
      title: "Untitled work"
    });
  });
});
