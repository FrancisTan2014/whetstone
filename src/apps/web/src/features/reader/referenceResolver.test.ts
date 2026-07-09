import type { WorkAnchorIndexDto } from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

import { buildAnchorIndex } from "./referenceResolver";

function index(anchors: WorkAnchorIndexDto["anchors"]): WorkAnchorIndexDto {
  return { anchors, workEntryId: "work-1" };
}

describe("buildAnchorIndex / resolve", () => {
  it("resolves a reference to the block + node carrying that (sourceFile, anchor)", () => {
    const resolver = buildAnchorIndex(
      index([
        {
          anchor: "fn1",
          blockEntryId: "b-1",
          nodeId: "n-heading",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        }
      ])
    );

    expect(resolver.resolve({ anchor: "fn1", sourceFile: "text/ch01.xhtml" })).toEqual({
      blockEntryId: "b-1",
      nodeId: "n-heading"
    });
  });

  it("does not collide when the same anchor id is reused in two source files", () => {
    const resolver = buildAnchorIndex(
      index([
        {
          anchor: "note",
          blockEntryId: "b-1",
          nodeId: "n-1",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        },
        {
          anchor: "note",
          blockEntryId: "b-2",
          nodeId: "n-2",
          sourceFile: "text/ch02.xhtml",
          unitEntryId: "u-2"
        }
      ])
    );

    expect(resolver.resolve({ anchor: "note", sourceFile: "text/ch01.xhtml" })).toEqual({
      blockEntryId: "b-1",
      nodeId: "n-1"
    });
    expect(resolver.resolve({ anchor: "note", sourceFile: "text/ch02.xhtml" })).toEqual({
      blockEntryId: "b-2",
      nodeId: "n-2"
    });
  });

  it("keys a null source file as an empty-string scope, resolvable with no source file", () => {
    const resolver = buildAnchorIndex(
      index([
        { anchor: "fn1", blockEntryId: "b-1", nodeId: "n-1", sourceFile: null, unitEntryId: "u-1" }
      ])
    );

    expect(resolver.resolve({ anchor: "fn1" })).toEqual({ blockEntryId: "b-1", nodeId: "n-1" });
  });

  it("returns undefined for an anchor that is not in the index", () => {
    const resolver = buildAnchorIndex(
      index([
        {
          anchor: "fn1",
          blockEntryId: "b-1",
          nodeId: "n-1",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        }
      ])
    );

    expect(resolver.resolve({ anchor: "missing", sourceFile: "text/ch01.xhtml" })).toBeUndefined();
  });

  it("returns undefined when the anchor exists but under a different source file", () => {
    const resolver = buildAnchorIndex(
      index([
        {
          anchor: "fn1",
          blockEntryId: "b-1",
          nodeId: "n-1",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        }
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
          nodeId: "n-first",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        },
        {
          anchor: "fn1",
          blockEntryId: "b-second",
          nodeId: "n-second",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        }
      ])
    );

    expect(resolver.resolve({ anchor: "fn1", sourceFile: "text/ch01.xhtml" })).toEqual({
      blockEntryId: "b-first",
      nodeId: "n-first"
    });
  });
});

describe("buildAnchorIndex / canResolve", () => {
  it("is true for a live (sourceFile, anchor) and false for a dead one", () => {
    const resolver = buildAnchorIndex(
      index([
        {
          anchor: "fn1",
          blockEntryId: "b-1",
          nodeId: "n-1",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        }
      ])
    );

    expect(resolver.canResolve({ anchor: "fn1", sourceFile: "text/ch01.xhtml" })).toBe(true);
    expect(resolver.canResolve({ anchor: "fn1", sourceFile: "text/other.xhtml" })).toBe(false);
    expect(resolver.canResolve({ anchor: "missing", sourceFile: "text/ch01.xhtml" })).toBe(false);
  });
});

describe("buildAnchorIndex / anchorsForBlock", () => {
  it("returns every id-bearing element of a block in index (reading) order", () => {
    const resolver = buildAnchorIndex(
      index([
        {
          anchor: "block-top",
          blockEntryId: "b-1",
          nodeId: "b-1",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        },
        {
          anchor: "nested-heading",
          blockEntryId: "b-1",
          nodeId: "n-nested",
          sourceFile: "text/ch01.xhtml",
          unitEntryId: "u-1"
        }
      ])
    );

    expect(resolver.anchorsForBlock("b-1")).toEqual([
      { anchor: "block-top", nodeId: "b-1" },
      { anchor: "nested-heading", nodeId: "n-nested" }
    ]);
  });

  it("returns an empty list for a block with no id-bearing elements", () => {
    const resolver = buildAnchorIndex(index([]));

    expect(resolver.anchorsForBlock("b-unknown")).toEqual([]);
  });
});
