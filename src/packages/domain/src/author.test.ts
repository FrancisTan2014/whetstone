import { describe, expect, it } from "vitest";

import { toAuthorId } from "./author.js";

describe("author id", () => {
  it("brands non-empty author ids", () => {
    expect(toAuthorId("author-1")).toBe("author-1");
  });

  it("rejects blank author ids", () => {
    expect(() => toAuthorId("  ")).toThrow("AuthorId must be a non-empty string.");
  });
});
