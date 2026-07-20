import { describe, expect, it } from "vitest";

import { type NoteWorkspaceSource, readerLinkFor } from "./noteWorkspaceModel";

function source(overrides: Partial<NoteWorkspaceSource> = {}): NoteWorkspaceSource {
  return { blockEntryId: "block-1", snapshot: "the source", workEntryId: "work-1", ...overrides };
}

describe("readerLinkFor", () => {
  it("builds an encoded Reader deep-link when both the work and block are known", () => {
    expect(readerLinkFor(source({ blockEntryId: "b/2", workEntryId: "w 1" }))).toBe(
      "#/reader?work=w%201&block=b%2F2"
    );
  });

  it("returns null for a standalone note (no source)", () => {
    expect(readerLinkFor(null)).toBeNull();
  });

  it("returns null when the owning work is unknown", () => {
    expect(readerLinkFor(source({ workEntryId: null }))).toBeNull();
  });

  it("returns null when the anchored block is unknown", () => {
    expect(readerLinkFor(source({ blockEntryId: null }))).toBeNull();
  });
});
