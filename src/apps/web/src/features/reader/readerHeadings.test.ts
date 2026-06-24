import { describe, expect, it } from "vitest";

import { isUnitTitleRedundant } from "./readerHeadings";
import type { ReaderBlock, ReaderUnit } from "./readerModel";

function block(partial: Partial<ReaderBlock> & { entryId: string }): ReaderBlock {
  return {
    isHeading: false,
    markdown: partial.plaintext ?? partial.entryId,
    plaintext: partial.entryId,
    ...partial
  };
}

function unit(title: string | undefined, blocks: ReadonlyArray<ReaderBlock>): ReaderUnit {
  const base = { blocks, entryId: "u-1" };
  return title === undefined ? base : { ...base, title };
}

describe("isUnitTitleRedundant", () => {
  it("is false when the unit has no title", () => {
    expect(
      isUnitTitleRedundant(unit(undefined, [block({ entryId: "b-1", isHeading: true })]))
    ).toBe(false);
  });

  it("is false when the unit has no blocks", () => {
    expect(isUnitTitleRedundant(unit("Chapter One", []))).toBe(false);
  });

  it("is true when the first block is a heading with the same text", () => {
    expect(
      isUnitTitleRedundant(
        unit("Chapter One", [block({ entryId: "b-1", isHeading: true, plaintext: "Chapter One" })])
      )
    ).toBe(true);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(
      isUnitTitleRedundant(
        unit("  Chapter   One ", [
          block({ entryId: "b-1", isHeading: true, plaintext: "chapter one" })
        ])
      )
    ).toBe(true);
  });

  it("is false when the first heading differs from the title", () => {
    expect(
      isUnitTitleRedundant(
        unit("Chapter One", [block({ entryId: "b-1", isHeading: true, plaintext: "Overview" })])
      )
    ).toBe(false);
  });

  it("is false when the first block is not a heading", () => {
    expect(
      isUnitTitleRedundant(
        unit("Chapter One", [block({ entryId: "b-1", isHeading: false, plaintext: "Chapter One" })])
      )
    ).toBe(false);
  });
});
