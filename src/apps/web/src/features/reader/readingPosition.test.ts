import { describe, expect, it, vi } from "vitest";

import type { ReaderStructure } from "./readerModel";
import { resolveOpening, type LocateBlockUnit } from "./readingPosition";

const structure: ReaderStructure = {
  units: [
    { blockCount: 0, entryId: "u-1", orderIndex: 0, title: "One" },
    { blockCount: 0, entryId: "u-2", orderIndex: 1, title: "Two" }
  ],
  workEntryId: "work-1"
};

// A locator stub resolving the listed blocks to their owning unit; any other block is unknown.
function locator(owners: Record<string, string>): LocateBlockUnit {
  return vi.fn(async (blockEntryId: string) => owners[blockEntryId]);
}

describe("resolveOpening", () => {
  it("opens the deep-linked block's unit and scrolls to the block, over a saved position", async () => {
    const plan = await resolveOpening(structure, {
      deepLinkBlockEntryId: "b-x",
      locateBlockUnit: locator({ "b-x": "u-1" }),
      savedPosition: { anchorBlockEntryId: "b-saved", unitEntryId: "u-2" }
    });

    expect(plan).toEqual({ scrollBlockEntryId: "b-x", unitIndex: 0 });
  });

  it("falls through to the saved position when the deep-linked block is unknown", async () => {
    const plan = await resolveOpening(structure, {
      deepLinkBlockEntryId: "b-missing",
      locateBlockUnit: locator({}),
      savedPosition: { anchorBlockEntryId: "b-3", unitEntryId: "u-2" }
    });

    expect(plan).toEqual({ scrollBlockEntryId: "b-3", unitIndex: 1 });
  });

  it("falls through when the deep-linked block's unit is no longer in the structure", async () => {
    const plan = await resolveOpening(structure, {
      deepLinkBlockEntryId: "b-x",
      locateBlockUnit: locator({ "b-x": "gone" })
    });

    expect(plan).toEqual({ unitIndex: 0 });
  });

  it("restores a saved unit and scrolls to its block anchor", async () => {
    const plan = await resolveOpening(structure, {
      locateBlockUnit: locator({}),
      savedPosition: { anchorBlockEntryId: "b-3", unitEntryId: "u-2" }
    });

    expect(plan).toEqual({ scrollBlockEntryId: "b-3", unitIndex: 1 });
  });

  it("restores a saved unit with no anchor to the top of that unit", async () => {
    const plan = await resolveOpening(structure, {
      locateBlockUnit: locator({}),
      savedPosition: { unitEntryId: "u-2" }
    });

    expect(plan).toEqual({ unitIndex: 1 });
  });

  it("falls back to the first unit when the saved unit no longer exists", async () => {
    const plan = await resolveOpening(structure, {
      locateBlockUnit: locator({}),
      savedPosition: { anchorBlockEntryId: "b-3", unitEntryId: "gone" }
    });

    expect(plan).toEqual({ unitIndex: 0 });
  });

  it("opens the first unit when there is no deep link or saved position", async () => {
    const plan = await resolveOpening(structure, { locateBlockUnit: locator({}) });

    expect(plan).toEqual({ unitIndex: 0 });
  });
});
