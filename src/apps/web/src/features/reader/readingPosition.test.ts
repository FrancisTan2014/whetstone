import { describe, expect, it, vi } from "vitest";

import type { ReaderView } from "./readerModel";
import {
  createLocalStoragePositionStore,
  parseReadingPosition,
  readingPositionKey,
  resolveOpening,
  serializeReadingPosition,
  type PositionStorage,
  type ReadingPosition
} from "./readingPosition";

const view: ReaderView = {
  units: [
    { blocks: [], entryId: "u-1", title: "One" },
    { blocks: [], entryId: "u-2", title: "Two" }
  ],
  workEntryId: "work-1"
};

describe("readingPositionKey", () => {
  it("namespaces the key per work", () => {
    expect(readingPositionKey("work-9")).toBe("whetstone:reading-position:work-9");
  });
});

describe("parseReadingPosition", () => {
  it("returns undefined for missing storage", () => {
    expect(parseReadingPosition(null)).toBeUndefined();
  });

  it("returns undefined for non-JSON", () => {
    expect(parseReadingPosition("{not json")).toBeUndefined();
  });

  it("returns undefined for a non-object payload", () => {
    expect(parseReadingPosition("42")).toBeUndefined();
    expect(parseReadingPosition("null")).toBeUndefined();
  });

  it("returns undefined for a missing or empty unit id", () => {
    expect(parseReadingPosition(JSON.stringify({ scrollOffset: 0 }))).toBeUndefined();
    expect(
      parseReadingPosition(JSON.stringify({ scrollOffset: 0, unitEntryId: "" }))
    ).toBeUndefined();
  });

  it("returns undefined for an invalid scroll offset", () => {
    expect(
      parseReadingPosition(JSON.stringify({ scrollOffset: "x", unitEntryId: "u-1" }))
    ).toBeUndefined();
    expect(
      parseReadingPosition(JSON.stringify({ scrollOffset: -5, unitEntryId: "u-1" }))
    ).toBeUndefined();
    expect(
      parseReadingPosition(
        JSON.stringify({ scrollOffset: Number.POSITIVE_INFINITY, unitEntryId: "u-1" })
      )
    ).toBeUndefined();
  });

  it("parses a valid position", () => {
    expect(parseReadingPosition(JSON.stringify({ scrollOffset: 120, unitEntryId: "u-2" }))).toEqual(
      {
        scrollOffset: 120,
        unitEntryId: "u-2"
      }
    );
  });
});

describe("serializeReadingPosition", () => {
  it("round-trips through parse", () => {
    const position: ReadingPosition = { scrollOffset: 50, unitEntryId: "u-1" };
    expect(parseReadingPosition(serializeReadingPosition(position))).toEqual(position);
  });
});

describe("createLocalStoragePositionStore", () => {
  function fakeStorage(initial: Record<string, string> = {}): {
    setItem: ReturnType<typeof vi.fn>;
    storage: PositionStorage;
  } {
    const map = new Map(Object.entries(initial));
    const setItem = vi.fn((key: string, value: string) => {
      map.set(key, value);
    });
    return {
      setItem,
      storage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem
      }
    };
  }

  it("reads and writes a position", () => {
    const { storage, setItem } = fakeStorage();
    const store = createLocalStoragePositionStore(storage);

    store.write("work-1", { scrollOffset: 10, unitEntryId: "u-2" });
    expect(setItem).toHaveBeenCalledWith(
      "whetstone:reading-position:work-1",
      JSON.stringify({ scrollOffset: 10, unitEntryId: "u-2" })
    );
    expect(store.read("work-1")).toEqual({ scrollOffset: 10, unitEntryId: "u-2" });
  });

  it("returns undefined when there is no saved position", () => {
    const { storage } = fakeStorage();
    expect(createLocalStoragePositionStore(storage).read("work-x")).toBeUndefined();
  });

  it("degrades gracefully when storage throws", () => {
    const store = createLocalStoragePositionStore({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      }
    });

    expect(store.read("work-1")).toBeUndefined();
    expect(() => store.write("work-1", { scrollOffset: 0, unitEntryId: "u-1" })).not.toThrow();
  });
});

describe("resolveOpening", () => {
  it("opens the deep-linked block's unit and scrolls to the block", () => {
    expect(
      resolveOpening(view, {
        deepLinkBlockEntryId: "b-x",
        savedPosition: { scrollOffset: 9, unitEntryId: "u-2" }
      })
    ).toEqual({ scrollBlockEntryId: "b-x", unitIndex: 0 });
  });

  it("restores a saved unit and its scroll offset", () => {
    expect(
      resolveOpening(view, { savedPosition: { scrollOffset: 80, unitEntryId: "u-2" } })
    ).toEqual({
      scrollOffset: 80,
      unitIndex: 1
    });
  });

  it("falls back to the first unit when the saved unit no longer exists", () => {
    expect(
      resolveOpening(view, { savedPosition: { scrollOffset: 80, unitEntryId: "gone" } })
    ).toEqual({ unitIndex: 0 });
  });

  it("opens the first unit when there is no deep link or saved position", () => {
    expect(resolveOpening(view, {})).toEqual({ unitIndex: 0 });
  });
});
