import type { WorkContentDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import { describe, expect, it } from "vitest";

import { buildReaderView } from "./readerModel";

const introParagraph = { children: [{ type: "text", value: "Intro" }], type: "paragraph" };
const chapterHeading = {
  children: [{ type: "text", value: "Chapter One" }],
  depth: 2,
  type: "heading"
};
const emphasisParagraph = {
  children: [{ children: [{ type: "text", value: "emphasized" }], type: "emphasis" }],
  type: "paragraph"
};

// Reading units and blocks are intentionally out of order to prove the model sorts
// them by orderIndex rather than trusting array position.
const unorderedContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("b-2b"),
          mdast: emphasisParagraph,
          orderIndex: 1,
          plaintext: "emphasized"
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
    },
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("b-1"),
          mdast: introParagraph,
          orderIndex: 0,
          plaintext: "Intro"
        }
      ],
      entryId: toEntryId("u-1"),
      orderIndex: 0
    }
  ],
  workEntryId: toEntryId("work-1")
};

describe("buildReaderView", () => {
  it("orders reading units by orderIndex and keeps the work id", () => {
    const view = buildReaderView(unorderedContent);

    expect(view.workEntryId).toBe("work-1");
    expect(view.units.map((unit) => unit.entryId)).toEqual(["u-1", "u-2"]);
  });

  it("orders blocks within a unit and serializes each block to Markdown", () => {
    const view = buildReaderView(unorderedContent);
    const chapter = view.units[1];

    expect(chapter?.blocks.map((block) => block.entryId)).toEqual(["b-2a", "b-2b"]);
    expect(chapter?.blocks.map((block) => block.markdown)).toEqual([
      "## Chapter One",
      "*emphasized*"
    ]);
    expect(view.units[0]?.blocks[0]?.markdown).toBe("Intro");
  });

  it("includes a unit title when present and omits it otherwise", () => {
    const view = buildReaderView(unorderedContent);

    expect(view.units[0]?.title).toBeUndefined();
    expect(view.units[1]?.title).toBe("Chapter One");
  });
});
