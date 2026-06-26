import type { ReadingUnitContentDto, WorkStructureDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import { describe, expect, it } from "vitest";

import { buildReaderStructure, toReaderBlocks } from "./readerModel";

const chapterHeading = {
  children: [{ type: "text", value: "Chapter One" }],
  depth: 2,
  type: "heading"
};
const emphasisParagraph = {
  children: [{ children: [{ type: "text", value: "emphasized" }], type: "emphasis" }],
  type: "paragraph"
};
const figureNode = { type: "image", url: "/img" };

// Reading units are intentionally out of order to prove the structure sorts them by
// orderIndex rather than trusting array position.
const unorderedStructure: WorkStructureDto = {
  readingUnits: [
    { blockCount: 2, entryId: toEntryId("u-2"), orderIndex: 1, title: "Chapter One" },
    { blockCount: 1, entryId: toEntryId("u-1"), orderIndex: 0 }
  ],
  workEntryId: toEntryId("work-1")
};

// Blocks are out of order and include a figure (image + alt) so the model proves it sorts by
// orderIndex and carries the image metadata only when present.
const unorderedUnit: ReadingUnitContentDto = {
  blocks: [
    {
      blockType: "paragraph",
      entryId: toEntryId("b-2b"),
      mdast: emphasisParagraph,
      orderIndex: 1,
      plaintext: "emphasized"
    },
    {
      alt: "A diagram",
      blockType: "figure",
      entryId: toEntryId("b-2c"),
      imageResourceId: "img-1",
      mdast: figureNode,
      orderIndex: 2,
      plaintext: ""
    },
    {
      blockType: "heading",
      entryId: toEntryId("b-2a"),
      mdast: chapterHeading,
      orderIndex: 0,
      plaintext: "Chapter One"
    }
  ],
  entryId: toEntryId("u-2"),
  orderIndex: 1,
  title: "Chapter One"
};

describe("buildReaderStructure", () => {
  it("orders reading-unit metadata by orderIndex and keeps the work id", () => {
    const structure = buildReaderStructure(unorderedStructure);

    expect(structure.workEntryId).toBe("work-1");
    expect(structure.units.map((unit) => unit.entryId)).toEqual(["u-1", "u-2"]);
  });

  it("keeps each unit's block count for the 目录", () => {
    const structure = buildReaderStructure(unorderedStructure);

    expect(structure.units.map((unit) => unit.blockCount)).toEqual([1, 2]);
  });

  it("includes a unit title when present and omits it otherwise", () => {
    const structure = buildReaderStructure(unorderedStructure);

    expect(structure.units[0]?.title).toBeUndefined();
    expect(structure.units[1]?.title).toBe("Chapter One");
  });
});

describe("toReaderBlocks", () => {
  it("orders blocks within a unit and keeps each block's stored mdast", () => {
    const blocks = toReaderBlocks(unorderedUnit);

    expect(blocks.map((block) => block.entryId)).toEqual(["b-2a", "b-2b", "b-2c"]);
    expect(blocks.map((block) => block.mdast)).toEqual([
      chapterHeading,
      emphasisParagraph,
      figureNode
    ]);
    expect(blocks.map((block) => block.plaintext)).toEqual(["Chapter One", "emphasized", ""]);
  });

  it("flags heading blocks via isHeading", () => {
    const blocks = toReaderBlocks(unorderedUnit);

    expect(blocks.map((block) => block.isHeading)).toEqual([true, false, false]);
  });

  it("carries a figure block's image id and alt, and omits them on other blocks", () => {
    const blocks = toReaderBlocks(unorderedUnit);
    const figure = blocks[2];
    const heading = blocks[0];

    expect(figure?.imageResourceId).toBe("img-1");
    expect(figure?.alt).toBe("A diagram");
    expect(heading?.imageResourceId).toBeUndefined();
    expect(heading?.alt).toBeUndefined();
  });
});
