import { describe, expect, it } from "vitest";

import type { ReaderView } from "./readerModel";
import { resolveOpening } from "./readingPosition";

const view: ReaderView = {
  units: [
    { blocks: [], entryId: "u-1", title: "One" },
    { blocks: [], entryId: "u-2", title: "Two" }
  ],
  workEntryId: "work-1"
};

describe("resolveOpening", () => {
  it("opens the deep-linked block's unit and scrolls to the block", () => {
    expect(
      resolveOpening(view, {
        deepLinkBlockEntryId: "b-x",
        savedPosition: { anchorBlockEntryId: "b-saved", unitEntryId: "u-2" }
      })
    ).toEqual({ scrollBlockEntryId: "b-x", unitIndex: 0 });
  });

  it("restores a saved unit and scrolls to its block anchor", () => {
    expect(
      resolveOpening(view, { savedPosition: { anchorBlockEntryId: "b-3", unitEntryId: "u-2" } })
    ).toEqual({ scrollBlockEntryId: "b-3", unitIndex: 1 });
  });

  it("restores a saved unit with no anchor to the top of that unit", () => {
    expect(resolveOpening(view, { savedPosition: { unitEntryId: "u-2" } })).toEqual({
      unitIndex: 1
    });
  });

  it("falls back to the first unit when the saved unit no longer exists", () => {
    expect(
      resolveOpening(view, { savedPosition: { anchorBlockEntryId: "b-3", unitEntryId: "gone" } })
    ).toEqual({ unitIndex: 0 });
  });

  it("opens the first unit when there is no deep link or saved position", () => {
    expect(resolveOpening(view, {})).toEqual({ unitIndex: 0 });
  });
});
