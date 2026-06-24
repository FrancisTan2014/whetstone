import { describe, expect, it } from "vitest";

import type { BlockDto, WorkContentDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import { assertContentPersisted, batchSize, insertInBatches } from "./insertBatching.js";

function block(plaintext: string): BlockDto {
  return {
    blockType: "paragraph",
    entryId: toEntryId(`block-${plaintext}`),
    mdast: { type: "paragraph" },
    orderIndex: 0,
    plaintext
  };
}

function content(blockCount: number): WorkContentDto {
  return {
    readingUnits:
      blockCount === 0
        ? []
        : [
            {
              blocks: Array.from({ length: blockCount }, (_, index) => block(`b${index}`)),
              entryId: toEntryId("unit-1"),
              orderIndex: 0
            }
          ],
    workEntryId: toEntryId("work-1")
  };
}

function rowWith(columnCount: number, value: number): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (let column = 0; column < columnCount; column += 1) {
    row[`column-${column}`] = value;
  }
  return row;
}

describe("batchSize", () => {
  it("sizes a batch so a wide row stays under the parameter ceiling", () => {
    expect(batchSize(7)).toBe(Math.floor(30000 / 7));
  });

  it("never returns fewer than one row even for an extremely wide row", () => {
    expect(batchSize(40000)).toBe(1);
  });
});

describe("insertInBatches", () => {
  it("performs no insert for empty input", async () => {
    const batches: number[] = [];

    await insertInBatches([], async (batch) => {
      batches.push(batch.length);
    });

    expect(batches).toEqual([]);
  });

  it("inserts all rows in a single batch when they fit under the ceiling", async () => {
    const rows = [rowWith(7, 1), rowWith(7, 2)];
    const batches: number[] = [];

    await insertInBatches(rows, async (batch) => {
      batches.push(batch.length);
    });

    expect(batches).toEqual([2]);
  });

  it("splits oversized input into multiple ceiling-bounded batches", async () => {
    const columns = 15;
    const size = batchSize(columns); // 2000 rows per batch
    const rows = Array.from({ length: size * 2 + 1 }, (_, index) => rowWith(columns, index));
    const batches: number[] = [];

    await insertInBatches(rows, async (batch) => {
      batches.push(batch.length);
    });

    expect(batches).toEqual([size, size, 1]);
  });
});

describe("assertContentPersisted", () => {
  it("throws when a non-empty source persisted zero blocks", () => {
    expect(() => assertContentPersisted(5, content(0))).toThrow(/persisted no blocks/);
  });

  it("returns the content when blocks persisted", () => {
    const persisted = content(3);
    expect(assertContentPersisted(3, persisted)).toBe(persisted);
  });

  it("does not throw when an empty source legitimately persisted zero blocks", () => {
    const empty = content(0);
    expect(assertContentPersisted(0, empty)).toBe(empty);
  });
});
