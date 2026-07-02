import type { WorkAnchorIndexDto } from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

import { buildAnchorIndex } from "./referenceResolver";

function index(anchors: WorkAnchorIndexDto["anchors"]): WorkAnchorIndexDto {
  return { anchors, workEntryId: "work-1" };
}

describe("buildAnchorIndex / resolve", () => {
  it("resolves a reference to the block carrying that (sourceFile, anchor)", () => {
    const resolver = buildAnchorIndex(
      index([
        { anchor: "fn1", blockEntryId: "b-1", sourceFile: "text/ch01.xhtml", unitEntryId: "u-1" }
      ])
    );

    expect(resolver.resolve({ anchor: "fn1", sourceFile: "text/ch01.xhtml" })).toBe("b-1");
  });

  it("does not collide when the same anchor id is reused in two source files", () => {
    const resolver = buildAnchorIndex(
      index([
        { anchor: "note", blockEntryId: "b-1", sourceFile: "text/ch01.xhtml", unitEntryId: "u-1" },
        { anchor: "note", blockEntryId: "b-2", sourceFile: "text/ch02.xhtml", unitEntryId: "u-2" }
      ])
    );

    expect(resolver.resolve({ anchor: "note", sourceFile: "text/ch01.xhtml" })).toBe("b-1");
    expect(resolver.resolve({ anchor: "note", sourceFile: "text/ch02.xhtml" })).toBe("b-2");
  });

  it("keys a null source file as an empty-string scope, resolvable with no source file", () => {
    const resolver = buildAnchorIndex(
      index([{ anchor: "fn1", blockEntryId: "b-1", sourceFile: null, unitEntryId: "u-1" }])
    );

    expect(resolver.resolve({ anchor: "fn1" })).toBe("b-1");
  });

  it("returns undefined for an anchor that is not in the index", () => {
    const resolver = buildAnchorIndex(
      index([
        { anchor: "fn1", blockEntryId: "b-1", sourceFile: "text/ch01.xhtml", unitEntryId: "u-1" }
      ])
    );

    expect(resolver.resolve({ anchor: "missing", sourceFile: "text/ch01.xhtml" })).toBeUndefined();
  });

  it("returns undefined when the anchor exists but under a different source file", () => {
    const resolver = buildAnchorIndex(
      index([
        { anchor: "fn1", blockEntryId: "b-1", sourceFile: "text/ch01.xhtml", unitEntryId: "u-1" }
      ])
    );

    expect(resolver.resolve({ anchor: "fn1", sourceFile: "text/other.xhtml" })).toBeUndefined();
  });

  it("keeps the first block when a (sourceFile, anchor) is duplicated (reading order wins)", () => {
    const resolver = buildAnchorIndex(
      index([
        {
          anchor: "fn1",
          blockEntryId: "b-first",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        },
        {
          anchor: "fn1",
          blockEntryId: "b-second",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        }
      ])
    );

    expect(resolver.resolve({ anchor: "fn1", sourceFile: "text/ch01.xhtml" })).toBe("b-first");
  });
});
