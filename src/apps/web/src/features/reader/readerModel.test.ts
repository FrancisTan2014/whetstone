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

// A unit ingested with PM `doc_blocks` (#311/#312) renders through the static-renderer instead of
// mdast. The blocks are intentionally out of order and exercise every field the reader derives from
// a PM node: heading vs paragraph vs figure, plaintext from the node's text, and a figure's image
// reference + alt (read from the figure's leading `image` child), present and absent.
const pmUnit: ReadingUnitContentDto = {
  blocks: [],
  docBlocks: [
    {
      entryId: toEntryId("pm-p"),
      node: {
        attrs: { id: "pm-p" },
        content: [{ text: "Hello world", type: "text" }],
        type: "paragraph"
      },
      orderIndex: 1,
      type: "paragraph"
    },
    {
      entryId: toEntryId("pm-f1"),
      node: {
        attrs: { id: "pm-f1" },
        content: [
          { attrs: { alt: "A chart", imageResourceId: "img-9", src: null }, type: "image" },
          { content: [{ text: "Caption.", type: "text" }], type: "figureCaption" }
        ],
        type: "figure"
      },
      orderIndex: 2,
      type: "figure"
    },
    {
      entryId: toEntryId("pm-f2"),
      node: {
        attrs: { id: "pm-f2" },
        content: [{ attrs: { alt: null, imageResourceId: null, src: null }, type: "image" }],
        type: "figure"
      },
      orderIndex: 3,
      type: "figure"
    },
    {
      entryId: toEntryId("pm-f3"),
      node: {
        attrs: { id: "pm-f3" },
        content: [{ content: [{ text: "Orphan caption.", type: "text" }], type: "figureCaption" }],
        type: "figure"
      },
      orderIndex: 4,
      type: "figure"
    },
    {
      entryId: toEntryId("pm-h"),
      node: {
        attrs: { id: "pm-h", level: 2 },
        content: [{ text: "Chapter One", type: "text" }],
        type: "heading"
      },
      orderIndex: 0,
      type: "heading"
    }
  ],
  entryId: toEntryId("u-pm"),
  orderIndex: 0
};

describe("toReaderBlocks (PM doc blocks, #312)", () => {
  it("renders from PM doc blocks when present, ordered by orderIndex, carrying the PM node", () => {
    const blocks = toReaderBlocks(pmUnit);

    expect(blocks.map((block) => block.entryId)).toEqual([
      "pm-h",
      "pm-p",
      "pm-f1",
      "pm-f2",
      "pm-f3"
    ]);
    expect(blocks[0]?.node).toBe(pmUnit.docBlocks?.[4]?.node);
    expect(blocks.every((block) => block.mdast === undefined)).toBe(true);
  });

  it("derives plaintext from the PM node's text, including figure captions and image-only figures", () => {
    const blocks = toReaderBlocks(pmUnit);

    expect(blocks.map((block) => block.plaintext)).toEqual([
      "Chapter One",
      "Hello world",
      "Caption.",
      "",
      "Orphan caption."
    ]);
  });

  it("maps PM node types onto the reader's block kind and heading flag", () => {
    const blocks = toReaderBlocks(pmUnit);

    expect(blocks.map((block) => block.blockType)).toEqual([
      "heading",
      "paragraph",
      "figure",
      "figure",
      "figure"
    ]);
    expect(blocks.map((block) => block.isHeading)).toEqual([true, false, false, false, false]);
  });

  it("reads a figure image's stored reference and alt, omitting them when absent or imageless", () => {
    const blocks = toReaderBlocks(pmUnit);
    const withImage = blocks[2];
    const nulledImage = blocks[3];
    const noImage = blocks[4];

    expect(withImage?.imageResourceId).toBe("img-9");
    expect(withImage?.alt).toBe("A chart");
    expect(nulledImage?.imageResourceId).toBeUndefined();
    expect(nulledImage?.alt).toBeUndefined();
    expect(noImage?.imageResourceId).toBeUndefined();
    expect(noImage?.alt).toBeUndefined();
  });

  it("falls back to mdast blocks when the unit has an empty doc-block list", () => {
    const blocks = toReaderBlocks({ ...unorderedUnit, docBlocks: [] });

    expect(blocks.map((block) => block.entryId)).toEqual(["b-2a", "b-2b", "b-2c"]);
    expect(blocks[0]?.mdast).toBe(chapterHeading);
  });
});
