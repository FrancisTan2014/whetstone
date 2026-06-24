import { describe, expect, it } from "vitest";

import type { WorkContentDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import { summarizeWorkContent, workContentSummaryLabel } from "./workContentSummary";

function content(unitBlockCounts: ReadonlyArray<number>): WorkContentDto {
  return {
    readingUnits: unitBlockCounts.map((blockCount, unitIndex) => ({
      blocks: Array.from({ length: blockCount }, (_unused, blockIndex) => ({
        blockType: "paragraph" as const,
        entryId: toEntryId(`u${unitIndex}-b${blockIndex}`),
        mdast: { type: "paragraph" },
        orderIndex: blockIndex,
        plaintext: `block ${blockIndex}`
      })),
      entryId: toEntryId(`u${unitIndex}`),
      orderIndex: unitIndex
    })),
    workEntryId: toEntryId("work-1")
  };
}

describe("summarizeWorkContent", () => {
  it("counts zero units and blocks for empty content", () => {
    expect(summarizeWorkContent(content([]))).toEqual({ blockCount: 0, readingUnitCount: 0 });
  });

  it("sums blocks across reading units", () => {
    expect(summarizeWorkContent(content([2, 0, 3]))).toEqual({
      blockCount: 5,
      readingUnitCount: 3
    });
  });
});

describe("workContentSummaryLabel", () => {
  it("uses singular nouns for a single unit and block", () => {
    expect(workContentSummaryLabel({ blockCount: 1, readingUnitCount: 1 })).toBe(
      "1 reading unit · 1 block"
    );
  });

  it("uses plural nouns for zero and many", () => {
    expect(workContentSummaryLabel({ blockCount: 0, readingUnitCount: 4 })).toBe(
      "4 reading units · 0 blocks"
    );
  });
});
